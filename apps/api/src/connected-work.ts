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
  adapterFor,
  adapterImplemented,
  canManageConnection,
  CAPABILITY_CATEGORY,
  CAPABILITY_VOCABULARY_VERSION,
  CONNECTOR_CAPABILITIES,
  CONNECTOR_LIMITS,
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
) => void;

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

/**
 * The connector action port the deterministic engine consumes. It reads live
 * connection state and refuses anything ambiguous, so a revoked or disabled
 * connection fails closed, and a delegated connection used by any authority other
 * than its owner is denied.
 */
export function connectorActionPortFor(q: Query): ConnectorActionPort {
  return {
    async inspect({ tenant_id, connection_id, actor_role, user_id }) {
      const row = await one(
        q,
        "SELECT id,provider_key,status,enabled,ownership,owner_user_id,capabilities_granted" +
          " FROM connector_connections WHERE tenant_id=$1 AND id=$2",
        [tenant_id, connection_id],
      );
      if (!row) return null;
      void actor_role;
      void user_id;
      return {
        exists: true,
        enabled: row.enabled === true,
        status: row.status,
        ownership: row.ownership,
        owner_user_id: row.owner_user_id,
        capabilities_granted: [...(row.capabilities_granted || [])],
        provider_key: row.provider_key,
      };
    },
    async invoke({ tenant_id, connection_id, action, capability, payload }) {
      const row = await one(
        q,
        "SELECT provider_key FROM connector_connections WHERE tenant_id=$1 AND id=$2",
        [tenant_id, connection_id],
      );
      assert(row, 404, "Connector connection not found");
      const definition = providerDefinition(row.provider_key);
      const declared = definition.actions.find((item) => item.key === action);
      assert(declared, 400, `Connector provider ${definition.key} does not declare action ${action}`);
      assert(
        declared!.requires_capability === capability,
        400,
        `Connector action ${action} requires ${declared!.requires_capability}`,
      );
      return adapterFor(row.provider_key).action({
        action,
        capability,
        config: {},
        payload: payload || {},
      });
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
export function connectedWorkRoutes(route: ConnectedWorkRoute): void {
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
        config: input.config,
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

  route(
    "POST",
    "/connectors/connections/:id/revoke",
    "Revoke a connection and destroy its credentials",
    async (q, a, r) => {
      humanSession(a);
      return { connection: await revokeConnection(q, a, connectionParam(r)) };
    },
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
