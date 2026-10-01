import { randomUUID } from "node:crypto";
import { createStorage } from "../packages/storage/index.ts";

function isNotFound(error: any) {
  return (
    error?.$metadata?.httpStatusCode === 404 ||
    ["NoSuchKey", "NotFound", "ENOENT"].includes(error?.name || error?.code)
  );
}

if (!process.argv.includes("--write-test")) {
  throw new Error(
    "Refusing to write to object storage without --write-test. The probe creates and deletes one unique temporary object.",
  );
}
if (process.env.STORAGE_PROVIDER !== "s3") {
  throw new Error("Set STORAGE_PROVIDER=s3 before running provider acceptance");
}
if (!process.env.S3_BUCKET) {
  throw new Error("Set S3_BUCKET explicitly before running provider acceptance");
}

const key = `${randomUUID()}/${randomUUID()}/${randomUUID()}`;
const original = Buffer.from(
  `OpenJM Workspace S3 provider acceptance ${randomUUID()}\n`,
);
const replacement = Buffer.from("overwrite must be rejected\n");
const storage = createStorage();
let objectMayExist = false;

try {
  await storage.health();
  console.log("PASS bucket health/authentication");

  await storage.put(key, original, "text/plain");
  objectMayExist = true;
  const firstRead = await storage.get(key);
  if (!firstRead.equals(original)) {
    throw new Error("Object round-trip bytes did not match");
  }
  console.log("PASS conditional PUT and authenticated GET");

  let overwriteRejected = false;
  try {
    await storage.put(key, replacement, "text/plain");
  } catch {
    overwriteRejected = true;
  }
  if (!overwriteRejected) {
    throw new Error(
      "Provider accepted an overwrite for an existing key; If-None-Match immutability is not compatible",
    );
  }
  const afterOverwrite = await storage.get(key);
  if (!afterOverwrite.equals(original)) {
    throw new Error("Existing object changed during overwrite rejection check");
  }
  console.log("PASS existing-key overwrite rejected and original preserved");

  await storage.delete(key);
  objectMayExist = false;
  try {
    await storage.get(key);
    throw new Error("Deleted probe object is still readable");
  } catch (error: any) {
    if (error?.message === "Deleted probe object is still readable") throw error;
    if (!isNotFound(error)) {
      throw new Error(
        `Delete verification did not return object-not-found (status=${error?.$metadata?.httpStatusCode ?? "unknown"}, code=${error?.name || error?.code || "unknown"})`,
      );
    }
  }
  console.log("PASS delete and object-not-found verification");
  console.log(
    `S3 provider acceptance PASS for bucket ${process.env.S3_BUCKET}`,
  );
} finally {
  if (objectMayExist) {
    await storage.delete(key).catch(() => undefined);
  }
  storage.close?.();
}
