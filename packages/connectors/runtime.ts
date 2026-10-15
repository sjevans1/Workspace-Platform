/**
 * W29-A: the connector runtime.
 *
 * Provider-neutral by construction: this module knows about connections,
 * capabilities, credentials, sync checkpoints, normalized events and bounded
 * failures. It knows NOTHING about Gmail, Microsoft Graph, Telegram or any other
 * provider, and provider adapters can never reach Workspace authorization from
 * here. A connector may hold external authority; it never holds Workspace
 * authority, and it can never broaden a user's Workspace permissions.
 *
 * Ownership is explicit and enforced on every entry point:
 *  - a USER-DELEGATED connection is readable and manageable by its owning user
 *    (and by a tenant owner/admin);
 *  - a TENANT/SHARED connection is readable by tenant members and manageable only
 *    by a tenant owner/admin.
 * A normal member can therefore never manage a shared company mailbox, bot or
 * calendar, and an unrelated user can never read a delegated connection.
 */
import { randomUUID } from "node:crypto";
import { assert } from "../contracts/index.ts";
import type { Database, Query } from "../database/index.ts";
import { one } from "../database/index.ts";
import type { Actor } from "../auth/index.ts";
import {
  defaultCapabilities,
  normalizeCapabilities,
  providerDefinition,
  SYNTHETIC_PROVIDER_KEY,
  type Capability,
  type ProviderDefinition,
} from "./registry.ts";
import { ADAPTER_HOOKS, adapterFor, adapterImplemented } from "./registry.ts";
import type { AdapterHooks, NormalizedEvent } from "./adapter.ts";
import {
  backoffSeconds,
  classifyProviderFailure,
  isRetryableCategory,
  RETRY_POLICY,
  type ConnectionStatus,
  type FailureCategory,
  type ProviderFailureInput,
} from "./failure.ts";
import {
  credentialAad,
  credentialsFor,
  openCredential,
  putCredential,
  revokeCredentials,
  sanitizeCredentialMetadata,
  tokenDigest,
  type CredentialMetadata,
  type CredentialRecord,
} from "./credentials.ts";

export const CONNECTOR_LIMITS = {
  max_connections_per_tenant: 50,
  max_user_connections_per_user: 20,
  max_events_per_sync: 50,
  sync_claim_batch: 10,
  event_dispatch_batch: 25,
  max_credentials_per_connection: 16,
  sync_lease_seconds: 120,
  max_config_bytes: 8192,
} as const;

export type Ownership = "user" | "tenant";

export type PublicConnection = {
  id: string;
  provider_key: string;
  provider_display_name: string;
  provider_category: string;
  provider_implemented: boolean;
  adapter_version: string;
  ownership: Ownership;
  owner_user_id: string | null;
  label: string;
  status: ConnectionStatus;
  enabled: boolean;
  capabilities_requested: Capability[];
  capabilities_granted: Capability[];
  capabilities_available: Capability[];
  config: Record<string, unknown>;
  created_at: Date;
  updated_at: Date;
  connected_at: Date | null;
  disabled_at: Date | null;
  revoked_at: Date | null;
  last_success_at: Date | null;
  last_sync_at: Date | null;
  last_event_at: Date | null;
  last_error_at: Date | null;
  last_error_category: string | null;
  attention_reason: string | null;
  ownership_label: string;
  credentials: CredentialRecord[];
};

const OWNERSHIP_LABEL: Record<Ownership, string> = {
  user: "Delegated user",
  tenant: "Shared (tenant)",
};

export function isTenantAdministrator(actor: Pick<Actor, "role">): boolean {
  return ["owner", "admin"].includes(actor.role);
}

export function canManageConnection(
  actor: Pick<Actor, "role" | "user_id">,
  row: { ownership: string; owner_user_id: string | null },
): boolean {
  if (isTenantAdministrator(actor)) return true;
  return row.ownership === "user" && row.owner_user_id === actor.user_id;
}

export function canReadConnection(
  actor: Pick<Actor, "role" | "user_id">,
  row: { ownership: string; owner_user_id: string | null },
): boolean {
  if (isTenantAdministrator(actor)) return true;
  if (row.ownership === "user") return row.owner_user_id === actor.user_id;
  return true;
}

/**
 * The status projection. It is the ONLY shape a browser may receive, and it can
 * only ever be built from non-secret columns plus the sanitized credential
 * metadata allowlist.
 */
