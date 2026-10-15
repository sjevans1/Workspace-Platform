/**
 * W29-A / W30-A worker phases.
 *
 * Both phases reuse the worker's accepted architecture instead of adding a second
 * queue: a bounded CLAIM inside a short tenant transaction, the provider call made
 * OUTSIDE any transaction (so a slow or hostile provider cannot hold a database
 * connection or a row lock), then a short transaction that records the outcome only
 * if this worker still owns the lease. A crashed worker leaves a recoverable lease
 * that becomes claimable after it expires.
 *
 * The automation phase runs entirely inside the tenant transaction because its
 * registered actions are bounded Workspace operations. Provider-backed ACTIONS
 * (send mail, create a calendar event, post to a channel) are not implemented in
 * this tranche; when they are, their adapter I/O must be moved out of the run
 * transaction using exactly this claim/execute/commit shape.
 */
import { randomUUID } from "node:crypto";
import type { Database, Query } from "../../../packages/database/index.ts";
import { one } from "../../../packages/database/index.ts";
import {
  OAUTH_TEST_PROVIDER_KEY,
  activeCredential,
  adapterFor,
  backoffSeconds,
  claimDueSync,
  claimRefresh,
  classifyProviderFailure,
  completeRefresh,
  completeSync,
  failRefresh,
  failSync,
  oauthDescriptorFor,
  markRefreshIoStarted,
  oauthRegistry,
  recordConnectorEvent,
  refreshDue,
  refreshGrant,
  testOAuthTransport,
  type FailureCategory,
  type CredentialMetadata,
  type SyncClaim,
} from "../../../packages/connectors/index.ts";
import {
  dispatchConnectorEvent,
  dispatchWorkspaceEvent,
  engineTick,
  externalEffectTick,
  pruneRuns,
  scheduleTick,
  type ConnectorActionPort,
  type EngineDeps,
} from "../../../packages/automation/index.ts";
import { connectorActionPortFor } from "../../api/src/connected-work.ts";

async function audit(
  q: Query,
  tenant: string,
  action: string,
  resourceId: string | null,
): Promise<void> {
  await q.query(
    "INSERT INTO audit_events(id,tenant_id,actor_id,action,resource_id) VALUES($1,$2,NULL,$3,$4)",
    [randomUUID(), tenant, action, resourceId],
  );
}

function providerFailureFrom(error: unknown) {
  const status = (error as { statusCode?: number })?.statusCode;
  if (typeof status === "number") return classifyProviderFailure({ status });
  const message = String((error as Error)?.message || "");
  if (/timeout|ETIMEDOUT|ECONNRESET/i.test(message))
    return classifyProviderFailure({ kind: "timeout" });
  if (/fetch failed|ENOTFOUND|ECONNREFUSED|EAI_AGAIN/i.test(message))
    return classifyProviderFailure({ kind: "network" });
  return classifyProviderFailure({ kind: "protocol" });
}

/**
 * One bounded connector sync phase for a tenant. A sync that fails never advances
 * the cursor: the cursor is written only by `completeSync`.
 */
/**
 * W29-P0/A3: the operational refresh phase.
 *
 * Same discipline as the sync tick: a short transaction claims the lease, the
 * provider call happens with NO transaction held, and a second short transaction
 * commits the outcome under the fence. A crashed worker leaves a claim that expires
 * and is reclaimed; a worker whose claim was reclaimed cannot commit; and a
 * connection that was revoked or disabled while the refresh was in flight cannot be
 * refreshed back to connected.
 */
function oauthTransportFor(descriptor: { key: string; test_only: boolean }) {
  // The acceptance fixture is answered in-process and exists only when the
  // deployment enabled test wiring, which production refuses at load.
  return descriptor.test_only ? testOAuthTransport(descriptor as never) : undefined;
}

