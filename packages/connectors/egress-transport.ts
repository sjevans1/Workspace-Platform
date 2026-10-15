/**
 * W29-P0/A2: the governed provider transport.
 *
 * This is the ONLY supported way for a Connected Work adapter to reach a provider
 * over the network. It never performs a preflight DNS check and then hands the
 * original URL to a general-purpose client: it resolves, validates EVERY answer
 * against the operator policy, and then dials exactly the validated address while
 * the original hostname is retained for the HTTP Host header, TLS SNI and
 * certificate verification. A blocked destination is refused before any socket
 * exists, so it is never contacted merely to produce its denial.
 *
 * Bounded by construction: connect/TLS/read/total timeouts, request and response
 * size ceilings, no redirects (a 3xx is bounded metadata, never a followed
 * request), no ambient proxy, no keep-alive reuse, TLS verification always on, and
 * normalized error categories whose summaries contain no URL, credential, token or
 * exception text.
 */
import { createHash } from "node:crypto";
import { promises as dns } from "node:dns";
import { Agent as HttpAgent, request as httpRequest } from "node:http";
import { connect as netConnect, isIP, type Socket } from "node:net";
import { connect as tlsConnect, type TLSSocket } from "node:tls";
import {
  EGRESS_LIMITS,
  authorizeHostAndPort,
  classifyAddress,
  evaluateDestination,
  parseDestination,
  redactDestination,
  type EgressPolicy,
} from "./egress-policy.ts";

export const EGRESS_TRANSPORT_LIMITS = Object.freeze({
  /**
   * Resolution is bounded like every other phase. The total budget below covers
   * DNS, TCP, TLS and HTTP together, so a slow resolver cannot consume the
   * connection budget and a late answer can never proceed to a dial.
   */
  dns_timeout_ms: 4_000,
  connect_timeout_ms: 5_000,
  tls_timeout_ms: 8_000,
  read_timeout_ms: 15_000,
  total_timeout_ms: 30_000,
  max_request_bytes: 256 * 1024,
  max_response_bytes: 1024 * 1024,
  max_response_header_bytes: 32 * 1024,
  /** Redirects are never followed. A 3xx is provider metadata, not a new request. */
  max_redirects: 0,
  max_summary: 200,
});

export type EgressFailureCode =
  | "invalid_destination"
  | "unsupported_scheme"
  | "unsupported_port"
  | "url_userinfo"
  | "policy_denied"
  | "dns_failure"
  | "dns_timeout"
  | "connect_timeout"
  | "connect_failure"
  | "tls_failure"
  | "request_too_large"
  | "write_failure"
  | "read_timeout"
  | "response_too_large"
  | "aborted"
  | "protocol_error";

const SUMMARIES: Record<EgressFailureCode, string> = {
  invalid_destination: "The destination is not a valid public host",
  unsupported_scheme: "Only https destinations are supported by this transport",
  unsupported_port: "The destination port is not permitted",
  url_userinfo: "Credentials in a destination URL are refused",
  policy_denied: "The operator egress policy does not permit this destination",
  dns_failure: "The destination could not be resolved",
  dns_timeout:
    "The destination could not be resolved within the permitted time",
  connect_timeout:
    "The connection attempt timed out before any request was sent",
  connect_failure: "The connection attempt failed before any request was sent",
  tls_failure:
    "The TLS handshake or certificate verification failed before any request was sent",
  request_too_large: "The request exceeds the permitted size",
  write_failure: "The request could not be written completely",
  read_timeout: "The provider did not respond within the permitted time",
  response_too_large: "The provider response exceeds the permitted size",
  aborted: "The request was aborted",
  protocol_error: "The provider response could not be read",
};

/**
 * `not_sent` is claimed ONLY when the runtime can prove nothing left the process:
 * a policy refusal, a DNS failure, a failed connect or a failed TLS handshake.
 * Everything after the request may have been written is `unknown`, which is what
 * keeps A1's honest outcome-unknown semantics intact.
 */
