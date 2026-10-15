# Governed provider egress (W29-P0/A2)

Every real Connected Work adapter reaches a provider through the boundary described
here. Nothing else is supported: an adapter that opens its own socket, resolves its
own hostname or disables certificate verification is outside the contract, and the
code review and acceptance for this package treat that as a defect.

The implementation is `packages/connectors/egress-policy.ts` (the destination
policy evaluator) and `packages/connectors/egress-transport.ts` (the HTTPS client
and the reusable TCP/TLS primitives for future IMAP/SMTP clients). Both are
exported from `packages/connectors/index.ts`.

## The rule in one paragraph

A destination is refused unless the operator policy permits it, and a permitted
destination is dialled by ADDRESS, never by re-resolving the hostname. The
hostname is retained only for the HTTP `Host` header, TLS SNI and certificate
identity. Redirects are never followed, TLS verification can never be turned off,
and every failure is a normalized category whose summary contains no URL, no
credential, no token and no exception text.

## Always denied

These can never be reached, whatever is configured:

- loopback (`127.0.0.0/8`, `::1`);
- link-local (`169.254.0.0/16`, `fe80::/10`) and every cloud instance-metadata
  address (`169.254.169.254`, `100.100.100.200`, `192.0.0.192`, `fd00:ec2::254`);
- carrier-grade/shared space (`100.64.0.0/10`);
- multicast (`224.0.0.0/4`, `ff00::/8`), unspecified (`0.0.0.0/8`, `::`) and the
  limited broadcast address;
- benchmark and documentation ranges (`198.18.0.0/15`, `2001:2::/48`,
  `192.0.2.0/24`, `198.51.100.0/24`, `203.0.113.0/24`, `2001:db8::/32`);
- reserved and transition ranges (`240.0.0.0/4`, `192.0.0.0/24`, `192.88.99.0/24`,
  `2002::/16`, `64:ff9b::/96`, `100::/64`).

IPv4-mapped and IPv4-embedded IPv6 addresses are classified by the IPv4 address
they carry, so `::ffff:127.0.0.1` and `::ffff:169.254.169.254` are refused too.

## Private destinations need an explicit operator rule

Private (RFC1918) and IPv6 unique-local (RFC4193) destinations are denied by
default. An operator may approve a specific internal mail or calendar server:

```bash
CONNECTOR_EGRESS_RULES='[
  {"host":"mail.internal.example","ports":[443,993,465,587],"cidr":"10.20.0.0/16","allow_private":true}
]'
```

A rule is deliberately narrow:

- `host` is an exact canonical hostname (no wildcards; punycode; lowercase);
- `ports` lists every permitted port explicitly;
- `cidr` must contain every resolved address of that host, and it must not overlap
  a never-reachable range (a rule covering `127.0.0.0/8`, `169.254.0.0/16` or all
  of `fd00::/8` is refused at load, because `fd00::/8` contains the cloud IMDSv6
  address);
- `allow_private: true` is required, and the same rule cannot be used to reach a
  different host, port or range.

Host AND port AND CIDR must all match, and every answer of a resolution must fall
inside the CIDR: a hostname that answers with one in-range and one out-of-range
address is refused.

Malformed policy fails closed at startup with a bounded, non-secret message
instead of degrading to a permissive default. `NODE_TLS_REJECT_UNAUTHORIZED=0` is
refused outright.

### TLS trust for internal servers

An internal server usually has a private CA. Provide the CA bundle explicitly:

```bash
CONNECTOR_EGRESS_CA_PEM="$(cat /etc/openjm/internal-ca.pem)"
```

That CA is additional trust material for the boundary; it never relaxes hostname
verification, and there is no per-request or per-tenant way to bypass either.

## Public destinations

Public destinations are permitted once their addresses are validated. An operator
who wants to pin provider traffic to known endpoints can:

```bash
CONNECTOR_EGRESS_PUBLIC_RULES='[{"host":"api.provider.example","ports":[443]}]'
```

When that list is non-empty, only those host and port pairs are reachable, so a
tenant cannot redirect provider traffic to an arbitrary public host.

## What the transport enforces

| Control                      | Value                                                                                                                          |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| Scheme                       | `https` only for the HTTP client; sockets use the same policy primitives                                                       |
| TLS                          | verification always on, `minVersion` TLS 1.2, hostname identity from the URL                                                   |
| Redirects                    | never followed (`max_redirects` 0); a 3xx is recorded as metadata                                                              |
| Proxy                        | none: ambient `HTTP_PROXY`/`HTTPS_PROXY` are ignored                                                                           |
| Connect / TLS / read / total | 5 s / 8 s / 15 s / 30 s, each overridable per request within bounds                                                            |
| Request body                 | 256 KiB                                                                                                                        |
| Response body                | 1 MiB, aborted when exceeded                                                                                                   |
| Response headers             | 32 KiB, and only an allowlist (`content-type`, `content-length`, `retry-after`, `x-ratelimit-*`, `date`, `server`) is recorded |
| Pooling                      | none: a fresh validated dial per request, no keep-alive reuse                                                                  |
| Error surface                | normalized code + fixed summary + honest `delivery_state`                                                                      |

