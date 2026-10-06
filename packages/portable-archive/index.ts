import { createHash } from "node:crypto";
import {
  Unzip,
  UnzipInflate,
  Zip,
  ZipDeflate,
  ZipPassThrough,
  strFromU8,
  strToU8,
} from "fflate";
import { z } from "zod";

export const PORTABLE_ARCHIVE_FORMAT = "workspace-portable-archive";
export const PORTABLE_ARCHIVE_VERSION = 1;
export const portableArchiveLimits = Object.freeze({
  maxArchiveBytes: 64 * 1024 * 1024,
  maxUncompressedBytes: 128 * 1024 * 1024,
  maxEntryBytes: 25 * 1024 * 1024,
  maxEntries: 10_000,
  maxCompressionRatio: 200,
  maxManifestBytes: 2 * 1024 * 1024,
});

const sha256 = z.string().regex(/^[a-f0-9]{64}$/);
export const portableArchiveEntrySchema = z.object({
  path: z.string().min(1).max(512),
  size: z.number().int().min(0).max(portableArchiveLimits.maxEntryBytes),
  sha256,
}).strict();

export const portableArchiveManifestSchema = z.object({
  format: z.literal(PORTABLE_ARCHIVE_FORMAT),
  version: z.literal(PORTABLE_ARCHIVE_VERSION),
  exported_at: z.string().datetime(),
  product_version: z.string().trim().min(1).max(80),
  root: z.object({
    source_id: z.uuid(),
    kind: z.enum(["workspace", "space", "page", "database"]),
    title: z.string().max(500),
  }).strict(),
  counts: z.object({
    resources: z.number().int().min(1).max(5_000),
    documents: z.number().int().min(0).max(5_000),
    databases: z.number().int().min(0).max(2_000),
    records: z.number().int().min(0).max(5_000),
    files: z.number().int().min(0).max(2_000),
  }).strict(),
  entries: z.array(portableArchiveEntrySchema)
    .max(portableArchiveLimits.maxEntries),
}).strict();

export type PortableArchiveManifest =
  z.infer<typeof portableArchiveManifestSchema>;
export type PortableArchiveEntry = {
  path: string;
  data: Buffer | Uint8Array | string;
  store?: boolean;
};

function fail(message: string): never {
  throw new Error(`Invalid portable archive: ${message}`);
}

export function canonicalArchivePath(input: string) {
  if (
    !input ||
    input.length > 512 ||
    input.includes("\\") ||
    input.includes("\0") ||
    input.startsWith("/") ||
    input.endsWith("/") ||
    /^[A-Za-z]:/.test(input)
  ) fail("unsafe entry path");
  const segments = input.split("/");
  if (segments.some((part) => !part || part === "." || part === ".."))
    fail("unsafe entry path");
  return segments.join("/");
}

function toBuffer(value: PortableArchiveEntry["data"]) {
  if (typeof value === "string") return Buffer.from(value, "utf8");
  return Buffer.from(value);
}

function descriptor(path: string, data: Buffer) {
  return {
    path,
    size: data.length,
    sha256: createHash("sha256").update(data).digest("hex"),
  };
}

function assertDistinctPaths(paths: string[]) {
  const exact = new Set<string>(),
    folded = new Set<string>();
  for (const raw of paths) {
    const path = canonicalArchivePath(raw),
      fold = path.toLowerCase();
    if (exact.has(path) || folded.has(fold))
      fail("duplicate or case-colliding entry path");
    exact.add(path);
    folded.add(fold);
  }
}

export function buildPortableArchive(
  manifest: Omit<PortableArchiveManifest, "entries">,
  entries: PortableArchiveEntry[],
) {
  if (entries.length > portableArchiveLimits.maxEntries)
    fail("too many entries");
  assertDistinctPaths(["manifest.json", ...entries.map((entry) => entry.path)]);
  const prepared = entries.map((entry) => {
    const path = canonicalArchivePath(entry.path),
      data = toBuffer(entry.data);
    if (data.length > portableArchiveLimits.maxEntryBytes)
      fail(`entry too large: ${path}`);
    return { ...entry, path, data };
  });
  const total = prepared.reduce((sum, entry) => sum + entry.data.length, 0);
  if (total > portableArchiveLimits.maxUncompressedBytes)
    fail("uncompressed archive exceeds limit");

  const validated = portableArchiveManifestSchema.parse({
    ...manifest,
    entries: prepared.map((entry) => descriptor(entry.path, entry.data)),
  });
  const manifestBytes = Buffer.from(
    JSON.stringify(validated, null, 2) + "\n", "utf8");
  if (manifestBytes.length > portableArchiveLimits.maxManifestBytes)
    fail("manifest exceeds limit");

  const chunks: Buffer[] = [];
  let outputBytes = 0;
  const zip = new Zip((error, data) => {
    if (error) throw error;
    outputBytes += data.length;
    if (outputBytes > portableArchiveLimits.maxArchiveBytes)
      fail("compressed archive exceeds limit");
    chunks.push(Buffer.from(data));
  });
  const add = (path: string, data: Buffer, store = false) => {
    const stream = store
      ? new ZipPassThrough(path)
      : new ZipDeflate(path, { level: 6 });
    zip.add(stream);
    stream.push(data, true);
  };
  add("manifest.json", manifestBytes);
  for (const entry of prepared)
    add(entry.path, entry.data, entry.store === true);
  zip.end();
  return Buffer.concat(chunks);
}