const NOT_SENT: ReadonlySet<EgressFailureCode> = new Set<EgressFailureCode>([
  "invalid_destination",
  "unsupported_scheme",
  "unsupported_port",
  "url_userinfo",
  "policy_denied",
  "dns_failure",
  "dns_timeout",
  "connect_timeout",
  "connect_failure",
  "tls_failure",
  "request_too_large",
]);

export type EgressDeliveryState = "not_sent" | "unknown";

export class ProviderEgressError extends Error {
  readonly code: EgressFailureCode;
  readonly delivery_state: EgressDeliveryState;
  readonly summary: string;
  /** Redacted destination identity: scheme, host and port only. Never a path. */
  readonly destination: string | null;

  constructor(
    code: EgressFailureCode,
    options: {
      destination?: string | null;
      delivery_state?: EgressDeliveryState;
    } = {},
  ) {
    const summary = SUMMARIES[code] || "The provider request failed";
    super(summary);
    this.name = "ProviderEgressError";
    this.code = code;
    this.summary = summary;
    this.delivery_state =
      options.delivery_state ?? (NOT_SENT.has(code) ? "not_sent" : "unknown");
    this.destination = options.destination ?? null;
  }
}

export type DnsResolver = (
  hostname: string,
) => Promise<{ address: string; family: number }[]>;

export type TcpDialer = (input: {
  address: string;
  port: number;
  family: 4 | 6;
  timeoutMs: number;
}) => Promise<Socket>;

export type EgressTransportDeps = {
  /**
   * Test seam. The production default resolves through the system resolver; a test
   * injects deterministic answers so the hostile cases are reproducible. It is not
   * reachable from configuration.
   */
  resolve?: DnsResolver;
  /** Test seam for the socket itself; the default dials the validated address. */
  dial?: TcpDialer;
};

/**
 * One monotonic deadline shared by every phase of a request. Each phase may only
 * spend what is LEFT of the total, so DNS + TCP + TLS + HTTP cannot each consume
 * their own budget and blow the bound the caller asked for.
 */
export type EgressDeadline = {
  expiresAt: number;
  remaining: () => number;
};

export function egressDeadline(totalMs: number, now = Date.now()): EgressDeadline {
  const expiresAt = now + Math.max(1, totalMs);
  return { expiresAt, remaining: () => expiresAt - Date.now() };
}

/**
 * Runs one phase under an explicit budget. The losing promise is discarded: a
 * resolver that answers after the budget cannot hand its answer to the caller, so
 * a late DNS result never proceeds to a dial.
 */
export async function runUnderBudget<T>(
  work: Promise<T>,
  budgetMs: number,
  code: EgressFailureCode,
): Promise<T> {
  if (budgetMs <= 0) {
    work.catch(() => undefined);
    throw new ProviderEgressError(code);
  }
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new ProviderEgressError(code)), budgetMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

const defaultResolve: DnsResolver = async (hostname) => {
  const answers = await dns.lookup(hostname, { all: true, verbatim: true });
  return answers.map((answer) => ({
    address: answer.address,
    family: answer.family,
  }));
};

const defaultDial: TcpDialer = ({ address, port, family, timeoutMs }) =>
  new Promise<Socket>((resolve, reject) => {
    const socket = netConnect({ host: address, port, family });
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new ProviderEgressError("connect_timeout"));
    }, timeoutMs);
    socket.once("connect", () => {
      clearTimeout(timer);
      socket.setNoDelay(true);
      resolve(socket);
    });
    socket.once("error", (error: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      reject(
        new ProviderEgressError(
          error.code === "ETIMEDOUT" ? "connect_timeout" : "connect_failure",
        ),
      );
    });
  });

export type ValidatedDial = {
  socket: Socket;
  /** The exact address the socket was pinned to. */
  address: string;
  family: 4 | 6;
  host: string;
  port: number;
  /** Original validated hostname, for TLS SNI and certificate identity. */
  servername: string;
};

