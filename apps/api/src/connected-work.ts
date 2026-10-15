/**
 * W29-A / W30-A: HTTP surface for Connected Work and deterministic automations.
 *
 * Two properties drive the shape of this module:
 *
 * 1. Nothing here returns credential material. Connector status is projected
 *    through `publicConnection()`, whose only credential-adjacent content is the
 *    sanitized metadata allowlist, and the ingress route answers uniformly so a
 *    caller cannot use it to enumerate connections.
 * 2. Authorization is explicit per route. Connector management and automation
 *    authoring are HUMAN session features in this tranche: a service token is
 *    refused rather than inheriting the privilege of whichever user minted it.
 *    Tenant isolation itself is the database's job (`db.tenant` sets
 *    `app.tenant_id`, every new table is FORCE ROW LEVEL SECURITY).
 */
import { z } from "zod";
import type { FastifyInstance } from "fastify";
import { assert, HttpError } from "../../../packages/contracts/index.ts";
import type { Database, Query } from "../../../packages/database/index.ts";
import { one } from "../../../packages/database/index.ts";
import { randomUUID } from "node:crypto";
import type { Actor } from "../../../packages/auth/index.ts";
import {
  CREDENTIAL_METADATA_KEYS,
  OAUTH_TEST_PROVIDER_KEY,
  completeAuthorizationAttempt,
  consumeAuthorizationAttempt,
  exchangeAuthorizationCode,
  failAuthorizationAttempt,
  oauthDescriptorFor,
  oauthRegistry,
  issueTestCode,
  activeCredential,
  oauthStatusFor,
  providerKeys,
  revokeProviderGrant,
  registerOAuthTestProvider,
  resetOAuthTestProvider,
  startAuthorizationAttempt,
  testOAuthTransport,
  EGRESS_PREFLIGHT_PORTS,
  PREFLIGHT_USE_CASES,
  adapterFor,
  buildConnectionConfig,
  adapterImplemented,
  canManageConnection,
  canReadConnection,
  CAPABILITY_CATEGORY,
  CAPABILITY_VOCABULARY_VERSION,
  CONNECTOR_CAPABILITIES,
  CONNECTOR_LIMITS,
  connectionActionFacts,
  connectorMetricsForTenant,
  createConnection,
  credentialsFor,
  declaredProviders,
  getConnection,
  ingestProviderEvent,
  isCapability,
  isTenantAdministrator,
  listConnections,
  normalizeCapabilities,
  preflightEndpoint,
  providerCatalog,
  providerDefinition,
  revokeConnection,
  rotateConnectionCredential,
  connectConnection,
  setConnectionEnabled,
  testConnection,
  type Capability,
} from "../../../packages/connectors/index.ts";
import {
  actionCatalog,
  cancelRun,
  createWorkflow,
  deleteWorkflow,
  disableWorkflow,
  enableWorkflow,
  engineTick,
  getRunDetail,
  getWorkflowDetail,
  deprovisionServicePrincipal,
  dispatchConnectorEvent,
  getServicePrincipal,
  listRuns,
  listWorkflows,
  provisionServicePrincipal,
  pruneRuns,
  retryRun,
  saveDraft,
  scheduleTick,
  triggerCatalog,
  triggerManualRun,
  validateDraft,
  WORKFLOW_LIMITS,
  workflowMetricsForTenant,
  CONDITION_OPERATORS,
  type ConnectorActionPort,
} from "../../../packages/automation/index.ts";

type Handler = (q: Query, a: Actor, r: any, reply: any) => Promise<any>;
export type ConnectedWorkRoute = (
  m: "GET" | "POST" | "PATCH" | "DELETE",
  p: string,
  summary: string,
  h: Handler,
  s?: string,
  limits?: { max: number; timeWindow: string },
) => void;

/**
 * W29-P0/A2: the seam for a route that must NOT hold a tenant transaction across
 * network work. The route wrapper opens no transaction of its own; the handler
 * opens short-lived tenant transactions through `run` for authorization and lets
 * them go before it resolves anything, so a slow resolver cannot occupy a pool
 * connection. The actor still comes from the authenticated session, so tenant
 * identity cannot be spoofed through the seam.
 */
export type TenantSeam = {
  run: <T>(fn: (q: Query) => Promise<T>) => Promise<T>;
  /**
   * The initiating browser session's token. It is used ONLY to derive the
   * non-reversible session digest an authorization attempt is bound to; it is never
   * stored, returned or logged.
   */
  session_token: string;
};

export type ConnectedWorkSeamRoute = (
  m: "GET" | "POST",
  p: string,
  summary: string,
  h: (seam: TenantSeam, a: Actor, r: any, reply: any) => Promise<any>,
  options: {
    rateLimit: { max: number; timeWindow: string };
    /**
     * W29-P0/A3: the route's own log level. The OAuth callback sets `silent`, because
     * a request log line for it would contain the authorization code and the state in
     * the URL; the handler logs a bounded, non-secret outcome instead.
     */
    log?: { level: string };
  },
) => void;

/**
 * W29-P0/A2: the authoritative validation for a connection configuration. The guided
 * form uses the same builder in the browser; this is where a value is accepted, so a
 * request built by anything else is held to exactly the same contract and nothing is
 * silently dropped.
 */
