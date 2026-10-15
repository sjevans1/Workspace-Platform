/**
 * W29-P0/A2 acceptance: the governed provider transport.
 *
 * These tests prove the boundary against a REAL TLS server and REAL sockets. The
 * only things injected are the DNS answers and the socket target (explicit test
 * seams, never reachable from configuration), because the production policy
 * refuses loopback by design and a test server has to live somewhere.
 *
 * The properties under test are the ones that decide whether a future adapter can
 * be tricked: a denied destination is never contacted at all, the socket is dialled
 * to the validated address while the ORIGINAL hostname is what TLS verifies,
 * redirects are never followed, every limit is enforced, and no error or evidence
 * carries a credential, a URL or a raw exception.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  createServer as createHttpsServer,
  type Server as HttpsServer,
} from "node:https";
import {
  createServer as createNetServer,
  connect as netConnect,
} from "node:net";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  EGRESS_TRANSPORT_LIMITS,
  ProviderEgressError,
  loadEgressPolicy,
  providerHttpRequest,
  validatedTlsConnect,
  type EgressTransportDeps,
} from "../packages/connectors/index.ts";

const HOST = "mail.example.test";
const OTHER_HOST = "other.example.test";
const PUBLIC_IP = "93.184.216.34";
const FAKE_SECRET = "sk-live-FAKE-a2-9f3a2b7c4d5e";

let dir = "";
let caPem = "";
let server: HttpsServer | null = null;
let serverPort = 0;
let silentServer: HttpsServer | null = null;
let silentPort = 0;
let otherPort = 0;
const seen: {
  host: string | undefined;
  servername: string | undefined;
  url: string | undefined;
  authorization: string | undefined;
  body: string;
}[] = [];

const resolverFor =
  (addresses: string[]): EgressTransportDeps["resolve"] =>
  async () =>
    addresses.map((address) => ({
      address,
      family: address.includes(":") ? 6 : 4,
    }));

/** Dial the local test server while the policy validated a public destination. */
const dialTo =
  (port: number): EgressTransportDeps["dial"] =>
  () =>
    new Promise((resolve, reject) => {
      const socket = netConnect({ host: "127.0.0.1", port });
      socket.once("connect", () => resolve(socket));
      socket.once("error", reject);
    });

const policyWithCa = () =>
  loadEgressPolicy({
    CONNECTOR_EGRESS_CA_PEM: caPem,
  });

before(async () => {
  dir = await mkdtemp(join(tmpdir(), "workspace-a2-egress-"));
  const openssl = (args: string[]) =>
    execFileSync("openssl", args, { cwd: dir, stdio: "pipe" });
  openssl([
    "req",
    "-x509",
    "-newkey",
    "rsa:2048",
    "-sha256",
    "-days",
    "2",
    "-nodes",
    "-keyout",
    "ca.key",
    "-out",
    "ca.crt",
    "-subj",
    "/CN=A2 Test CA",
  ]);
  await writeFile(
    join(dir, "san.cnf"),
    "[req]\ndistinguished_name=dn\n[dn]\n[ext]\nsubjectAltName=DNS:mail.example.test\n",
  );
  openssl([
    "req",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-keyout",
    "server.key",
    "-out",
    "server.csr",
    "-subj",
    `/CN=${HOST}`,
  ]);
  openssl([
    "x509",
    "-req",
    "-in",
    "server.csr",
    "-CA",
    "ca.crt",
    "-CAkey",
    "ca.key",
    "-CAcreateserial",
    "-out",
    "server.crt",
    "-days",
    "2",
    "-sha256",
    "-extfile",
    "san.cnf",
  ]);
  caPem = await readFile(join(dir, "ca.crt"), "utf8");
  const key = await readFile(join(dir, "server.key"));
  const cert = await readFile(join(dir, "server.crt"));

  server = createHttpsServer({ key, cert }, (req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const socket = req.socket as unknown as { servername?: string };
      seen.push({
        host: req.headers.host,
        servername: socket.servername,
        url: req.url,
        authorization: req.headers.authorization as string | undefined,
        body: Buffer.concat(chunks).toString("utf8"),
      });
      if (req.url === "/redirect")
        return void res
          .writeHead(302, {
            location: `https://169.254.169.254/latest/meta-data/`,
          })
          .end();
      if (req.url === "/big") {
        res.writeHead(200, { "content-type": "text/plain" });
        for (let index = 0; index < 40; index += 1)
          res.write("x".repeat(32 * 1024));
        return void res.end();
      }
      if (req.url === "/headers")
        return void res
          .writeHead(200, {
            "content-type": "application/json",
            "set-cookie": "session=must-not-be-recorded",
            "x-secret-token": "must-not-be-recorded",
            "x-ratelimit-remaining": "42",
          })
          .end(JSON.stringify({ ok: true }));
      res
        .writeHead(200, { "content-type": "application/json" })
        .end(JSON.stringify({ ok: true }));
    });
  });
  await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
  serverPort = (server.address() as { port: number }).port;

  // A server that accepts the connection and never answers.
  silentServer = createHttpsServer({ key, cert }, () => {});
  await new Promise<void>((resolve) =>
    silentServer!.listen(0, "127.0.0.1", resolve),
  );
  silentPort = (silentServer.address() as { port: number }).port;

  // A plain TCP listener that closes immediately, for connect failures.
  const plain = createNetServer((socket) => socket.destroy());
  await new Promise<void>((resolve) => plain.listen(0, "127.0.0.1", resolve));
  otherPort = (plain.address() as { port: number }).port;
  plain.unref();
});

