/**
 * W29-P0/A2: the governed provider egress policy.
 *
 * Real Connected Work adapters (OAuth token exchange, IMAP/SMTP, JMAP, provider
 * REST) must never be able to open an arbitrary outbound connection. This module
 * is the single destination-policy evaluator every provider transport uses, so an
 * adapter cannot invent its own network rules and a tenant cannot grant itself
 * internal reach.
 *
 * The posture is deny-by-default for everything that is not a public internet
 * destination:
 *
 *   - always denied (never overridable by configuration): loopback, link-local,
 *     multicast, unspecified, broadcast, carrier-grade/shared, cloud instance
 *     metadata, benchmark/documentation/reserved and transition ranges;
 *   - private (RFC1918) and IPv6 unique-local (RFC4193) addresses are denied
 *     unless an operator rule names the EXACT host, the exact port and a CIDR that
 *     contains every resolved address, and the rule declares that it is allowed to
 *     reach private space;
 *   - public destinations are allowed, and an operator may optionally pin them to
 *     a host+port allowlist.
 *
 * Everything here is pure and deterministic: parsing, classification and the
 * decision are functions of their inputs, so the hostile cases are directly
 * testable and the same evaluator can be reused by any protocol client.
 */
import { isIP } from "node:net";
import { assert } from "../contracts/index.ts";

export const EGRESS_LIMITS = Object.freeze({
  /** Operator rules per policy. */
  max_rules: 32,
  /** Ports declared by one rule. */
  max_ports_per_rule: 16,
  /** Answers considered for one resolution. */
  max_dns_answers: 16,
  /** Hostname length bound (a DNS name is 253 characters). */
  max_hostname_length: 253,
  max_summary: 200,
});

/** How a resolved address is classified. Only `public` is allowed by default. */
export type AddressClass =
  | "public"
  | "private"
  | "unique_local"
  | "loopback"
  | "link_local"
  | "multicast"
  | "unspecified"
  | "broadcast"
  | "carrier_grade"
  | "benchmark"
  | "documentation"
  | "reserved"
  | "metadata"
  | "transition";

/**
 * Classes an operator rule may reach. Deliberately tiny: private and IPv6
 * unique-local only. Loopback, link-local, metadata and every other special range
 * stay denied even with a rule, so a misconfiguration cannot expose the host.
 */
const OVERRIDABLE: ReadonlySet<AddressClass> = new Set<AddressClass>([
  "private",
  "unique_local",
]);

export type AddressClassification = {
  class: AddressClass;
  /** True when an operator rule could permit this address. */
  overridable: boolean;
  /** True when the address can never be reached, whatever the configuration. */
  hard_deny: boolean;
  /** Canonical form of the address as classified. */
  address: string;
};

export type EgressDenialCode =
  | "invalid_destination"
  | "unsupported_scheme"
  | "unsupported_port"
  | "url_userinfo"
  | "dns_failure"
  | "empty_dns_answer"
  | "address_denied"
  | "address_not_permitted"
  | "policy_invalid";

export type EgressDecision =
  | {
      allowed: true;
      host: string;
      port: number;
      address: string;
      family: 4 | 6;
      addresses: string[];
    }
  | { allowed: false; code: EgressDenialCode; summary: string };

export type EgressRule = {
  host: string;
  ports: number[];
  cidr: string | null;
  allow_private: boolean;
};

export type EgressPolicy = {
  /** Immutable operator rules for private/ULA destinations. */
  rules: EgressRule[];
  /** Optional host+port pinning for public destinations (empty = any public). */
  public_rules: EgressRule[];
  /** Extra CA material for explicitly trusted internal endpoints, or null. */
  ca_pem: string | null;
};

export const DEFAULT_EGRESS_POLICY: EgressPolicy = Object.freeze({
  rules: [],
  public_rules: [],
  ca_pem: null,
});

// ---------------------------------------------------------------------------
// Address classification.
// ---------------------------------------------------------------------------

const v4 = (parts: number[]): string => parts.join(".");

