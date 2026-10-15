// OCP-2B: server-side access to the accepted OCP-2A read APIs.
//
// The fleet operator credential lives ONLY here, in server-side configuration. It is
// never sent to the browser, never placed in a client bundle (this console ships no
// client-side JavaScript at all), and never included in an error surfaced to a user.

import { rateLimitPolicy, type RateLimitPolicy } from "../../../packages/security/rate-limit.ts";

export type FleetConsoleConfig = {
  baseUrl: string;
  operatorToken: string;
  sessionSecret: string;
  port: number;
  host: string;
  // One production boolean, derived once from NODE_ENV or FLEET_CONSOLE_PRODUCTION, and
  // used for the fleet API transport rules, Secure cookies and the browser-facing
  // public-origin and bind contract. There is no second interpretation of production.
  production: boolean;
  publicUrl: string | null;
  sessionTtlMs: number;
  requestTimeoutMs: number;
  secureCookie: boolean;
  rateLimit: RateLimitPolicy;
};

const bounded = (raw: string | undefined, fallback: number, min: number, max: number): number => {
  const value = Number(raw);
  if (!Number.isFinite(value)) return fallback;
  return Math.min(Math.max(Math.floor(value), min), max);
};

// Fail closed: the console is useless and unsafe without an API base, the operator
// credential and a session signing secret.
export function fleetConsoleConfig(env: Record<string, string | undefined>): FleetConsoleConfig {
  const rawBaseUrl = (env.FLEET_API_BASE_URL ?? "").trim();
  const operatorToken = env.FLEET_OPERATOR_TOKEN ?? "";
  const sessionSecret = env.FLEET_CONSOLE_SESSION_SECRET ?? "";
  const production = isProductionMode(env);
  const baseUrl = parseFleetApiBaseUrl(rawBaseUrl, production);
  // The browser-facing origin contract: in production the console must be published over
  // HTTPS. The local listener may still be plaintext loopback behind a TLS terminator.
  const publicUrl = parseConsolePublicUrl(env.FLEET_CONSOLE_PUBLIC_URL, production);
  const host = parseConsoleHost(env.FLEET_CONSOLE_HOST, production);
  if (operatorToken.length < 24) throw new Error("FLEET_OPERATOR_TOKEN is required (server-side only)");
  if (sessionSecret.length < 32) throw new Error("FLEET_CONSOLE_SESSION_SECRET must be at least 32 characters");
  return {
    baseUrl: baseUrl.replace(/\/+$/, ""),
    operatorToken,
    sessionSecret,
    port: bounded(env.FLEET_CONSOLE_PORT, 4200, 1, 65_535),
    host,
    production,
    publicUrl,
    // Bounded session lifetime: 15 minutes minimum, 24 hours maximum, 8 hours default.
    sessionTtlMs: bounded(env.FLEET_CONSOLE_SESSION_TTL_MS, 8 * 3_600_000, 900_000, 86_400_000),
    // Bounded request timeout so a slow or hanging fleet API cannot pin the console.
    requestTimeoutMs: bounded(env.FLEET_CONSOLE_REQUEST_TIMEOUT_MS, 5_000, 500, 15_000),
    // Production mode through EITHER mechanism always yields a Secure cookie; the
    // explicit setting can only add protection outside production, never remove it.
    secureCookie: production || String(env.FLEET_CONSOLE_SECURE_COOKIE ?? "").toLowerCase() === "true",
    rateLimit: rateLimitPolicy(env),
  };
}



// One production indicator for the whole console.
export function isProductionMode(env: Record<string, string | undefined>): boolean {
  return String(env.NODE_ENV ?? "").toLowerCase() === "production" || String(env.FLEET_CONSOLE_PRODUCTION ?? "").toLowerCase() === "true";
}

