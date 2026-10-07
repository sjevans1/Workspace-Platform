import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  compareBackups,
  encodeBackup,
  rotateBackups,
  verifyBackup,
  type Archive,
} from "../scripts/backup.ts";

const key = "a".repeat(64);
const fingerprint = createHash("sha256").update(key).digest("hex");

function archive(overrides: Partial<Archive> = {}): Archive {
  const bytes = Buffer.from("attachment bytes");
  return {
    format: "openjm-backup-v1",
    created_at: "2026-10-07T00:00:00.000Z",
    versions: ["001_initial.sql", "002_retention.sql"],
    key_fingerprint: fingerprint,
    tables: { organisations: [{ id: "org-1" }], users: [] },
    objects: {
      "org-1/file-1": {
        sha256: createHash("sha256").update(bytes).digest("hex"),
        mime: "text/plain",
        data: bytes.toString("base64"),
      },
    },
    ...overrides,
  };
}

test("W23 backup verification accepts a sound archive and refuses unsafe ones", () => {
  process.env.ENCRYPTION_KEY = key;
  const summary = verifyBackup(encodeBackup(archive()));
  assert.equal(summary.format, "openjm-backup-v1");
  assert.equal(summary.newest_schema_version, "002_retention.sql");
  assert.equal(summary.schema_versions, 2);
  assert.equal(summary.tables, 2);
  assert.equal(summary.rows, 1);
  assert.equal(summary.objects, 1);
  assert.equal(summary.object_bytes, "attachment bytes".length);
  assert.equal(summary.key_fingerprint, fingerprint);

  // A deployment holding a different key cannot read the archive offered to it.
  assert.throws(
    () =>
      verifyBackup(encodeBackup(archive()), {
        ...process.env,
        ENCRYPTION_KEY: "b".repeat(64),
      }),
    /different ENCRYPTION_KEY/,
  );

  // A tampered attachment fails its checksum instead of restoring silently.
  const tampered = archive();
  tampered.objects["org-1/file-1"].sha256 = createHash("sha256")
    .update("other bytes")
    .digest("hex");
  assert.throws(() => verifyBackup(encodeBackup(tampered)), /failed its checksum/);

  // A corrupted ciphertext never reaches archive parsing.
  const envelope = JSON.parse(encodeBackup(archive()));
  envelope.data = Buffer.from("not the same ciphertext").toString("base64url");
  assert.throws(
    () => verifyBackup(JSON.stringify(envelope)),
    /Backup decryption failed/,
  );
});

test("W23 backup comparison detects durable table and object drift", () => {
  process.env.ENCRYPTION_KEY = key;
  const left = archive();
  const same = structuredClone(left);
  same.created_at = "2026-10-08T00:00:00.000Z";
  const comparison = compareBackups(encodeBackup(left), encodeBackup(same));
  assert.equal(comparison.rows, 1);
  assert.equal(comparison.objects, 1);
  assert.equal(comparison.object_bytes, "attachment bytes".length);

  const tableDrift = structuredClone(left);
  tableDrift.tables.organisations = [{ id: "org-2" }];
  assert.throws(
    () => compareBackups(encodeBackup(left), encodeBackup(tableDrift)),
    /table content differs: organisations/,
  );

  const objectDrift = structuredClone(left);
  const changed = Buffer.from("different attachment bytes");
  objectDrift.objects["org-1/file-1"] = {
    sha256: createHash("sha256").update(changed).digest("hex"),
    mime: "text/plain",
    data: changed.toString("base64"),
  };
  assert.throws(
    () => compareBackups(encodeBackup(left), encodeBackup(objectDrift)),
    /object catalogs differ/,
  );
});

test("W23 backup rotation bounds retention without deleting unverified files", async () => {
  process.env.ENCRYPTION_KEY = key;
  const directory = await mkdtemp(join(tmpdir(), "workspace-backup-"));
  try {
    for (const [name, created] of [
      ["workspace-2026-10-01.json", "2026-10-01T00:00:00.000Z"],
      ["workspace-2026-10-02.json", "2026-10-02T00:00:00.000Z"],
      ["workspace-2026-10-03.json", "2026-10-03T00:00:00.000Z"],
    ])
      await writeFile(
        join(directory, name),
        encodeBackup(archive({ created_at: created })),
        { mode: 0o600 },
      );
    // An unreadable file must be reported and kept, never deleted.
    await writeFile(join(directory, "notes.json"), "not a backup", {
      mode: 0o600,
    });

    const result = await rotateBackups(directory, 2);
    assert.deepEqual(result.kept, [
      "workspace-2026-10-03.json",
      "workspace-2026-10-02.json",
    ]);
    assert.deepEqual(result.removed, ["workspace-2026-10-01.json"]);
    assert.deepEqual(result.skipped, ["notes.json"]);
    assert.deepEqual((await readdir(directory)).sort(), [
      "notes.json",
      "workspace-2026-10-02.json",
      "workspace-2026-10-03.json",
    ]);

    // Retention must be explicit; an unbounded or nonsensical count is refused.
    await assert.rejects(() => rotateBackups(directory, 0), /positive integer/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
