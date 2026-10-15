/**
 * W29-P0/A2: the shared egress readiness runtime.
 *
 * One implementation answers "would this destination be allowed?" for both planes:
 * the customer endpoint-readiness check in a workspace and the operator diagnostic
 * in the fleet console. A diagnostic answer and a real connection attempt can
 * therefore never disagree, because they evaluate the same policy with the same
 * resolver contract.
 *
 * Preflight is DNS + policy ONLY. It never opens a socket to the destination, so it
 * cannot be used as an SSRF or port-scanning oracle and a blocked endpoint is never
 * contacted to produce its denial. Transport truth (TLS, reachability) comes from a
 * real connection test through the governed transport.
 */
import { createHash } from "node:crypto";
import { promises as dns } from "node:dns";
import {
  EGRESS_LIMITS,
  canonicalHostname,
  classifyAddress,
  evaluateDestination,
  loadEgressPolicy,
  type EgressPolicy,
} from "./egress-policy.ts";
import { destinationDigest } from "./egress-transport.ts";

/** Bumped when the readiness vocabulary or its meaning changes. */
export const EGRESS_POLICY_VERSION = "1.0.0";

/**
 * The ports a readiness check may consider. A customer-supplied port outside this
 * set is refused, so the check can never be turned into an arbitrary port probe.
 */
export const EGRESS_PREFLIGHT_PORTS = [443, 993, 465, 587] as const;

/** The canonical readiness states, shared by both planes. */
export const READINESS_STATES = [
  "ready",
  "blocked_by_operator_policy",
  "private_requires_approval",
  "dns_not_safe",
  "dns_failure",
  "invalid_destination",
  "unsupported_scheme",
  "unsupported_port",
  "tls_issue",
  "unreachable",
] as const;

export type ReadinessState = (typeof READINESS_STATES)[number];

export type ReadinessResult = {
  state: ReadinessState;
  /** Bounded evaluator code, never free text. */
  code: string;
  summary: string;
  next_action: string;
  host: string | null;
  port: number;
  destination_digest: string;
  /** Class of the resolved address, never the address itself. */
  address_class: string | null;
  resolved_answers: number;
  /** Explicit: preflight performs no outbound connection. */
  contacted: false;
  policy: { fingerprint: string; version: string };
};

/**
 * A stable, non-reversible identity of the EFFECTIVE policy, so an operator can
 * compare two deployments (or two releases) without disclosing the policy body.
 * The CA bundle is represented by presence only, never by content.
 */
export function policyFingerprint(policy: EgressPolicy): string {
  const canonical = JSON.stringify({
    version: EGRESS_POLICY_VERSION,
    rules: [...policy.rules]
      .map((rule) => ({
        host: rule.host,
        ports: [...rule.ports].sort((a, b) => a - b),
        cidr: rule.cidr,
        allow_private: rule.allow_private,
      }))
      .sort((a, b) => (a.host < b.host ? -1 : a.host > b.host ? 1 : 0)),
    public_rules: [...policy.public_rules]
      .map((rule) => ({
        host: rule.host,
        ports: [...rule.ports].sort((a, b) => a - b),
      }))
      .sort((a, b) => (a.host < b.host ? -1 : a.host > b.host ? 1 : 0)),
    internal_trust_chain: Boolean(policy.ca_pem),
  });
  return createHash("sha256").update(canonical).digest("hex").slice(0, 24);
}

let cachedPolicy: EgressPolicy | null = null;

/**
 * The effective policy, loaded once from deployment configuration. A malformed
 * policy throws, so a misconfiguration fails loudly instead of degrading to a
 * permissive default.
 */
export function egressPolicy(
  env: Record<string, string | undefined> = process.env,
): EgressPolicy {
  if (!cachedPolicy) cachedPolicy = loadEgressPolicy(env);
  return cachedPolicy;
}

/** Test seam: forget the cached policy so an env change is observable. */
export function resetEgressPolicyCache(): void {
  cachedPolicy = null;
}

export type EgressResolver = (
  host: string,
) => Promise<{ address: string; family: number }[]>;

const defaultResolver: EgressResolver = async (host) => {
  const answers = await dns.lookup(host, { all: true, verbatim: true });
  return answers.map((answer) => ({
    address: answer.address,
    family: answer.family,
  }));
};

let activeResolver: EgressResolver | null = null;

/**
 * Test seam: acceptance runs inject deterministic DNS answers so the hostile cases
 * are reproducible. It is not reachable from configuration, from a route or from a
 * request; the production default is the system resolver.
 */
export function setEgressResolverForTesting(
  resolver: EgressResolver | null,
): void {
  activeResolver = resolver;
}

const NEXT_ACTIONS: Record<ReadinessState, string> = {
  ready: "Continue and connect the provider account.",
  blocked_by_operator_policy:
    "This destination is never reachable. Choose a public endpoint, or ask the deployment operator.",
  private_requires_approval:
    "An OpenJM operator must approve internal destinations. A workspace administrator cannot grant private-network reach.",
  dns_not_safe:
    "This hostname resolves to a blocked address. Use an endpoint that resolves to public space.",
  dns_failure: "Check the hostname, then run the check again.",
  invalid_destination: "Correct the hostname and run the check again.",
  unsupported_scheme: "Use a supported scheme for this provider.",
  unsupported_port: "Choose a port the deployment supports for this provider.",
  tls_issue:
    "Reported by a real connection test: fix the certificate or ask the operator to add the internal trust chain.",
  unreachable:
    "Reported by a real connection test: check connectivity from the deployment.",
};