export async function oauthRefreshTick(
  db: Database,
  tenant: string,
  options: { now?: Date; limit?: number } = {},
): Promise<{ due: number; refreshed: number; attention: number; skipped: number }> {
  const now = options.now ?? new Date();
  const keys = [...oauthRegistry().descriptors.keys()];
  if (!keys.length) return { due: 0, refreshed: 0, attention: 0, skipped: 0 };
  // The ACCESS credential's metadata decides eligibility: a healthy token with time
  // left is never refreshed, however often the worker ticks.
  const candidates = await db.tenant(tenant, (q) =>
    q.query(
      "SELECT c.id,c.provider_key,rc.key_version AS refresh_version,ac.metadata AS access_metadata," +
        " COALESCE(ac.key_version,0) AS access_version" +
        " FROM connector_connections c" +
        " JOIN connector_credentials rc ON rc.tenant_id=c.tenant_id AND rc.connection_id=c.id AND rc.kind='oauth_refresh' AND rc.revoked_at IS NULL" +
        " LEFT JOIN connector_credentials ac ON ac.tenant_id=c.tenant_id AND ac.connection_id=c.id AND ac.kind='oauth_access' AND ac.revoked_at IS NULL" +
        " WHERE c.tenant_id=$1 AND c.status='connected' AND c.enabled AND c.provider_key = ANY($2::text[])" +
        " ORDER BY c.id LIMIT $3",
      [tenant, keys, Math.max(1, Math.min(options.limit ?? 20, 50))],
    ),
  );
  let refreshed = 0;
  let attention = 0;
  let skipped = 0;
  for (const row of candidates.rows as {
    id: string;
    provider_key: string;
    refresh_version: number;
    access_version: number;
    access_metadata: CredentialMetadata | null;
  }[]) {
    const descriptor = oauthDescriptorFor(row.provider_key);
    if (!descriptor) continue;
    // Due-driven cadence: a token with more than the refresh window left is left
    // alone, so repeated ticks make no outbound calls at all.
    if (!refreshDue(row.access_metadata, now)) {
      skipped += 1;
      continue;
    }
    // Claim the lease in a short transaction.
    const claim = await db.tenant(tenant, (q) =>
      claimRefresh(q, {
        tenant,
        connection_id: row.id,
        credential_version: Number(row.refresh_version),
        now,
      }),
    );
    if (!claim) continue;
    // Read the refresh token, then release the transaction before any I/O.
    const stored = await db.tenant(tenant, (q) =>
      activeCredential(q, tenant, row.id, "oauth_refresh"),
    );
    if (!stored) continue;
    // The durable pre-I/O boundary: after this point the claim is not safely
    // retryable, so a crash here becomes attention/reconnect rather than a blind
    // replay of a token the provider may already have rotated.
    const marked = await db.tenant(tenant, (q) =>
      markRefreshIoStarted(q, { tenant, claim, now }),
    );
    if (!marked) continue;
    const result = await refreshGrant({
      descriptor,
      refresh_token: stored.secret,
      transport: oauthTransportFor(descriptor),
    });
    if (!result.ok) {
      await db.tenant(tenant, (q) =>
        failRefresh(q, {
          tenant,
          claim,
          category: result.category,
          // An invalid grant or an unreachable provider needs a human: the grant is
          // unusable and further attempts cannot fix it.
          attention: ["refresh_invalid_grant", "provider_unreachable"].includes(
            result.category,
          ),
          reason: result.category,
        }),
      );
      attention += 1;
      continue;
    }
    const committed = await db.tenant(tenant, (q) =>
      completeRefresh(q, {
        tenant,
        claim,
        descriptor,
        tokens: result.outcome,
        now,
      }),
    ).catch(() => null);
    if (!committed) {
      attention += 1;
      continue;
    }
    if (committed.attention) attention += 1;
    else refreshed += 1;
  }
  return { due: candidates.rows.length, refreshed, attention, skipped };
}