function ipv4ToBigInt(address: string): bigint | null {
  const parts = address.split(".");
  if (parts.length !== 4) return null;
  let value = 0n;
  for (const part of parts) {
    // Ambiguous IPv4 forms (octal `0177.0.0.1`, hex `0x7f.0.0.1`, dword
    // `2130706433`, short forms `127.1`) are refused rather than normalised: a
    // parser that accepts them disagrees with the socket's own resolver, which is
    // exactly how an SSRF filter gets bypassed.
    if (!/^(0|[1-9][0-9]{0,2})$/.test(part)) return null;
    const octet = Number(part);
    if (octet > 255) return null;
    value = (value << 8n) | BigInt(octet);
  }
  return value;
}

function inV4Range(value: bigint, base: string, bits: number): boolean {
  const baseValue = ipv4ToBigInt(base);
  if (baseValue === null) return false;
  const size = 1n << BigInt(32 - bits);
  return value >= baseValue && value < baseValue + size;
}

const V4_HARD_DENY: { base: string; bits: number; class: AddressClass }[] = [
  { base: "0.0.0.0", bits: 8, class: "unspecified" },
  { base: "10.0.0.0", bits: 8, class: "private" },
  { base: "100.64.0.0", bits: 10, class: "carrier_grade" },
  { base: "127.0.0.0", bits: 8, class: "loopback" },
  { base: "169.254.0.0", bits: 16, class: "link_local" },
  { base: "172.16.0.0", bits: 12, class: "private" },
  { base: "192.0.0.0", bits: 24, class: "reserved" },
  { base: "192.0.2.0", bits: 24, class: "documentation" },
  { base: "192.88.99.0", bits: 24, class: "transition" },
  { base: "192.168.0.0", bits: 16, class: "private" },
  { base: "198.18.0.0", bits: 15, class: "benchmark" },
  { base: "198.51.100.0", bits: 24, class: "documentation" },
  { base: "203.0.113.0", bits: 24, class: "documentation" },
  { base: "224.0.0.0", bits: 4, class: "multicast" },
  // The limited broadcast address is classified before the 240/4 reserved block
  // so its class name is precise; both are hard denied either way.
  { base: "255.255.255.255", bits: 32, class: "broadcast" },
  { base: "240.0.0.0", bits: 4, class: "reserved" },
];

/** Cloud instance-metadata addresses, denied whatever else is configured. */
const V4_METADATA = ["169.254.169.254", "100.100.100.200", "192.0.0.192"];

const V6_HARD_DENY: { base: string; bits: number; class: AddressClass }[] = [
  { base: "::", bits: 128, class: "unspecified" },
  { base: "::1", bits: 128, class: "loopback" },
  { base: "::ffff:0:0", bits: 96, class: "transition" },
  { base: "64:ff9b::", bits: 96, class: "transition" },
  { base: "100::", bits: 64, class: "reserved" },
  { base: "2001:2::", bits: 48, class: "benchmark" },
  { base: "2001:db8::", bits: 32, class: "documentation" },
  { base: "2002::", bits: 16, class: "transition" },
  { base: "fc00::", bits: 7, class: "unique_local" },
  { base: "fe80::", bits: 10, class: "link_local" },
  { base: "ff00::", bits: 8, class: "multicast" },
];

const V6_METADATA = ["fd00:ec2::254"];

function ipv6ToBigInt(address: string): bigint | null {
  const zone = address.indexOf("%");
  if (zone !== -1) return null; // scoped addresses are refused, never normalised
  const halves = address.split("::");
  if (halves.length > 2) return null;
  const parseGroups = (input: string): number[] | null => {
    if (!input) return [];
    const groups = input.split(":");
    const out: number[] = [];
    for (const group of groups) {
      if (group.includes(".")) {
        const mapped = ipv4ToBigInt(group);
        if (mapped === null) return null;
        out.push(Number((mapped >> 16n) & 0xffffn), Number(mapped & 0xffffn));
        continue;
      }
      if (!/^[0-9a-fA-F]{1,4}$/.test(group)) return null;
      out.push(parseInt(group, 16));
    }
    return out;
  };
  const head = parseGroups(halves[0]);
  const tail = halves.length === 2 ? parseGroups(halves[1]) : [];
  if (!head || !tail) return null;
  const missing = 8 - (head.length + tail.length);
  if (halves.length === 2 && missing < 0) return null;
  if (halves.length === 1 && head.length !== 8) return null;
  const groups = [...head, ...Array(Math.max(0, missing)).fill(0), ...tail];
  if (groups.length !== 8) return null;
  let value = 0n;
  for (const group of groups) value = (value << 16n) | BigInt(group);
  return value;
}

