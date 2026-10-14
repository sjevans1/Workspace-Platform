#!/usr/bin/env node
/**
 * CI helper: wait until the AUTHENTICATED acceptance principal has enough
 * general API read budget for the Connected Work browser lane.
 *
 * Why this exists (FULL run 38473169389):
 *
 *   The API keys authenticated `GET /api/v1/*` reads (excluding `/auth/` and
 *   `/setup`) as `principal:<tenant>:<user>`, while unauthenticated traffic is
 *   keyed by network identity. `scripts/ci/wait-for-auth-budget.sh` deliberately
 *   reads the NETWORK key through an unauthenticated read-only route, so it
 *   cannot see the principal bucket at all. The deterministic engine/viewport
 *   harness authenticates as the same acceptance principal the Connected Work
 *   lane uses (`browser@example.test` in the same acceptance tenant), so that
 *   lane inherits whatever the harness spent. In run 38473169389 the network
 *   check reported 271 remaining, the Connected Work lane then received HTTP 429
 *   on its first authenticated read, and the Connections tab rendered its
 *   error branch (`Rate limit exceeded, retry in 6 seconds`) instead of the
 *   empty state the lane asserts.
 *
 * What this helper does:
 *
 *   - reads an existing Playwright storage-state file (default
 *     `e2e/.auth/session.json`, the state the immediately preceding
 *     deterministic harness writes);
 *   - extracts the existing Workspace session cookie and never logs or prints
 *     it, in whole or in part;
 *   - issues ONE authenticated read-only request (`GET /api/v1/me`) per probe,
 *     which is keyed by exactly the same `principal:<tenant>:<user>` limiter
 *     the Connected Work reads use;
 *   - reads the real `x-ratelimit-*` response headers;
 *   - requires a healthy remaining budget (default 240 of 300) before it lets
 *     the lane start;
 *   - honours the server-directed `Retry-After` on 429, and otherwise waits for
 *     the real limiter window (from `x-ratelimit-reset`) to replenish instead of
 *     sleeping a fixed blind minute;
 *   - fails closed on missing/unreadable session state, refused
 *     authentication, missing rate-limit evidence, an unusable 429 hint, or a
 *     budget that never recovers inside the bounded wait.
 *
 * What this helper must never do:
 *
 *   - issue any request to the sign-in route, valid or invalid: its
 *     10-per-5-minutes budget COUNTS every request, so a probe can spend the
 *     last attempt a legitimate qualification login needs;
 *   - read the limiter's private storage (for example a Redis key layout);
 *   - raise, bypass or disable the production rate limiter.
 *
 * Usage: node scripts/ci/wait-for-principal-budget.mjs [base-url]
 */

import { readFile } from "node:fs/promises";
import { setTimeout as sleep } from "node:timers/promises";

const BASE_URL = (
  process.argv[2] ||
  process.env.E2E_BASE_URL ||
  "http://localhost:8080"
).replace(/\/+$/, "");

const STATE_PATH =
  process.env.PRINCIPAL_BUDGET_STATE ||
  process.env.E2E_AUTH_STATE ||
  "e2e/.auth/session.json";

const COOKIE_NAME = process.env.PRINCIPAL_BUDGET_COOKIE || "workspace_session";

// The authenticated read route shared by every lane that reads workspace data.
// It carries no route-level rate-limit configuration, so it shares the global
// per-principal store with the Connected Work reads. It is read-only: no state
// changes and no sign-in request is issued.
const PROBE_PATH = process.env.PRINCIPAL_BUDGET_PATH || "/api/v1/me";