export function publicConnection(
  row: any,
  credentials: CredentialRecord[] = [],
): PublicConnection {
  const definition = providerDefinition(row.provider_key);
  return {
    id: row.id,
    provider_key: row.provider_key,
    provider_display_name: definition.display_name,
    provider_category: definition.category,
    provider_implemented: adapterImplemented(row.provider_key),
    adapter_version: definition.adapter_version,
    ownership: row.ownership,
    owner_user_id: row.owner_user_id,
    label: row.label,
    status: row.status,
    enabled: row.enabled,
    capabilities_requested: [...(row.capabilities_requested || [])],
    capabilities_granted: [...(row.capabilities_granted || [])],
    capabilities_available: [...definition.capabilities],
    config: sanitizeCredentialMetadata(row.config) as unknown as Record<
      string,
      unknown
    >,
    created_at: row.created_at,
    updated_at: row.updated_at,
    connected_at: row.connected_at,
    disabled_at: row.disabled_at,
    revoked_at: row.revoked_at,
    last_success_at: row.last_success_at,
    last_sync_at: row.last_sync_at,
    last_event_at: row.last_event_at,
    last_error_at: row.last_error_at,
    last_error_category: row.last_error_category,
    attention_reason: row.attention_reason,
    ownership_label: OWNERSHIP_LABEL[row.ownership as Ownership],
    credentials,
  };
}

async function audit(
  q: Query,
  tenant: string,
  actorId: string | null,
  action: string,
  resourceId: string | null,
): Promise<void> {
  // The audit row carries the action, the connection and the actor only. There is
  // deliberately no detail column, so a secret can never reach the audit trail.
  await q.query(
    "INSERT INTO audit_events(id,tenant_id,actor_id,action,resource_id) VALUES($1,$2,$3,$4,$5)",
    [randomUUID(), tenant, actorId, action, resourceId],
  );
}

export type CreateConnectionInput = {
  provider_key: string;
  label: string;
  ownership: Ownership;
  config?: Record<string, unknown>;
  capabilities?: unknown;
};

export async function createConnection(
  q: Query,
  actor: Actor,
  input: CreateConnectionInput,
): Promise<PublicConnection> {
  const definition: ProviderDefinition = providerDefinition(input.provider_key);
  assert(
    ["user", "tenant"].includes(input.ownership),
    400,
    "Connection ownership must be user or tenant",
  );
  assert(
    definition.ownership.includes(input.ownership),
    400,
    `Provider ${definition.key} does not support ${input.ownership} ownership`,
  );
  if (input.ownership === "tenant")
    assert(
      isTenantAdministrator(actor),
      403,
      "Administrator access required to create a shared connection",
    );
  const label = String(input.label || "").trim();
  assert(
    label.length >= 1 && label.length <= 120,
    400,
    "Connection label must contain 1-120 characters",
  );
  const requested =
    input.capabilities === undefined
      ? defaultCapabilities(definition)
      : normalizeCapabilities(input.capabilities);
  for (const capability of requested)
    assert(
      definition.capabilities.includes(capability),
      400,
      `Provider ${definition.key} does not provide ${capability}`,
    );

  const total = Number(
    (
      await one(
        q,
        "SELECT count(*)::int AS c FROM connector_connections WHERE tenant_id=$1",
        [actor.tenant_id],
      )
    )?.c || 0,
  );
  assert(
    total < CONNECTOR_LIMITS.max_connections_per_tenant,
    409,
    "Connection limit reached for this workspace",
  );
  if (input.ownership === "user") {
    const mine = Number(
      (
        await one(
          q,
          "SELECT count(*)::int AS c FROM connector_connections WHERE tenant_id=$1 AND owner_user_id=$2",
          [actor.tenant_id, actor.user_id],
        )
      )?.c || 0,
    );
    assert(
      mine < CONNECTOR_LIMITS.max_user_connections_per_user,
      409,
      "Delegated connection limit reached",
    );
  }
  const config = sanitizeCredentialMetadata(input.config);
  assert(
    Buffer.byteLength(JSON.stringify(config)) <=
      CONNECTOR_LIMITS.max_config_bytes,
    400,
    "Connection configuration is too large",
  );

  const id = randomUUID();
  await q.query(
    "INSERT INTO connector_connections(id,tenant_id,provider_key,ownership,owner_user_id,label,status,enabled," +
      " capabilities_requested,capabilities_granted,config,created_by)" +
      " VALUES($1,$2,$3,$4,$5,$6,'pending',true,$7,'{}',$8,$9)",
    [
      id,
      actor.tenant_id,
      definition.key,
      input.ownership,
      input.ownership === "user" ? actor.user_id : null,
      label,
      requested,
      JSON.stringify(config),
      actor.user_id,
    ],
  );
  await q.query(
    "INSERT INTO connector_sync_state(tenant_id,connection_id,poll_interval_seconds)" +
      " VALUES($1,$2,$3)",
    [actor.tenant_id, id, definition.default_poll_interval_seconds],
  );
  await audit(
    q,
    actor.tenant_id,
    actor.user_id,
    "connector.connection_created",
    id,
  );
  const row = await one(q, "SELECT * FROM connector_connections WHERE id=$1", [
    id,
  ]);
  return publicConnection(row);
}