function inV6Range(value: bigint, base: string, bits: number): boolean {
  const baseValue = ipv6ToBigInt(base);
  if (baseValue === null) return false;
  const size = 1n << BigInt(128 - bits);
  return value >= baseValue && value < baseValue + size;
}

/**
 * Classifies one resolved address. IPv4-mapped and IPv4-embedded IPv6 forms are
 * classified by the IPv4 address they carry, so `::ffff:127.0.0.1` and
 * `::ffff:169.254.169.254` can never slip past a v4-only check.
 */
export function classifyAddress(address: string): AddressClassification | null {
  const trimmed = String(address || "").trim();
  if (!trimmed) return null;
  const kind = isIP(trimmed);
  if (kind === 4) {
    const value = ipv4ToBigInt(trimmed);
    if (value === null) return null;
    if (V4_METADATA.includes(v4([...trimmed.split(".").map(Number)])))
      return {
        class: "metadata",
        overridable: false,
        hard_deny: true,
        address: trimmed,
      };
    for (const range of V4_HARD_DENY) {
      if (inV4Range(value, range.base, range.bits))
        return {
          class: range.class,
          overridable: OVERRIDABLE.has(range.class),
          hard_deny: !OVERRIDABLE.has(range.class),
          address: trimmed,
        };
    }
    return {
      class: "public",
      overridable: false,
      hard_deny: false,
      address: trimmed,
    };
  }
  if (kind !== 6) return null;
  const value = ipv6ToBigInt(trimmed);
  if (value === null) return null;
  // IPv4-mapped (::ffff:0:0/96) and IPv4-embedded (::/96) forms: classify the v4.
  const mappedBase = ipv6ToBigInt("::ffff:0:0")!;
  if (value >= mappedBase && value < mappedBase + (1n << 32n)) {
    const embedded = v4([
      Number((value >> 24n) & 0xffn),
      Number((value >> 16n) & 0xffn),
      Number((value >> 8n) & 0xffn),
      Number(value & 0xffn),
    ]);
    const inner = classifyAddress(embedded);
    return inner ? { ...inner, address: trimmed } : null;
  }
  for (const metadata of V6_METADATA) {
    if (inV6Range(value, metadata, 128))
      return {
        class: "metadata",
        overridable: false,
        hard_deny: true,
        address: trimmed,
      };
  }
  for (const range of V6_HARD_DENY) {
    if (inV6Range(value, range.base, range.bits))
      return {
        class: range.class,
        overridable: OVERRIDABLE.has(range.class),
        hard_deny: !OVERRIDABLE.has(range.class),
        address: trimmed,
      };
  }
  return {
    class: "public",
    overridable: false,
    hard_deny: false,
    address: trimmed,
  };
}

// ---------------------------------------------------------------------------
// Hostname and URL canonicalisation.
// ---------------------------------------------------------------------------

const HOSTNAME_LABEL = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;

/**
 * Canonicalises a hostname to its ASCII (punycode) lowercase form and refuses
 * everything ambiguous: bracketed or zoned literals, control characters, empty
 * labels, wildcards and over-long names.
 */
export function canonicalHostname(input: string): string | null {
  const raw = String(input ?? "").trim();
  if (!raw || raw.length > EGRESS_LIMITS.max_hostname_length) return null;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f\s]/.test(raw)) return null;
  if (raw.includes("*")) return null;
  if (raw.startsWith("[") || raw.endsWith("]")) return null;
  if (raw.includes("%")) return null;
  // A literal-looking input is validated by THIS parser, never by the URL parser:
  // `new URL('https://0177.0.0.1/')` silently normalises the octal form to
  // 127.0.0.1, which is precisely how an SSRF filter and the socket's own resolver
  // are made to disagree. Only a canonical literal is accepted.
  if (/^[0-9a-fA-FxX.:]+$/.test(raw)) {
    if (isIP(raw) === 0) return null;
    return raw.toLowerCase();
  }
  const withoutRootDot = raw.endsWith(".") ? raw.slice(0, -1) : raw;
  if (!withoutRootDot) return null;
  let ascii: string;
  try {
    ascii = new URL(`https://${withoutRootDot}/`).hostname;
  } catch {
    return null;
  }
  if (!ascii || ascii.length > EGRESS_LIMITS.max_hostname_length) return null;
  if (isIP(ascii) === 0) {
    const labels = ascii.split(".");
    if (labels.length < 2) return null;
    if (!labels.every((label) => HOSTNAME_LABEL.test(label))) return null;
  }
  return ascii;
}

