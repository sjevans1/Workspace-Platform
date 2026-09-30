import pg from "pg";
import { readdir, readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
export async function migrate(
  url: string,
  options: { directory?: string } = {},
) {
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  try {
    await c.query("SELECT pg_advisory_lock(4832991)");
    await c.query(
      "CREATE TABLE IF NOT EXISTS schema_migrations(version text PRIMARY KEY,applied_at timestamptz DEFAULT now())",
    );
    await c.query(
      "ALTER TABLE schema_migrations ADD COLUMN IF NOT EXISTS checksum text",
    );
    const dir =
      options.directory ||
      fileURLToPath(
        new URL("../../infrastructure/migrations/", import.meta.url),
      );
    for (const name of (await readdir(dir))
      .filter((n) => n.endsWith(".sql"))
      .sort()) {
      const sql = await readFile(`${dir}/${name}`, "utf8"),
        checksum = createHash("sha256").update(sql).digest("hex"),
        applied = await c.query(
          "SELECT checksum FROM schema_migrations WHERE version=$1",
          [name],
        );
      if (applied.rowCount) {
        const existing = applied.rows[0].checksum;
        if (existing === null) {
          await c.query(
            "UPDATE schema_migrations SET checksum=$2 WHERE version=$1 AND checksum IS NULL",
            [name, checksum],
          );
        } else if (existing !== checksum) {
          throw new Error(
            `Migration checksum mismatch for ${name}; historical migrations are immutable`,
          );
        }
        continue;
      }
      await c.query("BEGIN");
      try {
        await c.query(sql);
        await c.query(
          "INSERT INTO schema_migrations(version,checksum) VALUES($1,$2)",
          [name, checksum],
        );
        await c.query("COMMIT");
      } catch (e) {
        await c.query("ROLLBACK");
        throw e;
      }
    }
    if (process.env.RUNTIME_DB_PASSWORD) {
      if (
        !(
          await c.query(
            "SELECT 1 FROM pg_roles WHERE rolname='workspace_runtime'",
          )
        ).rowCount
      )
        await c.query(
          "CREATE ROLE workspace_runtime LOGIN NOSUPERUSER NOBYPASSRLS",
        );
      await c.query(
        `ALTER ROLE workspace_runtime PASSWORD '${process.env.RUNTIME_DB_PASSWORD.replaceAll("'", "''")}'`,
      );
      await c.query("GRANT workspace_app TO workspace_runtime");
    }
  } finally {
    await c.query("SELECT pg_advisory_unlock(4832991)");
    await c.end();
  }
}
if (process.argv[1] === fileURLToPath(import.meta.url))
  await migrate(
    process.env.MIGRATION_DATABASE_URL || process.env.DATABASE_URL || "",
  );
