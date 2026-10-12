// OCP-1B: real HTTPS acceptance for the exporter's production client path.
//
// The client runs in a child process so the ephemeral test CA can be trusted via
// NODE_EXTRA_CA_CERTS. Nothing in production code or in the harness disables TLS
// verification: the untrusted and hostname-mismatch cases fail precisely because
// the certificate is not trusted, and no NODE_TLS_REJECT_UNAUTHORIZED or
// rejectUnauthorized override exists anywhere.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createServer as createHttpsServer } from "node:https";
import { createServer as createHttpServer } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  TELEMETRY_ENVELOPE_VERSION,
  telemetryTransportConfig,
  verifyEnvelopeSignature,
} from "../packages/operations/telemetry-transport.ts";

const REPO = process.cwd();
const MODULE = join(REPO, "packages/operations/telemetry-transport.ts");
const OTEL = join(REPO, "packages/operations/operator-telemetry.ts");
const SECRET = "h".repeat(48);
const CREDENTIAL = "dep-https";

const SENTINELS = [
  "cfo@acme-customer.example",
  "11111111-2222-3333-4444-555555555555",
  "Confidential merger discussion minutes",
  "Q3-acquisition-nda-signed.pdf",
  "Bearer ",
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9",
  "workspace_session=",
  "postgres://",
  "client_secret=",
];

let dir = "";
let okServer: any, mismatchServer: any, otherServer: any;
let okPort = 0, mismatchPort = 0, otherPort = 0;
const received: { body: string; headers: Record<string, any>; path: string }[] = [];
let otherHits = 0;


function probe(args: { url: string; ca?: string; timeoutMs?: number }): Promise<{ outcome: string; category: string; delivered: boolean; probeCause: string | null }> {
  const spool = join(dir, `spool-${Math.random().toString(36).slice(2)}.jsonl`);
  const env: Record<string, string> = { ...(process.env as any), PROBE_SPOOL: spool };
  if (args.ca) env.NODE_EXTRA_CA_CERTS = args.ca;
  else delete env.NODE_EXTRA_CA_CERTS;
  // spawn, not spawnSync: this process also serves the test HTTPS origin, so the
  // event loop must stay free while the client runs.
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ["--import", "tsx", join(REPO, "tests/support/ocp1b-https-probe.ts"), args.url, CREDENTIAL, SECRET, String(args.timeoutMs ?? 5000), spool],
      { cwd: REPO, env, stdio: ["ignore", "pipe", "pipe"] },
    );
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += String(d)));
    child.stderr.on("data", (d) => (err += String(d)));
    child.on("error", reject);
    child.on("close", () => {
      const line = out.trim().split("\n").filter(Boolean).pop();
      if (!line) return reject(new Error(`probe produced no output: ${err.slice(-400)}`));
      try {
        resolve(JSON.parse(line));
      } catch (error) {
        reject(new Error(`probe output unparseable: ${line.slice(0, 200)}`));
      }
    });
  });
}

before(async () => {
  dir = await mkdtemp(join(tmpdir(), "ocp1b-https-"));
  const openssl = (args: string[]) => execFileSync("openssl", args, { cwd: dir, stdio: "pipe" });
  openssl(["req", "-x509", "-newkey", "rsa:2048", "-sha256", "-days", "2", "-nodes", "-keyout", "ca.key", "-out", "ca.crt", "-subj", "/CN=OCP1B Test CA"]);
  openssl(["req", "-newkey", "rsa:2048", "-nodes", "-keyout", "server.key", "-out", "server.csr", "-subj", "/CN=localhost"]);
  await writeFile(join(dir, "san.cnf"), "subjectAltName=DNS:localhost,IP:127.0.0.1\n");
  openssl(["x509", "-req", "-in", "server.csr", "-CA", "ca.crt", "-CAkey", "ca.key", "-CAcreateserial", "-out", "server.crt", "-days", "2", "-sha256", "-extfile", "san.cnf"]);
  await writeFile(join(dir, "san-other.cnf"), "subjectAltName=DNS:other.example\n");
  openssl(["x509", "-req", "-in", "server.csr", "-CA", "ca.crt", "-CAkey", "ca.key", "-CAcreateserial", "-out", "mismatch.crt", "-days", "2", "-sha256", "-extfile", "san-other.cnf"]);

  const { readFile } = await import("node:fs/promises");
  const key = await readFile(join(dir, "server.key"));
  okServer = createHttpsServer({ key, cert: await readFile(join(dir, "server.crt")) }, (req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      received.push({ body: Buffer.concat(chunks).toString("utf8"), headers: req.headers, path: req.url ?? "" });
      if (req.url === "/slow") return; // never respond, exercises the finite timeout
      if (req.url === "/redirect") {
        res.writeHead(302, { location: `http://127.0.0.1:${otherPort}/steal` });
        return res.end();
      }
      if (req.url === "/fail") {
        res.writeHead(500);
        return res.end("{}");
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end("{}");
    });
  });
  mismatchServer = createHttpsServer({ key, cert: await readFile(join(dir, "mismatch.crt")) }, (_q, s) => {
    s.writeHead(200);
    s.end("{}");
  });
  otherServer = createHttpServer((_q, s) => {
    otherHits += 1;
    s.writeHead(200);
    s.end("{}");
  });
  await new Promise<void>((r) => okServer.listen(0, "127.0.0.1", r));
  await new Promise<void>((r) => mismatchServer.listen(0, "127.0.0.1", r));
  await new Promise<void>((r) => otherServer.listen(0, "127.0.0.1", r));
  okPort = okServer.address().port;
  mismatchPort = mismatchServer.address().port;
  otherPort = otherServer.address().port;
});

