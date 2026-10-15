/**
 * W29-P0/A2: the shared egress readiness runtime.
 *
 * ONE evaluator, TWO scopes. The customer endpoint-readiness check runs inside the
 * deployment that will make the connection, so its answer is that deployment's
 * effective policy. The operator diagnostic runs in the Fleet service process, whose
 * configuration and resolver are its own, so its answer is Fleet-local and is NOT a
 * statement about any customer deployment: the same host can be `ready` in one and
 * `blocked` in the other. Every answer therefore declares its scope explicitly
 * (`EgressScope`), and per-deployment operator diagnosis is a separately gated
 * requirement (issue #234).
 *
 * Within one scope, a diagnostic answer and a real connection attempt cannot
 * disagree: both evaluate the same policy with the same resolver contract.
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
import {
  ProviderEgressError,
  destinationDigest,
  runUnderBudget,
} from "./egress-transport.ts";

/** Bumped when the readiness vocabulary or its meaning changes. */
export const EGRESS_POLICY_VERSION = "1.0.0";

/**
 * The ports a readiness check may consider. A customer-supplied port outside this
 * set is refused, so the check can never be turned into an arbitrary port probe.
 */
export const EGRESS_PREFLIGHT_PORTS = [443, 993, 465, 587] as const;

/**
 * The use cases the guided readiness journey offers. The choice is not decoration:
 * it selects the ports the check may consider and the guidance the answer carries,
 * so the journey is a real onboarding path rather than a network-check form.
 */
export const PREFLIGHT_USE_CASES = ["custom_imap", "custom_smtp", "https"] as const;
export type PreflightUseCase = (typeof PREFLIGHT_USE_CASES)[number];

export const USE_CASE_GUIDANCE: Record<
  PreflightUseCase,
  { label: string; ports: number[]; guidance: string }
> = Object.freeze({
  custom_imap: {
    label: "Custom mailbox over IMAP",
    ports: [993],
    guidance:
      "IMAP over TLS on port 993. Connecting needs the mailbox host, port 993 and a credential the provider issues for this workspace.",
  },
  custom_smtp: {
    label: "Custom mailbox over SMTP",
    ports: [465, 587],
    guidance:
      "SMTP over TLS on port 465, or submission on 587. Sending needs the provider's SMTP credential for this workspace.",
  },
  https: {
    label: "HTTPS API endpoint",
    ports: [443],
    guidance:
      "An HTTPS API endpoint on port 443. Connecting needs an API token the provider issues for this workspace.",
  },
});

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

/**
 * WHOSE policy an answer describes.
 *
 * `deployment` means the check ran inside the customer deployment that will make
 * the connection, so the answer is that deployment's effective policy.
 * `fleet_local` means it ran in the OpenJM Fleet service process, whose
 * configuration and resolver are its own: it is a useful operator reference, but
 * it is NOT a statement about any customer deployment.
 */
export type EgressScope = "deployment" | "fleet_local";

export const EGRESS_SCOPE_NOTES: Record<EgressScope, string> = Object.freeze({
  deployment:
    "Evaluated inside this deployment, with this deployment's egress configuration.",
  fleet_local:
    "Evaluated in the Fleet service process with the Fleet service's own egress configuration and resolver. This is not the policy of any customer deployment: a Ready answer here does not prove that a customer deployment would permit the destination.",
});

export type ReadinessResult = {
  state: ReadinessState;
  /** Whose policy this answer describes. */
  scope: EgressScope;
  scope_note: string;
  /** The use case this check was made for, when one was chosen. */
  use_case: PreflightUseCase | null;
  /** Plain-language guidance for the chosen use case. */
  guidance: string | null;
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
  use_case?: PreflightUseCase;
  /** Defaults to `deployment`: the caller is the deployment making the connection. */
  scope?: EgressScope;
  deps?: { resolve?: EgressResolver };
}): Promise<ReadinessResult> {
  const policy = input.policy ?? egressPolicy();
  const fingerprint = policyFingerprint(policy);
  const version = EGRESS_POLICY_VERSION;
  const port = Number(input.port);
  const scope: EgressScope = input.scope ?? "deployment";
  const base = {
    scope,
    scope_note: EGRESS_SCOPE_NOTES[scope],
    use_case: input.use_case ?? null,
    guidance: input.use_case ? USE_CASE_GUIDANCE[input.use_case].guidance : null,
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

  // The use case narrows the port vocabulary; without one, the full set applies.
  const allowedPorts = input.use_case
    ? USE_CASE_GUIDANCE[input.use_case].ports
    : (input.allowed_ports ?? [...EGRESS_PREFLIGHT_PORTS]);
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    return state("unsupported_port", "unsupported_port");
  if (!allowedPorts.includes(port))
    return state("unsupported_port", "unsupported_port");
  const host = canonicalHostname(input.host);
  if (!host) return state("invalid_destination", "invalid_destination");

  let answers: { address: string; family: number }[];
  try {
    // Resolution is bounded exactly like a real dial: a resolver that stalls must
    // not hold the request, and a late answer is never used.
    answers = await runUnderBudget(
      Promise.resolve().then(() =>
        (input.deps?.resolve ?? activeResolver ?? defaultResolver)(host),
      ),
      EGRESS_LIMITS.dns_timeout_ms,
      "dns_timeout",
    );
  } catch (error) {
    const code =
      error instanceof ProviderEgressError ? error.code : "dns_failure";
    return state("dns_failure", code, { host });
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
  /** The posture always describes the process it is read from. */
  scope: EgressScope;
  scope_note: string;
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
export function egressPosture(
  policy: EgressPolicy,
  scope: EgressScope = "fleet_local",
): EgressPosture {
  return {
    scope,
    scope_note: EGRESS_SCOPE_NOTES[scope],
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
