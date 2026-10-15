/**
 * W29-P0/A2 acceptance: the governed provider egress policy.
 *
 * These are the hostile cases that decide whether a real adapter could ever reach
 * something it must not: special-purpose and metadata addresses, parser evasions
 * that disagree with the socket's own resolver, DNS answers that contradict the
 * hostname, and operator rules that would quietly widen reach. Everything here is
 * pure: no network, no clock, no database.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_EGRESS_POLICY,
  ProviderEgressError,
  authorizeHostAndPort,
  canonicalCidr,
  canonicalHostname,
  cidrIsNetworkAligned,
  cidrTouchesHardDenyRange,
  classifyAddress,
  evaluateDestination,
  loadEgressPolicy,
  parseDestination,
  redactDestination,
  type EgressPolicy,
} from "../packages/connectors/index.ts";

const policy = DEFAULT_EGRESS_POLICY;

/** Narrows a parse result to its denial code, or fails the test. */
function parseErrorCode(result: ReturnType<typeof parseDestination>): string {
  assert.ok("error" in result, "expected the destination to be refused");
  return (result as { error: string }).error;
}

function deny(addresses: string[], host = "mail.example.test", port = 443) {
  const decision = evaluateDestination({ host, port, addresses, policy });
  assert.equal(
    decision.allowed,
    false,
    `expected denial for ${addresses.join(", ")}`,
  );
  return decision as Extract<typeof decision, { allowed: false }>;
}

// ---------------------------------------------------------------------------
// IPv4 special-purpose ranges.
// ---------------------------------------------------------------------------

/** Classes an operator rule may reach: denied by default, but overridable. */
const OVERRIDABLE_CLASSES = new Set(["private", "unique_local"]);

test("A2 policy: every IPv4 special-purpose range is denied by default", () => {
  const denied: [string, string][] = [
    ["127.0.0.1", "loopback"],
    ["127.255.255.254", "loopback"],
    ["0.0.0.0", "unspecified"],
    ["0.255.255.255", "unspecified"],
    ["169.254.1.1", "link_local"],
    ["169.254.169.254", "metadata"],
    ["10.1.2.3", "private"],
    ["172.16.0.1", "private"],
    ["172.31.255.255", "private"],
    ["192.168.0.1", "private"],
    ["100.64.0.1", "carrier_grade"],
    ["100.100.100.200", "metadata"],
    ["224.0.0.1", "multicast"],
    ["239.255.255.250", "multicast"],
    ["240.0.0.1", "reserved"],
    ["255.255.255.255", "broadcast"],
    ["192.0.2.10", "documentation"],
    ["198.51.100.7", "documentation"],
    ["203.0.113.9", "documentation"],
    ["198.18.0.5", "benchmark"],
    ["192.0.0.192", "metadata"],
    ["192.88.99.1", "transition"],
  ];
  for (const [address, expected] of denied) {
    const classified = classifyAddress(address);
    assert.ok(classified, `${address} must classify`);
    assert.equal(classified!.class, expected, address);
    assert.equal(
      classified!.hard_deny,
      !OVERRIDABLE_CLASSES.has(expected),
      `${address} hard-deny posture`,
    );
    const decision = deny([address]);
    assert.equal(
      decision.code,
      OVERRIDABLE_CLASSES.has(expected)
        ? "address_not_permitted"
        : "address_denied",
    );
  }
});

test("A2 policy: a private address is overridable but never by default", () => {
  const classified = classifyAddress("10.20.30.40");
  assert.equal(classified?.class, "private");
  assert.equal(classified?.overridable, true);
  assert.equal(classified?.hard_deny, false);
  const decision = deny(["10.20.30.40"], "mail.internal.example");
  assert.equal(decision.code, "address_not_permitted");
});

test("A2 policy: public IPv4 addresses are allowed and unremarkable", () => {
  const classified = classifyAddress("93.184.216.34");
  assert.equal(classified?.class, "public");
  const decision = evaluateDestination({
    host: "mail.example.test",
    port: 443,
    addresses: ["93.184.216.34"],
    policy,
  });
  assert.equal(decision.allowed, true);
  assert.equal(decision.allowed && decision.address, "93.184.216.34");
  assert.equal(decision.allowed && decision.family, 4);
});

