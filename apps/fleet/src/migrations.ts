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
  {
    version: 2,
    name: "audit_retention_index",
    sql: readFileSync(new URL("./migrations/002_audit_retention_index.sql", import.meta.url), "utf8"),
  },
];

export const FLEET_MIGRATION_LEDGER = "fleet_schema_migrations";

// Serializes migration application across replicas with a database-level advisory lock.
// The key is a fixed constant owned by the fleet schema, deliberately independent of any
// customer Workspace migration state, so concurrent startup cannot race: a second replica
// blocks until the first has finished and released the lock.
// "W27MIGRT" as a signed 64-bit advisory-lock key, so the fleet schema has one stable
// serialization identity across replicas.
export const FLEET_MIGRATION_LOCK_KEY = 0x574632374d494752n;

// Applies every pending migration in ascending order and returns the versions applied.
export type FleetMigrationHooks = {
  // Test-only seam: forces the unlock query itself to fail so the safe cleanup contract can be
  // proven deterministically.
  beforeAdvisoryUnlock?: () => void;
};

export async function runFleetMigrations(
  pool: pg.Pool,
  migrations: FleetMigration[] = FLEET_MIGRATIONS,
  hooks?: FleetMigrationHooks,
): Promise<number[]> {
  const versions = migrations.map((m) => m.version);
  if (new Set(versions).size !== versions.length) throw new Error("Duplicate fleet migration version");
  await pool.query(
    `CREATE TABLE IF NOT EXISTS ${FLEET_MIGRATION_LEDGER}(version integer PRIMARY KEY, name text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())`,
  );
  // One replica at a time. The lock is held for the whole apply loop and released on both
  // success and failure; the ledger is read AFTER acquiring it, so a replica that waited
  // observes migrations another replica already applied and applies nothing.
  const lock = await pool.connect();
  try {
    await lock.query("SELECT pg_advisory_lock($1::bigint)", [FLEET_MIGRATION_LOCK_KEY.toString()]);
    const applied = new Set<number>(
      (await lock.query(`SELECT version FROM ${FLEET_MIGRATION_LEDGER}`)).rows.map((row: any) => Number(row.version)),
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
  } finally {
    // Released in a finally so a failed migration cannot leave the fleet schema locked. A
    // session advisory lock lives for the lifetime of the session, so if the unlock cannot be
    // confirmed the connection is DESTROYED rather than returned to the pool: releasing it
    // normally could hand a still-locked session back to another caller.
    let unlocked = false;
    try {
      hooks?.beforeAdvisoryUnlock?.();
      await lock.query("SELECT pg_advisory_unlock($1::bigint)", [FLEET_MIGRATION_LOCK_KEY.toString()]);
      unlocked = true;
    } catch {
      unlocked = false;
    }
    lock.release(!unlocked);
  }
}

export async function fleetSchemaVersion(pool: pg.Pool): Promise<number> {
  try {
    const rows = await pool.query(`SELECT COALESCE(MAX(version),0) AS version FROM ${FLEET_MIGRATION_LEDGER}`);
    return Number(rows.rows[0]?.version ?? 0);
  } catch {
    return 0;
  }
}