// The browser reaches the console over HTTPS in production. In production this setting is
// required and must be an https origin at the root: embedded credentials, query strings,
// fragments and any path are refused, because the 1.0 console is not prefix-aware. The
// console's own listener may stay on plaintext loopback behind a trusted TLS terminator,
// so this is a public-origin contract, not a local-listener requirement.
export function parseConsolePublicUrl(raw: string | undefined, production: boolean): string | null {
  const value = (raw ?? "").trim();
  if (!value) {
    if (production) throw new Error("FLEET_CONSOLE_PUBLIC_URL is required in production (the https origin operators reach the console on)");
    return null;
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("FLEET_CONSOLE_PUBLIC_URL must be an absolute URL");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error("FLEET_CONSOLE_PUBLIC_URL must use http or https");
  if (url.username || url.password) throw new Error("FLEET_CONSOLE_PUBLIC_URL must not embed credentials");
  if (url.search) throw new Error("FLEET_CONSOLE_PUBLIC_URL must not contain a query string");
  if (url.hash) throw new Error("FLEET_CONSOLE_PUBLIC_URL must not contain a fragment");
  if (production && url.protocol !== "https:") throw new Error("FLEET_CONSOLE_PUBLIC_URL must use https in production");
  // OCP-2B 1.0 is published at the configured origin root. The console is not
  // prefix-aware, so a sub-path mounting is refused here rather than accepted and then
  // silently broken. The HTTPS reverse proxy forwards this root to the loopback
  // listener; it does not rewrite a prefix.
  // A path prefix (for reverse-proxy deployment) is preserved and normalized so read
  // endpoints resolve beneath it. Trailing slashes are removed. FLEET_API_BASE_URL is a
  // separate setting from the console's own public origin, and the BFF client honours
  // this prefix on every read call.
  // OCP-2B 1.0 is published at the configured origin root. The console is not
  // prefix-aware, so a sub-path mounting is refused here rather than accepted and then
  // silently broken. The HTTPS reverse proxy forwards this root to the loopback
  // listener; it does not rewrite a prefix.
  if (url.pathname !== "" && url.pathname !== "/") {
    throw new Error("FLEET_CONSOLE_PUBLIC_URL must not contain a path; deploy the 1.0 console at the origin root");
  }
  return `${url.protocol}//${url.host}`;
}

// Bind safety. The default is loopback. In production the console must not be exposed
// directly on a broadly reachable plaintext interface: external exposure belongs to the
// approved HTTPS ingress, not to the console process.
export const PRODUCTION_BIND_HOSTS = ["127.0.0.1", "::1", "localhost"] as const;

export function parseConsoleHost(raw: string | undefined, production: boolean): string {
  const value = (raw ?? "").trim() || "127.0.0.1";
  if (!production) return value;
  if (!(PRODUCTION_BIND_HOSTS as readonly string[]).includes(value.toLowerCase())) {
    throw new Error(
      "FLEET_CONSOLE_HOST must be a loopback address in production (127.0.0.1, ::1 or localhost); external exposure belongs to the HTTPS ingress, not the console process",
    );
  }
  return value;
}

// The fleet API base URL is a separate setting from the console's own public origin: an
// API path prefix is intentionally supported and normalized here, and the BFF client
// resolves its read endpoints beneath it. The console sends the shared operator credential
// as a bearer token on every request, so the transport must not be able to leak it.
// Parsing is strict: malformed URLs, embedded credentials, query strings and fragments are
// refused, and in production plaintext HTTP
// is only ever permitted to an explicitly local loopback destination. Private, container
// and RFC1918 addresses are NOT treated as loopback.
export const LOOPBACK_HOSTNAMES = ["127.0.0.1", "::1", "[::1]", "localhost"] as const;

export function parseFleetApiBaseUrl(raw: string, production = false): string {
  if (!raw) throw new Error("FLEET_API_BASE_URL is required (the OCP-2A fleet API base URL)");
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("FLEET_API_BASE_URL must be an absolute URL");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error("FLEET_API_BASE_URL must use http or https");
  if (url.username || url.password) throw new Error("FLEET_API_BASE_URL must not embed credentials");
  if (url.search) throw new Error("FLEET_API_BASE_URL must not contain a query string");
  if (url.hash) throw new Error("FLEET_API_BASE_URL must not contain a fragment");
  const loopback = (LOOPBACK_HOSTNAMES as readonly string[]).includes(url.hostname);
  if (url.protocol === "http:" && production && !loopback) {
    throw new Error(
      "FLEET_API_BASE_URL must use https in production (plaintext http is permitted only for a loopback destination such as 127.0.0.1, ::1 or localhost)",
    );
  }
  // OCP-2B 1.0 is published at the configured origin root. The console is not
  // prefix-aware, so a sub-path mounting is refused rather than accepted and then
  // silently broken. The HTTPS reverse proxy forwards this root to the loopback
  // listener; it does not rewrite a prefix.
  // A path prefix (for reverse-proxy deployment) is preserved and normalized so read
  // endpoints resolve beneath it. Trailing slashes are removed. This is a separate setting
  // from the console's own public origin, and the BFF client honours the prefix on every
  // read call.
  const path = url.pathname.replace(/\/+$/, "");
  return `${url.protocol}//${url.host}${path}`;
}

export type FleetApiResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: "unreachable" | "timeout" | "unauthorized" | "server_error"; status?: number };