function validateConnectionConfig(
  config: Record<string, unknown>,
): Record<string, unknown> {
  const built = buildConnectionConfig({
    advanced_json: JSON.stringify(config ?? {}),
    allowed_keys: CREDENTIAL_METADATA_KEYS,
  });
  assert(built.ok, 400, built.ok ? "" : built.error);
  return built.ok ? built.config : {};
}

/** The live membership and role check, re-read from the database. */
async function assertActiveAdministrator(
  q: Query,
  actor: Pick<Actor, "tenant_id" | "user_id" | "role">,
): Promise<void> {
  const row = await one(
    q,
    "SELECT role, active FROM memberships WHERE tenant_id=$1 AND user_id=$2",
    [actor.tenant_id, actor.user_id],
  );
  assert(
    Boolean(row) &&
      row.active === true &&
      ["owner", "admin"].includes(String(row.role)),
    403,
    "Administrator access required to check provider endpoints",
  );
}

/** Connector management and automation authoring are human-session features. */
function humanSession(a: Actor): void {
  assert(!a.scopes, 403, "Connector management requires a signed-in session");
}

/**
 * Tenant operational counters and the tenant automation identity are owner/admin
 * surfaces. A plain member's own connections and workflows stay untouched.
 */
function operationalMetrics(a: Actor): void {
  assert(
    isTenantAdministrator(a),
    403,
    "Administrator access required for workspace operational metrics",
  );
}

const UUID = z.string().uuid();
const connectionParam = (r: any) => UUID.parse(r.params.id);

const connectionBody = z.object({
  provider_key: z.string().min(1).max(64),
  label: z.string().min(1).max(120),
  ownership: z.enum(["user", "tenant"]),
  config: z.record(z.string(), z.any()).optional(),
  capabilities: z.array(z.string()).max(CONNECTOR_CAPABILITIES.length).optional(),
});

const secretBody = z.object({
  secret: z.string().min(16).max(4096),
  metadata: z.record(z.string(), z.any()).optional(),
});

const enabledBody = z.object({ enabled: z.boolean() });

const oauthStartBody = z
  .object({
    capabilities: z.array(z.string()).max(16).optional().default([]),
  })
  .strict();

/**
 * The transport for one descriptor. Production uses A2's governed HTTPS client; the
 * acceptance fixture is answered in-process, and it exists only when the deployment
 * enabled test wiring (which production refuses at load).
 */
function oauthTransportFor(descriptor: { key: string; test_only: boolean }) {
  if (descriptor.test_only) {
    assert(
      descriptor.key === OAUTH_TEST_PROVIDER_KEY,
      500,
      "Only the acceptance provider may use the acceptance transport",
    );
    return testOAuthTransport(descriptor as never);
  }
  return undefined;
}

const preflightBody = z
  .object({
    // Bounded before it ever reaches the resolver: a long or control-character
    // hostname is a request-shape error, not a policy question.
    host: z.string().min(1).max(253),
    port: z.number().int().min(1).max(65535),
    // The use case is not decoration: it selects the port vocabulary the check may
    // consider and the guidance the answer carries back to the administrator.
    use_case: z.enum(PREFLIGHT_USE_CASES).optional(),
  })
  .strict();

/**
 * The connector action port the deterministic engine consumes. It reads live
 * connection state and refuses anything ambiguous, so a revoked or disabled
 * connection fails closed, and a delegated connection used by any authority other
 * than its owner is denied.
 */
export function connectorActionPortFor(q: Query): ConnectorActionPort {
  return {
    async inspect({ tenant_id, connection_id, actor_role, user_id }) {
      // W29-P0/A1: one implementation of the live connection facts, shared with
      // the external-effect worker phase that re-checks them immediately before
      // provider I/O.
      const facts = await connectionActionFacts(q, tenant_id, connection_id);
      if (!facts) return null;
      void actor_role;
      void user_id;
      return facts;
    },
  };
}

/** Bounded, non-secret view of recent connector events. */
async function recentEvents(q: Query, tenant: string, connectionId: string) {
  return (
    await q.query(
      "SELECT id,event_type,provider_event_id,verification,received_at,provider_occurred_at," +
        " duplicate_count,dispatch_state,payload_ref,normalized_resource_refs" +
        " FROM connector_events WHERE tenant_id=$1 AND connection_id=$2" +
        " ORDER BY received_at DESC,id DESC LIMIT 25",
      [tenant, connectionId],
    )
  ).rows;
}

/**
 * Every route here runs inside `db.tenant(actor.tenant_id, ...)`, supplied by the
 * app builder's `route` helper, so tenant context and FORCE RLS are already active
 * and no route needs the pool directly. The only place that does is the
 * unauthenticated ingress registration below, which resolves its tenant through a
 * SECURITY DEFINER lookup.
 */
/**
 * W29-P0/A3: installs the deterministic acceptance OAuth provider. The caller is the
 * deployment's startup path, and it only calls this when the environment enables test
 * wiring: `loadOAuthRegistry` refuses that in production, and this function is never
 * reached there, so a production deployment has no fake provider key, descriptor,
 * adapter or browser route.
 */
