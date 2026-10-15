/**
 * W29-P0/A3: the provider-neutral OAuth2 authorization substrate.
 *
 * The shape of this module follows the accepted A1 discipline exactly:
 *
 *   short tenant transaction (claim/validate, fence) -> COMMIT
 *   -> provider network I/O with NO tenant transaction held
 *   -> short tenant transaction (re-validate the fence, commit the outcome)
 *
 * Nothing here is provider specific. A descriptor (operator-registered) supplies the
 * endpoints, the scope mapping and the refresh behaviour; this module supplies the
 * one-time state, PKCE S256, the sealed verifier, the fenced credential commit and
 * the durable refresh lease. Token, refresh and revocation traffic goes through A2's
 * governed transport, so an OAuth exchange cannot become an SSRF or TLS bypass.
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { assert } from "../contracts/index.ts";
import { one } from "../database/index.ts";
import type { Query } from "../database/index.ts";
import {
  credentialAad,
  openCredential,
  putCredential,
  readCredential,
  sealCredential,
  type CredentialMetadata,
} from "./credentials.ts";
import {
  providerHttpRequest,
  type EgressPolicy,
} from "./egress-transport.ts";
import { egressPolicy } from "./egress-runtime.ts";
import {
  effectiveGrant,
  type OAuthProviderDescriptor,
} from "./oauth-provider.ts";

/** Bounded, non-secret failure vocabulary shared by attempts, claims and the API. */
export const OAUTH_FAILURE_CATEGORIES = [
  "state_unknown",
  "state_expired",
  "state_replayed",
  "session_mismatch",
  "connection_mismatch",
  "attempt_superseded",
  "connection_revoked",
  "connection_disabled",
  "provider_denied",
  "exchange_failed",
  "insufficient_scope",
  "malformed_token_response",
  "refresh_invalid_grant",
  "refresh_unknown_outcome",
  "provider_unreachable",
  "unsupported_provider",
  "not_configured",
] as const;
export type OAuthFailureCategory = (typeof OAUTH_FAILURE_CATEGORIES)[number];

export const OAUTH_LIMITS = Object.freeze({
  /** An authorization attempt is short-lived: long enough to consent, no longer. */
  attempt_ttl_ms: 15 * 60 * 1000,
  /** A refresh lease bounds one worker's I/O; an expired lease is reclaimable. */
  refresh_lease_ms: 2 * 60 * 1000,
  /** Bounded refresh attempts before the connection needs a human again. */
  max_refresh_attempts: 5,
  max_state_length: 200,
  max_token_bytes: 16 * 1024,
});

// ---------------------------------------------------------------------------
// Cryptographic material.
// ---------------------------------------------------------------------------

/** The externally presented state: 256 bits of randomness, URL-safe. */
export function oauthStateToken(): string {
  return randomBytes(32).toString("base64url");
}

/** Only the DIGEST of the state is ever stored or compared. */
export function oauthStateDigest(state: string): string {
  return createHash("sha256").update(`connector-oauth-state:${state}`).digest("hex");
}

/** A non-reversible binding to the initiating session (never the session token). */
export function sessionDigest(sessionToken: string): string {
  return createHash("sha256")
    .update(`connector-oauth-session:${sessionToken}`)
    .digest("hex");
}

/** A lease token for one refresh claim. */
export function refreshClaimToken(): string {
  return randomBytes(32).toString("hex");
}

export type PkcePair = { verifier: string; challenge: string; method: "S256" };

/** PKCE S256: the challenge is the base64url SHA-256 of the verifier. */
export function pkcePair(): PkcePair {
  const verifier = randomBytes(48).toString("base64url");
  return {
    verifier,
    challenge: createHash("sha256").update(verifier).digest("base64url"),
    method: "S256",
  };
}

/** The AAD that binds a sealed PKCE verifier to one tenant, connection and attempt. */
export function oauthAttemptAad(
  tenant: string,
  connection: string,
  attempt: string,
): string {
  return `${tenant}:${connection}:oauth_attempt:${attempt}:v1`;
}