/**
 * Resolves, validates and dials a host:port for a socket-based provider protocol
 * (IMAP, SMTP, CalDAV). The caller receives a socket pinned to a validated address
 * plus the hostname to use for TLS verification. Nothing is contacted when the
 * policy refuses the destination.
 */
export async function validatedDial(input: {
  host: string;
  port: number;
  policy: EgressPolicy;
  allowed_ports?: number[];
  timeoutMs?: number;
  deps?: EgressTransportDeps;
  /** Shared phase deadline. Created here when the caller did not supply one. */
  deadline?: EgressDeadline;
}): Promise<ValidatedDial> {
  const resolve = input.deps?.resolve ?? defaultResolve;
  const dial = input.deps?.dial ?? defaultDial;
  const host = String(input.host || "").trim();
  const deadline =
    input.deadline ??
    egressDeadline(input.timeoutMs ?? EGRESS_TRANSPORT_LIMITS.total_timeout_ms);
  let answers: { address: string; family: number }[];
  try {
    answers = await runUnderBudget(
      Promise.resolve().then(() => resolve(host)),
      Math.min(EGRESS_TRANSPORT_LIMITS.dns_timeout_ms, deadline.remaining()),
      "dns_timeout",
    );
  } catch (error) {
    throw error instanceof ProviderEgressError
      ? error
      : new ProviderEgressError("dns_failure");
  }
  // A late answer is never used, even when it arrived just inside the budget.
  if (deadline.remaining() <= 0) throw new ProviderEgressError("dns_timeout");
  const decision = authorizeHostAndPort({
    host,
    port: Number(input.port),
    addresses: (answers || []).map((answer) => String(answer.address)),
    policy: input.policy,
    allowed_ports: input.allowed_ports,
  });
  if (!decision.allowed)
    throw new ProviderEgressError(
      decision.code === "address_denied" ||
        decision.code === "address_not_permitted" ||
        decision.code === "empty_dns_answer"
        ? "policy_denied"
        : (decision.code as EgressFailureCode),
    );
  const socket = await dial({
    address: decision.address,
    port: decision.port,
    family: decision.family,
    timeoutMs: Math.max(
      1,
      Math.min(
        input.timeoutMs ?? EGRESS_TRANSPORT_LIMITS.connect_timeout_ms,
        deadline.remaining(),
      ),
    ),
  });
  return {
    socket,
    address: decision.address,
    family: decision.family,
    host: decision.host,
    port: decision.port,
    servername: decision.host,
  };
}

/**
 * The same validated dial, then a TLS handshake whose identity is the ORIGINAL
 * hostname. Verification is always on; `ca` may only come from operator policy.
 */
export async function validatedTlsConnect(input: {
  host: string;
  port: number;
  policy: EgressPolicy;
  allowed_ports?: number[];
  timeoutMs?: number;
  deps?: EgressTransportDeps;
  /** Shared phase deadline. Created by validatedDial when absent. */
  deadline?: EgressDeadline;
}): Promise<{ socket: TLSSocket; dial: ValidatedDial }> {
  const dialled = await validatedDial(input);
  // The TLS identity is ALWAYS the canonical approved host. There is deliberately
  // no caller override: a caller-chosen SNI could verify a certificate for a name
  // the policy never approved.
  const servername = dialled.servername;
  try {
    const secure = await new Promise<TLSSocket>((resolve, reject) => {
      const socket = tlsConnect({
        socket: dialled.socket,
        servername: isIP(servername) ? undefined : servername,
        rejectUnauthorized: true,
        minVersion: "TLSv1.2",
        ...(input.policy.ca_pem ? { ca: input.policy.ca_pem } : {}),
      });
      const budget = input.deadline
        ? Math.max(
            1,
            Math.min(
              EGRESS_TRANSPORT_LIMITS.tls_timeout_ms,
              input.deadline.remaining(),
            ),
          )
        : EGRESS_TRANSPORT_LIMITS.tls_timeout_ms;
      const timer = setTimeout(() => {
        socket.destroy();
        reject(new ProviderEgressError("tls_failure"));
      }, budget);
      socket.once("secureConnect", () => {
        clearTimeout(timer);
        resolve(socket);
      });
      socket.once("error", () => {
        clearTimeout(timer);
        reject(new ProviderEgressError("tls_failure"));
      });
    });
    return { socket: secure, dial: dialled };
  } catch (error) {
    dialled.socket.destroy();
    throw error instanceof ProviderEgressError
      ? error
      : new ProviderEgressError("tls_failure");
  }
}

