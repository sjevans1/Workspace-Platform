import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

// CI infrastructure proof for scripts/ci/wait-for-auth-budget.sh.
//
// The critical property: the budget check is NON-MUTATING with respect to the
// sign-in limiter. It must never submit credentials, valid or invalid, because
// the sign-in route's production budget (10 attempts / 5 minutes per network) is
// shared, and a probe can spend the final remaining attempt and cause the
// legitimate qualification login to be rejected with 429.

const run = promisify(execFile);
const script = fileURLToPath(
  new URL("../scripts/ci/wait-for-auth-budget.sh", import.meta.url),
);

type HitLog = { methods: number; logins: number };

async function withStubServer(
  options: { generalRemaining: string | null },
  body: (baseUrl: string, hits: HitLog) => Promise<void>,
) {
  const hits: HitLog = { methods: 0, logins: 0 };
  const server: Server = createServer((req, res) => {
    if (req.url === "/api/v1/auth/methods") {
      hits.methods += 1;
      if (options.generalRemaining === null) {
        res.writeHead(200, {});
      } else {
        res.writeHead(200, { "x-ratelimit-remaining": options.generalRemaining });
      }
      res.end("{}");
      return;
    }
    if (req.url === "/api/v1/auth/login") {
      // Reaching here at all breaks the non-mutating contract.
      hits.logins += 1;
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "Incorrect email or password" }));
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  try {
    await body(`http://127.0.0.1:${port}`, hits);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

const fastEnv = {
  ...process.env,
  AUTH_BUDGET_GENERAL_ATTEMPTS: "3",
  AUTH_BUDGET_GENERAL_INTERVAL: "1",
  AUTH_BUDGET_MIN_REMAINING: "240",
};

test("budget check does not increment sign-in attempts", async () => {
  await withStubServer({ generalRemaining: "999" }, async (baseUrl, hits) => {
    const { stdout } = await run("bash", [script, baseUrl], { env: fastEnv });
    assert.match(stdout, /Rate-limit budget available/);
    assert.equal(
      hits.logins,
      0,
      "the budget check must not consume a sign-in attempt",
    );
  });
});

test("a full window is not consumed by the readiness check itself", async () => {
  await withStubServer({ generalRemaining: "999" }, async (baseUrl, hits) => {
    await run("bash", [script, baseUrl], { env: fastEnv });
    assert.equal(hits.logins, 0, "no sign-in attempt may be issued at all");
    assert.ok(hits.methods >= 1, "the read-only budget route is used");
  });
});

test("persistent general rate limiting still fails closed", async () => {
  await withStubServer({ generalRemaining: "1" }, async (baseUrl, hits) => {
    await assert.rejects(
      run("bash", [script, baseUrl], { env: fastEnv }),
      (error: any) => {
        assert.match(
          String(error.stderr),
          /Shared test rate-limit window did not recover/,
        );
        return true;
      },
    );
    assert.equal(hits.logins, 0, "failure handling must not probe sign-in");
  });
});

test("an absent budget header fails closed", async () => {
  await withStubServer({ generalRemaining: null }, async (baseUrl) => {
    await assert.rejects(
      run("bash", [script, baseUrl], { env: fastEnv }),
      (error: any) => {
        assert.match(
          String(error.stderr),
          /Shared test rate-limit window did not recover/,
        );
        return true;
      },
    );
  });
});

test("helper source contains no credential submission", async () => {
  const source = await readFile(script, "utf8");
  assert.ok(
    !/auth\/login/.test(source),
    "the helper must not reference the sign-in route at all",
  );
  assert.ok(!/password/i.test(source), "the helper must not submit credentials");
  assert.ok(
    source.includes("/api/v1/auth/methods"),
    "the read-only budget route must be used",
  );
});

test("legitimate login honors the server-directed reset and stays bounded", async () => {
  const spec = await readFile(
    fileURLToPath(new URL("../e2e/wave-r-capacity.spec.ts", import.meta.url)),
    "utf8",
  );
  const verified = spec.indexOf('r.url().includes("/api/v1/auth/login")');
  const readiness = spec.indexOf("recoverOnce(");
  assert.ok(verified >= 0, "the legitimate login must await its real response");
  assert.ok(
    readiness >= 0,
    "the capacity login must still use the shared readiness primitive",
  );
  assert.ok(
    verified < readiness,
    "sign-in must be confirmed before shell readiness is asserted",
  );
  assert.ok(
    spec.indexOf('headers()["retry-after"]') >= 0,
    "a 429 must be answered with the server-directed Retry-After",
  );
  assert.ok(
    spec.includes("Exceeded bounded rate-limit retries"),
    "the retry must stay bounded and fail hard when exhausted",
  );
  assert.ok(
    !/waitForTimeout\(\s*\d+\s*\)/.test(spec.split("const capacities")[0]),
    "no arbitrary fixed sleep may precede the capacity ladder",
  );
});

test("W24-R capacity criteria are unchanged by this infrastructure change", async () => {
  const spec = await readFile(
    fileURLToPath(new URL("../e2e/wave-r-capacity.spec.ts", import.meta.url)),
    "utf8",
  );
  assert.match(spec, /\[1, 5, 10, 25\]/, "the 1/5/10/25 ladder must remain");
  assert.ok(
    spec.includes("waitForCollabHealth"),
    "capacity measurement must remain in the spec",
  );
});