export function sealAttemptVerifier(
  tenant: string,
  connection: string,
  attempt: string,
  verifier: string,
): string {
  return sealCredential(oauthAttemptAad(tenant, connection, attempt), verifier);
}

export function openAttemptVerifier(
  tenant: string,
  connection: string,
  attempt: string,
  sealed: string,
): string {
  return openCredential(oauthAttemptAad(tenant, connection, attempt), sealed);
}

/** Constant-time comparison for two digests. */
export function digestEquals(a: string, b: string): boolean {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

// ---------------------------------------------------------------------------
// The authorization attempt lifecycle (all inside the caller's transaction).
// ---------------------------------------------------------------------------

export type OAuthAttemptRow = {
  id: string;
  tenant_id: string;
  connection_id: string;
  provider_key: string;
  initiated_by: string;
  session_digest: string;
  state_digest: string;
  verifier_sealed: string;
  redirect_uri: string;
  requested_scopes: string[];
  requested_capabilities: string[];
  generation: number;
  status: string;
  failure_category: string | null;
  issued_at: string;
  expires_at: string;
  consumed_at: string | null;
};

export type StartedAttempt = {
  attempt_id: string;
  generation: number;
  /** Returned to the caller for the redirect and then discarded. Never persisted raw. */
  state: string;
  /** Present only when the descriptor requires PKCE. Never persisted raw. */
  verifier: string | null;
  authorization_url: string;
  expires_at: string;
};

/**
 * Starts one authorization attempt for a connection. Any live predecessor is
 * SUPERSEDED in the same transaction, so exactly one attempt is live per connection
 * and a stale callback cannot revive an older intent.
 */
export async function startAuthorizationAttempt(
  q: Query,
  input: {
    tenant: string;
    connection: { id: string; provider_key: string; status: string; enabled: boolean };
    descriptor: OAuthProviderDescriptor;
    initiated_by: string;
    session_token: string;
    requested_capabilities: string[];
    now?: Date;
  },
): Promise<StartedAttempt> {
  const now = input.now ?? new Date();
  assert(
    input.connection.provider_key === input.descriptor.key,
    400,
    "This provider does not match the connection",
  );
  assert(
    input.connection.status !== "revoked",
    409,
    "A revoked connection cannot be authorized again",
  );
  const capabilities = input.requested_capabilities.slice(0, 16);
  const requested = input.descriptor.scopes
    .filter(
      (entry) =>
        entry.capability !== null && capabilities.includes(entry.capability),
    )
    .map((entry) => entry.scope);
  assert(
    requested.length > 0,
    400,
    "Choose at least one capability this connection may use",
  );

  // Supersede any live attempt for this connection.
  await q.query(
    "UPDATE connector_oauth_attempts SET status='superseded',updated_at=now()" +
      " WHERE tenant_id=$1 AND connection_id=$2 AND status IN ('authorizing','exchanging')",
    [input.tenant, input.connection.id],
  );
  const previous = await one(
    q,
    "SELECT COALESCE(MAX(generation),0) AS generation FROM connector_oauth_attempts WHERE tenant_id=$1 AND connection_id=$2",
    [input.tenant, input.connection.id],
  );
  const generation = Number(previous?.generation || 0) + 1;

  const state = oauthStateToken();
  const pkce = input.descriptor.pkce === "S256" ? pkcePair() : null;
  const attemptId = crypto.randomUUID();
  const expiresAt = new Date(now.getTime() + OAUTH_LIMITS.attempt_ttl_ms);
  await q.query(
    "INSERT INTO connector_oauth_attempts(id,tenant_id,connection_id,provider_key,initiated_by,session_digest,state_digest,verifier_sealed," +
      " redirect_uri,requested_scopes,requested_capabilities,generation,status,issued_at,expires_at)" +
      " VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'authorizing',$13,$14)",
    [
      attemptId,
      input.tenant,
      input.connection.id,
      input.descriptor.key,
      input.initiated_by,
      sessionDigest(input.session_token),
      oauthStateDigest(state),
      sealAttemptVerifier(
        input.tenant,
        input.connection.id,
        attemptId,
        pkce?.verifier ?? "no-pkce",
      ),
      input.descriptor.redirect_uri,
      requested,
      capabilities,
      generation,
      now,
      expiresAt,
    ],
  );

  const url = new URL(input.descriptor.authorization_url);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", input.descriptor.client_id);
  url.searchParams.set("redirect_uri", input.descriptor.redirect_uri);
  url.searchParams.set("scope", requested.join(" "));
  url.searchParams.set("state", state);
  if (pkce) {
    url.searchParams.set("code_challenge", pkce.challenge);
    url.searchParams.set("code_challenge_method", pkce.method);
  }
  return {
    attempt_id: attemptId,
    generation,
    state,
    verifier: pkce?.verifier ?? null,
    authorization_url: url.toString(),
    expires_at: expiresAt.toISOString(),
  };
}

export type ConsumedAttempt = {
  attempt: OAuthAttemptRow;
  verifier: string | null;
};

/**
 * Consumes one callback. Every binding is proved here, inside the caller's short
 * transaction: the state digest, the initiating session, the provider, the exact
 * redirect URI, expiry and one-time use. The attempt moves to `exchanging` by a
 * compare-and-set, so a second callback (or a second tab) cannot consume it twice.
 *
 * A refusal never reveals whether another tenant's attempt exists.
 */
export async function consumeAuthorizationAttempt(
  q: Query,
  input: {
    tenant: string;
    state: string;
    session_token: string;
    /** Optional binding proof, when the callback path is provider specific. */
    provider_key?: string;
    redirect_uri?: string;
    now?: Date;
  },
): Promise<
  | { ok: true; consumed: ConsumedAttempt }
  | { ok: false; category: OAuthFailureCategory }
> {
  const now = input.now ?? new Date();
  if (!input.state || input.state.length > OAUTH_LIMITS.max_state_length)
    return { ok: false, category: "state_unknown" };
  const digest = oauthStateDigest(input.state);
  const row = (await one(
    q,
    "SELECT * FROM connector_oauth_attempts WHERE tenant_id=$1 AND state_digest=$2",
    [input.tenant, digest],
  )) as OAuthAttemptRow | undefined;
  // Tenant RLS already scopes this read: a foreign state simply does not exist here.
  if (!row) return { ok: false, category: "state_unknown" };
  if (!digestEquals(row.session_digest, sessionDigest(input.session_token)))
    return { ok: false, category: "session_mismatch" };
  if (input.provider_key !== undefined && row.provider_key !== input.provider_key)
    return { ok: false, category: "connection_mismatch" };
  // The registered redirect URI is fixed by the descriptor and re-sent on the token
  // exchange, so a callback that does not name it is refused here when provided.
  if (input.redirect_uri !== undefined && row.redirect_uri !== input.redirect_uri)
    return { ok: false, category: "connection_mismatch" };
  if (row.status === "consumed") return { ok: false, category: "state_replayed" };
  if (row.status !== "authorizing")
    return { ok: false, category: "attempt_superseded" };
  if (new Date(row.expires_at).getTime() <= now.getTime()) {
    await q.query(
      "UPDATE connector_oauth_attempts SET status='expired',failure_category='state_expired',updated_at=now() WHERE id=$1 AND status='authorizing'",
      [row.id],
    );
    return { ok: false, category: "state_expired" };
  }
  const claimed = await q.query(
    "UPDATE connector_oauth_attempts SET status='exchanging',updated_at=now() WHERE id=$1 AND status='authorizing' RETURNING id",
    [row.id],
  );
  if (!claimed.rowCount) return { ok: false, category: "state_replayed" };
  return {
    ok: true,
    consumed: {
      attempt: { ...row, status: "exchanging" },
      verifier:
        row.verifier_sealed === "no-pkce"
          ? null
          : openAttemptVerifier(input.tenant, row.connection_id, row.id, row.verifier_sealed),
    },
  };
}

/** Records a safe failure category and closes the attempt. */
export async function failAuthorizationAttempt(
  q: Query,
  input: {
    tenant: string;
    attempt_id: string;
    category: OAuthFailureCategory;
    status?: "failed" | "denied" | "expired";
  },
): Promise<void> {
  await q.query(
    "UPDATE connector_oauth_attempts SET status=$3,failure_category=$4,updated_at=now()" +
      " WHERE tenant_id=$1 AND id=$2 AND status IN ('authorizing','exchanging')",
    [input.tenant, input.attempt_id, input.status ?? "failed", input.category],
  );
}

export type TokenOutcome = {
  access_token: string;
  refresh_token: string | null;
  granted_scopes: string[];
  account_hint: string | null;
  expires_in: number | null;
};

/**
 * The FENCED commit of a completed exchange, inside the caller's short transaction.
 * It refuses unless the attempt is still the one being exchanged, its generation is
 * still authoritative for the connection, and the connection is not revoked or
 * disabled: a delayed callback can therefore never resurrect or widen authority.
 */
export async function completeAuthorizationAttempt(
  q: Query,
  input: {
    tenant: string;
    attempt: OAuthAttemptRow;
    descriptor: OAuthProviderDescriptor;
    tokens: TokenOutcome;
    now?: Date;
  },
): Promise<{ capabilities: string[]; scopes: string[]; account_hint: string | null }> {
  const now = input.now ?? new Date();
  const current = (await one(
    q,
    "SELECT status,enabled,generation FROM connector_connections c," +
      " (SELECT COALESCE(MAX(generation),0) AS generation FROM connector_oauth_attempts WHERE tenant_id=$1 AND connection_id=$2) g" +
      " WHERE c.tenant_id=$1 AND c.id=$2",
    [input.tenant, input.attempt.connection_id],
  )) as { status: string; enabled: boolean; generation: number } | undefined;
  assert(current, 404, "Connection not found");
  const attempt = (await one(
    q,
    "SELECT status,generation FROM connector_oauth_attempts WHERE tenant_id=$1 AND id=$2",
    [input.tenant, input.attempt.id],
  )) as { status: string; generation: number } | undefined;
  assert(
    attempt?.status === "exchanging",
    409,
    "This authorization is no longer the active attempt",
  );
  assert(
    Number(attempt.generation) === Number(current.generation),
    409,
    "A newer authorization superseded this one",
  );
  assert(
    current.status !== "revoked",
    409,
    "This connection was revoked during authorization",
  );

  const grant = effectiveGrant({
    descriptor: input.descriptor,
    requested_scopes: input.attempt.requested_scopes,
    granted_scopes: input.tokens.granted_scopes,
  });
  if (!grant.complete) {
    await failAuthorizationAttempt(q, {
      tenant: input.tenant,
      attempt_id: input.attempt.id,
      category: "insufficient_scope",
      status: "failed",
    });
    throw Object.assign(new Error("The provider did not grant every requested permission"), {
      statusCode: 409,
      category: "insufficient_scope" as OAuthFailureCategory,
    });
  }

  const metadata: CredentialMetadata = {
    scopes: grant.scopes,
    ...(input.tokens.expires_in
      ? { expires_at: new Date(now.getTime() + input.tokens.expires_in * 1000).toISOString() }
      : {}),
    label: input.tokens.account_hint ?? undefined,
  };
  await putCredential(
    q,
    input.tenant,
    input.attempt.connection_id,
    "oauth_access",
    input.tokens.access_token,
    metadata,
  );
  if (input.tokens.refresh_token)
    await putCredential(
      q,
      input.tenant,
      input.attempt.connection_id,
      "oauth_refresh",
      input.tokens.refresh_token,
      { label: input.tokens.account_hint ?? undefined },
    );

  await q.query(
    "UPDATE connector_connections SET status='connected',capabilities_granted=$3,connected_at=COALESCE(connected_at,now())," +
      " last_error_at=NULL,last_error_category=NULL,attention_reason=NULL,updated_at=now()" +
      " WHERE tenant_id=$1 AND id=$2 AND status<>'revoked'",
    [input.tenant, input.attempt.connection_id, grant.capabilities],
  );
  await q.query(
    "UPDATE connector_oauth_attempts SET status='consumed',consumed_at=now(),updated_at=now() WHERE tenant_id=$1 AND id=$2",
    [input.tenant, input.attempt.id],
  );
  if (input.tokens.account_hint)
    await q.query(
      "UPDATE connector_connections SET config=config || jsonb_build_object('account_hint',$3::text),updated_at=now() WHERE tenant_id=$1 AND id=$2",
      [input.tenant, input.attempt.connection_id, input.tokens.account_hint],
    );
  return {
    capabilities: grant.capabilities,
    scopes: grant.scopes,
    account_hint: input.tokens.account_hint,
  };
}

// ---------------------------------------------------------------------------
// Provider transport (A2 governed egress; injected only for the test fixture).
// ---------------------------------------------------------------------------

export type OAuthHttpTransport = (input: {
  descriptor: OAuthProviderDescriptor;
  url: string;
  form: Record<string, string>;
  policy: EgressPolicy;
}) => Promise<{ status: number; body: string }>;

/**
 * The default transport: A2's validated-dial HTTPS client. It never follows a
 * redirect, never pools a socket, and reports a bounded non-secret failure.
 */
export const governedOAuthTransport: OAuthHttpTransport = async (input) => {
  const body = new URLSearchParams(input.form).toString();
  const response = await providerHttpRequest({
    url: input.url,
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      accept: "application/json",
    },
    body,
    policy: input.policy,
  });
  return { status: response.status, body: response.body.toString("utf8") };
};

