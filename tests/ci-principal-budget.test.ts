import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

// CI infrastructure proof for scripts/ci/wait-for-principal-budget.mjs.
//
// The property under test is the one FULL run 38473169389 failed on: entry into
// the Connected Work hosted browser gate must verify the budget of the SAME
// authenticated principal it will use, through the same
// `principal:<tenant>:<user>` limiter that keys authenticated `GET /api/v1/*`
// reads. The network-key check in scripts/ci/wait-for-auth-budget.sh cannot see
// that limiter, so it reported 271 remaining while the lane's first read was
// already 429.
//
// These tests exercise the helper against a stub that speaks the real response
// contract (x-ratelimit-remaining / x-ratelimit-limit / x-ratelimit-reset and
// Retry-After on 429). They assert the five required properties: healthy budget
// passes immediately; insufficient budget waits instead of declaring readiness;
// a 429 honours the server-directed Retry-After; malformed or missing auth state
// fails closed; and a refused session is never mistaken for available budget.

const run = promisify(execFile);
const helper = fileURLToPath(
  new URL("../scripts/ci/wait-for-principal-budget.mjs", import.meta.url),
);

const SESSION_VALUE = "session-cookie-value-must-never-be-logged-7f3a91";

type Probe = { hits: number; cookies: string[] };

function storageState(overrides?: Record<string, unknown>) {
  return JSON.stringify({
    cookies: [
      {
        name: "workspace_session",
        value: SESSION_VALUE,
        domain: "127.0.0.1",
        path: "/",
        expires: -1,
        httpOnly: true,
        secure: false,
        sameSite: "Lax",
      },
    ],
    origins: [],
    ...(overrides || {}),
  });
}

