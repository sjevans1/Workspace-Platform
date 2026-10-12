# W27 — Security, privacy and commercial distribution acceptance

Status: prepared for independent review on `feature/w27-final-security-release-gate`.
This record is evidence-oriented. Where a control is not yet verified it says so rather than
implying coverage, and no external review is claimed that has not happened.

## 1. Scope

W27 closes the release-readiness gaps in security, privacy and distribution around the
already accepted product. It does not rebuild W01–W26 functionality, does not touch W29/W30,
and does not reopen accepted cryptography or transport contracts. Already accepted and
deliberately unchanged: CI-H1 GHCR mirroring and digest pinning, constant-time operator-token
comparison, OCP-1B signed telemetry and replay control, AES-256-GCM credential sealing with
credential-bound AAD, bounded replay retention, serialized terminal deployment revocation,
issuance locking, Workspace/OCP independence, and the fleet-web HTTPS/public-origin/Secure
cookie controls.

## 2. Threat boundaries

| Boundary | Trust position | Principal controls |
| --- | --- | --- |
| browser → Workspace edge | untrusted network to trusted edge | TLS terminated at Caddy, session cookies, request budgets, CSP, tenant-scoped authorization with RLS |
| browser → fleet-web console | untrusted network to an OpenJM-controlled plane | production requires an HTTPS public origin, loopback-only listener bind, bounded HttpOnly `Secure` session, sign-in budgets |
| fleet-web → fleet API | OpenJM server to OpenJM server | server-side operator bearer only, strict URL validation, HTTPS required off-loopback |
| Workspace → fleet telemetry receiver | customer deployment to OpenJM plane | per-deployment credential, envelope version, credential binding, timestamp window, digest, HMAC signature, canonical payload validation, replay rejection |
| database / storage | trusted process to stateful stores | parameterised queries, FORCE RLS for tenant tables, encryption at rest for credentials, scoped roles |
| webhooks / external integrations | trusted process to untrusted destinations | allowlisted origins, redirect suppression, no credential forwarding |
| backup / restore | trusted operator to copied state | verification before any freshness claim, restore drill in the deployment tier |
| image / supply chain | upstream registry to release | CI-H1 mirror manifest, immutable digest pinning, SBOM plus fail-closed scanning per image |

Principal threat classes and where they are answered: tenant crossing (RLS and tenant-scoped
authorization tests), authorization bypass (route-level authorization tests, adversarial
negatives), credential replay (replay state unique on nonce and signature), fleet credential
abuse (per-deployment credentials plus budgets), telemetry forgery and replay (signature,
binding, digest, replay), hostile file upload (type/size limits plus antivirus), webhook SSRF
(allowlist, redirect suppression), session fixation (server-side session issue and rotation),
migration race (advisory lock), secrets exposure (allowlist telemetry, no-secret responses,
scanned responses in tests), supply-chain compromise (mirroring plus SBOM and scanning), and
backup or key loss (documented procedures in section 6).

Repository-owned adversarial testing is not an external penetration test, and this record
does not claim one.

## 3. Security evidence

Proven by implementation and tests in this branch:

- **B1 migration race.** The fleet migration runner serializes on a fixed PostgreSQL advisory
  lock held across the whole apply loop, reads the ledger only after acquiring it, and
  releases it on both success and failure. Two runners against one database apply a pending
  migration exactly once and the waiter observes it already applied; a failing migration
  rejects, leaves the ledger unadvanced, and does not strand the lock (proved by a subsequent
  successful run and by acquiring the lock directly afterwards).
- **B2 abuse control.** Bounded budgets cover operator authentication failures (strict per
  client plus a generous global bucket so one hostile client cannot starve legitimate
  operators), operator reads, lifecycle mutations, telemetry ingestion and console sign-in.
  Tests show failed authentication closing the budget, another client unaffected, ingestion
  volume bounded, a hostile envelope still rejected by verification rather than by the
  limiter, no credential material in a limited response, and exact per-window semantics with
  recovery at the limiter level. Client attribution uses the socket peer by default and an
  explicitly named trusted header only when configured, normalised through the repository's
  existing network-identity primitive so IPv6 churn cannot evade a budget.
