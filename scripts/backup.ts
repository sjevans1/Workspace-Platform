import pg from "pg";
import { createHash } from "node:crypto";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createStorage, type Storage } from "../packages/storage/index.ts";
const tables = [
  "organisations",
  "users",
  "memberships",
  "sessions",
  "invitations",
  "resources",
  "acl",
  "page_documents",
  "page_versions",
  "databases",
  "database_records",
  "database_views",
  "comments",
  "files",
  "bookmarks",
  "notifications",
  "event_outbox",
  "webhook_subscriptions",
  "webhook_deliveries",
  "audit_events",
  "jobs",
  "object_deletions",
] as const;
const digest = (b: string | Buffer) =>
  createHash("sha256").update(b).digest("hex");
export type Archive = {
  format: "openjm-backup-v1";
  created_at: string;
  versions: string[];
  key_fingerprint: string;
  tables: Record<string, any[]>;
  objects: Record<string, { sha256: string; mime: string; data: string }>;
};
export async function backup(url: string, storage: Storage): Promise<Archive> {
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  try {
    await c.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    const result: Archive = {
      format: "openjm-backup-v1",
      created_at: new Date().toISOString(),
      versions: (
        await c.query("SELECT version FROM schema_migrations ORDER BY version")
      ).rows.map((r) => r.version),
      key_fingerprint: digest(process.env.ENCRYPTION_KEY || ""),
      tables: {},
      objects: {},
    };
    for (const t of tables)
      result.tables[t] = (
        await c.query(`SELECT row_to_json(t) AS value FROM ${t} t`)
      ).rows.map((r) => r.value);
    let total = 0;
    for (const f of result.tables.files) {
      const bytes = await storage.get(f.object_key);
      total += bytes.length;
      if (total > 1073741824)
        throw Error(
          "Logical backup exceeds 1 GiB; use PostgreSQL and object-store native backup tooling",
        );
      result.objects[f.object_key] = {
        sha256: digest(bytes),
        mime: f.mime,
        data: bytes.toString("base64"),
      };
    }
    await c.query("COMMIT");
    return result;
  } catch (e) {
    await c.query("ROLLBACK");
    throw e;
  } finally {
    await c.end();
  }
}
export async function restore(url: string, archive: Archive, storage: Storage) {
  if (
    archive.format !== "openjm-backup-v1" ||
    archive.key_fingerprint !== digest(process.env.ENCRYPTION_KEY || "")
  )
    throw Error("Archive format or encryption key does not match");
  for (const [key, v] of Object.entries(archive.objects)) {
    if (
      !/^[a-f0-9-]+\/[a-f0-9-]+\/[a-f0-9-]+$/.test(key) ||
      digest(Buffer.from(v.data, "base64")) !== v.sha256
    )
      throw Error("Archive object checksum failed");
  }
  for (const t of tables)
    if (!Array.isArray(archive.tables[t])) throw Error(`Archive missing ${t}`);
  for (const f of archive.tables.files)
    if (!archive.objects[f.object_key])
      throw Error("Archive is missing a file");
  const c = new pg.Client({ connectionString: url }),
    written: string[] = [];
  await c.connect();
  try {
    await c.query("BEGIN");
    await c.query("SELECT pg_advisory_xact_lock(4832991)");
    const versions = (
      await c.query("SELECT version FROM schema_migrations ORDER BY version")
    ).rows.map((r) => r.version);
    if (JSON.stringify(versions) !== JSON.stringify(archive.versions))
      throw Error("Restore requires the same schema version");
    for (const t of tables)
      if ((await c.query(`SELECT 1 FROM ${t} LIMIT 1`)).rowCount)
        throw Error(`Restore requires an empty database: ${t}`);
    for (const t of tables)
      if (archive.tables[t].length)
        await c.query(
          `INSERT INTO ${t} SELECT * FROM json_populate_recordset(NULL::${t},$1::json)`,
          [JSON.stringify(archive.tables[t])],
        );
    for (const [key, v] of Object.entries(archive.objects)) {
      let exists = false;
      try {
        await storage.get(key);
        exists = true;
      } catch (e: any) {
        if (
          !["ENOENT", "NoSuchKey", "NotFound"].includes(e.code || e.name) &&
          e.$metadata?.httpStatusCode !== 404
        )
          throw e;
      }
      if (exists) throw Error("Restore object destination is not empty");
      await storage.put(key, Buffer.from(v.data, "base64"), v.mime);
      written.push(key);
    }
    await c.query("COMMIT");
  } catch (e) {
    await c.query("ROLLBACK");
    for (const key of written) await storage.delete(key);
    throw e;
  } finally {
    await c.end();
  }
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (process.env.WORKSPACE_MAINTENANCE !== "true")
    throw Error(
      "Stop api, collab and worker, then set WORKSPACE_MAINTENANCE=true",
    );
  const [mode, path] = process.argv.slice(2);
  if (!path || !["backup", "restore"].includes(mode))
    throw Error("Usage: backup.ts backup|restore <archive.json>");
  const url = process.env.MIGRATION_DATABASE_URL || process.env.DATABASE_URL;
  if (!url) throw Error("Owner database URL required");
  const storage = createStorage();
  try {
    if (mode === "backup") {
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, JSON.stringify(await backup(url, storage)), {
        mode: 0o600,
        flag: "wx",
      });
      console.log(`Backup written: ${path}`);
    } else {
      await restore(url, JSON.parse(await readFile(path, "utf8")), storage);
      console.log("Restore completed");
    }
  } finally {
    storage.close?.();
  }
}