export async function connectorTick(
  db: Database,
  tenant: string,
): Promise<{
  claimed: number;
  succeeded: number;
  failed: number;
  events: number;
  refresh: { due: number; refreshed: number; attention: number; skipped: number };
}> {
  // The refresh phase runs before sync, so a grant that is about to expire is
  // rotated before an adapter tries to use it. Its outcome is reported rather than
  // swallowed, so a continuous failure is visible instead of silent.
  let refresh: Awaited<ReturnType<typeof oauthRefreshTick>> = {
    due: 0,
    refreshed: 0,
    attention: 0,
    skipped: 0,
  };
  try {
    refresh = await oauthRefreshTick(db, tenant);
  } catch (error) {
    // Bounded and non-secret: the category only, never a token or a provider body.
    console.warn(
      JSON.stringify({
        event: "connector.oauth_refresh_failed",
        tenant: tenant.slice(0, 8),
        category: (error as { category?: string }).category ?? "unexpected",
      }),
    );
  }
  const claims: SyncClaim[] = await db.tenant(tenant, (q) => claimDueSync(q, tenant));
  let succeeded = 0,
    failed = 0,
    events = 0;
  for (const claim of claims) {
    let outcome:
      | { ok: true; next_cursor: string | null; recorded: number }
      | { ok: false; category: FailureCategory; backoff: number | null; summary: string };
    try {
      // The provider call happens with NO database transaction held.
      const result = await adapterFor(claim.provider_key).sync({
        cursor: claim.cursor,
        limit: 50,
        config: claim.config,
      });
      outcome = { ok: true, next_cursor: result.next_cursor, recorded: result.events.length };
      await db.tenant(tenant, async (q) => {
        for (const event of result.events)
          await recordConnectorEvent(q, tenant, claim.connection_id, claim.provider_key, event, "verified");
        await completeSync(q, tenant, claim, {
          next_cursor: result.next_cursor,
          next_at: new Date(Date.now() + claim.poll_interval_seconds * 1000),
        });
        await audit(q, tenant, "connector.sync_completed", claim.connection_id);
      });
      succeeded += 1;
      events += outcome.recorded;
    } catch (error) {
      const failure = providerFailureFrom(error);
      const backoff = failure.backoff_seconds ?? backoffSeconds(claim.attempt);
      await db.tenant(tenant, async (q) => {
        await failSync(q, tenant, claim, { status: (error as any)?.statusCode ?? null }, new Date(Date.now() + backoff * 1000));
        await audit(q, tenant, "connector.sync_failed", claim.connection_id);
      });
      // A non-retryable provider condition (expired credential, revoked
      // permission) has already moved the connection to attention_required.
      void failure;
      failed += 1;
    }
  }
  return { claimed: claims.length, succeeded, failed, events, refresh };
}

/**
 * One bounded automation phase for a tenant: schedules fire, verified connector
 * events and accepted outbox events become runs, queued runs execute, and bounded
 * retention prunes terminal history. Every part is per-tick bounded, so no tenant
 * can monopolize the worker.
 */
export async function automationTick(
  db: Database,
  tenant: string,
): Promise<{
  schedules: number;
  connector_runs: number;
  engine: { claimed: number; succeeded: number; failed: number; waiting: number };
  effects: {
    claimed: number;
    succeeded: number;
    failed: number;
    refused: number;
    outcome_unknown: number;
    stale: number;
    invoked: number;
  };
  pruned: number;
}> {
  const withPort = <T>(fn: (q: Query, deps: EngineDeps) => Promise<T>) =>
    db.tenant(tenant, (q) => fn(q, { connectorPort: connectorActionPortFor(q) }));
  const schedules = await withPort((q, deps) => scheduleTick(q, tenant, deps));
  const connector = await withPort((q, deps) => dispatchConnectorEvent(q, tenant, deps));
  const engine = await withPort((q, deps) => engineTick(q, tenant, deps));
  // W29-P0/A1: the provider-I/O phase runs AFTER the engine's transaction has
  // committed, so a connector action is PLANNED inside the run's transaction and
  // EXECUTED with no transaction and no row lock held. A terminal effect wakes its
  // parked run, so one settle pass lets the step complete inside the SAME tick.
  const effects = await externalEffectTick(db, tenant);
  const settled = await withPort((q, deps) => engineTick(q, tenant, deps));
  const pruned = await withPort((q) => pruneRuns(q, tenant));
  return {
    schedules: schedules.fired,
    connector_runs: connector.runs.length,
    engine: {
      claimed: engine.claimed + settled.claimed,
      succeeded: engine.succeeded + settled.succeeded,
      failed: engine.failed + settled.failed,
      waiting: engine.waiting + settled.waiting,
    },
    effects,
    pruned: pruned.deleted,
  };
}

/**
 * Workspace event dispatch runs INSIDE the existing outbox transaction, before the
 * accepted dispatcher marks those events dispatched, so a workspace event reaches a
 * workflow exactly once and a rolled-back transaction leaves neither the marker nor
 * the run behind.
 */
export async function workspaceEventTick(
  q: Query,
  tenant: string,
  deps: EngineDeps,
): Promise<{ runs: string[] }> {
  return dispatchWorkspaceEvent(q, tenant, deps);
}

export type { ConnectorActionPort };
export { one };
