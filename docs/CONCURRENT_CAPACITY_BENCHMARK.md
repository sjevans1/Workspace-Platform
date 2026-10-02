# W08e — reproducible 10k-record, 25-principal workload

**Status:** Native single-process concurrency qualification candidate; not accepted until exact-head full CI and results are inspected. [W08 capacity Issue #80](https://github.com/sjevans1/Workspace-Platform/issues/80) and [master roadmap #62](https://github.com/sjevans1/Workspace-Platform/issues/62). W08a–d are already accepted independently, including PR #81's 25-principal/200-record native test and live-refresh browser journey.

## Reproducible CI fixture

`tests/integration.test.ts` inserts **10,000 records** in one tenant using native PostgreSQL, with **5,000 wildcard-denied rows**; 25 independently authenticated member sessions each inherit live database access, while 12 have an additional personal row denial. A saved table view sorts by numeric `score DESC`, then `name ASC`, with deliberate numeric ties and null values. These authenticated sessions issue 25 parallel first-page reads and 25 parallel continuations through the encrypted W08c keyset API. The test checks no hidden metadata, no duplicates for unchanged records, and that a second tenant cannot read the table.

The same workload validates ten concurrent relation-candidate searches, two caller-specific JSON exports of 5,000/4,999 readable records, and five safe optimistic-record updates. All operations run with current tenant RLS; the cursor never grants access independently of the session.

## Evidence and limitations

The test emits a machine-parseable `W08_10K_CONCURRENT_BENCH` line reporting fixture preparation, workload elapsed, page p50/p95/p99 latency, Node process CPU user/system usage, before/after Node resident memory, and PostgreSQL pool maximum, allocated, idle, and one observed waiting-queue sample. It sets a **provisional** 60-second CI workload gate to detect serious regressions, not a production response-time SLO.

Interpret carefully: 25 concurrent *Fastify in-process HTTP requests* represent an application-level concurrency smoke/load fixture. They do **not** model 25 separate web browsers, network latency, disk I/O contention, multiple containers or concurrent collaboration/WebSockets. The Node RSS excludes PostgreSQL and worker process memory; a single pool-waiting sample is not a peak. The CI host is not a production reference server.

## Conditions before publishing a supported host envelope

- Run the same reproducible scenario on a named reference server, recording CPU/memory/disk, PostgreSQL version, `pg_stat_activity`, query plan and connection/lock distribution, app/worker/collaboration process RSS, and p95 under 10 and 25 real network clients.
- Include user edits, cursor refresh following reordering, ACL revoke during navigation, moderate concurrent uploads, AV scans, backup and background workers.
- Define published maximum concurrent users, supported database record counts, memory/disk minimums and operational alerting only from that tested host, not extrapolated from this CI fixture.
- Keep the explicitly documented **live read-committed pagination** policy: cross-page record moves may duplicate/omit until user refresh; every page reauthorizes, and deletion/revocation always fails closed.
- Require exact-head native test/build, deployed Chromium browser, accessibility (Chromium + Firefox), ClamAV/Trivy/SBOM and trusted HTTPS/WSS before merging this candidate.

Workspace remains a standalone self-hosted product, with no mandatory OpenJM Enterprise AI services, models, credentials, databases or cross-repo dependencies.