export type ProviderHttpResponse = {
  status: number;
  /** Allowlisted response headers only; never Set-Cookie or arbitrary provider headers. */
  headers: Record<string, string>;
  body: Buffer;
  /** True when the provider answered 3xx: recorded as metadata, never followed. */
  redirect: boolean;
  destination: {
    host: string;
    port: number;
    address: string;
    family: 4 | 6;
    redacted: string;
  };
  /** Bytes received, so a caller can attribute usage without storing content. */
  bytes: number;
};

/**
 * A one-off agent that hands the HTTP client the socket this transport already
 * dialled and verified. The client therefore cannot open its own connection or
 * resolve anything itself, and no socket is pooled or reused across requests.
 */
class PinnedSocketAgent extends HttpAgent {
  constructor(private readonly pinned: Socket) {
    super({ keepAlive: false, maxSockets: 1 });
  }
  override createConnection(): Socket {
    return this.pinned;
  }
}

const SAFE_RESPONSE_HEADERS = new Set([
  "content-type",
  "content-length",
  "retry-after",
  "x-ratelimit-limit",
  "x-ratelimit-remaining",
  "x-ratelimit-reset",
  "date",
  "server",
]);

function boundedHeaders(
  headers: Record<string, unknown>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    const key = name.toLowerCase();
    if (!SAFE_RESPONSE_HEADERS.has(key)) continue;
    const text = Array.isArray(value) ? value.join(", ") : String(value ?? "");
    out[key] = text.slice(0, 200);
  }
  return out;
}

/**
 * One bounded HTTPS request to a policy-approved provider destination.
 *
 * The socket is dialled to the validated address, TLS verification uses the
 * original hostname, redirects are never followed, and every failure surfaces as a
 * normalized category with a fixed summary and an honest delivery state.
 */
