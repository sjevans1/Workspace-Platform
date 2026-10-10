import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

// CI infrastructure proof: scripts/ci/wait-for-auth-budget.sh must adapt CI
// sequencing to the production rate limiter, never weaken it. It waits only for
// the server-directed interval, stays bounded, and fails closed.

const run = promisify(execFile);
const script = fileURLToPath(
  new URL("../scripts/ci/wait-for-auth-budget.sh", import.meta.url),
);

type StubOptions = {
  generalRemaining: string | null;
  signIn429Count: number; // how many initial sign-ins are rate limited
  retryAfter?: string;
};

async function withStubServer(
  options: StubOptions,
  body: (baseUrl: string, hits: { logins: number }) => Promise<void>,
) {
  let logins = 0;
  const server: Server = createServer((req, res) => {
    if (req.url === "/api/v1/auth/methods") {
      if (options.generalRemaining === null) {
        res.writeHead(200, {});
      } else {
        res.writeHead(200, { "x-ratelimit-remaining": options.generalRemaining });
      }
      res.end("{}");
      return;
    }
    if (req.url === "/api/v1/auth/login") {
      logins += 1;
      if (logins <= options.signIn429Count) {
        res.writeHead(429, {
          "retry-after": options.retryAfter ?? "1",
          "content-type": "application/json",
        });
        res.end(JSON.stringify({ error: "rate limited" }));
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end("{}");
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  try {
    await body(`http://127.0.0.1:${port}`, { logins });
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

const fastEnv = {
  ...process.env,
  AUTH_BUDGET_GENERAL_ATTEMPTS: "3",
  AUTH_BUDGET_GENERAL_INTERVAL: "1",
  AUTH_BUDGET_SIGNIN_ATTEMPTS: "4",
  AUTH_BUDGET_MIN_REMAINING: "240",
  AUTH_BUDGET_MAX_WAIT: "5",
};

test("auth budget helper: available budget exits immediately after one probe", async () => {
  await withStubServer(
    { generalRemaining: "999", signIn429Count: 0 },
    async (baseUrl) => {
      const { stdout } = await run("bash", [script, baseUrl], { env: fastEnv });
      assert.match(stdout, /Rate-limit budget available/);
      assert.match(stdout, /Sign-in rate-limit budget available \(status 200\)/);
    },
  );
});

test("auth budget helper: honors Retry-After and succeeds once the budget recovers", async () => {
  await withStubServer(
    { generalRemaining: "999", signIn429Count: 1, retryAfter: "1" },
    async (baseUrl) => {
      const { stdout } = await run("bash", [script, baseUrl], { env: fastEnv });
      assert.match(stdout, /Sign-in limited; waiting 1s before retry 1/);
      assert.match(stdout, /Sign-in rate-limit budget available \(status 200\)/);
    },
  );
});

test("auth budget helper: fails closed when the sign-in budget never recovers", async () => {
  await withStubServer(
    { generalRemaining: "999", signIn429Count: 99, retryAfter: "1" },
    async (baseUrl) => {
      await assert.rejects(
        run("bash", [script, baseUrl], { env: fastEnv }),
        (error: any) => {
          assert.match(String(error.stderr), /Sign-in rate-limit window did not recover/);
          return true;
        },
      );
    },
  );
});

test("auth budget helper: fails closed when the general budget never recovers", async () => {
  await withStubServer(
    { generalRemaining: "1", signIn429Count: 0 },
    async (baseUrl) => {
      await assert.rejects(
        run("bash", [script, baseUrl], { env: fastEnv }),
        (error: any) => {
          assert.match(String(error.stderr), /Shared test rate-limit window did not recover/);
          return true;
        },
      );
    },
  );
});

test("auth budget helper: rejects a server-directed wait beyond the bounded maximum", async () => {
  await withStubServer(
    { generalRemaining: "999", signIn429Count: 99, retryAfter: "600" },
    async (baseUrl) => {
      await assert.rejects(
        run("bash", [script, baseUrl], { env: fastEnv }),
        (error: any) => {
          assert.match(String(error.stderr), /exceeds the bounded maximum/);
          return true;
        },
      );
    },
  );
});