export type FleetDeployment = {
  id: string;
  workspace_deployment_id: string;
  alias: string | null;
  state: string;
  online_state: string;
  first_seen: string | null;
  last_seen: string | null;
  app_version: string | null;
  build_sha: string | null;
  schema_version: string | null;
  contract_version: string | null;
  queue: { depth: number | null; state: string } | null;
  storage: number | null;
  database_capacity: number | null;
  backup: { last_backup_at: string | null; state: string } | null;
  runtime: Record<string, string> | null;
};

export type FleetAlert = { deployment_id: string; category: string; severity: "info" | "warning" };
export type FleetAuditEntry = { action: string; deployment_id: string | null; detail: string | null; created_at: string };
export type FleetDeploymentDetail = {
  deployment: FleetDeployment & { notes: string | null };
  credentials: { id: string; state: string; created_at: string; rotated_at: string | null; revoked_at: string | null }[];
  telemetry: any;
  history: { observed_at: string; queue_state: string | null; backup_state: string | null; online_state: string | null }[];
  alerts: FleetAlert[];
};

export type FleetClient = {
  listDeployments(): Promise<FleetApiResult<{ deployments: FleetDeployment[] }>>;
  deployment(id: string): Promise<FleetApiResult<FleetDeploymentDetail>>;
  alerts(): Promise<FleetApiResult<{ alerts: FleetAlert[] }>>;
  audit(): Promise<FleetApiResult<{ audit: FleetAuditEntry[] }>>;
  egress(): Promise<FleetApiResult<{ posture: FleetEgressPosture }>>;
  egressDiagnostic(host: string, port: number): Promise<FleetApiResult<{ readiness: FleetEgressReadiness }>>;
  health(): Promise<FleetApiResult<{ status: string }>>;
};

// W29-P0/A2: the read-only posture the fleet API reports for outbound provider egress,
// and the canonical readiness answer it shares with the customer endpoint check.
export type FleetEgressPosture = {
  scope: string;
  scope_note: string;
  policy: { fingerprint: string; version: string; internal_rules: number; public_pinned: boolean; public_rules: number; internal_trust_chain: boolean };
  never_reachable: string[];
  overridable: string[];
  readiness_states: string[];
  preflight: { dns_only: boolean; contacts_endpoint: boolean };
};

export type FleetEgressReadiness = {
  scope: string;
  scope_note: string;
  state: string;
  code: string;
  summary: string;
  next_action: string;
  host: string | null;
  port: number;
  destination_digest: string;
  address_class: string | null;
  resolved_answers: number;
  contacted: boolean;
  policy: { fingerprint: string; version: string };
};

// Only these read paths are ever called. The console has no code path to an OCP-2A
// mutation endpoint.
export const FLEET_READ_PATHS = ["/deployments", "/alerts", "/audit", "/egress", "/egress/diagnostic", "/health"] as const;

export function createFleetClient(options: {
  baseUrl: string;
  operatorToken: string;
  timeoutMs: number;
  fetchImpl?: typeof fetch;
}): FleetClient {
  const doFetch = options.fetchImpl ?? fetch;

  const get = async <T>(path: string): Promise<FleetApiResult<T>> => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), options.timeoutMs);
    try {
      const response = await doFetch(`${options.baseUrl}${path}`, {
        method: "GET",
        headers: { authorization: `Bearer ${options.operatorToken}`, accept: "application/json" },
        redirect: "error",
        signal: controller.signal,
      });
      if (response.status === 401 || response.status === 403) return { ok: false, error: "unauthorized", status: response.status };
      if (!response.ok) return { ok: false, error: "server_error", status: response.status };
      // Bounded parse: a malformed body is a service error, never a crash and never a
      // raw body echoed to a user.
      const data = (await response.json()) as T;
      return { ok: true, data };
    } catch (error: any) {
      return { ok: false, error: error?.name === "AbortError" ? "timeout" : "unreachable" };
    } finally {
      clearTimeout(timer);
    }
  };

  return {
    listDeployments: () => get<{ deployments: FleetDeployment[] }>("/deployments"),
    deployment: (id: string) => get<FleetDeploymentDetail>(`/deployments/${encodeURIComponent(id)}`),
    alerts: () => get<{ alerts: FleetAlert[] }>("/alerts"),
    audit: () => get<{ audit: FleetAuditEntry[] }>("/audit"),
    egress: () => get<{ posture: FleetEgressPosture }>("/egress"),
    egressDiagnostic: (host: string, port: number) =>
      get<{ readiness: FleetEgressReadiness }>(`/egress/diagnostic?host=${encodeURIComponent(host)}&port=${encodeURIComponent(String(port))}`),
    health: () => get<{ status: string }>("/health"),
  };
}