type InspectedEntry = {
  path: string;
  size: number;
  sha256: string;
  data?: Buffer;
};

export function inspectPortableArchive(
  archive: Buffer | Uint8Array,
  options: { collect?: boolean } = {},
) {
  const input = Buffer.from(archive);
  if (input.length > portableArchiveLimits.maxArchiveBytes)
    fail("compressed archive exceeds limit");

  const observed = new Map<string, InspectedEntry>(),
    folded = new Set<string>();
  let totalBytes = 0,
    entryCount = 0,
    manifestBytes: Buffer | undefined,
    streamError: Error | undefined;

  const unzip = new Unzip((file) => {
    if (streamError) {
      file.terminate();
      return;
    }
    try {
      const path = canonicalArchivePath(file.name),
        fold = path.toLowerCase();
      if (folded.has(fold))
        fail("duplicate or case-colliding entry path");
      if (++entryCount > portableArchiveLimits.maxEntries + 1)
        fail("too many entries");
      folded.add(fold);
      if (
        file.originalSize !== undefined &&
        file.originalSize > portableArchiveLimits.maxEntryBytes
      ) fail(`entry too large: ${path}`);
      if (
        file.size !== undefined &&
        file.originalSize !== undefined &&
        file.size > 0 &&
        file.originalSize / file.size > portableArchiveLimits.maxCompressionRatio
      ) fail(`compression ratio exceeds limit: ${path}`);

      const hash = createHash("sha256"),
        chunks: Buffer[] = [];
      let size = 0;
      file.ondata = (error, chunk, final) => {
        if (streamError) return;
        try {
          if (error) throw error;
          const value = Buffer.from(chunk);
          size += value.length;
          totalBytes += value.length;
          if (size > portableArchiveLimits.maxEntryBytes)
            fail(`entry too large: ${path}`);
          if (totalBytes > portableArchiveLimits.maxUncompressedBytes)
            fail("uncompressed archive exceeds limit");
          if (
            path === "manifest.json" &&
            size > portableArchiveLimits.maxManifestBytes
          ) fail("manifest exceeds limit");
          hash.update(value);
          if (options.collect || path === "manifest.json") chunks.push(value);
          if (!final) return;
          const data = chunks.length ? Buffer.concat(chunks) : undefined;
          if (path === "manifest.json") manifestBytes = data;
          observed.set(path, {
            path,
            size,
            sha256: hash.digest("hex"),
            ...(options.collect ? { data } : {}),
          });
        } catch (error) {
          streamError = error as Error;
          file.terminate();
        }
      };
      file.start();
    } catch (error) {
      streamError = error as Error;
      file.terminate();
    }
  });
  unzip.register(UnzipInflate);
  try {
    const chunkBytes = 64 * 1024;
    for (
      let offset = 0;
      offset < input.length && !streamError;
      offset += chunkBytes
    )
      unzip.push(
        input.subarray(
          offset,
          Math.min(offset + chunkBytes, input.length),
        ),
        offset + chunkBytes >= input.length,
      );
  } catch (error) {
    streamError = error as Error;
  }
  if (streamError) fail(streamError.message);
  if (
    input.length > 0 &&
    totalBytes / input.length > portableArchiveLimits.maxCompressionRatio
  ) fail("aggregate compression ratio exceeds limit");
  if (!manifestBytes || !observed.has("manifest.json"))
    fail("manifest.json is required");

  let manifest: PortableArchiveManifest;
  try {
    manifest = portableArchiveManifestSchema.parse(
      JSON.parse(strFromU8(manifestBytes)),
    );
  } catch {
    fail("manifest is invalid");
  }
  assertDistinctPaths(manifest.entries.map((entry) => entry.path));
  const declared = new Map(
    manifest.entries.map((entry) => [entry.path, entry]),
  );
  if (declared.has("manifest.json"))
    fail("manifest must not declare itself");
  if (observed.size !== declared.size + 1)
    fail("archive contains undeclared or missing entries");

  for (const [path, entry] of observed) {
    if (path === "manifest.json") continue;
    const expected = declared.get(path);
    if (!expected) fail(`undeclared entry: ${path}`);
    if (entry.size !== expected.size || entry.sha256 !== expected.sha256)
      fail(`checksum or length mismatch: ${path}`);
  }
  for (const path of declared.keys())
    if (!observed.has(path)) fail(`missing entry: ${path}`);

  const collected = new Map<string, Buffer>();
  if (options.collect)
    for (const [path, entry] of observed)
      if (path !== "manifest.json" && entry.data)
        collected.set(path, entry.data);

  return {
    manifest,
    entries: collected,
    compressed_bytes: input.length,
    uncompressed_bytes: totalBytes,
  };
}

export function encodeArchiveJson(value: unknown) {
  return strToU8(JSON.stringify(value));
}