export type ParsedDestination = {
  scheme: "https";
  host: string;
  port: number;
  path: string;
};

/**
 * Parses a provider destination URL. Only HTTPS is supported by the HTTP
 * transport, userinfo is refused outright (credentials never belong in a URL),
 * and an unexpected port is refused rather than silently defaulted.
 */
export function parseDestination(
  rawUrl: string,
  options: { allowed_ports?: number[] } = {},
): ParsedDestination | { error: EgressDenialCode; summary: string } {
  let parsed: URL;
  try {
    parsed = new URL(String(rawUrl ?? ""));
  } catch {
    return {
      error: "invalid_destination",
      summary: "Destination URL could not be parsed",
    };
  }
  if (parsed.protocol !== "https:")
    return {
      error: "unsupported_scheme",
      summary:
        "Only https destinations are supported by the provider HTTP transport",
    };
  if (parsed.username || parsed.password)
    return {
      error: "url_userinfo",
      summary: "Credentials in a destination URL are refused",
    };
  const host = canonicalHostname(parsed.hostname);
  if (!host)
    return {
      error: "invalid_destination",
      summary: "Destination hostname is not a valid public host",
    };
  const port = parsed.port ? Number(parsed.port) : 443;
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    return {
      error: "unsupported_port",
      summary: "Destination port is out of range",
    };
  if (options.allowed_ports && !options.allowed_ports.includes(port))
    return {
      error: "unsupported_port",
      summary: "Destination port is not permitted",
    };
  const path = `${parsed.pathname || "/"}${parsed.search || ""}`;
  return { scheme: "https", host, port, path };
}

/** A redacted, log-safe rendering of a destination. Never userinfo or a query. */
export function redactDestination(input: {
  host: string;
  port: number;
  path?: string;
}): string {
  const path = String(input.path || "/")
    .split("?")[0]
    .split("#")[0];
  const bounded = path.length > 80 ? `${path.slice(0, 80)}…` : path;
  return `https://${input.host}:${input.port}${bounded}`;
}

// ---------------------------------------------------------------------------
// Policy configuration (operator only).
// ---------------------------------------------------------------------------

function cidrContains(cidr: string, address: string): boolean {
  const [base, bitsRaw] = cidr.split("/");
  const bits = Number(bitsRaw);
  const family = isIP(base);
  if (!family || !Number.isInteger(bits)) return false;
  const addressFamily = isIP(address);
  if (addressFamily !== family) return false;
  if (family === 4) {
    const value = ipv4ToBigInt(address);
    const baseValue = ipv4ToBigInt(base);
    if (value === null || baseValue === null || bits < 0 || bits > 32)
      return false;
    const size = 1n << BigInt(32 - bits);
    return value >= baseValue && value < baseValue + size;
  }
  const value = ipv6ToBigInt(address);
  const baseValue = ipv6ToBigInt(base);
  if (value === null || baseValue === null || bits < 0 || bits > 128)
    return false;
  const size = 1n << BigInt(128 - bits);
  return value >= baseValue && value < baseValue + size;
}