after(async () => {
  await new Promise<void>((resolve) =>
    server ? server.close(() => resolve()) : resolve(),
  );
  await new Promise<void>((resolve) =>
    silentServer ? silentServer.close(() => resolve()) : resolve(),
  );
  if (dir) await rm(dir, { recursive: true, force: true });
});

/** Runs a request that must fail, and returns the normalized egress error. */
async function failureOf(
  promise: Promise<unknown>,
): Promise<ProviderEgressError> {
  try {
    await promise;
  } catch (caught) {
    assert.ok(
      caught instanceof ProviderEgressError,
      `expected a normalized egress failure, got ${String(caught)}`,
    );
    return caught as ProviderEgressError;
  }
  throw new Error("expected the request to fail");
}

const request = (options: {
  url: string;
  addresses?: string[];
  dialPort?: number;
  deps?: EgressTransportDeps;
  policy?: ReturnType<typeof loadEgressPolicy>;
  body?: string;
  headers?: Record<string, string>;
  method?: "GET" | "POST";
  timeoutMs?: number;
}) =>
  providerHttpRequest({
    url: options.url,
    method: options.method ?? "GET",
    ...(options.body === undefined ? {} : { body: options.body }),
    ...(options.headers === undefined ? {} : { headers: options.headers }),
    ...(options.timeoutMs === undefined
      ? {}
      : { timeoutMs: options.timeoutMs }),
    policy: options.policy ?? policyWithCa(),
    deps: options.deps ?? {
      resolve: resolverFor(options.addresses ?? [PUBLIC_IP]),
      dial: dialTo(options.dialPort ?? serverPort),
    },
  });

// ---------------------------------------------------------------------------
// The happy path, over real TLS.
// ---------------------------------------------------------------------------

test("A2 transport: an allowed destination connects with the hostname, not the IP", async () => {
  seen.length = 0;
  const response = await request({
    url: `https://${HOST}:${serverPort}/ok`,
    headers: {
      authorization: `Bearer ${FAKE_SECRET}`,
      accept: "application/json",
    },
  });
  assert.equal(response.status, 200);
  assert.deepEqual(JSON.parse(response.body.toString("utf8")), { ok: true });
  assert.equal(response.destination.host, HOST);
  assert.equal(response.destination.address, PUBLIC_IP);
  assert.equal(seen.length, 1);
  assert.equal(
    seen[0].host,
    `${HOST}:${serverPort}`,
    "the Host header is the hostname",
  );
  assert.equal(
    seen[0].servername,
    HOST,
    "TLS SNI is the hostname, never the IP",
  );
  assert.equal(
    seen[0].authorization,
    `Bearer ${FAKE_SECRET}`,
    "the caller's header is sent",
  );
  assert.equal(response.redirect, false);
  assert.equal(
    response.destination.redacted,
    `https://${HOST}:${serverPort}/ok`,
  );
});

test("A2 transport: a redirect is recorded as metadata and never followed", async () => {
  seen.length = 0;
  const response = await request({
    url: `https://${HOST}:${serverPort}/redirect`,
  });
  assert.equal(response.status, 302);
  assert.equal(response.redirect, true);
  assert.equal(seen.length, 1, "no second request may be issued");
  assert.equal(
    response.headers.location,
    undefined,
    "a redirect target is not even exposed as a followable header",
  );
});

