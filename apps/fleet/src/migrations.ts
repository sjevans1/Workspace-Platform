// OCP-2A: versioned fleet migrations.
//
// The fleet schema is versioned rather than assumed: a ledger records what has been
// applied, migrations run in order, each in its own transaction, and applying them is
// idempotent. The service still applies pending migrations on boot, but schema
// evolution is explicit and ordered, and there is no destructive implicit rewrite.
// Fleet migrations are entirely separate from customer Workspace tenant migrations.
import { readFileSync } from "node:fs";
import pg from "pg";

export type FleetMigration = { version: number; name: string; sql: string };

export const FLEET_MIGRATIONS: FleetMigration[] = [
  {
    version: 1,
    name: "initial",
    sql: readFileSync(new URL("./migrations/001_initial.sql", import.meta.url), "utf8"),
  },
];

export const FLEET_MIGRATION_LEDGER = "fleet_schema_migrations";

// Applies every pending migration in ascending order and returns the versions applied.
export async function runFleetMigrations(pool: pg.Pool, migrations: FleetMigration[] = FLEET_MIGRATIONS): Promise<number[]> {
  const versions = migrations.map((m) => m.version);
  if (new Set(versions).size !== versions.length) throw new Error("Duplicate fleet migration version");
  await pool.query(
    `CREATE TABLE IF NOT EXISTS ${FLEET_MIGRATION_LEDGER}(version integer PRIMARY KEY, name text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())`,
  );
  const applied = new Set<number>(
    (await pool.query(`SELECT version FROM ${FLEET_MIGRATION_LEDGER}`)).rows.map((row: any) => Number(row.version)),
  );
  const pending = migrations.filter((m) => !applied.has(m.version)).sort((a, b) => a.version - b.version);
  const done: number[] = [];
  for (const migration of pending) {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(migration.sql);
      await client.query(`INSERT INTO ${FLEET_MIGRATION_LEDGER}(version,name) VALUES($1,$2)`, [migration.version, migration.name]);
      await client.query("COMMIT");
      done.push(migration.version);
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }
  return done;
}

export async function fleetSchemaVersion(pool: pg.Pool): Promise<number> {
  try {
    const rows = await pool.query(`SELECT COALESCE(MAX(version),0) AS version FROM ${FLEET_MIGRATION_LEDGER}`);
    return Number(rows.rows[0]?.version ?? 0);
  } catch {
    return 0;
  }
}
