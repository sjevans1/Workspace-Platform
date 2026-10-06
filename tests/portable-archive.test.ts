import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { strToU8, zipSync } from "fflate";
import {
  PORTABLE_ARCHIVE_FORMAT,
  buildPortableArchive,
  canonicalArchivePath,
  inspectPortableArchive,
} from "../packages/portable-archive/index.ts";

const rootId = "11111111-1111-4111-8111-111111111111";
const base = {
  format: PORTABLE_ARCHIVE_FORMAT as typeof PORTABLE_ARCHIVE_FORMAT,
  version: 1 as const,
  exported_at: "2026-10-06T19:00:00.000Z",
  product_version: "0.1.0",
  root: { source_id: rootId, kind: "space" as const, title: "Portable root" },
  counts: {
    resources: 2,
    documents: 1,
    databases: 0,
    records: 0,
    files: 1,
  },
};

function digest(data: Uint8Array | Buffer) {
  return createHash("sha256").update(data).digest("hex");
}

test("W17 archive round trip validates manifest checksums and collected bytes", () => {
  const resources = Buffer.from(
    JSON.stringify({ id: rootId, kind: "space", title: "Portable root" }) + "\n",
  );
  const document = Buffer.from(JSON.stringify({
    source_id: "22222222-2222-4222-8222-222222222222",
    blocks: [{ type: "paragraph", content: "portable body" }],
  }));
  const blob = Buffer.from("attachment payload");
  const archive = buildPortableArchive(base, [
    { path: "resources.jsonl", data: resources },
    { path: "documents/22222222-2222-4222-8222-222222222222.json",
      data: document },
    { path: "files/33333333-3333-4333-8333-333333333333/blob",
      data: blob, store: true },
  ]);
  const inspected = inspectPortableArchive(archive, { collect: true });
  assert.equal(inspected.manifest.version, 1);
  assert.equal(inspected.manifest.root.source_id, rootId);
  assert.equal(inspected.manifest.entries.length, 3);
  assert.deepEqual(inspected.entries.get("resources.jsonl"), resources);
  assert.deepEqual(
    inspected.entries.get(
      "files/33333333-3333-4333-8333-333333333333/blob",
    ),
    blob,
  );
  assert.ok(inspected.compressed_bytes > 0);
  assert.ok(inspected.uncompressed_bytes > blob.length);
});

test("W17 archive rejects unsafe paths and case-colliding names", () => {
  for (const path of [
    "../escape.json",
    "nested/../escape.json",
    "/absolute.json",
    "C:/windows.json",
    "nested\\windows.json",
    "nested//empty.json",
    "nested/./dot.json",
    "nul\0byte.json",
  ]) assert.throws(() => canonicalArchivePath(path), /unsafe entry path/);

  assert.throws(
    () => buildPortableArchive(base, [
      { path: "documents/A.json", data: "{}" },
      { path: "documents/a.json", data: "{}" },
    ]),
    /case-colliding/,
  );
});

test("W17 archive rejects checksum mismatch and undeclared entries", () => {
  const body = strToU8("changed body");
  const wrong = "0".repeat(64);
  const manifest = {
    ...base,
    entries: [{
      path: "documents/body.json",
      size: body.length,
      sha256: wrong,
    }],
  };
  const mismatch = Buffer.from(zipSync({
    "manifest.json": strToU8(JSON.stringify(manifest)),
    "documents/body.json": body,
  }));
  assert.throws(
    () => inspectPortableArchive(mismatch),
    /checksum or length mismatch/,
  );

  const clean = strToU8("{}");
  const undeclaredManifest = {
    ...base,
    entries: [{
      path: "documents/body.json",
      size: clean.length,
      sha256: digest(clean),
    }],
  };
  const undeclared = Buffer.from(zipSync({
    "manifest.json": strToU8(JSON.stringify(undeclaredManifest)),
    "documents/body.json": clean,
    "extra.json": strToU8("{}"),
  }));
  assert.throws(
    () => inspectPortableArchive(undeclared),
    /undeclared or missing/,
  );
});

test("W17 archive rejects compression bombs, truncation and unsupported versions", () => {
  const bomb = new Uint8Array(5 * 1024 * 1024);
  const bombArchive = Buffer.from(zipSync({
    "manifest.json": strToU8(JSON.stringify({
      ...base,
      entries: [{
        path: "bomb.bin",
        size: bomb.length,
        sha256: digest(bomb),
      }],
    })),
    "bomb.bin": bomb,
  }, { level: 9 }));
  assert.throws(
    () => inspectPortableArchive(bombArchive),
    /compression ratio exceeds limit/,
  );

  const valid = buildPortableArchive(base, [
    { path: "resources.jsonl", data: "{}\n" },
  ]);
  assert.throws(
    () => inspectPortableArchive(valid.subarray(0, Math.floor(valid.length / 2))),
    /Invalid portable archive/,
  );

  const unsupported = Buffer.from(zipSync({
    "manifest.json": strToU8(JSON.stringify({
      ...base,
      version: 2,
      entries: [],
    })),
  }));
  assert.throws(
    () => inspectPortableArchive(unsupported),
    /manifest is invalid/,
  );
});