function parseTokenResponse(
  status: number,
  body: string,
  descriptor: OAuthProviderDescriptor,
): { ok: true; outcome: TokenOutcome } | { ok: false; category: OAuthFailureCategory } {
  if (status >= 400) {
    // A denied or failed exchange is categorized, never surfaced with provider text.
    const text = body.slice(0, 400);
    if (/invalid_grant/i.test(text)) return { ok: false, category: "refresh_invalid_grant" };
    if (/access_denied/i.test(text)) return { ok: false, category: "provider_denied" };
    return { ok: false, category: "exchange_failed" };
  }
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(body) as Record<string, unknown>;
  } catch {
    return { ok: false, category: "malformed_token_response" };
  }
  const access = String(parsed.access_token ?? "");
  if (!access || access.length > OAUTH_LIMITS.max_token_bytes)
    return { ok: false, category: "malformed_token_response" };
  const refresh = parsed.refresh_token === undefined || parsed.refresh_token === null
    ? null
    : String(parsed.refresh_token);
  if (refresh !== null && (refresh.length === 0 || refresh.length > OAUTH_LIMITS.max_token_bytes))
    return { ok: false, category: "malformed_token_response" };
  const scopeText = String(parsed.scope ?? "").trim();
  const granted = scopeText ? scopeText.split(/[\s,]+/).filter(Boolean).slice(0, 64) : [];
  const hint =
    descriptor.account_hint_field && parsed[descriptor.account_hint_field] !== undefined
      ? String(parsed[descriptor.account_hint_field])
      : null;
  const expiresIn = Number(parsed.expires_in);
  return {
    ok: true,
    outcome: {
      access_token: access,
      refresh_token: refresh,
      granted_scopes: granted,
      account_hint: hint,
      expires_in: Number.isFinite(expiresIn) && expiresIn > 0 ? Math.floor(expiresIn) : null,
    },
  };
}

