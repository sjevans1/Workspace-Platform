import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

test("environment generator creates distinct protected application and backup keys and refuses overwrite", async () => {
  const dir = await mkdtemp(join(tmpdir(), "openjm-env-")),
    path = join(dir, ".env");
  try {
    const first = spawnSync(process.execPath, ["scripts/init-env.mjs", path], {
      cwd: process.cwd(),
      encoding: "utf8",
    });
    assert.equal(first.status, 0, first.stderr || first.stdout);

    const body = await readFile(path, "utf8"),
      app = body.match(/^ENCRYPTION_KEY=([a-f0-9]{64})$/m)?.[1],
      backup = body.match(/^BACKUP_ENCRYPTION_KEY=([a-f0-9]{64})$/m)?.[1];
    assert.ok(app, "missing generated ENCRYPTION_KEY");
    assert.ok(backup, "missing generated BACKUP_ENCRYPTION_KEY");
    assert.notEqual(app, backup);
    assert.equal((await stat(path)).mode & 0o777, 0o600);

    const second = spawnSync(process.execPath, ["scripts/init-env.mjs", path], {
      cwd: process.cwd(),
      encoding: "utf8",
    });
    assert.notEqual(second.status, 0);
    assert.match(second.stderr, /refusing to replace secrets/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