function positiveInt(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

const MIN_REMAINING = positiveInt(
  process.env.PRINCIPAL_BUDGET_MIN_REMAINING,
  240,
);
const ATTEMPTS = positiveInt(process.env.PRINCIPAL_BUDGET_ATTEMPTS, 10);
const INTERVAL_MS = positiveInt(process.env.PRINCIPAL_BUDGET_INTERVAL_MS, 5000);
const MAX_WAIT_MS = positiveInt(
  process.env.PRINCIPAL_BUDGET_MAX_WAIT_MS,
  90000,
);
const TOTAL_WAIT_MS = positiveInt(
  process.env.PRINCIPAL_BUDGET_TOTAL_WAIT_MS,
  300000,
);
const REQUEST_TIMEOUT_MS = positiveInt(
  process.env.PRINCIPAL_BUDGET_REQUEST_TIMEOUT_MS,
  10000,
);

function fail(message) {
  // One line, no secret material, exit non-zero: the gate must never start on
  // unproven budget.
  console.error(`Principal rate-limit readiness check failed: ${message}`);
  process.exit(1);
}

/**
 * Read the acceptance principal's session cookie out of an existing Playwright
 * storage-state file. Only equality against the target host is considered, and
 * the value is returned to the caller, never printed.
 */
async function sessionCookieValue() {
  let raw;
  try {
    raw = await readFile(STATE_PATH, "utf8");
  } catch {
    fail(
      `no Playwright storage state at ${STATE_PATH}; refusing to declare readiness without a real authenticated session`,
    );
  }
  let state;
  try {
    state = JSON.parse(raw);
  } catch {
    fail(`Playwright storage state at ${STATE_PATH} is not valid JSON`);
  }
  if (!state || !Array.isArray(state.cookies)) {
    fail(`Playwright storage state at ${STATE_PATH} has no cookie list`);
  }
  const host = new URL(BASE_URL).hostname;
  const cookie = state.cookies.find((candidate) => {
    if (!candidate || candidate.name !== COOKIE_NAME) return false;
    if (typeof candidate.value !== "string" || !candidate.value) return false;
    const domain = String(candidate.domain || "").replace(/^\./, "");
    return domain === host;
  });
  if (!cookie) {
    fail(
      `no ${COOKIE_NAME} cookie for ${host} in ${STATE_PATH}; the acceptance principal is not signed in`,
    );
  }
  return cookie.value;
}

function headerNumber(headers, name) {
  const value = headers.get(name);
  if (value === null) return null;
  const parsed = Number(String(value).trim());
  return Number.isFinite(parsed) ? parsed : null;
}

async function probe(cookie) {
  let response;
  try {
    response = await fetch(`${BASE_URL}${PROBE_PATH}`, {
      method: "GET",
      redirect: "manual",
      headers: {
        cookie: `${COOKIE_NAME}=${cookie}`,
        accept: "application/json",
      },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    return {
      networkError: String(error && error.message ? error.message : error),
    };
  }
  return {
    status: response.status,
    remaining: headerNumber(response.headers, "x-ratelimit-remaining"),
    limit: headerNumber(response.headers, "x-ratelimit-limit"),
    reset: headerNumber(response.headers, "x-ratelimit-reset"),
    retryAfter: headerNumber(response.headers, "retry-after"),
  };
}

const cookie = await sessionCookieValue();
const deadline = Date.now() + TOTAL_WAIT_MS;
let lastReason = "no probe was issued";

for (let attempt = 1; attempt <= ATTEMPTS; attempt += 1) {
  const result = await probe(cookie);

  if (result.networkError) {
    lastReason = `the API was unreachable on attempt ${attempt} (${result.networkError})`;
    console.error(`Principal budget probe ${attempt}: ${lastReason}`);
  } else if (result.status === 401 || result.status === 403) {
    // A refused session is NOT evidence of available budget.
    fail(
      `authenticated GET ${PROBE_PATH} was refused with HTTP ${result.status}; the acceptance session is invalid, so budget readiness cannot be proven`,
    );
  } else if (result.status === 429) {
    const waitSeconds =
      result.retryAfter !== null ? result.retryAfter : result.reset;
    const source =
      result.retryAfter !== null ? "Retry-After" : "x-ratelimit-reset";
    if (waitSeconds === null || waitSeconds <= 0) {
      fail(
        `HTTP 429 from ${PROBE_PATH} carried no usable Retry-After or x-ratelimit-reset hint`,
      );
    }
    lastReason = `the principal read budget is rate limited (HTTP 429)`;
    console.error(
      `Principal budget probe ${attempt}: HTTP 429; honouring the server-directed ${source} of ${waitSeconds}s`,
    );
    const waitMs = Math.min(Math.max(waitSeconds, 1) * 1000 + 250, MAX_WAIT_MS);
    if (Date.now() + waitMs > deadline) {
      fail(
        `the principal read budget stayed rate limited and the bounded wait expired (${lastReason})`,
      );
    }
    await sleep(waitMs);
    continue;
  } else if (result.status < 200 || result.status >= 300) {
    fail(
      `authenticated GET ${PROBE_PATH} returned HTTP ${result.status}; no rate-limit evidence can be read from it`,
    );
  } else if (result.remaining === null) {
    fail(
      `authenticated GET ${PROBE_PATH} returned HTTP 200 without a usable x-ratelimit-remaining header`,
    );
  } else if (result.remaining >= MIN_REMAINING) {
    const limit = result.limit === null ? "unknown" : String(result.limit);
    console.log(
      `Authenticated principal read budget available: ${result.remaining}/${limit}`,
    );
    console.log(
      `Probe: authenticated GET ${PROBE_PATH}; this is the same principal:<tenant>:<user> limiter the Connected Work reads use.`,
    );
    console.log(
      `Session cookie read from ${STATE_PATH}; no sign-in request was issued and no cookie value was logged.`,
    );
    process.exit(0);
  } else {
    const waitMs =
      result.reset !== null && result.reset > 0
        ? Math.min(result.reset * 1000 + 250, MAX_WAIT_MS)
        : INTERVAL_MS;
    lastReason = `the authenticated principal budget is ${result.remaining}, below the required ${MIN_REMAINING}`;
    console.error(
      `Principal budget probe ${attempt}: ${lastReason}; waiting ${Math.round(
        waitMs / 1000,
      )}s for the real limiter window to replenish`,
    );
    if (Date.now() + waitMs > deadline) {
      fail(`budget did not recover inside the bounded wait (${lastReason})`);
    }
    await sleep(waitMs);
    continue;
  }

  if (attempt < ATTEMPTS) {
    const waitMs = Math.min(INTERVAL_MS, MAX_WAIT_MS);
    if (Date.now() + waitMs > deadline) break;
    await sleep(waitMs);
  }
}

fail(
  `the authenticated principal read budget was not proven healthy in ${ATTEMPTS} probes (last observation: ${lastReason})`,
);
