import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { randomUUID } from "node:crypto";
import { parse } from "csv-parse/sync";
import { Database, one } from "../../../packages/database/index.ts";
import { decrypt, signature } from "../../../packages/events/index.ts";
import { assert, json } from "../../../packages/contracts/index.ts";
import { requireAccess } from "../../../packages/permissions/index.ts";
import type { Actor } from "../../../packages/auth/index.ts";
import { createResource, createRecord, purgeDeletedResource } from "../../api/src/domain.ts";
import { createStorage, type Storage } from "../../../packages/storage/index.ts";
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
export async function tick(db: Database, suppliedStorage?: Storage) {
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
          "SELECT * FROM webhook_subscriptions WHERE id=$1",
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
        if (p.format === "markdown")
          resource = await createResource(q, a, {
            parent_id: p.parent_id,
            kind: "page",
            title: p.name,
            blocks: await markdownToBlocks(p.content),
          });
        else {
          const rows = parse(p.content, {
            columns: true,
            bom: true,
            skip_empty_lines: true,
            max_record_size: 100000,
          }) as Record<string, string>[];
          assert(
            rows.length > 0 && rows.length <= 2000,
            400,
            "CSV requires 1–2000 rows",
          );
          const columns = Object.keys(rows[0]);
          assert(columns.length <= 100, 400, "CSV exceeds 100 columns");
          resource = await createResource(q, a, {
            parent_id: p.parent_id,
            kind: "database",
            title: p.name,
          });
          const props = columns.map((name, i) => ({
            id: `field${i}`,
            name,
            type: i ? "text" : "title",
          }));
          await q.query(
            "UPDATE databases SET properties=$2 WHERE resource_id=$1",
            [resource.id, json(props)],
          );
          for (const row of rows)
            await createRecord(
              q,
              a,
              resource.id,
              Object.fromEntries(
                columns.map((k, i) => [
                  `field${i}`,
                  row[k] || (i ? "" : "Untitled"),
                ]),
              ),
            );
        }
        await q.query(
          "UPDATE jobs SET status='completed',result=$2 WHERE id=$1",
          [j.id, json({ resource_id: resource.id })],
        );
      } catch (e) {
        await q.query("ROLLBACK TO SAVEPOINT import_job");
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