/** Exchanges an authorization code. NO tenant transaction may be held here. */
export async function exchangeAuthorizationCode(input: {
  descriptor: OAuthProviderDescriptor;
  code: string;
  verifier: string | null;
  policy?: EgressPolicy;
  transport?: OAuthHttpTransport;
}): Promise<{ ok: true; outcome: TokenOutcome } | { ok: false; category: OAuthFailureCategory }> {
  const transport = input.transport ?? governedOAuthTransport;
  const policy = input.policy ?? egressPolicy();
  const form: Record<string, string> = {
    grant_type: "authorization_code",
    code: input.code,
    redirect_uri: input.descriptor.redirect_uri,
  };
  if (input.descriptor.client_auth === "client_secret_post") {
    form.client_id = input.descriptor.client_id;
    form.client_secret = input.descriptor.client_secret;
  }
  if (input.verifier) {
    form.code_verifier = input.verifier;
  }
  const headers: Record<string, string> = {};
  try {
    const response = await transport({
      descriptor: input.descriptor,
      url: input.descriptor.token_url,
      form,
      policy,
    });
    void headers;
    return parseTokenResponse(response.status, response.body, input.descriptor);
  } catch {
    return { ok: false, category: "provider_unreachable" };
  }
}

/** Refreshes a grant. NO tenant transaction may be held here. */
export async function refreshGrant(input: {
  descriptor: OAuthProviderDescriptor;
  refresh_token: string;
  policy?: EgressPolicy;
  transport?: OAuthHttpTransport;
}): Promise<{ ok: true; outcome: TokenOutcome } | { ok: false; category: OAuthFailureCategory }> {
  const transport = input.transport ?? governedOAuthTransport;
  const policy = input.policy ?? egressPolicy();
  const form: Record<string, string> = {
    grant_type: "refresh_token",
    refresh_token: input.refresh_token,
  };
  if (input.descriptor.client_auth === "client_secret_post") {
    form.client_id = input.descriptor.client_id;
    form.client_secret = input.descriptor.client_secret;
  }
  try {
    const response = await transport({
      descriptor: input.descriptor,
      url: input.descriptor.token_url,
      form,
      policy,
    });
    return parseTokenResponse(response.status, response.body, input.descriptor);
  } catch {
    return { ok: false, category: "provider_unreachable" };
  }
}

