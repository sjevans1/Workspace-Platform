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
  adapterFor,
  backoffSeconds,
  claimDueSync,
  classifyProviderFailure,
  completeSync,
  failSync,
  recordConnectorEvent,
  type FailureCategory,
  type SyncClaim,
} from "../../../packages/connectors/index.ts";
import {
  dispatchConnectorEvent,
  dispatchWorkspaceEvent,
  engineTick,
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
export async function connectorTick(
  db: Database,
  tenant: string,
): Promise<{ claimed: number; succeeded: number; failed: number; events: number }> {
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
  return { claimed: claims.length, succeeded, failed, events };
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
  pruned: number;
}> {
  const withPort = <T>(fn: (q: Query, deps: EngineDeps) => Promise<T>) =>
    db.tenant(tenant, (q) => fn(q, { connectorPort: connectorActionPortFor(q) }));
  const schedules = await withPort((q, deps) => scheduleTick(q, tenant, deps));
  const connector = await withPort((q, deps) => dispatchConnectorEvent(q, tenant, deps));
  const engine = await withPort((q, deps) => engineTick(q, tenant, deps));
  const pruned = await withPort((q) => pruneRuns(q, tenant));
  return {
    schedules: schedules.fired,
    connector_runs: connector.runs.length,
    engine,
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
