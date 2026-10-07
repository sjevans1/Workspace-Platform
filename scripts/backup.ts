import pg from "pg";
import {
  createHash,
  createCipheriv,
  createDecipheriv,
  hkdfSync,
  randomBytes,
} from "node:crypto";
import { readFile, writeFile, mkdir, readdir, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createStorage, type Storage } from "../packages/storage/index.ts";
const tables = [
  "organisations",
  "users",
  "memberships",
  "sessions",
  "oidc_identities",
  // Restore logout replay protection, but intentionally do not persist
  // short-lived oidc_login_states (PKCE/nonce authorization-flow state).
  "oidc_logout_events",
  "oidc_tenant_providers",
  "scim_connectors",
  "scim_users",
  "scim_groups",
  "scim_group_role_mappings",
  "scim_group_members",
  "invitations",
  "resources",
  "acl",
  "page_documents",
  "page_versions",
  "resource_links",
  "databases",
  "database_records",
  "database_views",
  "comments",
  "files",
  "bookmarks",
  "notifications",
  "notification_preferences",
  "event_outbox",
  "webhook_subscriptions",
  "webhook_deliveries",
  "audit_events",
  "jobs",
  "job_artifacts",
  "object_deletions",
] as const;
const digest = (b: string | Buffer) =>
  createHash("sha256").update(b).digest("hex"),
  backupEnvelopeFormat = "openjm-backup-encrypted-v1";

function backupKey() {
  const value = process.env.ENCRYPTION_KEY || "";
  if (!/^[a-f0-9]{64}$/i.test(value))
    throw new Error("ENCRYPTION_KEY must contain 64 hex characters");
  return Buffer.from(
    hkdfSync(
      "sha256",
      Buffer.from(value, "hex"),
      Buffer.from("openjm-workspace"),
      Buffer.from("backup-archive-v1"),
      32,
    ),
  );
}

export function encodeBackup(archive: Archive) {
  const iv = randomBytes(12),
    cipher = createCipheriv("aes-256-gcm", backupKey(), iv);
  cipher.setAAD(Buffer.from(backupEnvelopeFormat));
  const body = Buffer.concat([
    cipher.update(Buffer.from(JSON.stringify(archive))),
    cipher.final(),
  ]);
  return JSON.stringify({
    format: backupEnvelopeFormat,
    iv: iv.toString("base64url"),
    tag: cipher.getAuthTag().toString("base64url"),
    data: body.toString("base64url"),
  });
}

export function decodeBackup(
  text: string,
  env: NodeJS.ProcessEnv = process.env,
): Archive {
  const envelope = JSON.parse(text);
  if (envelope?.format === "openjm-backup-v1") {
    if (env.ALLOW_LEGACY_PLAINTEXT_BACKUP !== "true")
      throw new Error(
        "Legacy plaintext backup refused; set ALLOW_LEGACY_PLAINTEXT_BACKUP=true only for a controlled one-time restore",
      );
    return envelope as Archive;
  }
  if (
    envelope?.format !== backupEnvelopeFormat ||
    typeof envelope.iv !== "string" ||
    typeof envelope.tag !== "string" ||
    typeof envelope.data !== "string"
  )
    throw new Error("Unsupported backup envelope");
  try {
    const decipher = createDecipheriv(
      "aes-256-gcm",
      backupKey(),
      Buffer.from(envelope.iv, "base64url"),
    );
    decipher.setAAD(Buffer.from(backupEnvelopeFormat));
    decipher.setAuthTag(Buffer.from(envelope.tag, "base64url"));
    const plain = Buffer.concat([
      decipher.update(Buffer.from(envelope.data, "base64url")),
      decipher.final(),
    ]);
    const archive = JSON.parse(plain.toString());
    if (archive?.format !== "openjm-backup-v1")
      throw new Error("Invalid backup payload");
    return archive as Archive;
  } catch {
    throw new Error("Backup decryption failed");
  }
}
export type Archive = {
  format: "openjm-backup-v1";
  created_at: string;
  versions: string[];
  key_fingerprint: string;
  tables: Record<string, any[]>;
  objects: Record<string, { sha256: string; mime: string; data: string }>;
};

export type BackupSummary = {
  format: string;
  created_at: string;
  schema_versions: number;
  newest_schema_version: string | null;
  tables: number;
  rows: number;
  objects: number;
  object_bytes: number;
  key_fingerprint: string;
};

