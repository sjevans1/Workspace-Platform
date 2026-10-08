import {
  test,
  expect,
  type Browser,
  type BrowserContext,
  type Page,
} from "@playwright/test";
import { execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import os from "node:os";

// W24 whole-stack qualification.
//
// Wave R qualified collaboration reconnection only. This harness measures the
// wider system on the same reference CI host and the same deployment stack:
// API latency and throughput for representative operations, container CPU/RSS,
// PostgreSQL connections and lock pressure, worker and queue backlog, and the
// antivirus/encrypted-storage path. It reuses the Wave R helpers and the
// existing deployed Compose stack rather than introducing a new load framework.
//
// The numbers it produces are CI-host qualification evidence for one runner
// class, not a universal production SLO.

const email = "browser@example.test";
const password = "browser-password-123";
const LEVELS = [1, 5, 10, 25];
const ITERATIONS = 3;

function compose(args: string[]) {
  return execFileSync("docker", ["compose", ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

async function login(page: Page) {
  await page.goto("/");
  const heading = page.getByRole("heading", { name: "Welcome back, Shane." });
  if (await heading.isVisible()) return;
  const signIn = page.getByRole("button", { name: "Sign in", exact: true });
  await expect(signIn).toBeVisible();
  await page.getByLabel("Email", { exact: true }).fill(email);
  await page.getByLabel("Password", { exact: true }).fill(password);
  await signIn.click();
  await expect(heading).toBeVisible();
}

function hostCharacteristics() {
  const cpus = os.cpus();
  return {
    platform: os.platform(),
    release: os.release(),
    arch: os.arch(),
    cpuCount: cpus.length,
    cpuModel: cpus.length ? cpus[0].model.trim() : "unknown",
    totalMemoryBytes: os.totalmem(),
    nodeVersion: process.version,
  };
}

function dockerStats() {
  const services = ["api", "collab", "worker", "postgres", "clamav", "valkey"];
  const result: Record<string, { cpuPercent: number; memoryBytes: number }> = {};
  for (const service of services) {
    try {
      const id = compose(["ps", "-q", service]).trim();
      if (!id) continue;
      const raw = execFileSync(
        "docker",
        ["stats", "--no-stream", "--format", "{{json .}}", id],
        { encoding: "utf8" },
      ).trim();
      const value = JSON.parse(raw);
      const cpuPercent =
        Number(String(value.CPUPerc || "0").replace("%", "")) || 0;
      const memoryToken = String(value.MemUsage || "0B").split("/")[0].trim();
      const match = memoryToken.match(/^([0-9.]+)([KMGTP]?i?B)$/i);
      const factors: Record<string, number> = {
        B: 1, KB: 1000, KIB: 1024,
        MB: 1000 ** 2, MIB: 1024 ** 2,
        GB: 1000 ** 3, GIB: 1024 ** 3,
        TB: 1000 ** 4, TIB: 1024 ** 4,
      };
      const memoryBytes = match
        ? Number(match[1]) * (factors[match[2].toUpperCase()] || 1)
        : 0;
      result[service] = { cpuPercent, memoryBytes };
    } catch {
      // A service that is not running is reported by omission, not by failure.
    }
  }
  return result;
}

function psqlJson(sql: string) {
  const output = compose([
    "exec", "-T", "postgres", "psql", "-U", "postgres", "-d", "workspace",
    "-At", "-c", sql,
  ]);
  return JSON.parse(output.trim());
}

function postgresStats() {
  return psqlJson(
    [
      "SELECT json_build_object(",
      "'connections',(SELECT count(*) FROM pg_stat_activity WHERE datname='workspace'),",
      "'active',(SELECT count(*) FROM pg_stat_activity WHERE datname='workspace' AND state='active'),",
      "'waiting',(SELECT count(*) FROM pg_stat_activity WHERE datname='workspace' AND wait_event IS NOT NULL),",
      "'locks',(SELECT count(*) FROM pg_locks l JOIN pg_database d ON d.oid=l.database WHERE d.datname='workspace'),",
      "'not_granted_locks',(SELECT count(*) FROM pg_locks l JOIN pg_database d ON d.oid=l.database WHERE d.datname='workspace' AND NOT l.granted),",
      "'lock_waits',(SELECT count(*) FROM pg_locks l JOIN pg_database d ON d.oid=l.database WHERE d.datname='workspace' AND l.mode='ExclusiveLock' AND NOT l.granted),",
      "'deadlocks',(SELECT deadlocks FROM pg_stat_database WHERE datname='workspace'),",
      "'xact_rollback',(SELECT xact_rollback FROM pg_stat_database WHERE datname='workspace'),",
      "'max_connections',(SELECT setting::int FROM pg_settings WHERE name='max_connections')",
      ")::text;",
    ].join(""),
  );
}

// Queue depth is read without exposing any tenant identifier or payload.
function backlogStats() {
  return psqlJson(
    [
      "SELECT json_build_object(",
      "'jobs_pending',(SELECT count(*) FROM jobs WHERE status='pending'),",
      "'jobs_running',(SELECT count(*) FROM jobs WHERE status='running'),",
      "'jobs_failed',(SELECT count(*) FROM jobs WHERE status='failed'),",
      "'jobs_cancelled',(SELECT count(*) FROM jobs WHERE status='cancelled'),",
      "'jobs_dead',(SELECT count(*) FROM jobs WHERE status='dead'),",
      "'webhook_pending',(SELECT count(*) FROM webhook_deliveries WHERE status='pending'),",
      "'webhook_dead',(SELECT count(*) FROM webhook_deliveries WHERE status='dead'),",
      "'outbox_pending',(SELECT count(*) FROM event_outbox WHERE dispatched_at IS NULL),",
      "'object_deletions_pending',(SELECT count(*) FROM object_deletions WHERE deleted_at IS NULL)",
      ")::text;",
    ].join(""),
  );
}

function percentile(values: number[], p: number) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(
    sorted.length - 1,
    Math.ceil((p / 100) * sorted.length) - 1,
  );
  return sorted[Math.max(0, index)];
}

function summarise(samples: number[]) {
  return {
    count: samples.length,
    p50: percentile(samples, 50),
    p95: percentile(samples, 95),
    p99: percentile(samples, 99),
    max: samples.length ? Math.max(...samples) : 0,
  };
}

const OPERATIONS = [
  "list",
  "recent",
  "detail",
  "content",
  "search",
  "permissions",
  "export",
  "update",
] as const;

async function createSessionPage(
  request: BrowserContext["request"],
  parentId: string,
  label: string,
) {
  const me = await (await request.get("/api/v1/me")).json();
  const response = await request.post("/api/v1/resources", {
    headers: { "X-CSRF-Token": me.csrf },
    data: { kind: "page", parent_id: parentId, title: label },
  });
  expect(response.ok(), await response.text()).toBeTruthy();
  return (await response.json()).id as string;
}

async function runSession(
  context: BrowserContext,
  pageId: string,
  samples: Record<string, number[]>,
) {
  const request = context.request;
  const me = await (await request.get("/api/v1/me")).json();
  const headers = { "X-CSRF-Token": me.csrf };

  for (let i = 0; i < ITERATIONS; i++) {
    const measure = async (name: string, call: () => Promise<{ ok(): boolean; status(): number; text(): Promise<string> }>) => {
      const started = performance.now();
      const response = await call();
      (samples[name] ||= []).push(performance.now() - started);
      expect(response.ok(), `${name}: ${response.status()} ${await response.text()}`).toBeTruthy();
      return response;
    };

    await measure("list", () => request.get("/api/v1/resources"));
    await measure("recent", () => request.get("/api/v1/resources?recent=true"));
    await measure("detail", () => request.get(`/api/v1/resources/${pageId}`));
    await measure("content", () => request.get(`/api/v1/pages/${pageId}/content`));
    await measure("search", () => request.get("/api/v1/search?q=W24"));
    await measure(
      "permissions",
      () => request.get(`/api/v1/resources/${pageId}/permissions`),
    );
    await measure(
      "export",
      () => request.get(`/api/v1/resources/${pageId}/export?format=csv`),
    );
    await measure("update", () =>
      request.patch(`/api/v1/resources/${pageId}`, {
        headers,
        data: { title: `W24 mixed ${i}` },
      }),
    );
  }
}

test("W24 measures whole-stack capacity for 1/5/10/25 concurrent sessions", async ({
  page,
  browser,
}) => {
  test.skip(
    process.env.E2E_W24_WHOLE_STACK !== "1",
    "W24 whole-stack capacity evidence runs only in the dedicated deployed acceptance step",
  );

  await login(page);
  const cookies = await page.context().cookies();
  const me = await (await page.request.get("/api/v1/me")).json();
  const roots = await (await page.request.get("/api/v1/resources")).json();
  const spaceResponse = await page.request.post("/api/v1/resources", {
    headers: { "X-CSRF-Token": me.csrf },
    data: {
      kind: "space",
      parent_id: roots[0].id,
      title: "W24 whole-stack " + Date.now(),
    },
  });
  expect(spaceResponse.ok(), await spaceResponse.text()).toBeTruthy();
  const space = await spaceResponse.json();

  const levels: Record<string, unknown>[] = [];
  const errors: string[] = [];

  for (const level of LEVELS) {
    const contexts: BrowserContext[] = [];
    const pageIds: string[] = [];
    const samples: Record<string, number[]> = {};
    let baselineDocker: Record<string, unknown> = {};
    let peakDocker: Record<string, unknown> = {};
    let baselinePostgres: Record<string, unknown> = {};
    let peakPostgres: Record<string, unknown> = {};
    const backlogBefore = backlogStats();

    try {
      for (let i = 0; i < level; i++) {
        const context = await browser.newContext();
        await context.addCookies(cookies);
        contexts.push(context);
        pageIds.push(
          await createSessionPage(context.request, space.id, `W24 s${i} ${Date.now()}`),
        );
      }

      baselineDocker = dockerStats();
      baselinePostgres = postgresStats();
      const started = performance.now();
      await Promise.all(
        contexts.map((context, index) =>
          runSession(context, pageIds[index], samples).catch((error) => {
            errors.push(`level=${level} session=${index}: ${String(error).slice(0, 200)}`);
          }),
        ),
      );
      const elapsedSeconds = (performance.now() - started) / 1000;
      peakDocker = dockerStats();
      peakPostgres = postgresStats();

      const latencies: Record<string, ReturnType<typeof summarise>> = {};
      let totalOperations = 0;
      for (const name of OPERATIONS) {
        const values = samples[name] || [];
        latencies[name] = summarise(values);
        totalOperations += values.length;
      }

      levels.push({
        concurrency: level,
        iterationsPerSession: ITERATIONS,
        elapsedSeconds,
        totalOperations,
        throughputPerSecond: elapsedSeconds
          ? Number((totalOperations / elapsedSeconds).toFixed(2))
          : 0,
        latencyMs: latencies,
        docker: { baseline: baselineDocker, peak: peakDocker },
        postgres: { baseline: baselinePostgres, peak: peakPostgres },
        backlogBefore,
        backlogAfter: backlogStats(),
        sampleErrors: errors.filter((entry) => entry.startsWith(`level=${level} `)),
      });
    } finally {
      for (const context of contexts) await context.close();
    }
  }

  expect(errors, errors.join("\n")).toEqual([]);

  const artifact = {
    format: "workspace-w24-capacity-v1",
    captured_at: new Date().toISOString(),
    scope: "CI-host qualification evidence only, not a universal production SLO",
    host: hostCharacteristics(),
    workload: {
      levels: LEVELS,
      iterationsPerSession: ITERATIONS,
      operations: [...OPERATIONS],
      routes: [
        "GET /api/v1/resources",
        "GET /api/v1/resources?recent=true",
        "GET /api/v1/resources/:id",
        "GET /api/v1/pages/:id/content",
        "GET /api/v1/search?q=",
        "GET /api/v1/resources/:id/permissions",
        "GET /api/v1/resources/:id/export?format=csv",
        "PATCH /api/v1/resources/:id",
      ],
      dataset: "fresh space with one page per concurrent session",
      note:
        "Runs against the already-deployed production-like Compose stack; " +
        "reuses the Wave R capacity helpers and the Wave R harness deployment.",
    },
    levels,
    maximumTestedConcurrency: Math.max(...LEVELS),
    errors,
  };

  await mkdir("capacity-results", { recursive: true });
  await writeFile(
    "capacity-results/w24-reference-host.json",
    JSON.stringify(artifact, null, 2),
  );

  expect(levels.length).toBe(LEVELS.length);
});