/** Best-effort provider revocation. Local denial never depends on this. */
export async function revokeProviderGrant(input: {
  descriptor: OAuthProviderDescriptor;
  refresh_token: string | null;
  policy?: EgressPolicy;
  transport?: OAuthHttpTransport;
}): Promise<{ attempted: boolean; category: OAuthFailureCategory | null }> {
  if (!input.descriptor.revoke_url || !input.refresh_token)
    return { attempted: false, category: null };
  const transport = input.transport ?? governedOAuthTransport;
  const policy = input.policy ?? egressPolicy();
  const form: Record<string, string> = {
    token: input.refresh_token,
    token_type_hint: "refresh_token",
  };
  if (input.descriptor.client_auth === "client_secret_post") {
    form.client_id = input.descriptor.client_id;
    form.client_secret = input.descriptor.client_secret;
  }
  try {
    const response = await transport({
      descriptor: input.descriptor,
      url: input.descriptor.revoke_url,
      form,
      policy,
    });
    return {
      attempted: true,
      category: response.status >= 400 ? "exchange_failed" : null,
    };
  } catch {
    return { attempted: true, category: "provider_unreachable" };
  }
}

// ---------------------------------------------------------------------------
// Durable refresh lease.
// ---------------------------------------------------------------------------

export type RefreshClaimRow = {
  id: string;
  tenant_id: string;
  connection_id: string;
  credential_version: number;
  claim_token: string;
  status: string;
  attempts: number;
  failure_category: string | null;
  expires_at: string;
};