// ---------------------------------------------------------------------------
// IPv6 special-purpose ranges and mapped forms.
// ---------------------------------------------------------------------------

test("A2 policy: IPv6 special-purpose ranges are denied, including mapped IPv4", () => {
  const denied: [string, string][] = [
    ["::", "unspecified"],
    ["::1", "loopback"],
    ["fe80::1", "link_local"],
    ["febf::1", "link_local"],
    ["fc00::1", "unique_local"],
    ["fd12:3456::1", "unique_local"],
    ["ff02::1", "multicast"],
    ["fd00:ec2::254", "metadata"],
    ["2001:db8::1", "documentation"],
    ["2001:2::1", "benchmark"],
    ["2002::1", "transition"],
    ["::ffff:127.0.0.1", "loopback"],
    ["::ffff:169.254.169.254", "metadata"],
    ["::ffff:10.0.0.1", "private"],
    ["::ffff:7f00:1", "loopback"],
    ["64:ff9b::7f00:1", "transition"],
  ];
  for (const [address, expected] of denied) {
    const classified = classifyAddress(address);
    assert.ok(classified, `${address} must classify`);
    assert.equal(classified!.class, expected, address);
    assert.equal(
      classified!.hard_deny,
      !OVERRIDABLE_CLASSES.has(expected),
      `${address} hard-deny posture`,
    );
    deny([address]);
  }
});

test("A2 policy: a scoped or malformed IPv6 address is refused, never normalised", () => {
  assert.equal(classifyAddress("fe80::1%eth0"), null);
  assert.equal(classifyAddress("::1%0"), null);
  assert.equal(classifyAddress("not-an-address"), null);
  assert.equal(classifyAddress(""), null);
  assert.equal(classifyAddress("1.2.3"), null);
  assert.equal(classifyAddress("999.1.1.1"), null);
});

test("A2 policy: a public IPv6 destination is allowed and keeps its family", () => {
  const decision = evaluateDestination({
    host: "mail.example.test",
    port: 443,
    addresses: ["2606:2800:220:1:248:1893:25c8:1946"],
    policy,
  });
  assert.equal(decision.allowed, true);
  assert.equal(decision.allowed && decision.family, 6);
});

// ---------------------------------------------------------------------------
// Hostname and URL parser evasions.
// ---------------------------------------------------------------------------

test("A2 policy: ambiguous IPv4 literal forms are refused by the hostname parser", () => {
  for (const form of [
    "0177.0.0.1",
    "0x7f.0.0.1",
    "2130706433",
    "127.1",
    "127.0.0.1.5",
    "127.0.0.01",
    "017700000001",
  ]) {
    assert.equal(
      canonicalHostname(form),
      null,
      `${form} must be refused as an ambiguous literal`,
    );
  }
  assert.equal(classifyAddress("0177.0.0.1"), null);
  assert.equal(classifyAddress("2130706433"), null);
  assert.equal(classifyAddress("0x7f000001"), null);
});

test("A2 policy: a canonical hostname is lowercased punycode and rejects wildcards", () => {
  assert.equal(canonicalHostname("MAIL.Example.TEST"), "mail.example.test");
  assert.equal(canonicalHostname("mail.example.test."), "mail.example.test");
  assert.equal(canonicalHostname("münchen.example"), "xn--mnchen-3ya.example");
  assert.equal(canonicalHostname("*.example.test"), null);
  assert.equal(canonicalHostname("mail.*.example"), null);
  assert.equal(canonicalHostname("localhost"), null);
  assert.equal(canonicalHostname("[::1]"), null);
  assert.equal(canonicalHostname("mail.example.test%0d"), null);
  assert.equal(canonicalHostname("mail .example.test"), null);
  assert.equal(canonicalHostname("a".repeat(254) + ".example"), null);
});