- **B3 audit retention.** Configurable, clamped retention with a bounded oldest-first pruning
  batch; tests cover removal only before the cutoff, retention at and after it, batch bounds
  with convergence, configuration clamping, and a forced pruning failure leaving committed
  lifecycle state and its audit intact.
- **B5 rotate versus terminal revocation.** Rotation locks the parent deployment before the
  credential, matching issuance. A deterministic race shows that when terminal revocation
  wins the lock, a concurrent rotation returns `deployment_revoked` with no new secret
  material written and the original secret unusable; normal rotation and concurrent issuance
  both complete, so no lock-order deadlock was introduced.

Already accepted and referenced rather than re-proved here: tenancy and RLS, sessions and
authorization, upload and antivirus handling, webhook SSRF controls, OCP-1B signature and
replay, fleet lifecycle state and audit, and TLS/Secure-cookie/WSS acceptance.

Proven by release CI, but only when the deployment tier runs: the per-image SBOMs and
fail-closed scans for the Workspace image, ClamAV and now PostgreSQL, Caddy, Valkey and
SeaweedFS. Those steps are committed and their evidence will be produced under the FULL
qualification that follows independent approval; this record does not claim them as verified
yet.

## 4. Privacy and retention reconciliation

| Data | Retention | Boundary |
| --- | --- | --- |
| Operator telemetry | least data only, bounded 16 KiB payload, allowlist plus prohibition scan; no customer content | `docs/OCP1A_OPERATOR_TELEMETRY.md` |
| Telemetry transport and replay state | bounded replay retention, deterministic pruning | `docs/OCP1B_TELEMETRY_TRANSPORT.md` |
| Support evidence bundle | explicit bounded authorization, 32 KiB ceiling, metadata-only retention | `docs/OCP1C_SUPPORT_EVIDENCE.md` |
| Fleet audit | bounded reads plus W27 configurable retention (default 90 days, clamped) with bounded pruning | this record, B3 |
| Backups | verification required before any freshness claim; restore drill is a release gate | `docs/RELEASE_SECURITY.md` |
| Workspace tenant data | unchanged by W27 | accepted product documentation |

No normal OCP operation requires page or document contents, attachment contents, Workspace
credentials, access/refresh/logout tokens, cookies or session secrets. Telemetry is
allowlisted by construction and the receiver additionally re-validates strictly; support
bundles are assembled from an allowlist with a prohibition scan. Where a Workspace tenant
retention figure is not stated in this repository, it is deliberately not invented here and
remains a host-specific review item.

## 5. Secrets and key operations

- **Workspace `ENCRYPTION_KEY`.** Required at startup, never logged or returned, and no
  diagnostic path prints it. Rotation is an operator change window, not a rolling operation.
- **Fleet encryption key.** Seals each deployment credential secret with AES-256-GCM under an
  AAD bound to the credential id. **Rotation decision (B4): can the key be rotated safely
  today without making active credentials unreadable? No, not in place, and the smallest safe
  contract is controlled credential re-provisioning** rather than a re-encryption subsystem:
  revoke every active deployment credential first (revocation is terminal per deployment and
  immediately blocks ingestion), confirm no credential remains active, change
  `FLEET_ENCRYPTION_KEY`, then issue fresh credentials. This is safe because an active
  credential is the only path that decrypts a stored secret, so after revocation no live flow
  depends on the old key, no plaintext is ever dumped, and rotation replaces secret material
  by re-sealing rather than by decrypting it. Inert rows sealed under the old key remain
  revoked and unusable. Backups of the credential table before the change, the ordering
  above, and a rollback that restores the previous key only while the previous key still
  matches the active credentials must all be observed; the old key is retired once every
  active credential was issued under the new one.
- **Deployment telemetry credential.** Per deployment, delivered once at issuance or
  rotation, never readable afterwards, never audited in value, and revoked independently.