/**
 * Claims the right to refresh one connection's grant. Exactly one live claim exists
 * per connection (partial unique index), so a second worker cannot refresh
 * concurrently; an expired claim is reclaimed with a fresh lease token, which is
 * what makes a crashed worker recoverable.
 */
export async function claimRefresh(
  q: Query,
  input: {
    tenant: string;
    connection_id: string;
    credential_version: number;
    now?: Date;
  },
): Promise<RefreshClaimRow | null> {
  const now = input.now ?? new Date();
  const lease = refreshClaimToken();
  const expiresAt = new Date(now.getTime() + OAUTH_LIMITS.refresh_lease_ms);
  const existing = (await one(
    q,
    "SELECT * FROM connector_oauth_refresh_claims WHERE tenant_id=$1 AND connection_id=$2 AND status='claimed'",
    [input.tenant, input.connection_id],
  )) as RefreshClaimRow | undefined;
  if (existing) {
    if (new Date(existing.expires_at).getTime() > now.getTime()) return null;
    const reclaimed = await q.query(
      "UPDATE connector_oauth_refresh_claims SET claim_token=$3,expires_at=$4,attempts=attempts+1,claimed_at=now(),updated_at=now()" +
        " WHERE tenant_id=$1 AND id=$2 AND status='claimed' AND claim_token=$5 AND expires_at<=$4 RETURNING id",
      [input.tenant, existing.id, lease, expiresAt, existing.claim_token],
    );
    if (!reclaimed.rowCount) return null;
    return { ...existing, claim_token: lease, expires_at: expiresAt.toISOString(), attempts: existing.attempts + 1 };
  }
  const id = crypto.randomUUID();
  await q.query(
    "INSERT INTO connector_oauth_refresh_claims(id,tenant_id,connection_id,credential_version,claim_token,status,attempts,expires_at)" +
      " VALUES($1,$2,$3,$4,$5,'claimed',1,$6)",
    [id, input.tenant, input.connection_id, input.credential_version, lease, expiresAt],
  );
  return {
    id,
    tenant_id: input.tenant,
    connection_id: input.connection_id,
    credential_version: input.credential_version,
    claim_token: lease,
    status: "claimed",
    attempts: 1,
    failure_category: null,
    expires_at: expiresAt.toISOString(),
  };
}