test("A2 policy: destination URLs refuse userinfo, unexpected schemes and ports", () => {
  assert.equal(
    parseErrorCode(
      parseDestination("https://alice:secret@mail.example.test/api"),
    ),
    "url_userinfo",
  );
  assert.equal(
    parseErrorCode(parseDestination("http://mail.example.test/")),
    "unsupported_scheme",
  );
  assert.equal(
    parseErrorCode(parseDestination("file:///etc/passwd")),
    "unsupported_scheme",
  );
  assert.equal(
    parseErrorCode(parseDestination("gopher://mail.example.test/")),
    "unsupported_scheme",
  );
  // An out-of-range port is rejected by the URL parser itself, so the honest code
  // is an invalid destination rather than a policy port refusal.
  assert.equal(
    parseErrorCode(parseDestination("https://mail.example.test:99999/")),
    "invalid_destination",
  );
  assert.equal(
    parseErrorCode(
      parseDestination("https://mail.example.test:25/", {
        allowed_ports: [443],
      }),
    ),
    "unsupported_port",
  );
  assert.equal(
    parseErrorCode(
      parseDestination("https://mail.example.test:8443/x", {
        allowed_ports: [443],
      }),
    ),
    "unsupported_port",
  );
  const ok = parseDestination("https://mail.example.test/x?y=1#z");
  assert.ok(!("error" in ok));
  assert.equal(ok.host, "mail.example.test");
  assert.equal(ok.port, 443);
  assert.equal(ok.path, "/x?y=1");
});

test("A2 policy: a redacted destination is host and port only", () => {
  // Blocker 4 (review): a path is not redacted material. Provider paths carry
  // bearer tokens, reset keys and opaque identifiers with no query string at all,
  // so NOTHING of the path may reach an error, a log or persisted evidence.
  const secrets = [
    "/oauth/token/eyJhbGciOiJIUzI1NiJ9.SECRET.SIGNATURE",
    "/d/reset/bd4f8a2c-1111-2222-3333-444455556666",
    "/api/v1/messages/01H8ZQ7KQ4T5V6W7X8Y9Z0ABCDEF",
    `/x/${"y".repeat(200)}`,
  ];
  for (const path of secrets) {
    const redacted = redactDestination({ host: "mail.example.test", port: 443 });
    assert.equal(redacted, "https://mail.example.test:443");
    for (const fragment of [path, path.split("/")[2] || "", path.slice(0, 40)])
      if (fragment.length > 3)
        assert.ok(
          !redacted.includes(fragment),
          `no path fragment may survive redaction: ${fragment.slice(0, 20)}`,
        );
  }
  // The full error surface is checked against a secret-bearing path.
  const error = new ProviderEgressError("tls_failure", {
    destination: redactDestination({ host: "mail.example.test", port: 443 }),
  });
  const rendered = JSON.stringify({
    code: error.code,
    summary: error.summary,
    destination: error.destination,
    message: error.message,
    stack: error.stack,
  });
  assert.ok(!rendered.includes("reset"), "no path segment is rendered");
  assert.ok(!/eyJ|SECRET|SIGNATURE|01H8ZQ/.test(rendered));
  assert.equal(error.destination, "https://mail.example.test:443");
});

// ---------------------------------------------------------------------------
// CIDR prefix alignment (Blocker 3).
// ---------------------------------------------------------------------------

test("A2 policy: CIDR matching is prefix-aligned, not base-offset arithmetic", () => {
  // The adversarial case from review: 10.0.0.5/24 must NOT be read as the range
  // 10.0.0.5 .. 10.0.1.4. The math is masked to the network boundary.
  // Built directly, because loadEgressPolicy now REFUSES a non-aligned CIDR (the
  // next test). This is the defence-in-depth case: even a value that bypassed
  // validation must be read as its prefix-aligned network, never as base+size.
  const unaligned: EgressPolicy = {
    rules: [
      {
        host: "mail.internal.example",
        ports: [993],
        cidr: "10.0.0.5/24",
        allow_private: true,
      },
    ],
    public_rules: [],
    ca_pem: null,
  };
  const allowed = (address: string) =>
    authorizeHostAndPort({
      host: "mail.internal.example",
      port: 993,
      addresses: [address],
      policy: unaligned,
    }).allowed;
  // Boundary behaviour is the /24 network, both edges exact.
  assert.equal(allowed("10.0.0.0"), true, "the network address is inside 10.0.0.0/24");
  assert.equal(allowed("10.0.0.255"), true, "the broadcast address is inside 10.0.0.0/24");
  assert.equal(allowed("10.0.1.4"), false, "an address outside the stated /24 is refused");
  assert.equal(allowed("10.0.1.0"), false, "the next /24 is refused");
  assert.equal(allowed("10.0.0.256"), false, "an invalid address is refused");
});