- **Operator credential and console session.** Shared bootstrap credential for 1.0, verified
  server-side only; the console issues its own signed bounded HttpOnly session that contains
  no fleet credential.
- **Backup recovery.** Restore must preserve the encryption keys in use, otherwise sealed
  credential material and tenant attachments are unrecoverable; this is an operator
  requirement, not a code path.

## 6. Distribution and legal inventory

| Artefact | Position |
| --- | --- |
| `LICENSE` | OpenJM proprietary terms; original application code is not licensed for redistribution |
| `THIRD_PARTY_LICENSES.md` | generated inventory of third-party packages and licences |
| `docs/licenses/**` | retained licence texts referenced by the inventory |
| BlockNote (MPL-2.0) | only Core, React, Mantine and server utilities are used; no `@blocknote/xl` package is installed or imported; files are unmodified and wrapped; notices must ship with distributed bundles and an internal copy of the corresponding source archives should be kept |
| ClamAV (GPL) | consumed as an unmodified image for scanning; obligations attach to redistribution of that component |
| PostgreSQL, Valkey, Caddy, SeaweedFS | consumed as unmodified upstream images with their own notices and licence terms |
| Node and base images | unmodified runtime bases pinned through the CI-H1 manifest; base-image notices travel with the images |

No legal counsel review is claimed. Open external question, requiring a business/legal
decision rather than engineering: whether and how distribution of the proprietary
application together with GPL and MPL components will be packaged and accompanied by the
corresponding source and notices for a commercial release. This is recorded as an external
release decision.

## 7. Repository hygiene

Checked on this branch: no committed production credentials, no real `.env` (only
`.env.example`), no private key material, no customer screenshots or content, no raw database
backups or dumps. Names such as `011_webhook_secret_rotation.sql` and `scripts/backup.ts` are
migration and tooling sources, not secret values. History was not rewritten as part of W27,
and no destructive repository history operation is part of this package.

## 8. Standalone behaviour

Workspace remains functional with the fleet control plane absent, telemetry disabled,
outbound connectivity unavailable, and a deployment disconnected. No OpenJM service is a
Workspace runtime dependency; the accepted isolation proof stands unchanged and is referenced
rather than re-implemented.

## 9. Explicit 1.0 decisions

**Individual fleet operator identity — accepted as a 1.0 limitation.** The initial operator
plane is OpenJM-controlled and reached only through an HTTPS origin in front of a
loopback-bound console, with a bounded HttpOnly session, sign-in abuse budgets, operator audit
and restricted administrative access. A strong shared bootstrap credential is acceptable for
that topology, and per-operator identity, RBAC and SSO are therefore deferred rather than
built. This must be revisited before the operator plane is exposed to more than a small
trusted operator group or to any party outside OpenJM.

**Fleet console sessions — accepted as a 1.0 limitation.** Sessions are signed, bounded and
`HttpOnly`, cannot be forged or extended beyond their TTL, and logout clears the cookie. They
are stateless, so a stolen cookie cannot be revoked individually before it expires, and the
only global invalidation lever is rotating the bootstrap credential or the session secret.
That is accepted for the restricted 1.0 topology, with a bounded TTL as the blast-radius
control; a session store is not built merely because it would be theoretically stronger.

## 10. Remaining limitations and external items

- Phase A scan and SBOM evidence is produced only by the deployment tier and is therefore
  pending FULL qualification after independent approval.
- Valkey is not yet in the CI-H1 mirror manifest, so its gate binds to the exact Compose
  reference by tag rather than by an immutable, manifest-provenanced digest.
- No cryptographic image signing, attestation, or admission policy is in place.
- No external penetration test has been performed; repository-owned adversarial testing is
  not equivalent to one.
- Per-operator fleet identity and server-side console session revocation remain deferred.
- Distribution packaging of GPL and MPL components, and the corresponding-source obligation
  for a commercial release, require an external business/legal decision.
- Workspace tenant retention figures that are not stated in this repository must be confirmed
  per deployment; this record does not invent them.