async function withStub(
  handler: (hit: number) => {
    status: number;
    headers?: Record<string, string>;
  },
  body: (baseUrl: string, probe: Probe) => Promise<void>,
) {
  const probe: Probe = { hits: 0, cookies: [] };
  const server: Server = createServer((req, res) => {
    if (req.url !== "/api/v1/me") {
      res.writeHead(404);
      res.end();
      return;
    }
    probe.hits += 1;
    probe.cookies.push(String(req.headers.cookie || ""));
    const { status, headers } = handler(probe.hits);
    res.writeHead(status, headers || {});
    res.end(
      status === 200 || status === 201 ? "{}" : JSON.stringify({ error: "x" }),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  try {
    await body(`http://127.0.0.1:${port}`, probe);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

async function stateFile(contents: string) {
  const dir = await mkdtemp(join(tmpdir(), "principal-budget-"));
  const path = join(dir, "session.json");
  await writeFile(path, contents);
  return path;
}

function env(statePath: string) {
  return {
    ...process.env,
    PRINCIPAL_BUDGET_STATE: statePath,
    PRINCIPAL_BUDGET_MIN_REMAINING: "240",
    PRINCIPAL_BUDGET_ATTEMPTS: "3",
    PRINCIPAL_BUDGET_INTERVAL_MS: "200",
    PRINCIPAL_BUDGET_MAX_WAIT_MS: "4000",
    PRINCIPAL_BUDGET_TOTAL_WAIT_MS: "8000",
    PRINCIPAL_BUDGET_REQUEST_TIMEOUT_MS: "2000",
    E2E_AUTH_STATE: "",
  };
}

test("a healthy principal budget passes immediately", async () => {
  const path = await stateFile(storageState());
  await withStub(
    () => ({
      status: 200,
      headers: {
        "x-ratelimit-limit": "300",
        "x-ratelimit-remaining": "299",
        "x-ratelimit-reset": "51",
      },
    }),
    async (baseUrl, probe) => {
      const { stdout } = await run("node", [helper, baseUrl], {
        env: env(path),
      });
      assert.match(
        stdout,
        /Authenticated principal read budget available: 299\/300/,
      );
      assert.equal(
        probe.hits,
        1,
        "a healthy budget must pass on the first probe",
      );
    },
  );
});

test("an insufficient principal budget waits instead of declaring readiness", async () => {
  const path = await stateFile(storageState());
  await withStub(
    (hit) => ({
      status: 200,
      headers: {
        "x-ratelimit-limit": "300",
        // The budget the engine/viewport harness leaves behind, then recovery.
        "x-ratelimit-remaining": hit === 1 ? "12" : "260",
        "x-ratelimit-reset": "1",
      },
    }),
    async (baseUrl, probe) => {
      const { stdout, stderr } = await run("node", [helper, baseUrl], {
        env: env(path),
      });
      assert.equal(
        probe.hits,
        2,
        "a low budget must not be accepted on the first probe",
      );
      assert.match(
        stderr,
        /the authenticated principal budget is 12, below the required 240/,
        "the low reading must be reported for what it is",
      );
      assert.match(
        stdout,
        /Authenticated principal read budget available: 260\/300/,
        "readiness is declared only once the real window has replenished",
      );
      assert.ok(
        !/299\/300|260\/300/.test(stderr),
        "no success may be claimed on the low reading",
      );
    },
  );
});

test("a 429 honours the server-directed Retry-After", async () => {
  const path = await stateFile(storageState());
  await withStub(
    (hit) => {
      const headers: Record<string, string> =
        hit === 1
          ? { "retry-after": "1" }
          : {
              "x-ratelimit-limit": "300",
              "x-ratelimit-remaining": "288",
              "x-ratelimit-reset": "12",
            };
      return { status: hit === 1 ? 429 : 200, headers };
    },
    async (baseUrl, probe) => {
      const started = Date.now();
      const { stdout, stderr } = await run("node", [helper, baseUrl], {
        env: env(path),
      });
      const elapsed = Date.now() - started;
      assert.ok(probe.hits >= 2, "a 429 must be re-probed, never accepted");
      assert.ok(
        elapsed >= 1000,
        `the Retry-After of 1s must be honoured (waited ${elapsed}ms)`,
      );
      assert.match(stderr, /honouring the server-directed Retry-After of 1s/);
      assert.match(
        stdout,
        /Authenticated principal read budget available: 288\/300/,
      );
    },
  );
});

test("a 429 without a usable hint fails closed", async () => {
  const path = await stateFile(storageState());
  await withStub(
    () => ({ status: 429, headers: {} }),
    async (baseUrl) => {
      await assert.rejects(
        run("node", [helper, baseUrl], { env: env(path) }),
        (error: any) => {
          assert.match(
            String(error.stderr),
            /HTTP 429 from \/api\/v1\/me carried no usable Retry-After/,
          );
          return true;
        },
      );
    },
  );
});

test("missing auth state fails closed without contacting the API", async () => {
  const path = join(tmpdir(), `absent-${Date.now()}-session.json`);
  await withStub(
    () => ({ status: 200, headers: { "x-ratelimit-remaining": "299" } }),
    async (baseUrl, probe) => {
      await assert.rejects(
        run("node", [helper, baseUrl], { env: env(path) }),
        (error: any) => {
          assert.match(String(error.stderr), /no Playwright storage state at/);
          return true;
        },
      );
      assert.equal(probe.hits, 0, "no probe may be issued without a session");
    },
  );
});

test("storage state without the session cookie fails closed", async () => {
  const path = await stateFile(storageState({ cookies: [] }));
  await withStub(
    () => ({ status: 200, headers: { "x-ratelimit-remaining": "299" } }),
    async (baseUrl, probe) => {
      await assert.rejects(
        run("node", [helper, baseUrl], { env: env(path) }),
        (error: any) => {
          assert.match(
            String(error.stderr),
            /the acceptance principal is not signed in/,
          );
          return true;
        },
      );
      assert.equal(probe.hits, 0);
    },
  );
});

test("malformed storage state fails closed", async () => {
  const path = await stateFile("{not json");
  await withStub(
    () => ({ status: 200, headers: { "x-ratelimit-remaining": "299" } }),
    async (baseUrl, probe) => {
      await assert.rejects(
        run("node", [helper, baseUrl], { env: env(path) }),
        (error: any) => {
          assert.match(String(error.stderr), /is not valid JSON/);
          return true;
        },
      );
      assert.equal(probe.hits, 0);
    },
  );
});

test("a refused session is never mistaken for available budget", async () => {
  const path = await stateFile(storageState());
  await withStub(
    () => ({
      status: 401,
      // A hostile or empty budget header beside a refused session must not pass.
      headers: { "x-ratelimit-limit": "300", "x-ratelimit-remaining": "299" },
    }),
    async (baseUrl) => {
      await assert.rejects(
        run("node", [helper, baseUrl], { env: env(path) }),
        (error: any) => {
          assert.match(String(error.stderr), /was refused with HTTP 401/);
          assert.ok(
            !/Authenticated principal read budget available/.test(
              String(error.stdout),
            ),
            "no readiness may be declared for a refused session",
          );
          return true;
        },
      );
    },
  );
});

test("a 200 without rate-limit evidence fails closed", async () => {
  const path = await stateFile(storageState());
  await withStub(
    () => ({ status: 200, headers: {} }),
    async (baseUrl) => {
      await assert.rejects(
        run("node", [helper, baseUrl], { env: env(path) }),
        (error: any) => {
          assert.match(
            String(error.stderr),
            /without a usable x-ratelimit-remaining header/,
          );
          return true;
        },
      );
    },
  );
});

test("the session cookie is used but never logged", async () => {
  const path = await stateFile(storageState());
  await withStub(
    () => ({
      status: 200,
      headers: { "x-ratelimit-limit": "300", "x-ratelimit-remaining": "297" },
    }),
    async (baseUrl, probe) => {
      const { stdout, stderr } = await run("node", [helper, baseUrl], {
        env: env(path),
      });
      assert.ok(
        probe.cookies.some((value) =>
          value.includes(`workspace_session=${SESSION_VALUE}`),
        ),
        "the real session cookie must be sent, so the principal limiter is exercised",
      );
      assert.ok(
        !`${stdout}${stderr}`.includes(SESSION_VALUE),
        "the cookie value must never be logged",
      );
    },
  );
});

test("helper source cannot submit credentials or reach limiter storage", async () => {
  const source = await readFile(helper, "utf8");
  assert.ok(
    !/auth\/login|password|credential/i.test(source),
    "the helper must not submit credentials or mention them",
  );
  assert.ok(
    !/from\s+["'](ioredis|redis)["']|require\(["'](ioredis|redis)["']\)|REDIS_URL/.test(
      source,
    ),
    "the helper must not couple CI to the limiter's private storage",
  );
  assert.ok(
    source.includes("storage state"),
    "the helper must read an existing Playwright storage state",
  );
  assert.ok(
    source.includes("/api/v1/me"),
    "the helper must probe an authenticated read route",
  );
});

test("the workflow requires both readiness checks before the Connected Work gate", async () => {
  const workflow = await readFile(
    fileURLToPath(new URL("../.github/workflows/ci.yml", import.meta.url)),
    "utf8",
  );
  const network = workflow.indexOf(
    "name: Wait for auth rate-limit budget before Connected Work",
  );
  const principal = workflow.indexOf(
    "name: Wait for authenticated principal read budget before Connected Work",
  );
  const lane = workflow.indexOf(
    "name: Verify Connected Work and Automations browser workflow",
  );
  assert.ok(network >= 0, "the network/general readiness check must remain");
  assert.ok(
    principal >= 0,
    "the authenticated-principal readiness check must exist",
  );
  assert.ok(lane >= 0, "the Connected Work gate must remain");
  assert.ok(network < principal, "the network check runs first");
  assert.ok(
    principal < lane,
    "the principal check must run immediately before the lane it protects",
  );
  const principalStep = workflow.slice(principal, lane);
  assert.match(
    principalStep,
    /node scripts\/ci\/wait-for-principal-budget\.mjs/,
    "the principal check must invoke the new helper",
  );
  // Structural check: a step-level `continue-on-error:` key inside the step's
  // own body would make it non-blocking. Comments that name the prohibition are
  // documentation, not configuration, so match a YAML key only.
  const stepBody = (from: number) => {
    const next = workflow.indexOf("\n      - ", from + 1);
    return workflow.slice(from, next === -1 ? undefined : next);
  };
  assert.ok(
    !/^[ \t]*continue-on-error:/m.test(stepBody(principal)),
    "the readiness check must fail the job, never be tolerated",
  );
  assert.ok(
    !/^[ \t]*continue-on-error:/m.test(stepBody(lane)),
    "the Connected Work gate must stay blocking",
  );
  const config = await readFile(
    fileURLToPath(
      new URL("../playwright.connected-work.config.ts", import.meta.url),
    ),
    "utf8",
  );
  assert.match(config, /retries: 0/, "the lane must keep retries at zero");
  assert.ok(
    !/test\.fixme|test\.skip|test\.slow/.test(config),
    "no quarantine mechanism may be introduced",
  );
});
