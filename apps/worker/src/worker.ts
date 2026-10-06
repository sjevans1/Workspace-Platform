import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { createHash, randomUUID } from "node:crypto";
import { prepareCsvImport, prepareCsvIntoExisting, csvSchemaDigest } from "../../../packages/imports/csv.ts";
import { Database, one } from "../../../packages/database/index.ts";
import { decrypt, emit, signature } from "../../../packages/events/index.ts";
import { assert, json } from "../../../packages/contracts/index.ts";
import { requireAccess } from "../../../packages/permissions/index.ts";
import type { Actor } from "../../../packages/auth/index.ts";
import { createResource, createRecord, purgeDeletedResource } from "../../api/src/domain.ts";
import { createStorage, type Storage } from "../../../packages/storage/index.ts";
import { createAntivirus, type Antivirus } from "../../../packages/security/antivirus.ts";
import { exportPortableTree } from "../../api/src/portable-export.ts";
import { importPortableArchive } from "../../api/src/portable-import.ts";
import { markdownToBlocks } from "../../../packages/editor/server.ts";
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
      for (const d of (
        await q.query(
          "SELECT * FROM webhook_deliveries WHERE status IN ('pending','retry') AND next_at<=now() ORDER BY next_at LIMIT 10 FOR UPDATE SKIP LOCKED",
        )
      ).rows) {
        const s = await one(
          q,
          // Retain a read lock through the send/commit. Secret activation waits
          // for already-started delivery transactions to finish signing.
          "SELECT * FROM webhook_subscriptions WHERE id=$1 FOR SHARE",
          [d.subscription_id],
        );
        if (!s?.active) {
          await q.query(
            "UPDATE webhook_deliveries SET status='cancelled' WHERE id=$1",
            [d.id],
          );
          continue;
        }
        const e = await one(q, "SELECT * FROM event_outbox WHERE id=$1", [
          d.event_id,
        ]);
        try {
          await deliver(s.url, decrypt(s.secret_encrypted), e);
          await q.query(
            "UPDATE webhook_deliveries SET status='delivered',attempts=attempts+1,last_error=NULL WHERE id=$1",
            [d.id],
          );
        } catch (err) {
          await q.query(
            "UPDATE webhook_deliveries SET status=$2,attempts=attempts+1,last_error=$3,next_at=now()+$4::interval WHERE id=$1",
            [
              d.id,
              d.attempts >= 7 ? "dead" : "retry",
              (err as Error).message.slice(0, 200),
              `${Math.min(3600, 5 * 2 ** d.attempts)} seconds`,
            ],
          );
        }
      }
    });
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
    await db.tenant(tenant, async (q) => {
      const j = await one(
        q,
        "SELECT * FROM jobs WHERE status='pending' ORDER BY created_at LIMIT 1 FOR UPDATE SKIP LOCKED",
      );
      if (!j) return;
      await q.query("SAVEPOINT import_job");
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
        await requireAccess(q, a, j.resource_id, 3);
        const p = j.payload;
        let resource;
        let jobResult: any;
        let stagedOutputKey: string | undefined;
        if (p.format === "workspace_archive_export") {
          const source = await requireAccess(q, a, p.source_id);
          assert(source.id === j.resource_id, 400, "Archive export source changed");
          const archive = await exportPortableTree(q, a, source.id, storage);
          const artifactId = randomUUID(),
            key = `${tenant}/${source.id}/${artifactId}`,
            digest = createHash("sha256").update(archive).digest("hex");
          await storage.put(key, archive, "application/zip");
          stagedOutputKey = key;
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
          );
          await q.query(
            "INSERT INTO object_deletions(id,tenant_id,object_key,reason)" +
              " VALUES($1,$2,$3,'job_input_consumed')" +
              " ON CONFLICT(tenant_id,object_key) DO NOTHING",
            [randomUUID(), tenant, artifact.object_key],
          );
          await q.query("DELETE FROM job_artifacts WHERE id=$1", [artifact.id]);
          resource = { id: imported.resource_id };
          jobResult = imported;
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
            // APPEND ONLY: no duplicate probing against hidden records and no
            // SQL UPDATE. Recheck parent/target membership and hold schema
            // row lock until all records are inserted and job completes.
            assert(p.existing_mode === "append" &&
              typeof p.expected_schema_digest === "string" &&
              Array.isArray(p.mapping),400,
              "Existing import requires an explicit mapping and append mode");
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
            for (const values of prepared.rows)
              await createRecord(q,a,target.id,values);
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
          "UPDATE jobs SET status='completed',result=$2 WHERE id=$1",
          [j.id, json(jobResult)],
        );
      } catch (e) {
        const outputArtifact = await one(
          q,
          "SELECT object_key FROM job_artifacts WHERE job_id=$1 AND kind='output'",
          [j.id],
        ).catch(() => null);
        await q.query("ROLLBACK TO SAVEPOINT import_job");
        if (outputArtifact?.object_key)
          await storage.delete(outputArtifact.object_key).catch(() => {});
        await q.query("UPDATE jobs SET status='failed',result=$2 WHERE id=$1", [
          j.id,
          json({ error: (e as Error).message.slice(0, 300) }),
        ]);
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
