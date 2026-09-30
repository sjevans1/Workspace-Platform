import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import pg from "pg";
import { testPostgres } from "../scripts/test-postgres.ts";
import { migrate } from "../packages/database/migrate.ts";

test("migration failure rolls back, corrected retry succeeds, and applied files are immutable", async () => {
  const database = await testPostgres(55439);
  const dir = await mkdtemp(`${tmpdir()}/workspace-migrations-`);
  const client = new pg.Client({ connectionString: database.url });
  await client.connect();
  try {
    const first = "CREATE TABLE migration_probe(id integer PRIMARY KEY);\n";
    await writeFile(`${dir}/001_probe.sql`, first);
    await writeFile(
      `${dir}/002_retry.sql`,
      [
        "CREATE TABLE rolled_back_probe(id integer PRIMARY KEY);",
        "INSERT INTO table_that_does_not_exist(id) VALUES(1);",
      ].join("\n"),
    );

    await assert.rejects(
      migrate(database.url, { directory: dir }),
      /table_that_does_not_exist|does not exist/i,
    );

    const appliedAfterFailure = await client.query(
      "SELECT version,checksum FROM schema_migrations ORDER BY version",
    );
    assert.deepEqual(
      appliedAfterFailure.rows.map((row) => row.version),
      ["001_probe.sql"],
    );
    assert.match(appliedAfterFailure.rows[0].checksum, /^[a-f0-9]{64}$/);
    assert.equal(
      (
        await client.query(
          "SELECT to_regclass('public.rolled_back_probe') AS relation",
        )
      ).rows[0].relation,
      null,
    );

    await writeFile(
      `${dir}/002_retry.sql`,
      "CREATE TABLE recovered_probe(id integer PRIMARY KEY);\n",
    );
    await migrate(database.url, { directory: dir });
    await migrate(database.url, { directory: dir });

    const appliedAfterRecovery = await client.query(
      "SELECT version,checksum FROM schema_migrations ORDER BY version",
    );
    assert.deepEqual(
      appliedAfterRecovery.rows.map((row) => row.version),
      ["001_probe.sql", "002_retry.sql"],
    );
    assert.ok(
      appliedAfterRecovery.rows.every((row) =>
        /^[a-f0-9]{64}$/.test(row.checksum),
      ),
    );
    assert.equal(
      (
        await client.query(
          "SELECT to_regclass('public.recovered_probe') AS relation",
        )
      ).rows[0].relation,
      "recovered_probe",
    );

    await writeFile(
      `${dir}/001_probe.sql`,
      first + "-- historical file was edited\n",
    );
    await assert.rejects(
      migrate(database.url, { directory: dir }),
      /checksum mismatch.*001_probe\.sql/i,
    );
  } finally {
    await client.end();
    await database.close();
    await rm(dir, { recursive: true, force: true });
  }
});