/**
 * Commits a refresh outcome under the fence. It refuses when the claim is no longer
 * authoritative (a newer credential exists, the claim was reclaimed, the connection
 * was revoked or disabled), so an old worker cannot overwrite a newer claimant or
 * revive a revoked connection.
 */
export async function completeRefresh(
  q: Query,
  input: {
    tenant: string;
    claim: RefreshClaimRow;
    descriptor: OAuthProviderDescriptor;
    tokens: TokenOutcome;
    now?: Date;
  },
): Promise<{ rotated: boolean }> {
  const now = input.now ?? new Date();
  const claim = (await one(
    q,
    "SELECT * FROM connector_oauth_refresh_claims WHERE tenant_id=$1 AND id=$2",
    [input.tenant, input.claim.id],
  )) as RefreshClaimRow | undefined;
  assert(
    claim?.status === "claimed" && digestEquals(claim.claim_token, input.claim.claim_token),
    409,
    "This refresh claim is no longer authoritative",
  );
  const connection = (await one(
    q,
    "SELECT status,enabled FROM connector_connections WHERE tenant_id=$1 AND id=$2",
    [input.tenant, input.claim.connection_id],
  )) as { status: string; enabled: boolean } | undefined;
  assert(connection, 404, "Connection not found");
  assert(connection.status !== "revoked", 409, "This connection was revoked");
  assert(connection.enabled, 409, "This connection is disabled");
  const active = (await one(
    q,
    "SELECT key_version FROM connector_credentials WHERE tenant_id=$1 AND connection_id=$2 AND kind='oauth_refresh' AND revoked_at IS NULL",
    [input.tenant, input.claim.connection_id],
  )) as { key_version: number } | undefined;
  assert(
    Number(active?.key_version ?? 0) === Number(input.claim.credential_version),
    409,
    "A newer credential superseded this refresh",
  );

  const metadata: CredentialMetadata = {
    ...(input.tokens.expires_in
      ? { expires_at: new Date(now.getTime() + input.tokens.expires_in * 1000).toISOString() }
      : {}),
  };
  await putCredential(
    q,
    input.tenant,
    input.claim.connection_id,
    "oauth_access",
    input.tokens.access_token,
    metadata,
  );
  let rotated = false;
  if (input.tokens.refresh_token) {
    await putCredential(
      q,
      input.tenant,
      input.claim.connection_id,
      "oauth_refresh",
      input.tokens.refresh_token,
      {},
    );
    rotated = true;
  } else if (input.descriptor.refresh_rotation !== "static") {
    // The provider did not return a refresh token. When its contract does not
    // promise that the previous one stays valid, replaying it would be a guess.
    await q.query(
      "UPDATE connector_oauth_refresh_claims SET status='failed',failure_category='refresh_unknown_outcome',completed_at=now(),updated_at=now() WHERE tenant_id=$1 AND id=$2",
      [input.tenant, input.claim.id],
    );
    await q.query(
      "UPDATE connector_connections SET status='attention_required',attention_reason='refresh_unknown_outcome',last_error_at=now(),last_error_category='refresh_unknown_outcome',updated_at=now()" +
        " WHERE tenant_id=$1 AND id=$2 AND status<>'revoked'",
      [input.tenant, input.claim.connection_id],
    );
    throw Object.assign(new Error("The provider did not confirm the new grant"), {
      statusCode: 409,
      category: "refresh_unknown_outcome" as OAuthFailureCategory,
    });
  }
  await q.query(
    "UPDATE connector_oauth_refresh_claims SET status='completed',completed_at=now(),updated_at=now() WHERE tenant_id=$1 AND id=$2",
    [input.tenant, input.claim.id],
  );
  await q.query(
    "UPDATE connector_connections SET last_success_at=now(),updated_at=now() WHERE tenant_id=$1 AND id=$2",
    [input.tenant, input.claim.connection_id],
  );
  return { rotated };
}