export async function listConnections(
  q: Query,
  actor: Actor,
): Promise<PublicConnection[]> {
  const rows = (
    await q.query(
      "SELECT * FROM connector_connections WHERE tenant_id=$1 ORDER BY created_at DESC,id",
      [actor.tenant_id],
    )
  ).rows;
  const visible = rows.filter((row) => canReadConnection(actor, row));
  const output: PublicConnection[] = [];
  for (const row of visible) {
    const credentials = canManageConnection(actor, row)
      ? await credentialsFor(q, actor.tenant_id, row.id)
      : [];
    output.push(publicConnection(row, credentials));
  }
  return output;
}

async function loadConnection(
  q: Query,
  actor: Pick<Actor, "tenant_id" | "role" | "user_id">,
  id: string,
): Promise<any> {
  assert(/^[0-9a-f-]{36}$/i.test(id), 400, "Invalid connection id");
  const row = await one(q, "SELECT * FROM connector_connections WHERE id=$1", [
    id,
  ]);
  // A connection the caller may not see reports as absent, never as forbidden.
  assert(row, 404, "Connection not found");
  assert(canReadConnection(actor, row), 404, "Connection not found");
  return row;
}

export async function getConnection(
  q: Query,
  actor: Actor,
  id: string,
): Promise<PublicConnection> {
  const row = await loadConnection(q, actor, id);
  return publicConnection(
    row,
    canManageConnection(actor, row)
      ? await credentialsFor(q, actor.tenant_id, row.id)
      : [],
  );
}

function requireManage(actor: Actor, row: any): void {
  assert(
    canManageConnection(actor, row),
    403,
    "Administrator access required to manage this connection",
  );
}

/**
 * Completes a connection by storing its credential. The secret is SUPPLIED by the
 * caller (an operator pastes a bot token or webhook secret); it is sealed and never
 * echoed back, so this route can never return credential material to a browser.
 */
export async function connectConnection(
  q: Query,
  actor: Actor,
  id: string,
  input: { secret: string; metadata?: CredentialMetadata },
): Promise<PublicConnection> {
  const row = await loadConnection(q, actor, id);
  requireManage(actor, row);
  assert(
    row.status !== "revoked",
    409,
    "A revoked connection cannot be reconnected",
  );
  const definition = providerDefinition(row.provider_key);
  const kind = definition.credential_kinds[0];
  const secret = String(input.secret || "");
  assert(
    secret.length >= 16 && secret.length <= 4096,
    400,
    "Connection secret must contain 16-4096 characters",
  );
  const assigned = await putCredential(q, actor.tenant_id, id, kind, secret, {
    ...(input.metadata || {}),
    ...(definition.webhook ? { token_digest: tokenDigest(secret) } : {}),
  });
  // Capabilities become GRANTED only once the connection is actually established.
  await q.query(
    "UPDATE connector_connections SET status='connected',enabled=true,connected_at=now(),updated_at=now()," +
      " capabilities_granted=capabilities_requested,disabled_at=NULL,attention_reason=NULL," +
      " last_error_at=NULL,last_error_category=NULL WHERE id=$1",
    [id],
  );
  // A freshly connected provider is queued for its first incremental sync, so a
  // connected connection is never left idle waiting for an operator to press sync.
  await q.query(
    "UPDATE connector_sync_state SET status='pending',next_attempt_at=now(),lease_token=NULL," +
      " lease_expires_at=NULL,updated_at=now() WHERE tenant_id=$1 AND connection_id=$2",
    [actor.tenant_id, id],
  );
  await audit(q, actor.tenant_id, actor.user_id, "connector.connected", id);
  await audit(
    q,
    actor.tenant_id,
    actor.user_id,
    "connector.capabilities_granted",
    id,
  );
  void assigned;
  return getConnection(q, actor, id);
}

export async function setConnectionEnabled(
  q: Query,
  actor: Actor,
  id: string,
  enabled: boolean,
): Promise<PublicConnection> {
  const row = await loadConnection(q, actor, id);
  requireManage(actor, row);
  assert(
    row.status !== "revoked",
    409,
    "A revoked connection cannot be enabled",
  );
  assert(
    enabled ? row.status !== "pending" : true,
    409,
    "Connect the provider before enabling it",
  );
  await q.query(
    "UPDATE connector_connections SET enabled=$2,updated_at=now()," +
      " status=CASE WHEN $2 THEN CASE WHEN status='disabled' THEN 'connected' ELSE status END ELSE 'disabled' END," +
      " disabled_at=CASE WHEN $2 THEN NULL ELSE now() END WHERE id=$1",
    [id, enabled],
  );
  if (enabled)
    await q.query(
      "UPDATE connector_sync_state SET status='pending',next_attempt_at=now(),updated_at=now()" +
        " WHERE tenant_id=$1 AND connection_id=$2 AND status='idle'",
      [actor.tenant_id, id],
    );
  await audit(
    q,
    actor.tenant_id,
    actor.user_id,
    enabled ? "connector.enabled" : "connector.disabled",
    id,
  );
  return getConnection(q, actor, id);
}