test("A2 transport: response headers are allowlisted, so a cookie or token is not recorded", async () => {
  const response = await request({
    url: `https://${HOST}:${serverPort}/headers`,
  });
  assert.equal(response.headers["content-type"], "application/json");
  assert.equal(response.headers["x-ratelimit-remaining"], "42");
  assert.equal(response.headers["set-cookie"], undefined);
  assert.equal(response.headers["x-secret-token"], undefined);
  assert.ok(!JSON.stringify(response.headers).includes("must-not-be-recorded"));
});

// ---------------------------------------------------------------------------
// Denied destinations are never contacted.
// ---------------------------------------------------------------------------

test("A2 transport: a denied destination is refused before any socket exists", async () => {
  let dials = 0;
  const countingDial: EgressTransportDeps["dial"] = async () => {
    dials += 1;
    throw new Error("must not be dialled");
  };
  const cases: [string, string[]][] = [
    ["loopback", ["127.0.0.1"]],
    ["metadata", ["169.254.169.254"]],
    ["private", ["10.1.2.3"]],
    ["unique local", ["fd00:1234::1"]],
    ["mixed public and private", [PUBLIC_IP, "10.1.2.3"]],
    ["carrier grade", ["100.64.0.1"]],
    ["mapped loopback", ["::ffff:127.0.0.1"]],
  ];
  for (const [label, addresses] of cases) {
    const error = await failureOf(
      request({
        url: `https://${HOST}:${serverPort}/ok`,
        addresses,
        deps: { resolve: resolverFor(addresses), dial: countingDial },
      }),
    );
    assert.ok(error instanceof ProviderEgressError, label);
    assert.equal(error.code, "policy_denied", label);
    assert.equal(error.delivery_state, "not_sent", label);
    assert.equal(
      error.summary.includes("127.0.0.1"),
      false,
      "no address is echoed",
    );
  }
  assert.equal(dials, 0, "a blocked endpoint must never be contacted");
});

test("A2 transport: an empty or failing DNS answer is a pre-send failure", async () => {
  const empty = await request({
    url: `https://${HOST}:${serverPort}/ok`,
    deps: { resolve: resolverFor([]), dial: dialTo(serverPort) },
  }).catch((caught) => caught);
  assert.equal(empty.code, "policy_denied");
  assert.equal(empty.delivery_state, "not_sent");

  const failed = await request({
    url: `https://${HOST}:${serverPort}/ok`,
    deps: {
      resolve: async () => {
        throw new Error("ENOTFOUND");
      },
      dial: dialTo(serverPort),
    },
  }).catch((caught) => caught);
  assert.equal(failed.code, "dns_failure");
  assert.equal(failed.delivery_state, "not_sent");
});

test("A2 transport: URL credentials, schemes and ports are refused before any dial", async () => {
  let dials = 0;
  const countingDial: EgressTransportDeps["dial"] = async () => {
    dials += 1;
    throw new Error("must not be dialled");
  };
  const deps: EgressTransportDeps = {
    resolve: resolverFor([PUBLIC_IP]),
    dial: countingDial,
  };
  const userinfo = await request({
    url: `https://alice:${FAKE_SECRET}@${HOST}:${serverPort}/ok`,
    deps,
  }).catch((caught) => caught);
  assert.equal(userinfo.code, "url_userinfo");
  assert.ok(!String(userinfo.message).includes(FAKE_SECRET));
  assert.ok(!String(userinfo.destination || "").includes("alice"));

  const scheme = await request({
    url: `http://${HOST}:${serverPort}/ok`,
    deps,
  }).catch((caught) => caught);
  assert.equal(scheme.code, "unsupported_scheme");

  const port = await providerHttpRequest({
    url: `https://${HOST}:${serverPort}/ok`,
    policy: policyWithCa(),
    allowed_ports: [443],
    deps,
  }).catch((caught) => caught);
  assert.equal(port.code, "unsupported_port");
  assert.equal(dials, 0);
});

// ---------------------------------------------------------------------------
// Connection and TLS failures.
// ---------------------------------------------------------------------------

test("A2 transport: a connect failure and a connect timeout are pre-send failures", async () => {
  // A listener that accepts and immediately destroys the socket: the TLS
  // handshake cannot complete, so nothing was ever sent.
  const refused = await request({
    url: `https://${HOST}:${otherPort}/ok`,
    dialPort: otherPort,
    deps: { resolve: resolverFor([PUBLIC_IP]), dial: dialTo(otherPort) },
  }).catch((caught) => caught);
  assert.equal(refused.code, "tls_failure");
  assert.equal(refused.delivery_state, "not_sent");

  // A dialer that fails outright is a connect failure, still before any write.
  const timeout = await request({
    url: `https://${HOST}:${serverPort}/ok`,
    deps: {
      resolve: resolverFor([PUBLIC_IP]),
      dial: async () => {
        await new Promise((resolve) => setTimeout(resolve, 50));
        throw new Error("connect failed");
      },
    },
  }).catch((caught) => caught);
  assert.equal(timeout.code, "connect_failure");
  assert.equal(timeout.delivery_state, "not_sent");
});