export type BackupComparison = {
  tables: number;
  rows: number;
  objects: number;
  object_bytes: number;
};

export function compareBackups(
  leftText: string,
  rightText: string,
  env: NodeJS.ProcessEnv = process.env,
): BackupComparison {
  verifyBackup(leftText, env);
  verifyBackup(rightText, env);
  const left = decodeBackup(leftText, env),
    right = decodeBackup(rightText, env);
  if (JSON.stringify(left.versions) !== JSON.stringify(right.versions))
    throw new Error("Backup schema versions differ");
  if (left.key_fingerprint !== right.key_fingerprint)
    throw new Error("Backup encryption-key fingerprints differ");

  let rows = 0;
  for (const table of tables) {
    const canonical = (archive: Archive) =>
      [...(archive.tables[table] || [])]
        .map((row) => JSON.stringify(row))
        .sort();
    const a = canonical(left),
      b = canonical(right);
    rows += a.length;
    if (JSON.stringify(a) !== JSON.stringify(b))
      throw new Error(`Backup table content differs: ${table}`);
  }

  const objectShape = (archive: Archive) =>
    Object.entries(archive.objects || {})
      .map(([key, value]) => [
        key,
        value.sha256,
        value.mime,
        Buffer.from(value.data, "base64").length,
      ])
      .sort((a, b) => String(a[0]).localeCompare(String(b[0])));
  const leftObjects = objectShape(left),
    rightObjects = objectShape(right);
  if (JSON.stringify(leftObjects) !== JSON.stringify(rightObjects))
    throw new Error("Backup object catalogs differ");

  return {
    tables: tables.length,
    rows,
    objects: leftObjects.length,
    object_bytes: leftObjects.reduce((sum, item) => sum + Number(item[3]), 0),
  };
}

// Read-only integrity check used by operators and CI before trusting an
// archive. It never touches the database or the object store, and it refuses
// an archive that was produced with a different deployment key, because the
// contained attachment bytes could not be decrypted after such a restore.
export function verifyBackup(
  text: string,
  env: NodeJS.ProcessEnv = process.env,
): BackupSummary {
  const archive = decodeBackup(text, env);
  if (!Array.isArray(archive.versions)) throw new Error("Backup has no schema versions");
  if (!archive.tables || typeof archive.tables !== "object")
    throw new Error("Backup has no table data");
  const fingerprint = digest(env.ENCRYPTION_KEY || "");
  if (archive.key_fingerprint !== fingerprint)
    throw new Error(
      "Backup was produced with a different ENCRYPTION_KEY; it cannot be restored by this deployment",
    );
  let rows = 0,
    objectBytes = 0;
  for (const table of tables) {
    const entries = archive.tables[table];
    if (!Array.isArray(entries))
      throw new Error(`Backup is missing durable table: ${table}`);
    rows += entries.length;
  }
  for (const [key, entry] of Object.entries(archive.objects || {})) {
    if (!entry || typeof entry.data !== "string" || typeof entry.sha256 !== "string")
      throw new Error(`Backup object ${key} is malformed`);
    const bytes = Buffer.from(entry.data, "base64");
    if (digest(bytes) !== entry.sha256)
      throw new Error(`Backup object ${key} failed its checksum`);
    objectBytes += bytes.length;
  }
  for (const file of archive.tables.files)
    if (!archive.objects[file.object_key])
      throw new Error("Backup is missing a file object");
  for (const artifact of archive.tables.job_artifacts)
    if (!archive.objects[artifact.object_key])
      throw new Error("Backup is missing a job artifact object");
  return {
    format: archive.format,
    created_at: archive.created_at,
    schema_versions: archive.versions.length,
    newest_schema_version: archive.versions.length
      ? archive.versions[archive.versions.length - 1]
      : null,
    tables: Object.keys(archive.tables).length,
    rows,
    objects: Object.keys(archive.objects || {}).length,
    object_bytes: objectBytes,
    key_fingerprint: archive.key_fingerprint,
  };
}

