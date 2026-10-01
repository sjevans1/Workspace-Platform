import { mkdir, readFile, writeFile, unlink } from "node:fs/promises";
import path from "node:path";
import {
  createCipheriv,
  createDecipheriv,
  hkdfSync,
  randomBytes,
} from "node:crypto";
import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
  HeadBucketCommand,
} from "@aws-sdk/client-s3";
export interface Storage {
  put(key: string, data: Buffer, mime: string): Promise<void>;
  get(key: string): Promise<Buffer>;
  delete(key: string): Promise<void>;
  health(): Promise<void>;
  close?(): void;
}

export type StorageEncryptionMode = "off" | "legacy-read" | "required";
const storageMagic = Buffer.from("4f4a534501a55aa5", "hex");

function storageKey(env: NodeJS.ProcessEnv) {
  const value = env.ENCRYPTION_KEY || "";
  if (!/^[a-f0-9]{64}$/i.test(value))
    throw new Error(
      "STORAGE_ENCRYPTION_MODE requires ENCRYPTION_KEY to contain 64 hex characters",
    );
  return Buffer.from(
    hkdfSync(
      "sha256",
      Buffer.from(value, "hex"),
      Buffer.from("openjm-workspace"),
      Buffer.from("storage-object-v1"),
      32,
    ),
  );
}

export function isEncryptedStoredObject(value: Buffer) {
  return (
    value.length >= storageMagic.length + 12 + 16 &&
    value.subarray(0, storageMagic.length).equals(storageMagic)
  );
}

export function encryptStoredObject(
  key: string,
  value: Buffer,
  env: NodeJS.ProcessEnv = process.env,
) {
  const iv = randomBytes(12),
    cipher = createCipheriv("aes-256-gcm", storageKey(env), iv);
  cipher.setAAD(Buffer.from(`object:${key}`));
  const body = Buffer.concat([cipher.update(value), cipher.final()]);
  return Buffer.concat([storageMagic, iv, cipher.getAuthTag(), body]);
}

export function decryptStoredObject(
  key: string,
  value: Buffer,
  env: NodeJS.ProcessEnv = process.env,
) {
  if (!isEncryptedStoredObject(value))
    throw new Error("Storage object is not encrypted");
  const offset = storageMagic.length,
    iv = value.subarray(offset, offset + 12),
    tag = value.subarray(offset + 12, offset + 28),
    body = value.subarray(offset + 28),
    cipher = createDecipheriv("aes-256-gcm", storageKey(env), iv);
  cipher.setAAD(Buffer.from(`object:${key}`));
  cipher.setAuthTag(tag);
  return Buffer.concat([cipher.update(body), cipher.final()]);
}
function local(root: string, key: string) {
  if (!/^[a-f0-9-]+\/[a-f0-9-]+\/[a-f0-9-]+$/.test(key))
    throw new Error("Invalid object key");
  return path.join(root, key);
}
function createRawStorage(env: NodeJS.ProcessEnv): Storage {
  if (env.STORAGE_PROVIDER === "s3") {
    const client = new S3Client({
        endpoint: env.S3_ENDPOINT || undefined,
        region: env.S3_REGION || "us-east-1",
        forcePathStyle: env.S3_FORCE_PATH_STYLE !== "false",
        credentials: env.S3_ACCESS_KEY
          ? {
              accessKeyId: env.S3_ACCESS_KEY,
              secretAccessKey: env.S3_SECRET_KEY || "",
            }
          : undefined,
      }),
      Bucket = env.S3_BUCKET || "workspace";
    return {
      async put(Key, Body, ContentType) {
        await client.send(
          new PutObjectCommand({
            Bucket,
            Key,
            Body,
            ContentType,
            IfNoneMatch: "*",
          }),
        );
      },
      async get(Key) {
        const r = await client.send(new GetObjectCommand({ Bucket, Key }));
        return Buffer.from(await r.Body!.transformToByteArray());
      },
      async delete(Key) {
        await client.send(new DeleteObjectCommand({ Bucket, Key }));
      },
      async health() {
        await client.send(new HeadBucketCommand({ Bucket }));
      },
      close: () => client.destroy(),
    };
  }
  const root = env.STORAGE_LOCAL_PATH || ".data/files";
  return {
    async put(k, b) {
      const p = local(root, k);
      await mkdir(path.dirname(p), { recursive: true });
      await writeFile(p, b, { flag: "wx" });
    },
    get: async (k) => readFile(local(root, k)),
    async delete(k) {
      await unlink(local(root, k)).catch((e) => {
        if (e.code !== "ENOENT") throw e;
      });
    },
    async health() {
      await mkdir(root, {
        recursive: true,
      });
    },
  };
}

export function createStorage(env: NodeJS.ProcessEnv = process.env): Storage {
  const mode = (env.STORAGE_ENCRYPTION_MODE || "off") as StorageEncryptionMode;
  if (!["off", "legacy-read", "required"].includes(mode))
    throw new Error(
      "STORAGE_ENCRYPTION_MODE must be off, legacy-read, or required",
    );
  if (mode !== "off") storageKey(env);
  const raw = createRawStorage(env);
  if (mode === "off") return raw;
  return {
    async put(key, value) {
      await raw.put(
        key,
        encryptStoredObject(key, value, env),
        "application/octet-stream",
      );
    },
    async get(key) {
      const value = await raw.get(key);
      if (isEncryptedStoredObject(value))
        return decryptStoredObject(key, value, env);
      if (mode === "legacy-read") return value;
      throw new Error("Unencrypted storage object rejected");
    },
    delete: (key) => raw.delete(key),
    health: () => raw.health(),
    close: raw.close ? () => raw.close?.() : undefined,
  };
}

export function createUnencryptedStorage(
  env: NodeJS.ProcessEnv = process.env,
): Storage {
  return createRawStorage({ ...env, STORAGE_ENCRYPTION_MODE: "off" });
}

export function inspectFile(name: string, declared: string, b: Buffer) {
  const ext = path.extname(name).toLowerCase();
  const types: Record<string, string> = {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".webp": "image/webp",
    ".pdf": "application/pdf",
    ".txt": "text/plain",
    ".md": "text/markdown",
    ".csv": "text/csv",
    ".json": "application/json",
    ".zip": "application/zip",
    ".docx":
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ".xlsx":
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ".pptx":
      "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  };
  const mime = types[ext];
  if (!mime) throw new Error("Unsupported file extension");
  if (
    mime === "image/png" &&
    b.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a"
  )
    throw new Error("Invalid PNG");
  if (mime === "image/jpeg" && b.subarray(0, 3).toString("hex") !== "ffd8ff")
    throw new Error("Invalid JPEG");
  if (mime === "image/gif" && !/^GIF8[79]a$/.test(b.subarray(0, 6).toString()))
    throw new Error("Invalid GIF");
  if (
    mime === "image/webp" &&
    (b.subarray(0, 4).toString() !== "RIFF" ||
      b.subarray(8, 12).toString() !== "WEBP")
  )
    throw new Error("Invalid WebP");
  if (mime === "application/pdf" && b.subarray(0, 5).toString() !== "%PDF-")
    throw new Error("Invalid PDF");
  if (
    [".zip", ".docx", ".xlsx", ".pptx"].includes(ext) &&
    b.subarray(0, 2).toString() !== "PK"
  )
    throw new Error("Invalid archive");
  if (
    declared !== mime &&
    declared !== "application/octet-stream" &&
    !(ext === ".md" && declared === "text/plain")
  )
    throw new Error("MIME type mismatch");
  return mime;
}