`delivery_state` is `not_sent` ONLY when the runtime can prove nothing left the
process: a policy refusal, a DNS failure, a failed connect, a failed TLS handshake
or an oversized request. Every failure after the request may have been written is
`unknown`, which is what preserves the durable external-effect lifecycle's honest
`outcome_unknown` semantics.

## Diagnostics and policy administration

Policy is deployment/operator configuration. There is no tenant-facing toggle for
private-network reach and no tenant-facing way to disable TLS verification; a
customer administrator is told that operator approval is required instead.

The read-only operator surface and the client-administrator endpoint-readiness
journey both evaluate destinations through this same module, so a diagnostic
answer and a real connection attempt can never disagree. See
`docs/CONNECTED_WORK_UX.md` for the role journeys and the API contract.

### The three surfaces

| Surface                   | Route                                          | Authorization                                                                       | Scope                     | Contact                 |
| ------------------------- | ---------------------------------------------- | ----------------------------------------------------------------------------------- | ------------------------- | ----------------------- |
| Client endpoint readiness | `POST /api/v1/connectors/endpoints/preflight`  | owner/admin, re-read live inside a short tenant transaction; human session; CSRF; 30/min per client | the deployment that will connect | none: DNS + policy only |
| Operator posture          | `GET /egress` (fleet API)                      | operator bearer token, read budget                                                  | **Fleet-local**           | none                    |
| Operator diagnostic       | `GET /egress/diagnostic?host&port` (fleet API) | operator bearer token, read budget, audited as `egress.diagnostic`                  | **Fleet-local**           | none                    |

Every answer declares its scope (`deployment` or `fleet_local`) and carries the note
that explains it. The Fleet service evaluates its own configuration and resolver, so
its answers are a reference for operators and NOT a statement about any customer
deployment: a Ready answer there does not prove a customer deployment would permit
the destination. A trusted per-deployment policy-identity channel is a separately
gated requirement before real-provider activation and is not implemented here.

Preflight holds no tenant transaction across network work: the route opens none, the
handler re-reads the caller's live membership and role inside a short tenant
transaction, releases it, and only then resolves. Resolution and the whole check are
bounded, and in the transport one shared deadline covers DNS, TCP, TLS and HTTP, so a
late DNS answer is never used to dial.

The use case is part of the contract: it selects the ports the check may consider
(IMAP 993, SMTP 465/587, HTTPS 443) and the guidance the answer carries.

The console page (`GET /egress` on the fleet console) renders the posture and
carries the diagnostic as an ordinary GET form, so the console still ships no
client-side script.

Preflight answers with one canonical vocabulary (`ready`, `blocked_by_operator_policy`,
`private_requires_approval`, `dns_not_safe`, `dns_failure`, `invalid_destination`,
`unsupported_scheme`, `unsupported_port`, `tls_issue`, `unreachable`), a summary, a
grounded next action, the policy fingerprint, and the class of the resolved address.
It never returns a raw address, a URL path, the policy body or the CA material: a
redacted destination is scheme, host and port only, because provider paths routinely
carry bearer tokens, reset keys or opaque identifiers with no query string at all. `tls_issue` and
`unreachable` are only ever reported by a real connection test through the governed
transport; preflight never contacts the endpoint, so a blocked destination is not
probed to produce its denial and the check cannot be used as a port scanner. The
port vocabulary is fixed (`443`, `993`, `465`, `587`), so an arbitrary port cannot be
probed either.

Operator rules are **prefix-aligned**: a rule CIDR must be written at its network
boundary (`10.0.0.0/24`, not `10.0.0.5/24`), and a non-aligned CIDR is refused at load
with the correct form named. The matching arithmetic masks to the network boundary as
well, so even a value that bypassed validation can never widen a rule past the prefix
the operator wrote. TLS identity is always the canonical approved host: there is no
caller-supplied SNI override, because a caller-chosen name could verify a certificate
for a destination the policy never approved.

Both planes must be given the same deployment egress configuration
(`CONNECTOR_EGRESS_*`). The policy is loaded once per process and a malformed policy
throws rather than degrading to a permissive default, so a misconfigured deployment
fails loudly. The posture exposes a policy **fingerprint** (a 24-character digest of
the effective rules, the public pinning state and the presence of an internal trust
chain) so two deployments or two releases can be compared without disclosing the
policy body.