export async function providerHttpRequest(input: {
  url: string;
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  headers?: Record<string, string>;
  body?: string | Buffer;
  policy: EgressPolicy;
  allowed_ports?: number[];
  timeoutMs?: number;
  deps?: EgressTransportDeps;
}): Promise<ProviderHttpResponse> {
  // The bound covers DNS, TCP, TLS and HTTP together. It starts here, before any
  // resolution, so a slow resolver can no longer extend the total.
  const deadline = egressDeadline(
    input.timeoutMs ?? EGRESS_TRANSPORT_LIMITS.total_timeout_ms,
  );
  const parsed = parseDestination(input.url, {
    allowed_ports: input.allowed_ports,
  });
  if ("error" in parsed)
    throw new ProviderEgressError(parsed.error as EgressFailureCode);
  const redacted = redactDestination({
    host: parsed.host,
    port: parsed.port,
  });
  const body = input.body === undefined ? null : Buffer.from(input.body);
  if (body && body.byteLength > EGRESS_TRANSPORT_LIMITS.max_request_bytes)
    throw new ProviderEgressError("request_too_large", {
      destination: redacted,
    });

  const dialled = await validatedTlsConnect({
    host: parsed.host,
    port: parsed.port,
    policy: input.policy,
    allowed_ports: input.allowed_ports,
    timeoutMs: input.timeoutMs,
    deps: input.deps,
    deadline,
  }).catch((error) => {
    if (error instanceof ProviderEgressError)
      throw new ProviderEgressError(error.code, { destination: redacted });
    throw new ProviderEgressError("connect_failure", { destination: redacted });
  });

  try {
    return await new Promise<ProviderHttpResponse>((resolve, reject) => {
      let settled = false;
      // True once the request has been handed to the socket: from that moment the
      // outcome is `unknown`, because bytes may have reached the provider.
      let wrote = false;
      const fail = (code: EgressFailureCode) => {
        if (settled) return;
        settled = true;
        dialled.socket.destroy();
        reject(new ProviderEgressError(code, { destination: redacted }));
      };
      // Only what is LEFT of the one request deadline: the phases above already
      // spent their share of it.
      const totalTimer = setTimeout(
        () => fail(wrote ? "read_timeout" : "connect_timeout"),
        Math.max(1, deadline.remaining()),
      );
      const headers: Record<string, string> = {};
      for (const [name, value] of Object.entries(input.headers || {})) {
        const key = name.toLowerCase();
        // A caller cannot smuggle a credential into evidence, and the transport
        // never invents an Authorization header of its own.
        if (!/^[a-z0-9-]{1,64}$/.test(key)) continue;
        headers[key] = String(value).slice(0, 4096);
      }
      headers.host =
        parsed.port === 443 ? parsed.host : `${parsed.host}:${parsed.port}`;
      const request = httpRequest({
        // The TLS socket is already connected to the validated address, so the
        // HTTP client must never open its own connection or resolve anything.
        agent: new PinnedSocketAgent(dialled.socket),
        host: parsed.host,
        port: parsed.port,
        method: input.method || "GET",
        path: parsed.path,
        headers,
        maxHeaderSize: EGRESS_TRANSPORT_LIMITS.max_response_header_bytes,
        setHost: false,
      });
      request.on("error", () => {
        if (settled) return;
        fail(wrote ? "write_failure" : "connect_failure");
      });
      request.on("response", (response) => {
        const status = Number(response.statusCode || 0);
        const chunks: Buffer[] = [];
        let bytes = 0;
        response.on("data", (chunk: Buffer) => {
          bytes += chunk.byteLength;
          if (bytes > EGRESS_TRANSPORT_LIMITS.max_response_bytes) {
            response.destroy();
            fail("response_too_large");
            return;
          }
          chunks.push(chunk);
        });
        response.on("error", () => fail("protocol_error"));
        response.on("end", () => {
          if (settled) return;
          settled = true;
          resolve({
            status,
            headers: boundedHeaders(
              response.headers as Record<string, unknown>,
            ),
            body: Buffer.concat(chunks),
            redirect: status >= 300 && status < 400,
            destination: {
              host: dialled.dial.host,
              port: dialled.dial.port,
              address: dialled.dial.address,
              family: dialled.dial.family,
              redacted,
            },
            bytes,
          });
        });
      });
      // Idle/read ceiling: a provider that stops talking must not hold the worker.
      dialled.socket.setTimeout(
        Math.max(
          1,
          Math.min(
            input.timeoutMs ?? EGRESS_TRANSPORT_LIMITS.read_timeout_ms,
            deadline.remaining(),
          ),
        ),
        () => fail(wrote ? "read_timeout" : "connect_timeout"),
      );
      request.end(body ?? undefined);
      wrote = true;
      request.on("close", () => clearTimeout(totalTimer));
      if (settled) clearTimeout(totalTimer);
    });
  } finally {
    dialled.socket.destroy();
  }
}

/**
 * A stable, non-reversible correlation identity for a destination, so diagnostics
 * and usage attribution can refer to an endpoint without storing the endpoint.
 */
export function destinationDigest(host: string, port: number): string {
  return createHash("sha256")
    .update(`${host.toLowerCase()}:${port}`)
    .digest("hex")
    .slice(0, 32);
}

/**
 * Classifies an address for diagnostics without exposing the raw address in
 * operator copy beyond its class.
 */
export function addressClassFor(address: string): string {
  return classifyAddress(address)?.class ?? "unknown";
}

/** Re-exported so adapters and diagnostics share one policy evaluator. */
export {
  EGRESS_LIMITS,
  evaluateDestination,
  type EgressPolicy,
} from "./egress-policy.ts";