export function enableOAuthTestProvider(): void {
  // Idempotent: a process may build more than one application (tests, workers).
  if (!providerKeys().includes(OAUTH_TEST_PROVIDER_KEY)) registerOAuthTestProvider();
  resetOAuthTestProvider();
}

/**
 * The acceptance provider's BROWSER half: a real consent page the administrator is
 * redirected to, with Approve and Deny. It is mounted only when the deployment
 * enabled test wiring (production refuses that at load), it validates every
 * parameter against the registered descriptor, and it never redirects anywhere but
 * the exact registered callback, so it cannot become an open redirect.
 */
export function registerOAuthTestProviderRoutes(app: FastifyInstance): void {
  const escape = (value: string) =>
    value.replace(/[&<>"']/g, (character) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]!,
    );

  app.get("/api/v1/oauth-test/authorize", async (r, reply) => {
    const descriptor = oauthDescriptorFor(OAUTH_TEST_PROVIDER_KEY);
    if (!descriptor) return reply.code(404).send("Not available");
    const query = (r.query ?? {}) as Record<string, string>;
    if (
      String(query.client_id ?? "") !== descriptor.client_id ||
      String(query.redirect_uri ?? "") !== descriptor.redirect_uri ||
      String(query.response_type ?? "") !== "code" ||
      String(query.code_challenge_method ?? "") !== "S256" ||
      !String(query.code_challenge ?? "") ||
      !String(query.state ?? "")
    )
      return reply.code(400).send("This authorization request is not registered");
    const scopes = String(query.scope ?? "")
      .split(/\s+/)
      .filter(Boolean)
      .filter((scope) => descriptor.scopes.some((entry) => entry.scope === scope));
    if (!scopes.length) return reply.code(400).send("No registered scope was requested");
    const hidden = [
      "client_id",
      "redirect_uri",
      "response_type",
      "code_challenge",
      "code_challenge_method",
      "state",
      "scope",
    ]
      .map(
        (name) =>
          `<input type="hidden" name="${name}" value="${escape(String(query[name] ?? ""))}" />`,
      )
      .join("\n      ");
    return reply
      .type("text/html; charset=utf-8")
      .send(`<!doctype html>
<html lang="en">
<head><meta charset="utf-8" /><meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Acceptance OAuth provider (test only)</title></head>
<body>
<main>
  <h1>Acceptance OAuth provider</h1>
  <p>This page is part of the deterministic acceptance fixture. It is not a real provider and it exists only when a deployment explicitly enables test wiring.</p>
  <p><strong>Workspace is asking for:</strong> ${scopes.map(escape).join(", ")}</p>
  <p><strong>Account:</strong> operations@example.test</p>
  <form method="post" action="/api/v1/oauth-test/approve">
      ${hidden}
    <button type="submit" name="decision" value="approve">Approve</button>
    <button type="submit" name="decision" value="deny">Deny</button>
  </form>
</main>
</body>
</html>`);
  });

  app.post("/api/v1/oauth-test/approve", async (r, reply) => {
    const descriptor = oauthDescriptorFor(OAUTH_TEST_PROVIDER_KEY);
    if (!descriptor) return reply.code(404).send("Not available");
    const body = (r.body ?? {}) as Record<string, string>;
    if (
      String(body.client_id ?? "") !== descriptor.client_id ||
      String(body.redirect_uri ?? "") !== descriptor.redirect_uri ||
      String(body.code_challenge_method ?? "") !== "S256" ||
      !String(body.code_challenge ?? "")
    )
      return reply.code(400).send("This authorization request is not registered");
    const state = String(body.state ?? "");
    if (!state) return reply.code(400).send("A state is required");
    const scopes = String(body.scope ?? "")
      .split(/\s+/)
      .filter(Boolean)
      .filter((scope) => descriptor.scopes.some((entry) => entry.scope === scope));
    const redirect = new URL(descriptor.redirect_uri);
    if (String(body.decision ?? "") !== "approve") {
      redirect.searchParams.set("error", "access_denied");
      redirect.searchParams.set("state", state);
      return reply.redirect(redirect.toString(), 303);
    }
    const issued = issueTestCode({
      descriptor_key: descriptor.key,
      redirect_uri: descriptor.redirect_uri,
      scopes,
      challenge: String(body.code_challenge ?? ""),
      method: "S256",
      behaviour: "approve",
    });
    redirect.searchParams.set("code", issued.code);
    redirect.searchParams.set("state", state);
    return reply.redirect(redirect.toString(), 303);
  });
}

export function connectedWorkRoutes(
  route: ConnectedWorkRoute,
  seamRoute: ConnectedWorkSeamRoute,
): void {
  route("GET", "/connectors/catalog", "List connector providers and capabilities", async () => {
    const providers = providerCatalog().map((definition) => ({
      ...definition,
      implemented: adapterImplemented(definition.key),
    }));
    return {
      vocabulary_version: CAPABILITY_VOCABULARY_VERSION,
      providers,
      declared: declaredProviders(),
      capabilities: CONNECTOR_CAPABILITIES.map((key) => ({
        key,
        category: CAPABILITY_CATEGORY[key],
      })),
      // The keys a connection configuration may actually carry: anything else would
      // be dropped by persistence, so the guided form refuses it instead.
      config_keys: [...CREDENTIAL_METADATA_KEYS],
      // Registered OAuth descriptors, in the customer's language. `connectable` is
      // true only when this deployment has an executable authorization path: a
      // provider that is merely declared never offers a Connect control.
      oauth: [...oauthRegistry().descriptors.values()].map((descriptor) => ({
        provider_key: descriptor.key,
        display_name: descriptor.display_name,
        test_only: descriptor.test_only,
        // A descriptor is connectable only when this deployment has an EXECUTABLE
        // authorization path for it. The acceptance fixture does (in acceptance
        // environments only); a registered real provider does not yet, because the
        // real adapters and the #234 activation gate are future work, so it is
        // described but never offered with a Connect control.
        connectable: descriptor.test_only,
        refresh_rotation: descriptor.refresh_rotation,
        scopes: descriptor.scopes.map((entry) => ({
          scope: entry.scope,
          capability: entry.capability,
          label: entry.label,
          description: entry.description,
        })),
      })),
      limits: {
        max_connections_per_tenant: CONNECTOR_LIMITS.max_connections_per_tenant,
        max_user_connections_per_user: CONNECTOR_LIMITS.max_user_connections_per_user,
        max_events_per_sync: CONNECTOR_LIMITS.max_events_per_sync,
      },
    };
  });

  route("GET", "/connectors/connections", "List visible connector connections", async (q, a) => ({
    connections: await listConnections(q, a),
  }));

  route(
    "POST",
    "/connectors/connections",
    "Create a connector connection",
    async (q, a, r) => {
      humanSession(a);
      const input = connectionBody.parse(r.body);
      const connection = await createConnection(q, a, {
        provider_key: input.provider_key,
        label: input.label,
        ownership: input.ownership,
        // The typed endpoint keys a guided form supplies are validated here, with
        // the same canonicalization a real destination must pass: a value the
        // browser pre-check accepted can never be stored unchecked.
        config: input.config ? validateConnectionConfig(input.config) : undefined,
        capabilities: input.capabilities,
      });
      return { connection };
    },
  );

  route("GET", "/connectors/connections/:id", "Read one connector connection", async (q, a, r) => ({
    connection: await getConnection(q, a, connectionParam(r)),
  }));

  route(
    "POST",
    "/connectors/connections/:id/connect",
    "Establish a connection with its supplied secret",
    async (q, a, r) => {
      humanSession(a);
      const input = secretBody.parse(r.body);
      return { connection: await connectConnection(q, a, connectionParam(r), input) };
    },
  );

  route(
    "POST",
    "/connectors/connections/:id/rotate",
    "Rotate a connection credential",
    async (q, a, r) => {
      humanSession(a);
      const input = secretBody.parse(r.body);
      return { connection: await rotateConnectionCredential(q, a, connectionParam(r), input) };
    },
  );

  route(
    "POST",
    "/connectors/connections/:id/enabled",
    "Enable or disable a connection without deleting it",
    async (q, a, r) => {
      humanSession(a);
      const input = enabledBody.parse(r.body);
      return { connection: await setConnectionEnabled(q, a, connectionParam(r), input.enabled) };
    },
  );

  seamRoute(
    "POST",
    "/connectors/connections/:id/revoke",
    "Revoke a connection and destroy its credentials",
    async (seam, a, r) => {
      humanSession(a);
      const id = connectionParam(r);
      // The provider grant is captured INSIDE the same short transaction that
      // commits the local denial, before the credential is invalidated: reading it
      // afterwards can only ever find nothing. It lives in bounded server memory and
      // is never returned, logged or audited.
      const { connection, providerGrant } = await seam.run(async (q) => {
        const existing = await getConnection(q, a, id);
        assert(
          canManageConnection(a, existing as any),
          403,
          "You cannot revoke this connection",
        );
        const stored = oauthDescriptorFor(String(existing.provider_key))
          ? await activeCredential(q, a.tenant_id, id, "oauth_refresh")
          : null;
        const revoked = await revokeConnection(q, a, id);
        return { connection: revoked, providerGrant: stored?.secret ?? null };
      });
      const descriptor = oauthDescriptorFor(String(connection.provider_key));
      if (descriptor && providerGrant) {
        // Best effort, AFTER the commit and with no tenant transaction held: a
        // provider that is slow or unreachable can neither delay nor undo the local
        // denial, and a revoked connection is never refreshed back to connected.
        await revokeProviderGrant({
          descriptor,
          refresh_token: providerGrant,
          transport: oauthTransportFor(descriptor),
        }).catch(() => undefined);
      }
      return { connection };
    },
    { rateLimit: { max: 30, timeWindow: "5 minutes" } },
  );

  route("POST", "/connectors/connections/:id/test", "Run the connection health probe", async (q, a, r) => {
    humanSession(a);
    return testConnection(q, a, connectionParam(r));
  });

  route(
    "POST",
    "/connectors/connections/:id/sync",
    "Queue an incremental sync for this connection",
    async (q, a, r) => {
      humanSession(a);
      const id = connectionParam(r);
      const connection = await getConnection(q, a, id);
      assert(connection.status !== "revoked", 409, "A revoked connection cannot sync");
      await q.query(
        "UPDATE connector_sync_state SET status='pending',next_attempt_at=now(),lease_token=NULL," +
          " lease_expires_at=NULL,updated_at=now() WHERE tenant_id=$1 AND connection_id=$2",
        [a.tenant_id, id],
      );
      await q.query(
        "INSERT INTO audit_events(id,tenant_id,actor_id,action,resource_id)" +
          " VALUES($1,$2,$3,'connector.sync_requested',$4)",
        [randomUUID(), a.tenant_id, a.user_id, id],
      );
      const row = await one(
        q,
        "SELECT status,next_attempt_at FROM connector_sync_state WHERE tenant_id=$1 AND connection_id=$2",
        [a.tenant_id, id],
      );
      // Nothing is processed inline: the sync is queued for the worker, which owns
      // the lease and the provider call, so this request never blocks on a provider.
      return { queued: true, processed: 0, status: row.status, next_at: row.next_attempt_at };
    },
  );

  route(
    "GET",
    "/connectors/connections/:id/events",
    "Read recent normalized connector events",
    async (q, a, r) => {
      const id = connectionParam(r);
      await getConnection(q, a, id);
      return { events: await recentEvents(q, a.tenant_id, id) };
    },
  );

  route("GET", "/connectors/credentials/:id", "Read non-secret credential metadata", async (q, a, r) => {
    humanSession(a);
    const id = UUID.parse(r.params.id);
    const connection = await getConnection(q, a, id);
    assert(canManageConnection(a, connection as any), 403, "Administrator access required");
    return { credentials: await credentialsFor(q, a.tenant_id, id) };
  });

  route(
    "GET",
    "/connectors/metrics",
    "Read this workspace's connector counters",
    async (q, a) => {
      humanSession(a);
      operationalMetrics(a);
      // Tenant-scoped, computed inside the caller's own transaction under FORCE RLS.
      // The deployment-wide aggregate is a platform surface and is deliberately NOT
      // reachable here: a customer must not be able to infer another tenant's
      // connector activity from these counters.
      return connectorMetricsForTenant(q, a.tenant_id);
    },
  );

  /**
   * W29-P0/A2 endpoint readiness. Owner/admin only, human session only, with its
   * own bounded budget. It resolves the hostname and evaluates the SAME policy a
   * real provider connection uses, and it NEVER opens a socket to the destination:
   * a blocked endpoint is not contacted to produce its denial, and the check cannot
   * be used as an arbitrary port probe (the port vocabulary is fixed per use case).
   *
   * It runs on the seam, not inside a tenant transaction: authorization is a short
   * tenant transaction that is released BEFORE the resolution starts, and both the
   * resolution and the whole check are bounded.
   */
  seamRoute(
    "POST",
    "/connectors/endpoints/preflight",
    "Check whether a provider endpoint may be reached",
    async (seam, a, r) => {
      humanSession(a);
      assert(isTenantAdministrator(a), 403, "Administrator access required to check provider endpoints");
      const body = preflightBody.parse(r.body ?? {});
      await seam.run((q) => assertActiveAdministrator(q, a));
      const readiness = await preflightEndpoint({
        host: body.host,
        port: body.port,
        use_case: body.use_case,
      });
      return { readiness };
    },
    // Bounded per minute. The route is a human-driven readiness check, and the
    // limiter keys a POST by network identity, so this also bounds a shared NAT.
    { rateLimit: { max: 30, timeWindow: "1 minute" } },
  );

  /**
   * W29-P0/A3: the authorization journey's API.
   *
   * `start` and the callback run on the seam, because both span a network step: the
   * short tenant transaction creates or consumes the attempt, the provider exchange
   * happens with NO transaction held, and a second short transaction commits the
   * fenced outcome. Nothing in these routes holds a pool connection across I/O.
   */
  seamRoute(
    "POST",
    "/connectors/connections/:id/oauth/start",
    "Start an external account authorization",
    async (seam, a, r) => {
      humanSession(a);
      const body = oauthStartBody.parse(r.body ?? {});
      const id = connectionParam(r);
      const prepared = await seam.run(async (q) => {
        const connection = await getConnection(q, a, id);
        assert(
          canManageConnection(a, connection as any),
          403,
          "You cannot authorize this connection",
        );
        const descriptor = oauthDescriptorFor(String(connection.provider_key));
        assert(
          descriptor,
          409,
          "This provider is not available for authorization in this deployment",
        );
        const started = await startAuthorizationAttempt(q, {
          tenant: a.tenant_id,
          connection: {
            id: String(connection.id),
            provider_key: String(connection.provider_key),
            status: String(connection.status),
            enabled: connection.enabled !== false,
            capabilities_requested:
              (connection.capabilities_requested as string[]) ?? [],
          },
          descriptor,
          initiated_by: a.user_id,
          session_token: seam.session_token,
          requested_capabilities: body.capabilities,
        });
        return {
          authorization_url: started.authorization_url,
          expires_at: started.expires_at,
          provider: descriptor.key,
        };
      });
      // Only the registered authorization URL leaves the server: no state, verifier
      // or client material is exposed as a JSON value.
      return { authorization: prepared };
    },
    { rateLimit: { max: 20, timeWindow: "5 minutes" } },
  );

  seamRoute(
    "POST",
    "/connectors/connections/:id/oauth/reconnect",
    "Reconnect an external account after a lost grant",
    async (seam, a, r) => {
      humanSession(a);
      const body = oauthStartBody.parse(r.body ?? {});
      const id = connectionParam(r);
      const prepared = await seam.run(async (q) => {
        const connection = await getConnection(q, a, id);
        assert(
          canManageConnection(a, connection as any),
          403,
          "You cannot authorize this connection",
        );
        // A revoked connection is terminal: reconnecting it would resurrect a
        // withdrawn grant, so a fresh connection is required instead.
        assert(
          String(connection.status) !== "revoked",
          409,
          "A revoked connection cannot be reconnected",
        );
        const descriptor = oauthDescriptorFor(String(connection.provider_key));
        assert(
          descriptor,
          409,
          "This provider is not available for authorization in this deployment",
        );
        const started = await startAuthorizationAttempt(q, {
          tenant: a.tenant_id,
          connection: {
            id: String(connection.id),
            provider_key: String(connection.provider_key),
            status: String(connection.status),
            enabled: connection.enabled !== false,
            capabilities_requested:
              (connection.capabilities_requested as string[]) ?? [],
          },
          descriptor,
          initiated_by: a.user_id,
          session_token: seam.session_token,
          requested_capabilities: body.capabilities.length
            ? body.capabilities
            : (connection.capabilities_requested as string[]) || [],
        });
        return {
          authorization_url: started.authorization_url,
          expires_at: started.expires_at,
          provider: descriptor.key,
        };
      });
      return { authorization: prepared };
    },
    { rateLimit: { max: 20, timeWindow: "5 minutes" } },
  );

  /**
   * The provider callback. It is a top-level browser GET, so the session cookie is
   * SameSite=Lax compatible; the state, not a CSRF header, is the binding. Every
   * outcome ends in a 303 to a CLEAN application URL: no code, state, error
   * description or token ever appears in the address the browser keeps.
   */
  seamRoute(
    "GET",
    "/connectors/oauth/callback",
    "Complete an external account authorization",
    async (seam, a, r, reply) => {
      humanSession(a);
      const query = (r.query ?? {}) as Record<string, unknown>;
      // A bounded, non-secret outcome line: the category only, never the code, the
      // state, the verifier, a token or the provider's error text.
      const note = (outcome: string, category?: string | null) =>
        console.info(
          JSON.stringify({
            event: "connector.oauth_callback",
            outcome,
            category: category ?? null,
          }),
        );
      const appUrl = String(process.env.APP_URL || "").replace(/\/$/, "") || "";
      const clean = (outcome: string, connection?: string | null) =>
        `${appUrl}/?oauth=${outcome}${connection ? `&connection=${connection}` : ""}`;
      const state = String(query.state ?? "").slice(0, 200);
      const code = String(query.code ?? "").slice(0, 4096);
      const providerError = query.error ? String(query.error).slice(0, 64) : "";

      // A provider-side denial or error closes the attempt it belongs to. The
      // attempt is resolved through the same binding proof as a success, so a
      // forged `error` in the query cannot close someone else's authorization.
      if (providerError) {
        const closed = await seam.run((q) =>
          consumeAuthorizationAttempt(q, {
            tenant: a.tenant_id,
            state,
            session_token: seam.session_token,
          }),
        );
        if (closed.ok)
          await seam.run((q) =>
            failAuthorizationAttempt(q, {
              tenant: a.tenant_id,
              attempt_id: closed.consumed.attempt.id,
              category:
                providerError === "access_denied" ? "provider_denied" : "exchange_failed",
              status: "denied",
            }),
          );
        return reply.redirect(clean("denied"), 303);
      }
      if (!state || !code) return reply.redirect(clean("invalid"), 303);

      const consumed = await seam.run((q) =>
        consumeAuthorizationAttempt(q, {
          tenant: a.tenant_id,
          state,
          session_token: seam.session_token,
        }),
      );
      if (!consumed.ok) {
        note("refused", consumed.category);
        return reply.redirect(
          clean(consumed.category === "provider_denied" ? "denied" : "error"),
          303,
        );
      }

      const attempt = consumed.consumed.attempt;
      const descriptor = oauthDescriptorFor(attempt.provider_key);
      if (!descriptor) {
        await seam.run((q) =>
          failAuthorizationAttempt(q, {
            tenant: a.tenant_id,
            attempt_id: attempt.id,
            category: "unsupported_provider",
          }),
        );
        return reply.redirect(clean("error", attempt.connection_id), 303);
      }

      // The exchange happens with NO tenant transaction held, through A2's governed
      // transport (or, for the acceptance fixture only, its in-process transport).
      const exchanged = await exchangeAuthorizationCode({
        descriptor,
        code,
        verifier: consumed.consumed.verifier,
        transport: oauthTransportFor(descriptor),
      });
      if (!exchanged.ok) {
        await seam.run((q) =>
          failAuthorizationAttempt(q, {
            tenant: a.tenant_id,
            attempt_id: attempt.id,
            category: exchanged.category,
            status: exchanged.category === "provider_denied" ? "denied" : "failed",
          }),
        );
        return reply.redirect(
          clean(
            exchanged.category === "provider_denied" ? "denied" : "error",
            attempt.connection_id,
          ),
          303,
        );
      }

      // The fenced commit: a second short transaction that re-checks the attempt
      // generation, the connection state and the grant before sealing anything.
      try {
        await seam.run((q) =>
          completeAuthorizationAttempt(q, {
            tenant: a.tenant_id,
            attempt,
            descriptor,
            tokens: exchanged.outcome,
            // Live membership and role are re-read inside the commit transaction.
            authority: { user_id: a.user_id },
          }),
        );
      } catch (error) {
        const category = String((error as { category?: string }).category ?? "exchange_failed");
        await seam
          .run((q) =>
            failAuthorizationAttempt(q, {
              tenant: a.tenant_id,
              attempt_id: attempt.id,
              category: category as never,
            }),
          )
          .catch(() => undefined);
        return reply.redirect(clean("error", attempt.connection_id), 303);
      }
      note("connected");
      return reply.redirect(clean("connected", attempt.connection_id), 303);
    },
    // Raw request logging is silenced for this route: its URL carries the code and
    // the state. The handler's own bounded outcome line is the log record.
    { rateLimit: { max: 60, timeWindow: "5 minutes" }, log: { level: "silent" } },
  );

  /** The safe, non-secret OAuth status of one connection. */
  route(
    "GET",
    "/connectors/connections/:id/oauth/status",
    "Read the OAuth status of one connection",
    async (q, a, r) => {
      humanSession(a);
      const connection = await getConnection(q, a, connectionParam(r));
      assert(
        canReadConnection(a, connection as any),
        403,
        "You cannot read this connection",
      );
      const descriptor = oauthDescriptorFor(String(connection.provider_key));
      const status = await oauthStatusFor(q, a.tenant_id, String(connection.id));
      const credentials = await credentialsFor(q, a.tenant_id, String(connection.id));
      return {
        oauth: {
          ...status,
          provider_registered: Boolean(descriptor),
          provider_display_name: descriptor?.display_name ?? null,
          test_only: descriptor?.test_only ?? false,
          scopes: (descriptor?.scopes ?? []).map((entry) => ({
            scope: entry.scope,
            capability: entry.capability,
            label: entry.label,
            description: entry.description,
          })),
          grant: credentials
            .filter((row) => ["oauth_access", "oauth_refresh"].includes(String(row.kind)))
            .map((row) => ({
              kind: row.kind,
              key_version: row.key_version,
              rotated_at: row.rotated_at,
              scopes: (row.metadata as Record<string, unknown>)?.scopes ?? [],
              expires_at: (row.metadata as Record<string, unknown>)?.expires_at ?? null,
            })),
        },
      };
    },
  );

  route("GET", "/automations/catalog", "List triggers, actions and condition operators", async () => ({
    triggers: triggerCatalog(),
    actions: actionCatalog(),
    operators: CONDITION_OPERATORS,
    limits: WORKFLOW_LIMITS,
  }));

  route("GET", "/automations/workflows", "List workflows", async (q, a) => ({
    workflows: await listWorkflows(q, a),
  }));

  route("POST", "/automations/workflows", "Create a draft workflow", async (q, a, r) => {
    humanSession(a);
    const input = z
      .object({
        name: z.string().min(1).max(200),
        description: z.string().max(2000).optional(),
        definition: z.any(),
        authority: z.enum(["delegated_user", "service_principal"]).optional(),
      })
      .parse(r.body);
    const created = await createWorkflow(q, a, input);
    return {
      workflow: created.workflow,
      draft_definition: created.definition,
      plan: created.plan,
    };
  });

  route("GET", "/automations/workflows/:id", "Read a workflow and its draft revision", async (q, a, r) =>
    getWorkflowDetail(q, a, UUID.parse(r.params.id)),
  );

  route("PATCH", "/automations/workflows/:id", "Save a new draft revision", async (q, a, r) => {
    humanSession(a);
    const input = z.object({ definition: z.any() }).parse(r.body);
    return saveDraft(q, a, UUID.parse(r.params.id), input);
  });

  route("POST", "/automations/workflows/:id/validate", "Validate a draft definition", async (q, a, r) => {
    humanSession(a);
    const input = z.object({ definition: z.any() }).parse(r.body);
    const result = await validateDraft(q, a, UUID.parse(r.params.id), input);
    return { ok: true, plan: result.plan };
  });

  route("POST", "/automations/workflows/:id/enable", "Publish a revision and enable the workflow", async (q, a, r) => {
    humanSession(a);
    return { workflow: await enableWorkflow(q, a, UUID.parse(r.params.id)) };
  });

  route("POST", "/automations/workflows/:id/disable", "Disable a workflow", async (q, a, r) => {
    humanSession(a);
    return disableWorkflow(q, a, UUID.parse(r.params.id));
  });

  route("DELETE", "/automations/workflows/:id", "Delete a workflow and its history", async (q, a, r) => {
    humanSession(a);
    await deleteWorkflow(q, a, UUID.parse(r.params.id));
    return { deleted: true };
  });

  route("POST", "/automations/workflows/:id/run", "Trigger a workflow run manually", async (q, a, r) => {
    humanSession(a);
    const input = z.object({ idempotency_key: z.string().min(1).max(200).optional() }).parse(r.body ?? {});
    return { run: await triggerManualRun(q, a, UUID.parse(r.params.id), input) };
  });

  route("GET", "/automations/runs", "List workflow runs", async (q, a, r) => {
    const params = r.query as Record<string, string>;
    const limit = Math.max(1, Math.min(Number(params.limit) || 25, 100));
    assert(
      !params.workflow_id || UUID.safeParse(params.workflow_id).success,
      400,
      "Invalid workflow filter",
    );
    return { runs: await listRuns(q, a, { workflow_id: params.workflow_id, limit }) };
  });

  route("GET", "/automations/runs/:id", "Read a run with its step evidence", async (q, a, r) =>
    getRunDetail(q, a, UUID.parse(r.params.id)),
  );

  route("POST", "/automations/runs/:id/cancel", "Cancel a run", async (q, a, r) => {
    humanSession(a);
    return { run: await cancelRun(q, a, UUID.parse(r.params.id)) };
  });

  route("POST", "/automations/runs/:id/retry", "Retry an eligible terminal run", async (q, a, r) => {
    humanSession(a);
    return { run: await retryRun(q, a, UUID.parse(r.params.id)) };
  });

  route(
    "GET",
    "/automations/metrics",
    "Read this workspace's workflow counters",
    async (q, a) => {
      humanSession(a);
      operationalMetrics(a);
      return workflowMetricsForTenant(q, a.tenant_id);
    },
  );

  route(
    "GET",
    "/automations/service-principal",
    "Read the tenant automation identity",
    async (q, a) => {
      // A normal member has no need for the tenant automation identity's
      // configuration or capability allowlist.
      humanSession(a);
      operationalMetrics(a);
      return { service_principal: await getServicePrincipal(q, a) };
    },
  );

  route(
    "POST",
    "/automations/service-principal",
    "Provision the tenant automation identity and its capability allowlist",
    async (q, a, r) => {
      humanSession(a);
      const input = z.object({ capabilities: z.array(z.string()).max(16) }).parse(r.body ?? {});
      return { service_principal: await provisionServicePrincipal(q, a, input) };
    },
  );

  route(
    "DELETE",
    "/automations/service-principal",
    "Remove the tenant automation identity allowlist",
    async (q, a) => {
      humanSession(a);
      return deprovisionServicePrincipal(q, a);
    },
  );

  route(
    "POST",
    "/automations/dev/tick",
    "Run one bounded automation engine tick for this tenant",
    async (q, a) => {
      humanSession(a);
      const deps = { connectorPort: connectorActionPortFor(q) };
      const schedules = await scheduleTick(q, a.tenant_id, deps);
      const connector = await dispatchConnectorEvent(q, a.tenant_id, deps);
      const engine = await engineTick(q, a.tenant_id, deps);
      const pruned = await pruneRuns(q, a.tenant_id);
      return { schedules, connector, engine, pruned };
    },
  );
}

/**
 * The provider-neutral ingress endpoint. It carries no session: the tenant is
 * resolved from the connection the provider named, through a definer lookup, and
 * the adapter must authenticate the request before anything is normalized. An
 * unverified request is refused UNIFORMLY (unknown connection, wrong token and
 * malformed token all answer the same way) so the endpoint cannot be used to
 * discover which connection ids exist.
 */
export function registerConnectorIngress(app: FastifyInstance, db: Database): void {
  app.route({
    method: "POST",
    url: "/api/v1/connectors/ingress/:connectionId",
    schema: { summary: "Connector provider event ingress", tags: ["connectors"] },
    handler: async (request: any, reply) => {
      const connectionId = String(request.params?.connectionId || "");
      const raw = JSON.stringify(request.body ?? {});
      assert(
        Buffer.byteLength(raw) <= CONNECTOR_LIMITS.max_config_bytes * 4,
        413,
        "Connector event payload is too large",
      );
      if (!/^[0-9a-f-]{36}$/i.test(connectionId)) {
        reply.code(401);
        return { error: "Connector request rejected" };
      }
      let result;
      try {
        result = await ingestProviderEvent(db, {
          connection_id: connectionId,
          headers: request.headers as Record<string, string | string[] | undefined>,
          body: request.body,
        });
      } catch (error) {
        if (error instanceof HttpError && error.statusCode === 400) {
          reply.code(400);
          return { error: error.message };
        }
        throw error;
      }
      if (result.accepted === true)
        return reply.code(202).send({
          accepted: true,
          event_id: result.event_id,
          duplicate: result.duplicate,
          event_type: result.event_type,
        });
      if (result.reason === "not_normalizable")
        return reply.code(400).send({ accepted: false, error: "Connector event was not usable" });
      if (result.reason === "rejected_event")
        return reply.code(409).send({ accepted: false, error: "Connector event was rejected" });
      // unknown_connection, invalid_signature and disabled all answer identically.
      return reply.code(401).send({ accepted: false, error: "Connector request rejected" });
    },
  });
}

export { isCapability, normalizeCapabilities };
export type { Capability };
