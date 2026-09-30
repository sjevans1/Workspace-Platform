import test from "node:test";
import assert from "node:assert/strict";
import { testPostgres } from "../scripts/test-postgres.ts";
import { migrate } from "../packages/database/migrate.ts";
import { Database } from "../packages/database/index.ts";

test("migrations are concurrent-safe, idempotent and checksum protected", async () => {
  const pg = await testPostgres(55436);
  try {
    if (pg.emulated) {
      await migrate(pg.url);
      await migrate(pg.url);
    } else {
      await Promise.all([migrate(pg.url), migrate(pg.url)]);
    }

    const db = new Database(pg.url, { serialize: pg.emulated });
    try {
      const initial = await db.system((q) =>
        q.query(
          "SELECT version,checksum FROM schema_migrations ORDER BY version",
        ),
      );
      assert.ok(initial.rows.length >= 3);
      for (const row of initial.rows)
        assert.match(row.checksum, /^[a-f0-9]{64}$/);

      // Re-running an unchanged migration set must be a no-op.
      await migrate(pg.url);
      const repeated = await db.system((q) =>
        q.query(
          "SELECT version,checksum FROM schema_migrations ORDER BY version",
        ),
      );
      assert.deepEqual(repeated.rows, initial.rows);

      // Existing deployments created before checksums are adopted once, then
      // the column is locked back to NOT NULL.
      await db.system(async (q) => {
        await q.query(
          "ALTER TABLE schema_migrations ALTER COLUMN checksum DROP NOT NULL",
        );
        await q.query(
          "UPDATE schema_migrations SET checksum=NULL WHERE version=$1",
          [initial.rows[0].version],
        );
      });
      await migrate(pg.url);
      const adopted = await db.system((q) =>
        q.query(
          "SELECT checksum FROM schema_migrations WHERE version=$1",
          [initial.rows[0].version],
        ),
      );
      assert.match(adopted.rows[0].checksum, /^[a-f0-9]{64}$/);

      // A historical migration whose recorded digest no longer matches the
      // repository must fail before any later migration can run.
      await db.system((q) =>
        q.query(
          "UPDATE schema_migrations SET checksum=$2 WHERE version=$1",
          [initial.rows[0].version, "0".repeat(64)],
        ),
      );
      await assert.rejects(
        migrate(pg.url),
        /Migration checksum mismatch.*historical migrations are immutable/,
      );
      const afterFailure = await db.system((q) =>
        q.query("SELECT count(*)::int n FROM schema_migrations"),
      );
      assert.equal(afterFailure.rows[0].n, initial.rows.length);
    } finally {
      await db.close();
    }
  } finally {
    await pg.close();
  }
});