/** Ambient-secret purge: revoking destroys the credential material and the cursor. */
export async function revokeConnection(
  q: Query,
  actor: Actor,
  id: string,
): Promise<PublicConnection> {
  const row = await loadConnection(q, actor, id);
  requireManage(actor, row);
  await revokeCredentials(q, actor.tenant_id, id);
  await q.query(
    "UPDATE connector_connections SET status='revoked',enabled=false,revoked_at=now(),updated_at=now()," +
      " capabilities_granted='{}',attention_reason='Revoked by an administrator' WHERE id=$1",
    [id],
  );
  await q.query(
    "UPDATE connector_sync_state SET cursor=NULL,status='idle',consecutive_failures=0,lease_token=NULL," +
      " lease_expires_at=NULL,last_error_category=NULL,last_error_summary=NULL,updated_at=now()" +
      " WHERE tenant_id=$1 AND connection_id=$2",
    [actor.tenant_id, id],
  );
  await audit(q, actor.tenant_id, actor.user_id, "connector.revoked", id);
  return getConnection(q, actor, id);
}

export async function rotateConnectionCredential(
  q: Query,
  actor: Actor,
  id: string,
  input: { secret: string; metadata?: CredentialMetadata },
): Promise<PublicConnection> {
  const row = await loadConnection(q, actor, id);
  requireManage(actor, row);
  assert(
    row.status !== "revoked",
    409,
    "A revoked connection cannot be rotated",
  );
  const definition = providerDefinition(row.provider_key);
  const kind = definition.credential_kinds[0];
  const secret = String(input.secret || "");
  assert(
    secret.length >= 16 && secret.length <= 4096,
    400,
    "Connection secret must contain 16-4096 characters",
  );
  await putCredential(q, actor.tenant_id, id, kind, secret, {
    ...(input.metadata || {}),
    ...(definition.webhook ? { token_digest: tokenDigest(secret) } : {}),
  });
  await q.query(
    "UPDATE connector_connections SET updated_at=now(),attention_reason=NULL," +
      " last_error_at=NULL,last_error_category=NULL," +
      " status=CASE WHEN status='attention_required' THEN 'connected' ELSE status END WHERE id=$1",
    [id],
  );
  await audit(
    q,
    actor.tenant_id,
    actor.user_id,
    "connector.credential_rotated",
    id,
  );
  return getConnection(q, actor, id);
}

/**
 * The bounded health/test probe. Health is NEVER inferred from the presence of a
 * credential: the adapter is actually asked, and the connection status is updated
 * from the classified outcome.
 */
export async function testConnection(
  q: Query,
  actor: Actor,
  id: string,
): Promise<{
  ok: boolean;
  category: FailureCategory | null;
  detail: string | null;
  status: ConnectionStatus;
}> {
  const row = await loadConnection(q, actor, id);
  requireManage(actor, row);
  assert(
    row.status !== "revoked",
    409,
    "A revoked connection cannot be tested",
  );
  const definition = providerDefinition(row.provider_key);
  if (!definition.health_check || !adapterImplemented(row.provider_key)) {
    return {
      ok: false,
      category: "permanent",
      detail: "Provider adapter is not implemented",
      status: row.status,
    };
  }
  const hooks = adapterFor(row.provider_key);
  await audit(
    q,
    actor.tenant_id,
    actor.user_id,
    "connector.health_checked",
    id,
  );
  const result = await hooks.health({
    config: (row.config || {}) as Record<string, unknown>,
  });
  if (result.ok) {
    await q.query(
      "UPDATE connector_connections SET updated_at=now()," +
        " status=CASE WHEN status='pending' THEN status ELSE 'connected' END," +
        " attention_reason=NULL WHERE id=$1",
      [id],
    );
    return {
      ok: true,
      category: null,
      detail: null,
      status: "connected" as ConnectionStatus,
    };
  }
  const failure = classifyProviderFailure({ kind: "protocol" });
  const category = result.category || failure.category;
  await applyConnectionAttention(
    q,
    actor.tenant_id,
    id,
    category,
    result.detail || "Provider health check failed",
  );
  return {
    ok: false,
    category,
    detail: result.detail || null,
    status: "attention_required",
  };
}