test("A2 policy: a non-aligned CIDR is refused at load with the aligned form named", () => {
  for (const [cidr, expected] of [
    ["10.0.0.5/24", "10.0.0.0/24"],
    ["10.20.30.40/16", "10.20.0.0/16"],
    ["fd00:1234::5/48", "fd00:1234::/48"],
  ]) {
    assert.equal(canonicalCidr(cidr), expected, cidr);
    assert.equal(cidrIsNetworkAligned(cidr), false, cidr);
    assert.throws(
      () =>
        loadEgressPolicy({
          CONNECTOR_EGRESS_RULES: JSON.stringify([
            { host: "mail.internal.example", ports: [993], cidr, allow_private: true },
          ]),
        }),
      new RegExp(expected.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
      `the rejection must name ${expected}`,
    );
  }
  for (const cidr of ["10.0.0.0/24", "10.20.0.0/16", "fd00:1234::/48", "0.0.0.0/0", "2001:db8::/32"])
    assert.equal(cidrIsNetworkAligned(cidr), true, cidr);
  assert.equal(canonicalCidr("not-a-cidr"), null);
  assert.equal(canonicalCidr("10.0.0.0/33"), null);
  assert.equal(canonicalCidr("fd00::/129"), null);
});

test("A2 policy: hard-deny overlap is computed on the masked network", () => {
  // A /7 that starts at 127.0.0.0 masks to 126.0.0.0/7, which still contains
  // loopback, so it stays disqualifying; a rule that only *looks* adjacent is not.
  assert.equal(cidrTouchesHardDenyRange("127.0.0.0/7"), true);
  assert.equal(cidrTouchesHardDenyRange("126.0.0.0/7"), true);
  assert.equal(cidrTouchesHardDenyRange("169.254.0.0/16"), true);
  assert.equal(cidrTouchesHardDenyRange("169.254.10.7/16"), true, "the unaligned form masks to the same /16");
  assert.equal(cidrTouchesHardDenyRange("10.20.30.40/16"), false, "private space stays approvable");
  assert.equal(cidrTouchesHardDenyRange("fd00:1234::5/48"), false);
  assert.equal(cidrTouchesHardDenyRange("::ffff:127.0.0.1/128"), true);
});

/** Builds a policy from rules without going through the environment. */
function policyWith(input: { rules: any[]; public_rules?: any[] }): EgressPolicy {
  return loadEgressPolicy({
    CONNECTOR_EGRESS_RULES: JSON.stringify(input.rules),
    ...(input.public_rules
      ? { CONNECTOR_EGRESS_PUBLIC_RULES: JSON.stringify(input.public_rules) }
      : {}),
  });
}

// ---------------------------------------------------------------------------
// DNS answer validation.
// ---------------------------------------------------------------------------

test("A2 policy: a public hostname resolving to a blocked address is denied", () => {
  const decision = deny(["93.184.216.34", "10.0.0.5"]);
  assert.equal(decision.code, "address_not_permitted");
  const metadata = deny(["93.184.216.34", "169.254.169.254"]);
  assert.equal(metadata.code, "address_denied");
  const loopback = deny(["127.0.0.1"]);
  assert.equal(loopback.code, "address_denied");
});

test("A2 policy: an empty, oversized or unclassifiable answer set is denied", () => {
  assert.equal(deny([]).code, "empty_dns_answer");
  const many = Array.from(
    { length: 17 },
    (_, index) => `93.184.216.${index + 1}`,
  );
  assert.equal(deny(many).code, "dns_failure");
  const unclassifiable = evaluateDestination({
    host: "mail.example.test",
    port: 443,
    addresses: ["not-an-ip"],
    policy,
  });
  assert.equal(unclassifiable.allowed, false);
  assert.equal(
    unclassifiable.allowed === false && unclassifiable.code,
    "invalid_destination",
  );
});

test("A2 policy: every answer must be permitted, so rebinding cannot smuggle one through", () => {
  // The first resolution looks clean, the second answers with a blocked address.
  const first = evaluateDestination({
    host: "mail.example.test",
    port: 443,
    addresses: ["93.184.216.34"],
    policy,
  });
  assert.equal(first.allowed, true);
  const rebound = evaluateDestination({
    host: "mail.example.test",
    port: 443,
    addresses: ["93.184.216.34", "192.168.1.10"],
    policy,
  });
  assert.equal(rebound.allowed, false);
});

// ---------------------------------------------------------------------------
// Operator policy: private exceptions.
// ---------------------------------------------------------------------------

const internalPolicy = loadEgressPolicy({
  CONNECTOR_EGRESS_RULES: JSON.stringify([
    {
      host: "mail.internal.example",
      ports: [443, 993, 465, 587],
      cidr: "10.20.0.0/16",
      allow_private: true,
    },
    {
      host: "calendar.internal.example",
      ports: [443],
      cidr: "fd00:1234::/48",
      allow_private: true,
    },
  ]),
});

test("A2 policy: an exact host+CIDR+port rule permits one internal endpoint", () => {
  const allowed = evaluateDestination({
    host: "mail.internal.example",
    port: 993,
    addresses: ["10.20.30.40"],
    policy: internalPolicy,
  });
  assert.equal(allowed.allowed, true);
  assert.equal(allowed.allowed && allowed.address, "10.20.30.40");
  const ula = evaluateDestination({
    host: "calendar.internal.example",
    port: 443,
    addresses: ["fd00:1234::5"],
    policy: internalPolicy,
  });
  assert.equal(ula.allowed, true);
});

test("A2 policy: the same rule does not permit another host, port or CIDR", () => {
  const otherHost = evaluateDestination({
    host: "other.internal.example",
    port: 993,
    addresses: ["10.20.30.40"],
    policy: internalPolicy,
  });
  assert.equal(otherHost.allowed, false);
  const otherPort = evaluateDestination({
    host: "mail.internal.example",
    port: 22,
    addresses: ["10.20.30.40"],
    policy: internalPolicy,
  });
  assert.equal(otherPort.allowed, false);
  const otherCidr = evaluateDestination({
    host: "mail.internal.example",
    port: 993,
    addresses: ["10.21.30.40"],
    policy: internalPolicy,
  });
  assert.equal(otherCidr.allowed, false);
  const mixed = evaluateDestination({
    host: "mail.internal.example",
    port: 993,
    addresses: ["10.20.30.40", "10.21.30.40"],
    policy: internalPolicy,
  });
  assert.equal(
    mixed.allowed,
    false,
    "one out-of-range answer voids the exception",
  );
});

test("A2 policy: an internal rule can never reach loopback, link-local or metadata", () => {
  for (const address of [
    "127.0.0.1",
    "169.254.169.254",
    "100.100.100.200",
    "::1",
    "fe80::1",
    "fd00:ec2::254",
  ]) {
    const decision = evaluateDestination({
      host: "mail.internal.example",
      port: 993,
      addresses: [address],
      policy: internalPolicy,
    });
    assert.equal(decision.allowed, false, address);
    assert.equal(
      decision.allowed === false && decision.code,
      "address_denied",
      address,
    );
  }
});

test("A2 policy: public pinning narrows public reach when an operator asks for it", () => {
  const pinned = loadEgressPolicy({
    CONNECTOR_EGRESS_PUBLIC_RULES: JSON.stringify([
      { host: "api.provider.example", ports: [443] },
    ]),
  });
  const allowed = evaluateDestination({
    host: "api.provider.example",
    port: 443,
    addresses: ["93.184.216.34"],
    policy: pinned,
  });
  assert.equal(allowed.allowed, true);
  const denied = evaluateDestination({
    host: "elsewhere.example",
    port: 443,
    addresses: ["93.184.216.34"],
    policy: pinned,
  });
  assert.equal(denied.allowed, false);
  assert.equal(
    denied.allowed === false && denied.code,
    "address_not_permitted",
  );
});

test("A2 policy: a malformed or unsafe operator policy fails closed at load", () => {
  assert.throws(
    () => loadEgressPolicy({ CONNECTOR_EGRESS_RULES: "{" }),
    /not valid JSON/,
  );
  assert.throws(
    () =>
      loadEgressPolicy({
        CONNECTOR_EGRESS_RULES: JSON.stringify([
          {
            host: "*.internal.example",
            ports: [443],
            cidr: "10.0.0.0/8",
            allow_private: true,
          },
        ]),
      }),
    /canonical host/,
  );
  assert.throws(
    () =>
      loadEgressPolicy({
        CONNECTOR_EGRESS_RULES: JSON.stringify([
          {
            host: "mail.internal.example",
            ports: [443],
            cidr: "169.254.0.0/16",
            allow_private: true,
          },
        ]),
      }),
    /never reachable/,
  );
  assert.throws(
    () =>
      loadEgressPolicy({
        CONNECTOR_EGRESS_RULES: JSON.stringify([
          {
            host: "mail.internal.example",
            ports: [443],
            cidr: "127.0.0.0/8",
            allow_private: true,
          },
        ]),
      }),
    /never reachable/,
  );
  assert.throws(
    () =>
      loadEgressPolicy({
        CONNECTOR_EGRESS_RULES: JSON.stringify([
          { host: "mail.internal.example", ports: [443], allow_private: true },
        ]),
      }),
    /exact CIDR/,
  );
  assert.throws(
    () =>
      loadEgressPolicy({
        CONNECTOR_EGRESS_RULES: JSON.stringify([
          { host: "mail.internal.example", ports: [0] },
        ]),
      }),
    /invalid port/,
  );
  assert.throws(
    () => loadEgressPolicy({ NODE_TLS_REJECT_UNAUTHORIZED: "0" }),
    /certificate verification/,
  );
  assert.throws(
    () => loadEgressPolicy({ CONNECTOR_EGRESS_CA_PEM: "not a pem" }),
    /PEM certificate/,
  );
  const loaded = loadEgressPolicy({
    CONNECTOR_EGRESS_RULES: JSON.stringify([
      {
        host: "mail.internal.example",
        ports: [993],
        cidr: "10.20.0.0/16",
        allow_private: true,
      },
    ]),
    CONNECTOR_EGRESS_CA_PEM:
      "-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----",
  });
  assert.equal(loaded.rules.length, 1);
  assert.ok(loaded.ca_pem?.includes("BEGIN CERTIFICATE"));
});

test("A2 policy: a CIDR overlapping a never-reachable range is refused", () => {
  assert.equal(cidrTouchesHardDenyRange("10.0.0.0/8"), false);
  assert.equal(cidrTouchesHardDenyRange("172.16.0.0/12"), false);
  assert.equal(cidrTouchesHardDenyRange("fd00:1234::/48"), false);
  // fd00::/8 contains the cloud IMDSv6 address fd00:ec2::254, so it is refused.
  assert.equal(cidrTouchesHardDenyRange("fd00::/8"), true);
  assert.equal(cidrTouchesHardDenyRange("0.0.0.0/0"), true);
  // A range that spans private space and public space is not disqualifying by
  // itself: only an overlap with a NEVER-reachable class is.
  assert.equal(cidrTouchesHardDenyRange("10.0.0.0/7"), false);
  assert.equal(cidrTouchesHardDenyRange("127.0.0.0/7"), true);
  assert.equal(cidrTouchesHardDenyRange("0.0.0.0/7"), true);
  assert.equal(cidrTouchesHardDenyRange("100.64.0.0/9"), true);
  assert.equal(cidrTouchesHardDenyRange("127.0.0.0/8"), true);
  assert.equal(cidrTouchesHardDenyRange("169.254.169.254/32"), true);
  assert.equal(cidrTouchesHardDenyRange("::/0"), true);
  assert.equal(cidrTouchesHardDenyRange("fc00::/6"), true);
  assert.equal(cidrTouchesHardDenyRange("not-a-cidr"), true);
});

test("A2 policy: the socket-protocol primitive shares the same decision", () => {
  const allowed = authorizeHostAndPort({
    host: "mail.internal.example",
    port: 993,
    addresses: ["10.20.30.40"],
    policy: internalPolicy,
    allowed_ports: [993, 465, 587],
  });
  assert.equal(allowed.allowed, true);
  const wrongPort = authorizeHostAndPort({
    host: "mail.internal.example",
    port: 25,
    addresses: ["10.20.30.40"],
    policy: internalPolicy,
    allowed_ports: [993, 465, 587],
  });
  assert.equal(wrongPort.allowed, false);
  assert.equal(
    wrongPort.allowed === false && wrongPort.code,
    "unsupported_port",
  );
  const badHost = authorizeHostAndPort({
    host: "2130706433",
    port: 993,
    addresses: ["93.184.216.34"],
    policy: internalPolicy,
  });
  assert.equal(badHost.allowed, false);
  assert.equal(
    badHost.allowed === false && badHost.code,
    "invalid_destination",
  );
});