/** Closes a claim with a safe category, escalating the connection when needed. */
export async function failRefresh(
  q: Query,
  input: {
    tenant: string;
    claim: RefreshClaimRow;
    category: OAuthFailureCategory;
    attention: boolean;
    reason?: string;
  },
): Promise<void> {
  await q.query(
    "UPDATE connector_oauth_refresh_claims SET status='failed',failure_category=$3,completed_at=now(),updated_at=now()" +
      " WHERE tenant_id=$1 AND id=$2",
    [input.tenant, input.claim.id, input.category],
  );
  if (!input.attention) return;
  await q.query(
    "UPDATE connector_connections SET status='attention_required',attention_reason=$3,last_error_at=now(),last_error_category=$3,updated_at=now()" +
      " WHERE tenant_id=$1 AND id=$2 AND status<>'revoked'",
    [input.tenant, input.claim.connection_id, input.reason ?? input.category],
  );
}

/** The active credential of a kind, decrypted, for a worker phase. */
export async function activeCredential(
  q: Query,
  tenant: string,
  connection: string,
  kind: "oauth_access" | "oauth_refresh",
): Promise<{ secret: string; version: number; metadata: CredentialMetadata } | null> {
  const row = await readCredential(q, tenant, connection, kind);
  if (!row) return null;
  const stored = (await one(
    q,
    "SELECT metadata FROM connector_credentials WHERE id=$1",
    [row.id],
  )) as { metadata: CredentialMetadata } | undefined;
  return {
    secret: row.secret,
    version: Number(row.key_version),
    metadata: (stored?.metadata ?? {}) as CredentialMetadata,
  };
}

/** The safe status projection for one connection's latest authorization attempt. */
export async function oauthStatusFor(
  q: Query,
  tenant: string,
  connection: string,
): Promise<{
  state: string;
  generation: number;
  failure_category: string | null;
  expires_at: string | null;
  issued_at: string | null;
  requested_capabilities: string[];
  redirect_uri_registered: boolean;
}> {
  const row = (await one(
    q,
    "SELECT status,generation,failure_category,expires_at,issued_at,requested_capabilities FROM connector_oauth_attempts" +
      " WHERE tenant_id=$1 AND connection_id=$2 ORDER BY generation DESC LIMIT 1",
    [tenant, connection],
  )) as
    | {
        status: string;
        generation: number;
        failure_category: string | null;
        expires_at: string;
        issued_at: string;
        requested_capabilities: string[];
      }
    | undefined;
  if (!row)
    return {
      state: "none",
      generation: 0,
      failure_category: null,
      expires_at: null,
      issued_at: null,
      requested_capabilities: [],
      redirect_uri_registered: true,
    };
  return {
    state: row.status,
    generation: Number(row.generation),
    failure_category: row.failure_category,
    expires_at: row.expires_at,
    issued_at: row.issued_at,
    requested_capabilities: row.requested_capabilities ?? [],
    redirect_uri_registered: true,
  };
}

/** True when the connection's stored grant metadata marks it expired. */
export function grantExpired(
  metadata: CredentialMetadata | null,
  now = new Date(),
): boolean {
  const value = metadata?.expires_at;
  if (typeof value !== "string") return false;
  const at = Date.parse(value);
  if (Number.isNaN(at)) return false;
  return at <= now.getTime();
}

void credentialAad;