const SUMMARIES: Record<ReadinessState, string> = {
  ready: "DNS and the deployment egress policy permit this destination.",
  blocked_by_operator_policy:
    "The deployment egress policy does not permit this destination.",
  private_requires_approval:
    "This destination resolves to private or unique-local space and no operator rule permits it.",
  dns_not_safe:
    "This hostname resolves to an address the policy never permits.",
  dns_failure: "This hostname could not be resolved.",
  invalid_destination: "This is not a valid canonical public hostname.",
  unsupported_scheme:
    "Only supported schemes may be used for provider destinations.",
  unsupported_port: "This port is not permitted for provider destinations.",
  tls_issue: "TLS verification failed for this destination.",
  unreachable: "This destination could not be reached.",
};

/**
 * Evaluates one destination without contacting it. Every answer of the resolution
 * must be permitted, so a hostile or rebinding resolver cannot smuggle a blocked
 * address through.
 */
export async function preflightEndpoint(input: {
  host: string;
  port: number;
  policy?: EgressPolicy;
  allowed_ports?: number[];
  deps?: { resolve?: EgressResolver };
}): Promise<ReadinessResult> {
  const policy = input.policy ?? egressPolicy();
  const fingerprint = policyFingerprint(policy);
  const version = EGRESS_POLICY_VERSION;
  const port = Number(input.port);
  const base = {
    host: null as string | null,
    port: Number.isFinite(port) ? port : 0,
    destination_digest: destinationDigest(String(input.host || ""), port || 0),
    address_class: null as string | null,
    resolved_answers: 0,
    contacted: false as const,
    policy: { fingerprint, version },
  };
  const state = (
    value: ReadinessState,
    code: string,
    extra: Partial<ReadinessResult> = {},
  ): ReadinessResult => ({
    ...base,
    ...extra,
    state: value,
    code,
    summary: SUMMARIES[value],
    next_action: NEXT_ACTIONS[value],
  });

  if (!Number.isInteger(port) || port < 1 || port > 65535)
    return state("unsupported_port", "unsupported_port");
  if (input.allowed_ports && !input.allowed_ports.includes(port))
    return state("unsupported_port", "unsupported_port");
  const host = canonicalHostname(input.host);
  if (!host) return state("invalid_destination", "invalid_destination");

  let answers: { address: string; family: number }[];
  try {
    answers = await (input.deps?.resolve ?? activeResolver ?? defaultResolver)(
      host,
    );
  } catch {
    return state("dns_failure", "dns_failure", { host });
  }
  const addresses = (answers || []).map((answer) => String(answer.address));
  if (!addresses.length)
    return state("dns_failure", "empty_dns_answer", { host });
  if (addresses.length > EGRESS_LIMITS.max_dns_answers)
    return state("dns_failure", "dns_failure", { host });

  const classes = addresses.map(
    (address) => classifyAddress(address)?.class ?? "unknown",
  );
  const addressClass = classes.includes("public")
    ? "public"
    : (classes[0] ?? null);
  const decision = evaluateDestination({ host, port, addresses, policy });
  if (decision.allowed)
    return state("ready", "ready", {
      host,
      address_class: addressClass,
      resolved_answers: addresses.length,
    });

  if (decision.code === "address_denied")
    return state("blocked_by_operator_policy", decision.code, {
      host,
      address_class: addressClass,
      resolved_answers: addresses.length,
    });
  if (decision.code === "address_not_permitted") {
    const overridable = classes.some((entry) =>
      ["private", "unique_local"].includes(entry),
    );
    return state(
      overridable ? "private_requires_approval" : "blocked_by_operator_policy",
      decision.code,
      { host, address_class: addressClass, resolved_answers: addresses.length },
    );
  }
  if (decision.code === "empty_dns_answer" || decision.code === "dns_failure")
    return state("dns_failure", decision.code, { host });
  if (decision.code === "unsupported_port")
    return state("unsupported_port", decision.code, { host });
  if (decision.code === "unsupported_scheme")
    return state("unsupported_scheme", decision.code, { host });
  return state("dns_not_safe", decision.code, {
    host,
    address_class: addressClass,
    resolved_answers: addresses.length,
  });
}

export type EgressPosture = {
  policy: {
    fingerprint: string;
    version: string;
    internal_rules: number;
    public_pinned: boolean;
    public_rules: number;
    internal_trust_chain: boolean;
  };
  /** Classes that can never be reached, by name only. */
  never_reachable: string[];
  /** Classes an operator rule may approve. */
  overridable: string[];
  readiness_states: string[];
  preflight: { dns_only: true; contacts_endpoint: false };
};

/** The read-only posture summary an operator page may show. */
export function egressPosture(policy: EgressPolicy): EgressPosture {
  return {
    policy: {
      fingerprint: policyFingerprint(policy),
      version: EGRESS_POLICY_VERSION,
      internal_rules: policy.rules.length,
      public_pinned: policy.public_rules.length > 0,
      public_rules: policy.public_rules.length,
      internal_trust_chain: Boolean(policy.ca_pem),
    },
    never_reachable: [
      "loopback",
      "link_local",
      "multicast",
      "unspecified",
      "broadcast",
      "carrier_grade",
      "benchmark",
      "documentation",
      "reserved",
      "metadata",
      "transition",
    ],
    overridable: ["private", "unique_local"],
    readiness_states: [...READINESS_STATES],
    preflight: { dns_only: true, contacts_endpoint: false },
  };
}