test("A2 transport: an untrusted CA and a hostname mismatch both fail TLS", async () => {
  const untrusted = await request({
    url: `https://${HOST}:${serverPort}/ok`,
    policy: loadEgressPolicy({}),
  }).catch((caught) => caught);
  assert.equal(untrusted.code, "tls_failure");
  assert.equal(untrusted.delivery_state, "not_sent");

  const mismatch = await request({
    url: `https://${OTHER_HOST}:${serverPort}/ok`,
    addresses: [PUBLIC_IP],
    deps: { resolve: resolverFor([PUBLIC_IP]), dial: dialTo(serverPort) },
  }).catch((caught) => caught);
  assert.equal(mismatch.code, "tls_failure");
  assert.equal(mismatch.delivery_state, "not_sent");
});

test("A2 transport: the socket protocol primitive returns a verified TLS socket", async () => {
  const { socket, dial } = await validatedTlsConnect({
    host: HOST,
    port: serverPort,
    policy: policyWithCa(),
    allowed_ports: [serverPort],
    deps: { resolve: resolverFor([PUBLIC_IP]), dial: dialTo(serverPort) },
  });
  assert.equal(dial.address, PUBLIC_IP);
  assert.equal(dial.servername, HOST);
  assert.equal(
    (socket as unknown as { authorized?: boolean }).authorized,
    true,
  );
  socket.destroy();

  const denied = await validatedTlsConnect({
    host: HOST,
    port: serverPort,
    policy: policyWithCa(),
    deps: { resolve: resolverFor(["127.0.0.1"]), dial: dialTo(serverPort) },
  }).catch((caught) => caught);
  assert.equal(denied.code, "policy_denied");
});

// ---------------------------------------------------------------------------
// Limits and timeouts.
// ---------------------------------------------------------------------------

test("A2 transport: an oversized request is refused before it is sent", async () => {
  const error = await request({
    url: `https://${HOST}:${serverPort}/ok`,
    method: "POST",
    body: "x".repeat(EGRESS_TRANSPORT_LIMITS.max_request_bytes + 1),
  }).catch((caught) => caught);
  assert.equal(error.code, "request_too_large");
  assert.equal(error.delivery_state, "not_sent");
});

test("A2 transport: an oversized response is aborted and reported as unknown", async () => {
  const error = await request({
    url: `https://${HOST}:${serverPort}/big`,
  }).catch((caught) => caught);
  assert.equal(error.code, "response_too_large");
  assert.equal(
    error.delivery_state,
    "unknown",
    "the request was written, so the outcome cannot be assumed",
  );
});

test("A2 transport: a provider that never answers times out as unknown", async () => {
  const error = await request({
    url: `https://${HOST}:${silentPort}/ok`,
    dialPort: silentPort,
    deps: { resolve: resolverFor([PUBLIC_IP]), dial: dialTo(silentPort) },
    timeoutMs: 300,
  }).catch((caught) => caught);
  assert.equal(error.code, "read_timeout");
  assert.equal(error.delivery_state, "unknown");
});

// ---------------------------------------------------------------------------
// Redaction.
// ---------------------------------------------------------------------------

test("A2 transport: no error field carries a credential, URL or raw exception", async () => {
  const error = await request({
    url: `https://${HOST}:${serverPort}/big`,
    headers: { authorization: `Bearer ${FAKE_SECRET}` },
  }).catch((caught) => caught);
  const serialized = JSON.stringify({
    message: error.message,
    summary: error.summary,
    code: error.code,
    delivery_state: error.delivery_state,
    destination: error.destination,
  });
  assert.ok(
    !serialized.includes(FAKE_SECRET),
    "the credential must not appear",
  );
  assert.ok(!serialized.includes("Bearer"), "the header value must not appear");
  assert.equal(
    error.message,
    error.summary,
    "the message is the fixed summary, never a raw exception",
  );
  for (const raw of [
    "must not be dialled",
    "connect failed",
    "too late",
    "ENOTFOUND",
  ])
    assert.ok(!serialized.includes(raw), `raw exception text leaked: ${raw}`);
  assert.equal(error.destination, `https://${HOST}:${serverPort}/big`);
});