// Bounded retention. Only files that verify as encrypted Workspace backups are
// candidates for deletion, so an operator file or an unreadable archive is
// reported and kept rather than silently removed.
export async function rotateBackups(
  directory: string,
  keep: number,
): Promise<{ kept: string[]; removed: string[]; skipped: string[] }> {
  if (!Number.isSafeInteger(keep) || keep < 1)
    throw new Error("Retention count must be a positive integer");
  const verified: { name: string; created_at: string }[] = [],
    skipped: string[] = [];
  for (const name of (await readdir(directory)).filter((n) => n.endsWith(".json")).sort()) {
    try {
      verified.push({
        name,
        created_at: verifyBackup(await readFile(join(directory, name), "utf8")).created_at,
      });
    } catch {
      skipped.push(name);
    }
  }
  verified.sort(
    (a, b) => b.created_at.localeCompare(a.created_at) || a.name.localeCompare(b.name),
  );
  const removed = verified.slice(keep).map((entry) => entry.name);
  for (const name of removed) await rm(join(directory, name));
  return { kept: verified.slice(0, keep).map((entry) => entry.name), removed, skipped };
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
    const captureObject = async (
      row: { object_key: string; mime: string; size?: number | string; sha256?: string },
    ) => {
      if (result.objects[row.object_key])
        throw Error("Duplicate backup object key across durable catalogs");
      const bytes = await storage.get(row.object_key);
      if (row.size !== undefined && bytes.length !== Number(row.size))
        throw Error("Backup object size does not match catalog metadata");
      const sha256 = digest(bytes);
      if (row.sha256 !== undefined && sha256 !== row.sha256)
        throw Error("Backup object checksum does not match catalog metadata");
      total += bytes.length;
      if (total > 1073741824)
        throw Error(
          "Logical backup exceeds 1 GiB; use PostgreSQL and object-store native backup tooling",
        );
      result.objects[row.object_key] = {
        sha256,
        mime: row.mime,
        data: bytes.toString("base64"),
      };
    };
    for (const file of result.tables.files) await captureObject(file);
    for (const artifact of result.tables.job_artifacts)
      await captureObject(artifact);
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
  for (const artifact of archive.tables.job_artifacts)
    if (!archive.objects[artifact.object_key])
      throw Error("Archive is missing a job artifact");
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
  const [mode, target, ...rest] = process.argv.slice(2);
  if (!target || !["backup", "restore", "verify", "rotate", "compare"].includes(mode))
    throw Error(
      "Usage: backup.ts backup|restore|verify <archive.json>" +
        " | backup.ts compare <source.json> <restored.json>" +
        " | backup.ts rotate <directory> --keep <count>",
    );
  if (mode === "verify") {
    // Read-only integrity check: no maintenance window and no database access.
    const summary = verifyBackup(await readFile(target, "utf8"));
    console.log(JSON.stringify(summary, null, 2));
    console.log(`Backup verified: ${target}`);
  } else if (mode === "compare") {
    const other = rest[0];
    if (!other)
      throw Error("Usage: backup.ts compare <source.json> <restored.json>");
    const comparison = compareBackups(
      await readFile(target, "utf8"),
      await readFile(other, "utf8"),
    );
    console.log(JSON.stringify(comparison, null, 2));
    console.log(`Backup contents match: ${target} == ${other}`);
  } else if (mode === "rotate") {
    const keepFlag = rest.indexOf("--keep");
    const keep = Number(rest[keepFlag + 1]);
    if (keepFlag < 0 || !Number.isSafeInteger(keep) || keep < 1)
      throw Error("Usage: backup.ts rotate <directory> --keep <count>");
    const result = await rotateBackups(target, keep);
    console.log(
      `Retained ${result.kept.length} encrypted backup(s), removed ` +
        (result.removed.length ? result.removed.join(", ") : "none") +
        (result.skipped.length
          ? `, kept ${result.skipped.length} unverified file(s) untouched: ${result.skipped.join(", ")}`
          : ""),
    );
  } else {
    if (process.env.WORKSPACE_MAINTENANCE !== "true")
      throw Error(
        "Stop api, collab and worker, then set WORKSPACE_MAINTENANCE=true",
      );
    const url = process.env.MIGRATION_DATABASE_URL || process.env.DATABASE_URL;
    if (!url) throw Error("Owner database URL required");
    const storage = createStorage();
    try {
      if (mode === "backup") {
        await mkdir(dirname(target), { recursive: true });
        await writeFile(target, encodeBackup(await backup(url, storage)), {
          mode: 0o600,
          flag: "wx",
        });
        console.log(`Backup written: ${target}`);
      } else {
        await restore(url, decodeBackup(await readFile(target, "utf8")), storage);
        console.log("Restore completed");
      }
    } finally {
      storage.close?.();
    }
  }
}