/** True when a rule CIDR touches a range that must never be reachable. */
export function cidrTouchesHardDenyRange(cidr: string): boolean {
  const [base, bitsRaw] = cidr.split("/");
  const bits = Number(bitsRaw);
  const family = isIP(base);
  if (!family || !Number.isInteger(bits)) return true;
  const overlaps = (
    baseA: bigint,
    sizeA: bigint,
    baseB: bigint,
    sizeB: bigint,
  ): boolean => baseA < baseB + sizeB && baseB < baseA + sizeA;
  if (family === 4) {
    if (bits < 0 || bits > 32) return true;
    const value = ipv4ToBigInt(base);
    if (value === null) return true;
    const size = 1n << BigInt(32 - bits);
    for (const range of V4_HARD_DENY) {
      // Only NEVER-overridable ranges are disqualifying: private and unique-local
      // space is exactly what an operator rule is allowed to approve.
      if (OVERRIDABLE.has(range.class)) continue;
      const rangeBase = ipv4ToBigInt(range.base)!;
      const rangeSize = 1n << BigInt(32 - range.bits);
      if (overlaps(value, size, rangeBase, rangeSize)) return true;
    }
    for (const metadata of V4_METADATA) {
      const metadataBase = ipv4ToBigInt(metadata)!;
      if (overlaps(value, size, metadataBase, 1n)) return true;
    }
    return false;
  }
  if (bits < 0 || bits > 128) return true;
  const value = ipv6ToBigInt(base);
  if (value === null) return true;
  const size = 1n << BigInt(128 - bits);
  for (const range of V6_HARD_DENY) {
    if (OVERRIDABLE.has(range.class)) continue;
    const rangeBase = ipv6ToBigInt(range.base)!;
    const rangeSize = 1n << BigInt(128 - range.bits);
    if (overlaps(value, size, rangeBase, rangeSize)) return true;
  }
  for (const metadata of V6_METADATA) {
    const metadataBase = ipv6ToBigInt(metadata)!;
    if (overlaps(value, size, metadataBase, 1n)) return true;
  }
  // A v6 rule that reaches into the IPv4-mapped block is handled by the
  // transition range above; a rule that is itself inside it is refused there too.
  return false;
}

type RawRule = {
  host?: unknown;
  ports?: unknown;
  cidr?: unknown;
  allow_private?: unknown;
};

function parseRule(raw: unknown, label: string): EgressRule {
  assert(
    raw && typeof raw === "object" && !Array.isArray(raw),
    500,
    `${label} must be an object`,
  );
  const rule = raw as RawRule;
  const host = canonicalHostname(String(rule.host ?? ""));
  assert(host !== null, 500, `${label} needs a canonical host`);
  const ports = Array.isArray(rule.ports) ? rule.ports : [];
  assert(
    ports.length > 0 && ports.length <= EGRESS_LIMITS.max_ports_per_rule,
    500,
    `${label} needs 1..${EGRESS_LIMITS.max_ports_per_rule} explicit ports`,
  );
  const parsedPorts = ports.map((port) => Number(port));
  for (const port of parsedPorts)
    assert(
      Number.isInteger(port) && port >= 1 && port <= 65535,
      500,
      `${label} declares an invalid port`,
    );
  const cidr =
    rule.cidr === undefined || rule.cidr === null ? null : String(rule.cidr);
  if (cidr !== null) {
    assert(
      /^[0-9a-fA-F.:]+\/[0-9]{1,3}$/.test(cidr),
      500,
      `${label} declares an invalid CIDR`,
    );
    assert(
      !cidrTouchesHardDenyRange(cidr),
      500,
      `${label} would reach a range that is never reachable (loopback, link-local, metadata or another special-purpose block)`,
    );
  }
  const allowPrivate = rule.allow_private === true;
  assert(
    allowPrivate ? cidr !== null : true,
    500,
    `${label} that reaches private space must declare the exact CIDR`,
  );
  return { host: host!, ports: parsedPorts, cidr, allow_private: allowPrivate };
}

function parseRuleList(value: string | undefined, label: string): EgressRule[] {
  if (!value || !value.trim()) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error(`${label} is not valid JSON`);
  }
  if (!Array.isArray(parsed))
    throw new Error(`${label} must be a JSON array of rules`);
  if (parsed.length > EGRESS_LIMITS.max_rules)
    throw new Error(
      `${label} declares more than ${EGRESS_LIMITS.max_rules} rules`,
    );
  return parsed.map((rule, index) => parseRule(rule, `${label}[${index}]`));
}

/**
 * Loads the immutable operator policy. A malformed policy throws a bounded,
 * non-secret startup error instead of degrading to a permissive default.
 */
