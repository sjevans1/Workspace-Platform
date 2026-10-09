import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { createHash, randomUUID } from "node:crypto";
import { prepareCsvImport, prepareCsvIntoExisting, csvSchemaDigest } from "../../../packages/imports/csv.ts";
import type { ImportMode } from "../../../packages/imports/keys.ts";
import { keyedImportDigest, normalizeKeyValue, resolveKeyProperty } from "../../../packages/imports/keys.ts";
import { keyedDecisionSet, planKeyedImport } from "../../../packages/imports/keyed.ts";
import { Database, one } from "../../../packages/database/index.ts";
import { decrypt, emit, signature } from "../../../packages/events/index.ts";
import { assert, json, view } from "../../../packages/contracts/index.ts";
import { stringify } from "csv-stringify/sync";
import { requireAccess } from "../../../packages/permissions/index.ts";
import type { Actor } from "../../../packages/auth/index.ts";
import { createResource, createRecord, updateRecordCanonical, purgeDeletedResource, resolveKeyedMatches, records } from "../../api/src/domain.ts";
import { createStorage, type Storage } from "../../../packages/storage/index.ts";
import { createAntivirus, type Antivirus } from "../../../packages/security/antivirus.ts";
import { exportPortableTree } from "../../api/src/portable-export.ts";
import { importPortableArchive } from "../../api/src/portable-import.ts";
import { markdownToBlocks } from "../../../packages/editor/server.ts";
/** Internal signal: a durable export observed a cooperative cancellation request. */
class ExportCancelled extends Error {}
export function webhookUrl(text: string) {
  const u = new URL(text);
  assert(
    ["http:", "https:"].includes(u.protocol) &&
      !u.username &&
      !u.password &&
      (process.env.WEBHOOK_ALLOWED_ORIGINS || "")
        .split(",")
        .map((x) => x.trim())
        .includes(u.origin),
    400,
    "Webhook origin is not allowlisted",
  );
  return u;
}
function deliver(url: string, secret: string, event: any) {
  const u = webhookUrl(url),
    time = String(Math.floor(Date.now() / 1000)),
    body = JSON.stringify({
      id: event.id,
      type: event.type,
      tenant_id: event.tenant_id,
      resource_id: event.resource_id,
      version: event.version,
      timestamp: event.created_at,
    });
  return new Promise<void>((resolve, reject) => {
    const req = (u.protocol === "https:" ? httpsRequest : httpRequest)(
      u,
      {
        method: "POST",
        timeout: 10000,
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(body),
          "X-Workspace-Timestamp": time,
          "X-Workspace-Signature": `sha256=${signature(secret, time, body)}`,
          "X-Workspace-Event": event.id,
        },
      },
      (res) => {
        let bytes = 0;
        res.on("data", (b) => {
          bytes += b.length;
          if (bytes > 65536) req.destroy(new Error("Response too large"));
        });
        res.on("end", () =>
          res.statusCode! >= 200 && res.statusCode! < 300
            ? resolve()
            : reject(new Error(`HTTP ${res.statusCode}`)),
        );
      },
    );
    req.on("timeout", () => req.destroy(new Error("Delivery timed out")));
    req.on("error", reject);
    req.end(body);
  });
}
export async function tick(
  db: Database,
  suppliedStorage?: Storage,
  suppliedAntivirus?: Antivirus,
) {
  const storage = suppliedStorage || createStorage();
  const closeStorage = !suppliedStorage;
  const tenants = await db.system((q) =>
    q.query("SELECT id FROM worker_tenants()"),
  );
  try {
  for (const { id: tenant } of tenants.rows) {
    await db.tenant(tenant, async (q) => {
      for (const e of (
        await q.query(
          "SELECT * FROM event_outbox WHERE dispatched_at IS NULL ORDER BY created_at LIMIT 50 FOR UPDATE SKIP LOCKED",
        )
      ).rows) {
        for (const s of (
          await q.query(
            "SELECT id FROM webhook_subscriptions WHERE active AND $1=ANY(events)",
            [e.type],
          )
        ).rows)
          await q.query(
            "INSERT INTO webhook_deliveries(id,tenant_id,subscription_id,event_id) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING",
            [randomUUID(), tenant, s.id, e.id],
          );
        await q.query(
          "UPDATE event_outbox SET dispatched_at=now() WHERE id=$1",
          [e.id],
        );
      }
    });

    // W20: claim a bounded lease in a short tenant transaction, perform the
    // outbound HTTP request without holding DB row/transaction locks, then
    // finalize only if this worker still owns the lease token. A crashed
    // worker leaves a recoverable lease that becomes claimable after expiry.
    for (let deliveryIndex = 0; deliveryIndex < 10; deliveryIndex++) {
      const claimed = await db.tenant(tenant, async (q) => {
        await q.query(
          "UPDATE webhook_deliveries AS d SET status='cancelled'," +
            " lease_token=NULL,lease_expires_at=NULL" +
            " FROM webhook_subscriptions AS s" +
            " WHERE d.subscription_id=s.id AND d.tenant_id=$1" +
            " AND d.status IN ('pending','retry') AND s.active=false",
          [tenant],
        );
        const d = await one(
          q,
          "SELECT d.* FROM webhook_deliveries AS d" +
            " JOIN webhook_subscriptions AS s ON s.id=d.subscription_id" +
            " WHERE d.tenant_id=$1 AND s.active=true" +
            " AND d.status IN ('pending','retry') AND d.next_at<=now()" +
            " AND (d.lease_expires_at IS NULL OR d.lease_expires_at<=now())" +
            " ORDER BY d.next_at,d.id LIMIT 1 FOR UPDATE OF d SKIP LOCKED",
          [tenant],
        );
        if (!d) return null;
        const s = await one(
          q,
          // Coordinate only the short claim transaction with secret activation.
          // The lock is released before any network I/O begins.
          "SELECT * FROM webhook_subscriptions WHERE id=$1 FOR SHARE",
          [d.subscription_id],
        );
        if (!s?.active) return null;
        const e = await one(q, "SELECT * FROM event_outbox WHERE id=$1", [
          d.event_id,
        ]);
        const leaseToken = randomUUID();
        await q.query(
          "UPDATE webhook_deliveries SET lease_token=$2," +
            " lease_expires_at=now()+interval '30 seconds' WHERE id=$1",
          [d.id, leaseToken],
        );
        return {
          delivery: d,
          subscription: s,
          event: e,
          leaseToken,
        };
      });
      if (!claimed) break;

      let deliveryError: Error | null = null;
      try {
        await deliver(
          claimed.subscription.url,
          decrypt(claimed.subscription.secret_encrypted),
          claimed.event,
        );
      } catch (error) {
        deliveryError = error as Error;
      }

      await db.tenant(tenant, async (q) => {
        if (!deliveryError) {
          await q.query(
            "UPDATE webhook_deliveries SET status='delivered'," +
              " attempts=attempts+1,last_error=NULL,lease_token=NULL," +
              " lease_expires_at=NULL WHERE id=$1 AND lease_token=$2",
            [claimed.delivery.id, claimed.leaseToken],
          );
          return;
        }
        await q.query(
          "UPDATE webhook_deliveries SET status=$3,attempts=attempts+1," +
            " last_error=$4,next_at=now()+$5::interval,lease_token=NULL," +
            " lease_expires_at=NULL WHERE id=$1 AND lease_token=$2",
          [
            claimed.delivery.id,
            claimed.leaseToken,
            claimed.delivery.attempts >= 7 ? "dead" : "retry",
            deliveryError.message.slice(0, 200),
            `${Math.min(3600, 5 * 2 ** claimed.delivery.attempts)} seconds`,
          ],
        );
      });
    }
    await db.tenant(tenant, async (q) => {
      const policy = await one(
        q,
        "SELECT trash_retention_days FROM organisations WHERE id=$1",
        [tenant],
      );
      if (policy?.trash_retention_days) {
        const candidate = await one(
          q,
          "SELECT id FROM resources WHERE deleted_at IS NOT NULL AND deleted_at <= now()-($1::int * interval '1 day') ORDER BY deleted_at,id LIMIT 1 FOR UPDATE SKIP LOCKED",
          [policy.trash_retention_days],
        );
        if (candidate)
          await purgeDeletedResource(q, tenant, candidate.id);

        for (const file of (
          await q.query(
            "SELECT id,object_key,resource_id FROM files WHERE deleted_at IS NOT NULL AND deleted_at <= now()-($1::int * interval '1 day') ORDER BY deleted_at,id LIMIT 25 FOR UPDATE SKIP LOCKED",
            [policy.trash_retention_days],
          )
        ).rows) {
          await q.query(
            "INSERT INTO object_deletions(id,tenant_id,object_key,reason) VALUES($1,$2,$3,'file_retention') ON CONFLICT(tenant_id,object_key) DO NOTHING",
            [randomUUID(), tenant, file.object_key],
          );
          await q.query("DELETE FROM files WHERE id=$1", [file.id]);
          await q.query(
            "INSERT INTO audit_events(id,tenant_id,actor_id,action,resource_id) VALUES($1,$2,NULL,'retention.file_purged',$3)",
            [randomUUID(), tenant, file.resource_id],
          );
        }
      }

      for (const artifact of (
        await q.query(
          "SELECT id,object_key FROM job_artifacts WHERE expires_at<=now()" +
            " ORDER BY expires_at,id LIMIT 25 FOR UPDATE SKIP LOCKED",
        )
      ).rows) {
        await q.query(
          "INSERT INTO object_deletions(id,tenant_id,object_key,reason)" +
            " VALUES($1,$2,$3,'job_artifact_expired')" +
            " ON CONFLICT(tenant_id,object_key) DO NOTHING",
          [randomUUID(), tenant, artifact.object_key],
        );
        await q.query("DELETE FROM job_artifacts WHERE id=$1", [artifact.id]);
      }

      for (const deletion of (
        await q.query(
          "SELECT * FROM object_deletions WHERE status IN ('pending','retry') AND next_at<=now() ORDER BY next_at,id LIMIT 25 FOR UPDATE SKIP LOCKED",
        )
      ).rows) {
        try {
          await storage.delete(deletion.object_key);
          await q.query(
            "UPDATE object_deletions SET status='completed',attempts=attempts+1,last_error=NULL,completed_at=now() WHERE id=$1",
            [deletion.id],
          );
        } catch (err) {
          await q.query(
            "UPDATE object_deletions SET status=$2,attempts=attempts+1,last_error=$3,next_at=now()+$4::interval WHERE id=$1",
            [
              deletion.id,
              deletion.attempts >= 7 ? "dead" : "retry",
              (err as Error).message.slice(0, 200),
              `${Math.min(3600, 5 * 2 ** deletion.attempts)} seconds`,
            ],
          );
        }
      }
    });
    const claimedJob = await db.tenant(tenant, async (q) => {
      const candidate = await one(
        q,
        "SELECT id FROM jobs" +
          " WHERE status='pending'" +
          " OR (status='running' AND lease_expires_at<=now())" +
          " ORDER BY created_at,id LIMIT 1 FOR UPDATE SKIP LOCKED",
      );
      if (!candidate) return null;
      const leaseToken = randomUUID();
      return one(
        q,
        "UPDATE jobs SET status='running',lease_token=$2," +
          " lease_expires_at=now()+interval '15 minutes'," +
          " attempts=attempts+1,started_at=COALESCE(started_at,now())" +
          " WHERE id=$1 RETURNING id,lease_token",
        [candidate.id, leaseToken],
      );
    });
    if (claimedJob)
    await db.tenant(tenant, async (q) => {
      // Hold the claimed job row for the processing transaction. If this
      // worker crashes, the transaction rolls back but the committed lease
      // remains on the row; after expiry another worker can safely reclaim it.
      // While this transaction is alive a competing worker uses SKIP LOCKED and
      // cannot process the same job, even if the lease clock itself expires.
      const j = await one(
        q,
        "SELECT * FROM jobs WHERE id=$1 AND status='running'" +
          " AND lease_token=$2 FOR UPDATE",
        [claimedJob.id, claimedJob.lease_token],
      );
      if (!j) return;
      await q.query("SAVEPOINT import_job");
      let pendingOutputKey: string | undefined;
      let importedObjectKeys: string[] = [];
      try {
        const m = await one(
          q,
          "SELECT m.role,u.name,u.email FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.user_id=$1 AND active",
          [j.user_id],
        );
        assert(m, 403, "Membership revoked");
        const a: Actor = {
          ...m,
          tenant_id: tenant,
          user_id: j.user_id,
          scopes: null,
          expires_at: new Date(Date.now() + 10000),
        };
        const p = j.payload;
        let resource;
        let jobResult: any;
        if (p.format === "workspace_archive_export") {
          const source = await requireAccess(q, a, p.source_id);
          assert(source.id === j.resource_id, 400, "Archive export source changed");
          const archive = await exportPortableTree(q, a, source.id, storage);
          const artifactId = j.id,
            key = `${tenant}/${source.id}/${artifactId}`,
            digest = createHash("sha256").update(archive).digest("hex");
          // Async export uses the job ID as a stable object identity. A
          // crashed attempt may have written this key without committing the
          // surrounding DB transaction; delete that orphan before retrying.
          await storage.delete(key).catch(() => {});
          pendingOutputKey = key;
          await storage.put(key, archive, "application/zip");
          await q.query(
            "INSERT INTO job_artifacts(id,tenant_id,job_id,object_key,kind,name,mime,size,sha256,expires_at)" +
              " VALUES($1,$2,$3,$4,'output',$5,'application/zip',$6,$7,now()+interval '24 hours')",
            [
              artifactId,
              tenant,
              j.id,
              key,
              "workspace-export.zip",
              archive.length,
              digest,
            ],
          );
          await emit(q, a, "export.performed", source.id);
          jobResult = {
            resource_id: source.id,
            artifact_id: artifactId,
            size: archive.length,
            sha256: digest,
          };
        } else if (p.format === "workspace_archive_import") {
          const artifact = await one(
            q,
            "SELECT * FROM job_artifacts WHERE job_id=$1 AND kind='input'" +
              " AND expires_at>now() FOR UPDATE",
            [j.id],
          );
          assert(artifact, 400, "Staged archive input is unavailable");
          const archive = await storage.get(artifact.object_key);
          assert(
            archive.length === Number(artifact.size) &&
              createHash("sha256").update(archive).digest("hex") === artifact.sha256 &&
              artifact.sha256 === p.archive_sha256,
            409,
            "Staged archive checksum mismatch",
          );
          const imported = await importPortableArchive(
            q,
            a,
            p.parent_id,
            archive,
            storage,
            suppliedAntivirus || createAntivirus(),
            j.id,
          );
          importedObjectKeys = imported.stored_object_keys;
          const { stored_object_keys: _internalKeys, ...publicImportResult } =
            imported;
          await q.query(
            "INSERT INTO object_deletions(id,tenant_id,object_key,reason)" +
              " VALUES($1,$2,$3,'job_input_consumed')" +
              " ON CONFLICT(tenant_id,object_key) DO NOTHING",
            [randomUUID(), tenant, artifact.object_key],
          );
          await q.query("DELETE FROM job_artifacts WHERE id=$1", [artifact.id]);
          resource = { id: imported.resource_id };
          jobResult = publicImportResult;
        } else if (p.format === "database_export") {
          // W09e: durable, bounded database export. Reuses the claimed lease,
          // the encrypted object store and job_artifacts. Rows are read with
          // keyset batches (records(after)) so there is no OFFSET scan and no
          // all-rows-in-RAM materialisation. Live permission was rechecked by
          // requireAccess above under the current worker membership.
          const source = await requireAccess(q, a, p.source_id);
          assert(source.id === j.resource_id, 400, "Export source changed");
          assert(
            source.kind === "database",
            400,
            "Export source is not a database",
          );
          const exportFormat = p.export_format === "json" ? "json" : "csv";
          const definition = await one(
            q,
            "SELECT properties FROM databases WHERE resource_id=$1",
            [source.id],
          );
          assert(definition, 404, "Database not found");
          const artifactId = j.id,
            key = `${tenant}/${source.id}/${artifactId}`;
          // Idempotent artifact identity: the job id keys the object. A crashed
          // attempt may have written this key without committing the enclosing
          // transaction, so remove any orphan before writing the final object.
          await storage.delete(key).catch(() => {});
          pendingOutputKey = key;
          const BATCH = 500,
            names = definition.properties.map((prop: any) => prop.name);
          const parts: Buffer[] = [],
            startedAt = Date.now();
          let peakRss = process.memoryUsage().rss,
            count = 0,
            batches = 0,
            wroteHeader = false,
            jsonFirst = true,
            after: any;
          if (exportFormat === "json") parts.push(Buffer.from("["));
          for (;;) {
            // Cooperative cancellation is observed between bounded batches.
            // The worker process is never killed; it unwinds cleanly.
            const requested = await one(
              q,
              "SELECT 1 FROM job_cancellations WHERE job_id=$1",
              [j.id],
            );
            if (requested) throw new ExportCancelled("Export cancelled");
            const batch = await records(
              q,
              a,
              source.id,
              view.parse({ type: "table" }),
              0,
              BATCH,
              after,
            );
            if (!batch.length) break;
            batches += 1;
            count += batch.length;
            const last = batch[batch.length - 1];
            after = { position: last.position, id: last.id };
            if (exportFormat === "csv") {
              parts.push(
                Buffer.from(
                  stringify(
                    batch.map((row: any) =>
                      definition.properties.map((prop: any) => {
                        let value = row.values[prop.id] ?? "";
                        if (Array.isArray(value)) value = value.join(";");
                        // Spreadsheet formula-injection mitigation: a cell that
                        // begins with a formula lead character is quoted.
                        return typeof value === "string" &&
                          /^[=+\-@\t\r]/.test(value)
                          ? `'${value}`
                          : value;
                      }),
                    ),
                    { header: !wroteHeader, columns: names },
                  ),
                ),
              );
              wroteHeader = true;
            } else {
              for (const row of batch) {
                parts.push(
                  Buffer.from(
                    (jsonFirst ? "" : ",") +
                      JSON.stringify({
                        values: row.values,
                        revision: row.revision,
                      }),
                  ),
                );
                jsonFirst = false;
              }
            }
            peakRss = Math.max(peakRss, process.memoryUsage().rss);
          }
          if (exportFormat === "json") parts.push(Buffer.from("]"));
          const body = Buffer.concat(parts),
            digest = createHash("sha256").update(body).digest("hex"),
            mime = exportFormat === "csv" ? "text/csv" : "application/json",
            name = `database.${exportFormat}`;
          await storage.put(key, body, mime);
          await q.query(
            "INSERT INTO job_artifacts(id,tenant_id,job_id,object_key,kind,name,mime,size,sha256,expires_at)" +
              " VALUES($1,$2,$3,$4,'output',$5,$6,$7,$8,now()+interval '24 hours')",
            [artifactId, tenant, j.id, key, name, mime, body.length, digest],
          );
          // Clear any cooperative-cancellation signal that arrived too late.
          await q.query("DELETE FROM job_cancellations WHERE job_id=$1", [j.id]);
          await emit(q, a, "export.performed", source.id);
          jobResult = {
            resource_id: source.id,
            artifact_id: artifactId,
            format: exportFormat,
            rows: count,
            batches,
            batch_size: BATCH,
            bytes: body.length,
            sha256: digest,
            duration_ms: Date.now() - startedAt,
            peak_rss_bytes: peakRss,
          };
        } else if (p.format === "markdown") {
          resource = await createResource(q, a, {
            parent_id: p.parent_id,
            kind: "page",
            title: p.name,
            blocks: await markdownToBlocks(p.content),
          });
          jobResult = { resource_id: resource.id };
        } else {
          // Strict re-parse and whole-file conversion under fresh worker
          // membership/parent permission. Any invalid cell fails BEFORE
          // creating the new database. The enclosing savepoint remains the
          // atomic rollback guard for subsequent DB/storage failures.
          if (p.target_database_id) {
            // Existing-database import. Append remains key blind and never
            // probes an existing record.
            const mode: ImportMode = p.existing_mode || "append";
            assert(typeof p.expected_schema_digest === "string" &&
              Array.isArray(p.mapping),400,
              "Existing import requires an explicit mapping and schema digest");
            const target = await requireAccess(q, a, p.target_database_id,3);
            assert(target.kind === "database" && !target.deleted_at &&
              target.parent_id === p.parent_id,404,
              "Import target unavailable");
            const definition = await one(q,
              "SELECT properties FROM databases WHERE resource_id=$1 FOR UPDATE",
              [target.id]);
            assert(definition && csvSchemaDigest(definition.properties) ===
              p.expected_schema_digest,409,
              "Target schema changed; preview again");
            const prepared = prepareCsvIntoExisting(
              p.content,p.mapping,definition.properties);
            if (mode === "append") {
              assert(p.key_property_id === undefined,400,
                "Append mode does not take a key property");
              for (const values of prepared.rows)
                await createRecord(q,a,target.id,values);
            } else {
              assert(p.key_property_id,400,
                "Keyed import modes require an explicit key property");
              // The plan is re-derived inside the job against current state, so
              // decisions taken at preview time can never be applied blindly.
              const keyProperty = resolveKeyProperty(
                definition.properties,p.key_property_id);
              const keys: string[] = [];
              for (const values of prepared.rows) {
                try {
                  const normalized = normalizeKeyValue(
                    keyProperty,values[keyProperty.id]);
                  if (normalized) keys.push(normalized);
                } catch {
                  // Malformed keys are planned as conflicts, never looked up.
                }
              }
              const matches = await resolveKeyedMatches(q,a,target.id,
                keyProperty,keys,mode === "authorized-update" ? 3 : 1);
              const plan = planKeyedImport({
                mode,
                rows: prepared.rows,
                targetProperties: definition.properties,
                keyPropertyId: keyProperty.id,
                visible: matches.visible,
                restrictedKeys: matches.restrictedKeys,
              });
              assert(typeof p.keyed_plan_digest === "string",400,
                "Keyed import requires an accepted preview plan digest");
              const currentPlanDigest = keyedImportDigest({
                mode,
                key_property_id: keyProperty.id,
                target_database_id: target.id,
                schema_digest: p.expected_schema_digest,
                content_hash: createHash("sha256").update(p.content).digest("hex"),
                mapping: p.mapping,
                decision_set: keyedDecisionSet(plan),
              });
              assert(currentPlanDigest === p.keyed_plan_digest,409,
                "Import preview changed; preview again");
              // A missing, malformed or duplicated key, an ambiguous identity,
              // and a collision outside the actor's access all fail the whole
              // job before anything is written. The restricted case deliberately
              // shares the ordinary conflict message, so a hidden row cannot be
              // told apart from a visible one.
              const conflicts = plan.rows.filter((row) =>
                row.action === "conflict" || row.action === "conflict_restricted");
              assert(!conflicts.length,409,
                "Import stopped: " + conflicts.length +
                " conflicting row(s); no records were written");
              for (const decision of plan.rows) {
                if (decision.action === "skip") continue;
                if (decision.action === "insert") {
                  await createRecord(q,a,target.id,prepared.rows[decision.index]);
                  continue;
                }
                // Unreachable: every conflict was rejected above. Kept explicit
                // so an unrecognised decision can never fall through to a write.
                if (decision.action !== "update")
                  assert(false,409,
                    "Import stopped: unresolved row decision; no records were written");
                // Recheck write permission on the exact record immediately
                // before changing it, then update only if the revision the
                // decision was built from is still current.
                await updateRecordCanonical(
                  q,
                  a,
                  decision.resource_id,
                  prepared.rows[decision.index],
                  decision.expected_revision,
                );
              }
            }
            resource = target;
          } else {
            assert(!p.existing_mode && !p.expected_schema_digest,400,
              "Target options require a database");
            const prepared = prepareCsvImport(p.content, p.mapping);
            resource = await createResource(q, a, {
              parent_id: p.parent_id,
              kind: "database",
              title: p.name,
            });
            await q.query(
              "UPDATE databases SET properties=$2 WHERE resource_id=$1",
              [resource.id, json(prepared.properties)],
            );
            for (const values of prepared.rows)
              await createRecord(q,a,resource.id,values);
          }
          jobResult = { resource_id: resource.id };
        }
        await q.query(
          "UPDATE jobs SET status='completed',result=$2,completed_at=now()," +
            " lease_token=NULL,lease_expires_at=NULL WHERE id=$1 AND lease_token=$3",
          [j.id, json(jobResult), claimedJob.lease_token],
        );
        pendingOutputKey = undefined;
        importedObjectKeys = [];
      } catch (e) {
        await q.query("ROLLBACK TO SAVEPOINT import_job");
        if (pendingOutputKey)
          await storage.delete(pendingOutputKey).catch(() => {});
        for (const key of importedObjectKeys)
          await storage.delete(key).catch(() => {});
        if (e instanceof ExportCancelled) {
          // Cooperative cancellation: publish nothing, remove the partial
          // artifact (if any) and the signal, and record a clean cancel.
          await q.query("DELETE FROM job_cancellations WHERE job_id=$1", [j.id]);
          await q.query(
            "UPDATE jobs SET status='cancelled',result=$2,cancelled_at=now()," +
              " completed_at=now(),lease_token=NULL,lease_expires_at=NULL" +
              " WHERE id=$1 AND lease_token=$3",
            [j.id, json({ cancelled: true }), claimedJob.lease_token],
          );
        } else {
          await q.query(
            "UPDATE jobs SET status='failed',result=$2,completed_at=now()," +
              " lease_token=NULL,lease_expires_at=NULL WHERE id=$1 AND lease_token=$3",
            [
              j.id,
              json({ error: (e as Error).message.slice(0, 300) }),
              claimedJob.lease_token,
            ],
          );
        }
      }
    });
  }
  } finally {
    if (closeStorage) storage.close?.();
  }
}
export type WorkerHealthState = {
  startedAt: number;
  lastStartedAt: number | null;
  lastCompletedAt: number | null;
  lastError: string | null;
  consecutiveFailures: number;
  running: boolean;
};

const health: WorkerHealthState = {
  startedAt: Date.now(),
  lastStartedAt: null,
  lastCompletedAt: null,
  lastError: null,
  consecutiveFailures: 0,
  running: false,
};

export function workerHealthState(): WorkerHealthState {
  return { ...health };
}

export function startWorker(db: Database, storage: Storage = createStorage()) {
  health.startedAt = Date.now();
  health.lastStartedAt = null;
  health.lastCompletedAt = null;
  health.lastError = null;
  health.consecutiveFailures = 0;
  health.running = false;
  let running: Promise<unknown> | undefined;
  const timer = setInterval(() => {
    if (running) return;
    health.running = true;
    health.lastStartedAt = Date.now();
    running = tick(db, storage)
      .then(() => {
        health.lastCompletedAt = Date.now();
        health.lastError = null;
        health.consecutiveFailures = 0;
      })
      .catch((e) => {
        health.lastError = (e as Error).message.slice(0, 200);
        health.consecutiveFailures += 1;
        console.error("Worker tick failed", e);
      })
      .finally(() => {
        health.running = false;
        running = undefined;
      });
  }, 1000);
  return async () => {
    clearInterval(timer);
    await running;
    storage.close?.();
  };
}