async function applyConnectionAttention(
  q: Query,
  tenant: string,
  connectionId: string,
  category: FailureCategory,
  summary: string,
): Promise<void> {
  await q.query(
    "UPDATE connector_connections SET last_error_at=now(),last_error_category=$3," +
      " updated_at=now(),attention_reason=$4," +
      " status=CASE WHEN status='revoked' OR status='disabled' THEN status ELSE 'attention_required' END" +
      " WHERE id=$1 AND tenant_id=$2",
    [connectionId, tenant, category, summary.slice(0, 200)],
  );
}

export type SyncClaim = {
  connection_id: string;
  provider_key: string;
  cursor: string | null;
  config: Record<string, unknown>;
  lease_token: string;
  attempt: number;
  poll_interval_seconds: number;
};

/** Claims a bounded, leased batch of due syncs. A crashed worker's lease expires. */
export async function claimDueSync(
  q: Query,
  tenant: string,
  limit = CONNECTOR_LIMITS.sync_claim_batch,
): Promise<SyncClaim[]> {
  const candidates = (
    await q.query(
      "SELECT s.connection_id,s.attempts,c.provider_key,s.cursor,c.config,s.poll_interval_seconds" +
        " FROM connector_sync_state s JOIN connector_connections c" +
        " ON c.tenant_id=s.tenant_id AND c.id=s.connection_id" +
        " WHERE s.tenant_id=$1 AND c.enabled AND c.status='connected'" +
        // A claim is due when the connection has work queued or a previous attempt
        // failed, OR when a worker died holding the lease ('running' with an
        // expired lease). Without that last case a crashed sync would strand the
        // connection in 'running' forever.
        " AND (s.status IN ('pending','failed')" +
        " OR (s.status='running' AND (s.lease_expires_at IS NULL OR s.lease_expires_at<=now())))" +
        " AND s.next_attempt_at<=now()" +
        " AND (s.lease_expires_at IS NULL OR s.lease_expires_at<=now())" +
        " ORDER BY s.next_attempt_at,s.connection_id LIMIT $2 FOR UPDATE OF s SKIP LOCKED",
      [tenant, Math.max(1, Math.min(limit, CONNECTOR_LIMITS.sync_claim_batch))],
    )
  ).rows;
  const claims: SyncClaim[] = [];
  for (const candidate of candidates) {
    const leaseToken = randomUUID();
    await q.query(
      "UPDATE connector_sync_state SET status='running',lease_token=$3," +
        " lease_expires_at=now()+($4 || ' seconds')::interval,last_attempt_at=now()," +
        " attempts=attempts+1,updated_at=now() WHERE tenant_id=$1 AND connection_id=$2",
      [
        tenant,
        candidate.connection_id,
        leaseToken,
        CONNECTOR_LIMITS.sync_lease_seconds,
      ],
    );
    claims.push({
      connection_id: candidate.connection_id,
      provider_key: candidate.provider_key,
      cursor: candidate.cursor,
      config: (candidate.config || {}) as Record<string, unknown>,
      lease_token: leaseToken,
      attempt: Number(candidate.attempts) + 1,
      poll_interval_seconds: Number(candidate.poll_interval_seconds) || 300,
    });
  }
  return claims;
}

/**
 * Commits a successful sync: the cursor advances ONLY here, in the same statement
 * that records the success, so a failed sync can never advance it.
 */
export async function completeSync(
  q: Query,
  tenant: string,
  claim: SyncClaim,
  outcome: { next_cursor: string | null; next_at: Date },
): Promise<void> {
  await q.query(
    "UPDATE connector_sync_state SET cursor=COALESCE($4,cursor),status='idle',sync_generation=sync_generation+1," +
      " consecutive_failures=0,last_success_at=now(),next_attempt_at=$5,lease_token=NULL,lease_expires_at=NULL," +
      " last_error_category=NULL,last_error_summary=NULL,updated_at=now()" +
      " WHERE tenant_id=$1 AND connection_id=$2 AND status='running' AND lease_token=$3",
    [
      tenant,
      claim.connection_id,
      claim.lease_token,
      outcome.next_cursor,
      outcome.next_at,
    ],
  );
  await q.query(
    "UPDATE connector_connections SET last_sync_at=now(),last_success_at=now(),updated_at=now()" +
      " WHERE tenant_id=$1 AND id=$2",
    [tenant, claim.connection_id],
  );
}