export function loadEgressPolicy(
  env: Record<string, string | undefined> = process.env,
): EgressPolicy {
  if (env.NODE_TLS_REJECT_UNAUTHORIZED === "0")
    throw new Error(
      "Provider egress refuses to start with NODE_TLS_REJECT_UNAUTHORIZED=0: certificate verification can never be disabled",
    );
  const rules = parseRuleList(
    env.CONNECTOR_EGRESS_RULES,
    "CONNECTOR_EGRESS_RULES",
  );
  const publicRules = parseRuleList(
    env.CONNECTOR_EGRESS_PUBLIC_RULES,
    "CONNECTOR_EGRESS_PUBLIC_RULES",
  );
  for (const rule of rules)
    if (!rule.allow_private)
      throw new Error(
        "CONNECTOR_EGRESS_RULES entries must set allow_private: true; use CONNECTOR_EGRESS_PUBLIC_RULES to pin public destinations",
      );
  const caPem = (env.CONNECTOR_EGRESS_CA_PEM || "").trim();
  if (caPem && !caPem.includes("BEGIN CERTIFICATE"))
    throw new Error(
      "CONNECTOR_EGRESS_CA_PEM does not contain a PEM certificate",
    );
  return {
    rules,
    public_rules: publicRules,
    ca_pem: caPem || null,
  };
}

// ---------------------------------------------------------------------------
// The decision.
// ---------------------------------------------------------------------------

function ruleMatches(
  rule: EgressRule,
  host: string,
  port: number,
  addresses: string[],
): boolean {
  if (rule.host !== host) return false;
  if (!rule.ports.includes(port)) return false;
  if (!rule.cidr) return false;
  return addresses.every((address) => cidrContains(rule.cidr!, address));
}

/**
 * Decides whether a destination may be dialled, using ONLY the addresses that
 * were actually resolved. Every answer must be acceptable: a hostname that
 * resolves to one public and one private address is refused, so a hostile or
 * rebinding resolver cannot smuggle a blocked destination through.
 */
export function evaluateDestination(input: {
  host: string;
  port: number;
  addresses: string[];
  policy: EgressPolicy;
}): EgressDecision {
  const { host, port, policy } = input;
  if (!input.addresses.length)
    return {
      allowed: false,
      code: "empty_dns_answer",
      summary: "The destination resolved to no addresses",
    };
  if (input.addresses.length > EGRESS_LIMITS.max_dns_answers)
    return {
      allowed: false,
      code: "dns_failure",
      summary:
        "The destination resolved to more addresses than the policy considers",
    };
  const classified: AddressClassification[] = [];
  for (const address of input.addresses) {
    const result = classifyAddress(address);
    if (!result)
      return {
        allowed: false,
        code: "invalid_destination",
        summary: "A resolved address could not be classified",
      };
    classified.push(result);
  }
  const blocked = classified.find((entry) => entry.hard_deny);
  if (blocked)
    return {
      allowed: false,
      code: "address_denied",
      summary: `Destination resolves to a ${blocked.class.replace(/_/g, " ")} address, which is never reachable`,
    };
  const restricted = classified.filter((entry) => entry.overridable);
  if (restricted.length) {
    const permitted = policy.rules.find((rule) =>
      ruleMatches(rule, host, port, input.addresses),
    );
    if (!permitted)
      return {
        allowed: false,
        code: "address_not_permitted",
        summary:
          "Destination resolves to private or unique-local space and no operator rule permits this host, port and range",
      };
  }
  if (policy.public_rules.length) {
    const pinned = policy.public_rules.some(
      (rule) => rule.host === host && rule.ports.includes(port),
    );
    if (!pinned)
      return {
        allowed: false,
        code: "address_not_permitted",
        summary:
          "Public destinations are pinned to an operator allowlist and this host and port are not on it",
      };
  }
  const chosen = classified[0];
  return {
    allowed: true,
    host,
    port,
    address: chosen.address,
    family: isIP(chosen.address) === 4 ? 4 : 6,
    addresses: classified.map((entry) => entry.address),
  };
}

/**
 * The reusable destination-policy primitive for non-HTTP provider protocols
 * (IMAP, SMTP, CalDAV over sockets). It performs the same classification and
 * returns the validated address the socket must be pinned to.
 */
export function authorizeHostAndPort(input: {
  host: string;
  port: number;
  addresses: string[];
  policy: EgressPolicy;
  allowed_ports?: number[];
}): EgressDecision {
  const host = canonicalHostname(input.host);
  if (!host)
    return {
      allowed: false,
      code: "invalid_destination",
      summary: "Destination hostname is not a valid public host",
    };
  if (input.allowed_ports && !input.allowed_ports.includes(Number(input.port)))
    return {
      allowed: false,
      code: "unsupported_port",
      summary: "Destination port is not permitted",
    };
  return evaluateDestination({
    host,
    port: Number(input.port),
    addresses: input.addresses,
    policy: input.policy,
  });
}
