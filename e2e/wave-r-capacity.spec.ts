import { test, expect, type Browser, type BrowserContext, type Page } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import { recoverOnce, assertWorkspaceShell } from "./support/readiness";

const email = "browser@example.test";
const password = "browser-password-123";

function compose(args: string[]) {
  return execFileSync("docker", ["compose", ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

async function login(page: Page) {
  await page.goto("/");
  const heading = page.getByRole("heading", { name: "Welcome back, Shane." });
  const signIn = page.getByRole("button", { name: "Sign in", exact: true });
  // Deterministic entry state: wait for whichever state the application
  // presents (an already-authenticated shell, or the sign-in form) before
  // deciding whether to authenticate. An instantaneous visibility check would
  // skip sign-in whenever the page had not rendered yet.
  await expect(signIn.or(heading)).toBeVisible({ timeout: 30000 });
  if (await signIn.isVisible()) {
    // Sign in the way the accepted accessibility login does: wait for the real
    // login request, verify its outcome, and honor a rate limit with bounded
    // backoff. A blind fill-and-click silently no-ops when the click lands
    // before the page is interactive, and it cannot distinguish a 429 from a
    // successful sign-in, which is how this step failed at its entry check.
    for (let attempt = 0; attempt < 4; attempt++) {
      await page.getByLabel("Email", { exact: true }).fill(email);
      await page.getByLabel("Password", { exact: true }).fill(password);
      const response = page.waitForResponse(
        (r) =>
          r.url().includes("/api/v1/auth/login") &&
          r.request().method() === "POST",
      );
      await signIn.click();
      const loginResponse = await response;
      if (loginResponse.status() !== 429) {
        expect(
          loginResponse.ok(),
          "Login should succeed or return a bounded rate limit",
        ).toBeTruthy();
        break;
      }
      const retry = Number(loginResponse.headers()["retry-after"] || 0);
      const body = await loginResponse.json().catch(() => ({}));
      const fromBody = Number(
        String(body.error || "").match(/retry in (\d+) seconds?/i)?.[1] || 0,
      );
      const seconds = retry || fromBody || 10;
      expect(
        seconds,
        "Only bounded login backoff is supported in acceptance",
      ).toBeLessThanOrEqual(30);
      if (attempt === 3) throw Error("Exceeded bounded rate-limit retries");
      await page.waitForTimeout((seconds + 1) * 1000);
    }
  }
  // CI-H2 ordering: establish the authenticated Workspace shell through the
  // shared readiness primitive BEFORE any legacy content assertion, so a
  // not-yet-ready application takes the single bounded recovery instead of
  // failing the entry check. This protects entry only; the capacity/load
  // assertions below are untouched.
  await recoverOnce(
    `capacity-shell-${test.info().project.name}`,
    () => assertWorkspaceShell(page),
    async () => {
      await page.goto("/");
    },
  );
  // Legacy assertion retained, now guaranteed to run after shell readiness.
  await expect(heading).toBeVisible();
}

async function waitForCollabHealth(expectedConnections?: number) {
  for (let attempt = 0; attempt < 90; attempt++) {
    try {
      const raw = compose([
        "exec", "-T", "collab", "node", "-e",
        "fetch('http://127.0.0.1:1235/health').then(async r=>{const b=await r.text();if(!r.ok)process.exit(2);console.log(b)}).catch(()=>process.exit(3))",
      ]);
      const health = JSON.parse(raw.trim());
      if (
        health.healthy === true &&
        (expectedConnections === undefined || Number(health.connections) >= expectedConnections)
      ) return health;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error("Collaboration service did not reach the expected healthy state");
}

function dockerStats() {
  const services = ["api", "collab", "worker", "postgres"];
  const result: Record<string, { cpuPercent: number; memoryBytes: number }> = {};
  for (const service of services) {
    const id = compose(["ps", "-q", service]).trim();
    if (!id) continue;
    const raw = execFileSync(
      "docker",
      ["stats", "--no-stream", "--format", "{{json .}}", id],
      { encoding: "utf8" },
    ).trim();
    const value = JSON.parse(raw);
    const cpuPercent = Number(String(value.CPUPerc || "0").replace("%", "")) || 0;
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
  }
  return result;
}

function postgresStats() {
  const sql = [
    "SELECT json_build_object(",
    "'connections',(SELECT count(*) FROM pg_stat_activity WHERE datname='workspace'),",
    "'active',(SELECT count(*) FROM pg_stat_activity WHERE datname='workspace' AND state='active'),",
    "'waiting',(SELECT count(*) FROM pg_stat_activity WHERE datname='workspace' AND wait_event IS NOT NULL),",
    "'locks',(SELECT count(*) FROM pg_locks l JOIN pg_database d ON d.oid=l.database WHERE d.datname='workspace'),",
    "'not_granted_locks',(SELECT count(*) FROM pg_locks l JOIN pg_database d ON d.oid=l.database WHERE d.datname='workspace' AND NOT l.granted)",
    ")::text;",
  ].join("");
  const output = compose([
    "exec", "-T", "postgres", "psql", "-U", "postgres", "-d", "workspace",
    "-At", "-c", sql,
  ]);
  return JSON.parse(output.trim());
}

function percentile(values: number[], p: number) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, index)];
}

async function createCapacityPage(page: Page) {
  const me = await (await page.request.get("/api/v1/me")).json();
  const headers = { "X-CSRF-Token": me.csrf };
  const roots = await (await page.request.get("/api/v1/resources")).json();
  const spaceResponse = await page.request.post("/api/v1/resources", {
    headers,
    data: {
      kind: "space",
      parent_id: roots[0].id,
      title: "W24-R capacity " + Date.now(),
    },
  });
  expect(spaceResponse.ok(), await spaceResponse.text()).toBeTruthy();
  const space = await spaceResponse.json();
  const resourceResponse = await page.request.post("/api/v1/resources", {
    headers,
    data: {
      kind: "page",
      parent_id: space.id,
      title: "W24-R reconnect capacity " + Date.now(),
    },
  });
  expect(resourceResponse.ok(), await resourceResponse.text()).toBeTruthy();
  return resourceResponse.json();
}

async function openEditors(
  browser: Browser,
  basePage: Page,
  count: number,
  url: string,
) {
  const cookies = await basePage.context().cookies();
  const sessions: { context: BrowserContext; page: Page }[] = [];
  for (let i = 0; i < count; i++) {
    const context = await browser.newContext();
    await context.addCookies(cookies);
    const page = await context.newPage();
    await page.goto(url);
    await expect(page.locator(".bn-editor")).toBeVisible({ timeout: 30000 });
    sessions.push({ context, page });
  }
  return sessions;
}

test("W24-R measures 1/5/10/25 editor reconnect capacity on the CI host", async ({
  page,
  browser,
}) => {
  test.skip(
    process.env.E2E_W24_CAPACITY !== "1",
    "W24-R capacity evidence runs only in the dedicated deployed acceptance step",
  );
  test.setTimeout(12 * 60 * 1000);
  await login(page);
  const resource = await createCapacityPage(page);
  const url = "/?page=" + resource.id;
  const contentUrl = "/api/v1/pages/" + resource.id + "/content";
  const capacities = [1, 5, 10, 25];
  const evidence: any = {
    schema: 1,
    note: "CI-host qualification evidence only; not a universal production SLO.",
    host: {
      platform: process.platform,
      arch: process.arch,
      cpuCount: os.cpus().length,
      cpuModel: os.cpus()[0]?.model || "unknown",
      totalMemoryBytes: os.totalmem(),
    },
    startedAt: new Date().toISOString(),
    scenarios: [],
  };

  for (const count of capacities) {
    const sessions = await openEditors(browser, page, count, url);
    try {
      await waitForCollabHealth(count);
      const baselineDocker = dockerStats();
      const baselineDb = postgresStats();

      // Give every client a distinct acknowledged edit before the fault.
      const preTokens = sessions.map(
        (_, i) => "pre" + count + "-" + i + "-" + Date.now(),
      );
      for (let i = 0; i < sessions.length; i++) {
        const editor = sessions[i].page.locator(".bn-editor");
        await editor.click();
        await sessions[i].page.keyboard.press("ControlOrMeta+End");
        await sessions[i].page.keyboard.insertText(" " + preTokens[i]);
      }
      // plain_text is whitespace-normalised and trimmed, so the separator space
      // before the first token is not preserved and counting " pre" occurrences
      // can never reach `count`. Require each editor's own token instead.
      await expect.poll(async () => {
        const response = await page.request.get(contentUrl);
        if (!response.ok()) return 0;
        const plain = (await response.json()).plain_text || "";
        return preTokens.filter((token) => plain.includes(token)).length;
      }, { timeout: 45000 }).toBeGreaterThanOrEqual(count);

      compose(["stop", "collab"]);
      await Promise.all(sessions.map(async ({ page: client }) => {
        await expect(client.getByRole("status").filter({ hasText: "Offline" }))
          .toBeVisible({ timeout: 30000 });
      }));

      const tokens = sessions.map((_, i) => " post" + count + "-" + i + "-" + Date.now());
      for (let i = 0; i < sessions.length; i++) {
        const editor = sessions[i].page.locator(".bn-editor");
        await editor.click();
        await sessions[i].page.keyboard.press("ControlOrMeta+End");
        await sessions[i].page.keyboard.insertText(tokens[i]);
      }

      const restartStarted = Date.now();
      compose(["start", "collab"]);
      await waitForCollabHealth();
      const reconnectLatencies: number[] = [];
      await Promise.all(sessions.map(async ({ page: client }) => {
        await expect(client.getByRole("status").filter({ hasText: "Saved" }))
          .toBeVisible({ timeout: 90000 });
        reconnectLatencies.push(Date.now() - restartStarted);
      }));

      // Every reconnecting editor's offline edit must land exactly once. The
      // collaboration writer persists in debounced batches and the clients
      // reconnect at different times, so waiting only for the final token can
      // read a batch that still lacks the editors that reconnected last.
      // Require every token, each exactly once, in a single canonical read.
      await expect.poll(async () => {
        const response = await page.request.get(contentUrl);
        if (!response.ok()) return [];
        const plain = (await response.json()).plain_text || "";
        return tokens.filter(
          (token) => plain.split(token.trim()).length - 1 === 1,
        );
      }, { timeout: 90000 }).toHaveLength(tokens.length);

      const peakDocker = dockerStats();
      const peakDb = postgresStats();
      const health = await waitForCollabHealth(count);

      evidence.scenarios.push({
        sessions: count,
        reconnectLatencyMs: {
          p50: percentile(reconnectLatencies, 50),
          p95: percentile(reconnectLatencies, 95),
          p99: percentile(reconnectLatencies, 99),
          max: Math.max(...reconnectLatencies),
        },
        collaboration: health,
        postgres: { baseline: baselineDb, afterReconnect: peakDb },
        docker: { baseline: baselineDocker, afterReconnect: peakDocker },
      });
    } finally {
      try { compose(["start", "collab"]); } catch {}
      await waitForCollabHealth();
      await Promise.all(sessions.map(({ context }) => context.close()));
    }
  }

  evidence.completedAt = new Date().toISOString();
  await mkdir("capacity-results", { recursive: true });
  await writeFile(
    "capacity-results/w24-r-capacity.json",
    JSON.stringify(evidence, null, 2) + "\n",
    "utf8",
  );

  console.log("W24-R CAPACITY EVIDENCE");
  console.log(JSON.stringify(evidence, null, 2));

  expect(evidence.scenarios.map((entry: any) => entry.sessions))
    .toEqual(capacities);
  for (const scenario of evidence.scenarios) {
    expect(scenario.collaboration.healthy).toBe(true);
    expect(Number(scenario.postgres.afterReconnect.not_granted_locks || 0)).toBe(0);
  }
});