after(async () => {
  for (const s of [okServer, mismatchServer, otherServer]) {
    // The timeout case leaves a socket open on purpose; destroy it so close resolves.
    if (typeof s.closeAllConnections === "function") s.closeAllConnections();
    await new Promise<void>((r) => s.close(() => r()));
  }
  await rm(dir, { recursive: true, force: true });
});

test("production configuration rejects an HTTP telemetry endpoint", () => {
  const http = telemetryTransportConfig({
    OPERATOR_TELEMETRY_ENABLED: "true",
    OPERATOR_TELEMETRY_ENDPOINT: `http://127.0.0.1:${okPort}/ok`,
    OPERATOR_TELEMETRY_CREDENTIAL_ID: CREDENTIAL,
    OPERATOR_TELEMETRY_SECRET: SECRET,
  });
  assert.equal(http.ok, false);
  assert.ok(http.config.endpoint === null, "an insecure endpoint must never be accepted");
});

test("trusted ephemeral CA with a valid hostname delivers the real signed envelope", async () => {
  const result = await probe({ url: `https://127.0.0.1:${okPort}/ok`, ca: join(dir, "ca.crt") });
  assert.equal(result.outcome, "delivered", JSON.stringify(result));
  assert.equal(result.delivered, true);
  const hit = received.find((r) => r.path === "/ok");
  assert.ok(hit, "the server must have received the request");
  // The bytes on the wire are the real envelope, verifiable with the deployment secret.
  const envelope = JSON.parse(hit!.body);
  assert.equal(envelope.envelope, TELEMETRY_ENVELOPE_VERSION);
  assert.equal(envelope.credential_id, CREDENTIAL);
  assert.equal(verifyEnvelopeSignature(envelope, SECRET), true, "the received envelope must verify");
  assert.equal(hit!.headers["x-workspace-credential"], CREDENTIAL);
  assert.ok(!JSON.stringify(hit!.headers).includes(SECRET), "no header may carry the secret");
});

test("over-the-wire privacy: prohibited sentinels never leave the deployment", () => {
  const hit = received.find((r) => r.path === "/ok");
  assert.ok(hit, "the successful delivery must be captured");
  const body = hit!.body;
  for (const sentinel of SENTINELS)
    assert.ok(!body.includes(sentinel), `the wire body leaked ${sentinel}`);
  assert.ok(!body.includes(SECRET), "the wire body must never contain the credential secret");
  // The envelope metadata itself must not reintroduce identifiers either.
  const envelope = JSON.parse(body);
  for (const key of Object.keys(envelope))
    assert.ok(
      ["envelope", "contract", "deployment_id", "credential_id", "generated_at", "nonce", "payload_digest", "payload", "signature"].includes(key),
      `unexpected envelope key ${key}`,
    );
  assert.equal(envelope.deployment_id, "ws-probe");
  assert.ok(!JSON.stringify(envelope).includes("acme"), "no customer-derived identifier may appear");
});

test("an untrusted certificate fails closed without any verification bypass", async () => {
  const result = await probe({ url: `https://127.0.0.1:${okPort}/ok` });
  assert.equal(result.outcome, "retryable");
  assert.equal(result.category, "tls");
  assert.equal(result.delivered, false);
});

test("a hostname mismatch fails closed", async () => {
  const result = await probe({ url: `https://127.0.0.1:${mismatchPort}/ok`, ca: join(dir, "ca.crt") });
  assert.equal(result.outcome, "retryable");
  assert.equal(result.category, "tls");
});

test("a finite timeout is honoured and classified", async () => {
  const result = await probe({ url: `https://127.0.0.1:${okPort}/slow`, ca: join(dir, "ca.crt"), timeoutMs: 1500 });
  assert.equal(result.outcome, "retryable");
  assert.equal(result.category, "timeout");
});

test("a redirect cannot forward the credential or signature to another origin", async () => {
  const before = otherHits;
  const result = await probe({ url: `https://127.0.0.1:${okPort}/redirect`, ca: join(dir, "ca.crt") });
  assert.equal(result.outcome, "retryable");
  assert.equal(otherHits, before, "the credential must never be forwarded to another origin");
  const redirectHit = received.filter((r) => r.path === "/redirect").pop();
  assert.ok(redirectHit, "the first origin saw the request");
});

test("a 5xx response is classified retryable", async () => {
  const result = await probe({ url: `https://127.0.0.1:${okPort}/fail`, ca: join(dir, "ca.crt") });
  assert.equal(result.outcome, "retryable");
  assert.equal(result.category, "retryable_response");
});
