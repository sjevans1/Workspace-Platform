import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createStorage,
  createUnencryptedStorage,
  isEncryptedStoredObject,
} from "../packages/storage/index.ts";

test("local storage encrypts new objects and enforces legacy-read versus required mode", async () => {
  const root = await mkdtemp(join(tmpdir(), "openjm-storage-encryption-")),
    base = {
      STORAGE_PROVIDER: "local",
      STORAGE_LOCAL_PATH: root,
      ENCRYPTION_KEY: "c".repeat(64),
    } as NodeJS.ProcessEnv,
    encryptedKey =
      "11111111-1111-1111-1111-111111111111/22222222-2222-2222-2222-222222222222/33333333-3333-3333-3333-333333333333",
    legacyKey =
      "11111111-1111-1111-1111-111111111111/22222222-2222-2222-2222-222222222222/44444444-4444-4444-4444-444444444444",
    plain = Buffer.from("attachment plaintext must not be stored as-is");

  try {
    const required = createStorage({
      ...base,
      STORAGE_ENCRYPTION_MODE: "required",
    });
    await required.put(encryptedKey, plain, "text/plain");

    const disk = await readFile(join(root, encryptedKey));
    assert(isEncryptedStoredObject(disk));
    assert(!disk.includes(plain));
    assert.deepEqual(await required.get(encryptedKey), plain);

    const raw = createUnencryptedStorage(base);
    await raw.put(legacyKey, plain, "text/plain");

    await assert.rejects(
      required.get(legacyKey),
      /Unencrypted storage object rejected/,
    );

    const legacy = createStorage({
      ...base,
      STORAGE_ENCRYPTION_MODE: "legacy-read",
    });
    assert.deepEqual(await legacy.get(legacyKey), plain);

    const migratedWrite =
      "11111111-1111-1111-1111-111111111111/22222222-2222-2222-2222-222222222222/55555555-5555-5555-5555-555555555555";
    await legacy.put(migratedWrite, plain, "text/plain");
    assert(
      isEncryptedStoredObject(await readFile(join(root, migratedWrite))),
    );

    const wrongKey = createStorage({
      ...base,
      ENCRYPTION_KEY: "d".repeat(64),
      STORAGE_ENCRYPTION_MODE: "required",
    });
    await assert.rejects(
      wrongKey.get(encryptedKey),
      /authenticate|Unsupported state|unable/i,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