/** Records a failed sync. The cursor is untouched, and the retry is bounded. */
export async function failSync(
  q: Query,
  tenant: string,
  claim: SyncClaim,
  failure: ProviderFailureInput,
  nextAttemptAt: Date,
): Promise<{ category: FailureCategory; attention: boolean }> {
  const classified = classifyProviderFailure(failure);
  const failures =
    Number(
      (
        await one(
          q,
          "SELECT consecutive_failures FROM connector_sync_state WHERE tenant_id=$1 AND connection_id=$2",
          [tenant, claim.connection_id],
        )
      )?.consecutive_failures || 0,
    ) + 1;
  const exhausted =
    !isRetryableCategory(classified.category) ||
    failures >= RETRY_POLICY.attention_after_failures;
  await q.query(
    "UPDATE connector_sync_state SET status=$4,consecutive_failures=$5,lease_token=NULL,lease_expires_at=NULL," +
      " last_error_category=$6,last_error_summary=$7,next_attempt_at=$8,updated_at=now()" +
      " WHERE tenant_id=$1 AND connection_id=$2 AND status='running' AND lease_token=$3",
    [
      tenant,
      claim.connection_id,
      claim.lease_token,
      exhausted ? "attention" : "failed",
      failures,
      classified.category,
      classified.summary,
      nextAttemptAt,
    ],
  );
  if (classified.connection_status)
    await applyConnectionAttention(
      q,
      tenant,
      claim.connection_id,
      classified.category,
      classified.summary,
    );
  else
    await q.query(
      "UPDATE connector_connections SET last_error_at=now(),last_error_category=$3,updated_at=now()" +
        " WHERE tenant_id=$1 AND id=$2",
      [tenant, claim.connection_id, classified.category],
    );
  return { category: classified.category, attention: exhausted };
}

export type RecordedEvent = {
  id: string;
  inserted: boolean;
  dedupe_key: string;
  event_type: string;
};

/**
 * Records one normalized provider event. The unique (tenant, connection, dedupe
 * key) index makes repeated delivery of the same provider event a DUPLICATE rather
 * than a second logical event, and the duplicate is counted for operator metrics.
 */
export async function recordConnectorEvent(
  q: Query,
  tenant: string,
  connectionId: string,
  providerKey: string,
  event: NormalizedEvent,
  verification: "verified" | "unverified" | "rejected",
): Promise<RecordedEvent> {
  const payload = JSON.stringify(event.payload_ref);
  assert(
    Buffer.byteLength(payload) <= CONNECTOR_LIMITS.max_config_bytes,
    400,
    "Connector event metadata is too large",
  );
  const row = await one(
    q,
    "INSERT INTO connector_events(id,tenant_id,connection_id,provider_key,event_type,provider_event_id," +
      " dedupe_key,verification,provider_occurred_at,normalized_resource_refs,payload_ref,dispatch_state)" +
      " VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)" +
      " ON CONFLICT(tenant_id,connection_id,dedupe_key) DO UPDATE" +
      " SET duplicate_count=connector_events.duplicate_count+1" +
      " RETURNING id,dedupe_key,event_type,(xmax=0) AS inserted",
    [
      randomUUID(),
      tenant,
      connectionId,
      providerKey,
      event.event_type,
      event.provider_event_id,
      event.dedupe_key,
      verification,
      event.occurred_at ? new Date(event.occurred_at) : null,
      JSON.stringify(event.resource_refs.slice(0, 16)),
      payload,
      verification === "verified" ? "pending" : "skipped",
    ],
  );
  await q.query(
    "UPDATE connector_connections SET last_event_at=now(),updated_at=now() WHERE tenant_id=$1 AND id=$2",
    [tenant, connectionId],
  );
  return {
    id: row.id,
    inserted: row.inserted === true,
    dedupe_key: row.dedupe_key,
    event_type: row.event_type,
  };
}

export type IngressResult =
  | {
      accepted: true;
      connection_id: string;
      event_id: string;
      duplicate: boolean;
      event_type: string;
      tenant_id: string;
    }
  | {
      accepted: false;
      reason:
        | "unknown_connection"
        | "invalid_signature"
        | "not_normalizable"
        | "rejected_event"
        | "disabled";
    };

/**
 * The generic ingress contract. A provider request is untrusted until the adapter
 * authenticates it, and ONLY a verified event may become executable workflow
 * input. The tenant is resolved through a definer lookup because the request
 * carries no session, so no client-supplied value ever selects the tenant.
 */
