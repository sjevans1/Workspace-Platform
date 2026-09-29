import { randomBytes } from "node:crypto";
import { writeFile, readFile } from "node:fs/promises";
const path = process.argv[2] || ".env";
try {
  await readFile(path);
  throw Error(`${path} already exists; refusing to replace secrets`);
} catch (e) {
  if (e.code !== "ENOENT") throw e;
}
const template = await readFile(
  new URL("../.env.example", import.meta.url),
  "utf8",
);
const output = template
  .replaceAll("GENERATE_OWNER_PASSWORD", randomBytes(24).toString("hex"))
  .replaceAll("GENERATE_RUNTIME_PASSWORD", randomBytes(24).toString("hex"))
  .replaceAll("GENERATE_ENCRYPTION_KEY", randomBytes(32).toString("hex"))
  .replaceAll("GENERATE_SETUP_TOKEN", randomBytes(24).toString("base64url"));
await writeFile(path, output, { mode: 0o600, flag: "wx" });
console.log(`Created ${path}. Read SETUP_TOKEN there for first-run setup.`);