export async function ingestProviderEvent(
  db: Database,
  input: {
    connection_id: string;
    headers: Record<string, string | string[] | undefined>;
    body: unknown;
  },
): Promise<IngressResult> {
  assert(
    /^[0-9a-f-]{36}$/i.test(String(input.connection_id || "")),
    400,
    "Invalid connection id",
  );
  const presented = headerValue(input.headers, "x-connector-token");
  assert(presented.length <= 4096, 400, "Connector token is too long");
  const resolved = await db.system((q) =>
    one(q, "SELECT * FROM connector_ingress_context($1::uuid,$2)", [
      input.connection_id,
      tokenDigest(presented),
    ]),
  );
  if (!resolved) return { accepted: false, reason: "unknown_connection" };
  if (resolved.status === "revoked" || !resolved.enabled)
    return { accepted: false, reason: "disabled" };

  const hooks = ADAPTER_HOOKS.get(resolved.provider_key);
  if (!hooks) return { accepted: false, reason: "not_normalizable" };
  // The definer lookup returns the sealed envelope; it is opened here, only to be
  // handed to the adapter's own verification step, and is never logged or returned.
  const secret = openCredential(
    credentialAad(resolved.tenant_id, resolved.connection_id, "webhook_secret"),
    String(resolved.secret_encrypted || ""),
  );
  const verification = hooks.verifyInbound({
    headers: input.headers,
    body: input.body,
    secret,
  });
  if (!verification.verified)
    return { accepted: false, reason: "invalid_signature" };
  let normalized: NormalizedEvent | null = null;
  try {
    normalized = hooks.normalizeInbound({
      headers: input.headers,
      body: input.body,
      secret: "",
    });
  } catch {
    return { accepted: false, reason: "not_normalizable" };
  }
  if (!normalized) return { accepted: false, reason: "rejected_event" };

  // The definer lookup already proved the token digest; the adapter's own check is
  // the second, provider-specific step. Only now does a tenant context exist.
  const recorded = await db.tenant(resolved.tenant_id, (q) =>
    recordConnectorEvent(
      q,
      resolved.tenant_id,
      resolved.connection_id,
      resolved.provider_key,
      normalized!,
      "verified",
    ),
  );
  return {
    accepted: true,
    connection_id: resolved.connection_id,
    event_id: recorded.id,
    duplicate: !recorded.inserted,
    event_type: recorded.event_type,
    tenant_id: resolved.tenant_id,
  };
}

function headerValue(
  headers: Record<string, string | string[] | undefined>,
  name: string,
): string {
  const value = headers[name] ?? headers[name.toLowerCase()];
  if (Array.isArray(value)) return value[0] ?? "";
  return value ?? "";
}

/** Verified events awaiting workflow dispatch. */
export async function pendingConnectorEvents(
  q: Query,
  tenant: string,
  limit = CONNECTOR_LIMITS.event_dispatch_batch,
): Promise<any[]> {
  return (
    await q.query(
      "SELECT id,connection_id,provider_key,event_type,provider_event_id,received_at," +
        " provider_occurred_at,normalized_resource_refs,payload_ref" +
        " FROM connector_events WHERE tenant_id=$1 AND verification='verified' AND dispatch_state='pending'" +
        " ORDER BY received_at,id LIMIT $2 FOR UPDATE SKIP LOCKED",
      [
        tenant,
        Math.max(1, Math.min(limit, CONNECTOR_LIMITS.event_dispatch_batch)),
      ],
    )
  ).rows;
}

export async function markEventDispatched(
  q: Query,
  tenant: string,
  id: string,
): Promise<void> {
  await q.query(
    "UPDATE connector_events SET dispatch_state='dispatched',processed_at=now()" +
      " WHERE tenant_id=$1 AND id=$2 AND verification='verified'",
    [tenant, id],
  );
}

/**
 * The CUSTOMER-facing connector counters, computed inside the caller's tenant
 * transaction so FORCE RLS applies. `connectorMetrics` below is the separate
 * platform/operator surface: it aggregates the whole deployment through a
 * SECURITY DEFINER count function and must never be reachable from a tenant route,
 * because a customer must not be able to infer another tenant's connector activity.
 */
export async function connectorMetricsForTenant(
  q: Query,
  tenant: string,
): Promise<Record<string, number>> {
  const row = await one(
    q,
    "SELECT" +
      " (SELECT count(*)::int FROM connector_connections WHERE tenant_id=$1) AS connections," +
      " (SELECT count(*)::int FROM connector_connections WHERE tenant_id=$1 AND status='attention_required') AS attention_required," +
      " (SELECT count(*)::int FROM connector_sync_state WHERE tenant_id=$1 AND status IN ('failed','attention')) AS sync_failures," +
      " (SELECT count(*)::int FROM connector_events WHERE tenant_id=$1) AS events_received," +
      " (SELECT COALESCE(SUM(duplicate_count),0)::int FROM connector_events WHERE tenant_id=$1) AS events_duplicate",
    [tenant],
  );
  return {
    connections: Number(row?.connections || 0),
    attention_required: Number(row?.attention_required || 0),
    sync_failures: Number(row?.sync_failures || 0),
    events_received: Number(row?.events_received || 0),
    events_duplicate: Number(row?.events_duplicate || 0),
  };
}

/** The connector half of the operator metrics surface. */
export async function connectorMetrics(
  db: Database,
): Promise<Record<string, number>> {
  const row = await db.system((q) =>
    one(q, "SELECT * FROM workspace_connector_health()"),
  );
  return {
    connections: Number(row?.connections || 0),
    attention_required: Number(row?.attention_required || 0),
    sync_failures: Number(row?.sync_failures || 0),
    events_received: Number(row?.events_received || 0),
    events_duplicate: Number(row?.events_duplicate || 0),
  };
}

/** Re-exported so the API layer can build a connection's declared actions. */
export function providerActions(providerKey: string) {
  return providerDefinition(providerKey).actions;
}

/**
 * W29-P0/A1: the live authority facts of one connection, read inside the caller's
 * tenant transaction. It is the single implementation used by the engine's
 * connector port AND by the external-effect worker phase before provider I/O, so
 * the pre-execution re-check cannot drift from the authorization the run saw.
 */
export type ConnectionActionFacts = {
  /** Always true when a row is returned; absent connections are reported as null. */
  exists: boolean;
  enabled: boolean;
  status: string;
  ownership: string;
  owner_user_id: string | null;
  capabilities_granted: string[];
  provider_key: string;
};

export async function connectionActionFacts(
  q: Query,
  tenant: string,
  connectionId: string,
): Promise<ConnectionActionFacts | null> {
  const row = await one(
    q,
    "SELECT id,provider_key,status,enabled,ownership,owner_user_id,capabilities_granted" +
      " FROM connector_connections WHERE tenant_id=$1 AND id=$2",
    [tenant, connectionId],
  );
  if (!row) return null;
  return {
    exists: true,
    enabled: row.enabled === true,
    status: String(row.status),
    ownership: String(row.ownership),
    owner_user_id: row.owner_user_id ?? null,
    capabilities_granted: [...(row.capabilities_granted || [])],
    provider_key: String(row.provider_key),
  };
}

/**
 * The one reach rule for a connector action, as a pure function so the engine and
 * the external-effect worker apply the same boundary. Ownership decides reach: a
 * user-delegated connection belongs to exactly one user, and a tenant/shared
 * connection is reachable by an administrator or by the tenant's own service
 * principal. Everything else is refused with a reason, and the caller decides how
 * to surface it.
 */
export function connectorReachDenial(input: {
  facts: ConnectionActionFacts;
  capability: string;
  authority_kind: "delegated_user" | "service_principal";
  authority_user_id: string | null;
  actor_role: string;
}): string | null {
  const { facts, capability, authority_kind, authority_user_id, actor_role } =
    input;
  if (!facts.enabled) return "connection is disabled";
  if (facts.status !== "connected") return "connection is not connected";
  if (!facts.capabilities_granted.includes(capability))
    return "connection does not hold the required capability";
  const ownsConnection =
    facts.ownership === "user" && facts.owner_user_id === authority_user_id;
  const sharedReachable =
    facts.ownership === "tenant" &&
    (authority_kind === "service_principal" ||
      actor_role === "owner" ||
      actor_role === "admin");
  if (!ownsConnection && !sharedReachable)
    return "connection is not available to this run's authority";
  return null;
}

/**
 * W29-P0/A1: the ONE governed way to execute a declared provider action.
 *
 * It validates the provider's declared contract (the action exists, and it is the
 * action that requires this capability) and then performs the adapter call. The
 * caller is responsible for the transaction boundary: this function must be
 * invoked with NO tenant database transaction and NO row lock held, which is what
 * the external-effect worker phase guarantees.
 */
export async function invokeProviderAction(input: {
  provider_key: string;
  action: string;
  capability: string;
  payload: Record<string, unknown>;
  effect?: { idempotency_key: string; attempt: number };
}): Promise<Record<string, unknown>> {
  const definition = providerDefinition(input.provider_key);
  const declared = definition.actions.find((item) => item.key === input.action);
  assert(
    declared,
    400,
    `Connector provider ${definition.key} does not declare action ${input.action}`,
  );
  assert(
    declared!.requires_capability === input.capability,
    400,
    `Connector action ${input.action} requires ${declared!.requires_capability}`,
  );
  assert(
    adapterImplemented(definition.key),
    400,
    `Connector provider ${definition.key} has no implemented adapter`,
  );
  return adapterFor(definition.key).action({
    action: input.action,
    capability: declared!.requires_capability,
    config: {},
    payload: input.payload || {},
    ...(input.effect ? { effect: input.effect } : {}),
  });
}

/**
 * Whether the provider offers an idempotency primitive for this action. The
 * external-effect lifecycle reads it at plan time, because it decides whether a
 * reclaimed lease may re-send or must settle as outcome-unknown.
 */
export function providerActionIdempotent(
  providerKey: string,
  action: string,
): boolean {
  const declared = providerDefinition(providerKey).actions.find(
    (item) => item.key === action,
  );
  return declared?.idempotent === true;
}
