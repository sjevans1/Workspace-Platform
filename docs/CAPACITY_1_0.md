# Workspace 1.0 whole-stack capacity

**CI-host qualification evidence only. This is not a universal production SLO.**

This document reports whole-stack capacity measured on a GitHub-hosted runner
against a production-like Docker Compose deployment. It complements
`docs/BUILD_CHECKPOINT.md`, which records the collaboration-only W24-R
reconnection measurements. Every number below comes from one captured artifact:

- `capacity-results/w24-reference-host.json` (uploaded with the deployed
  acceptance job as part of `browser-results`)
- captured `2026-10-08T17:59:47.195Z`
- produced by `e2e/w24-capacity.spec.ts` on the deployed stack, not on a
  workstation

## Scope

Wave R qualified collaboration reconnection only. This qualification extends
that to the wider system: the API request path for representative operations,
container resource use, PostgreSQL connection and lock state, and worker and
queue backlog, at 1, 5, 10 and 25 concurrent authenticated sessions.

It is one runner class on one day. Treat it as a bounded statement about the
tested configurations, not as a guarantee for any other hardware, dataset,
tenant count or network condition.

## Host

| Property | Measured |
| --- | --- |
| Platform | linux |
| Architecture | x64 |
| Kernel | 6.17.0-1022-azure |
| CPU count | 4 |
| CPU model | INTEL(R) XEON(R) PLATINUM 8573C |
| Total memory | 16,765,370,368 bytes (about 15.6 GiB) |
| Runtime | Node.js v24.21.0 |

The API, collaboration, worker, PostgreSQL, ClamAV and Valkey containers share
this host, together with Caddy and the Playwright driver.

## Workload

| Property | Value |
| --- | --- |
| Concurrency levels | 1, 5, 10, 25 sessions |
| Iterations per session | 2 |
| Operations per iteration | 8 |
| Operations measured | resource list, recent resources, resource detail, page content, search, permissions check, page export (`format=markdown`), resource title update |
| Dataset shape | one freshly created space with one page per concurrent session |
| Transport | local Docker network through the deployment entry point |

Each session authenticates as the same principal and issues the eight
operations in sequence, repeating twice. Every session patch-updates only the
page it created, so no two sessions contend on the same row.

Two deliberate properties of the workload, both relevant when reading the
throughput figures:

1. **The production rate limiter is unchanged.** The deployment allows 300
   requests per minute per authenticated principal, and all sessions in this
   harness share one principal. The harness therefore paces itself to 240
   requests per minute. It recorded **zero rate-limited (429) responses at every
   level**, so the pacing held and no measured request was rejected.
2. **Latency excludes the pacing wait.** `latencyMs` in the artifact times only
   the request itself. The wait imposed by the pacing rule is reported
   separately as `pacingQueueMs`, because it is a property of the harness, not
   of the system under test. `elapsedSeconds` and `throughputPerSecond` do
   include it.

## Latency

Server-side latency in milliseconds, measured over the local deployment
network. `max` is the maximum observed for that operation.

### 1 concurrent session

| Operation | n | p50 | p95 | p99 | max |
| --- | --- | --- | --- | --- | --- |
| list | 2 | 5.0 | 6.5 | 6.5 | 6.5 |
| recent | 2 | 37.9 | 39.4 | 39.4 | 39.4 |
| detail | 2 | 6.2 | 7.3 | 7.3 | 7.3 |
| content | 2 | 5.9 | 27.6 | 27.6 | 27.6 |
| search | 2 | 7.1 | 12.3 | 12.3 | 12.3 |
| permissions | 2 | 5.3 | 6.3 | 6.3 | 6.3 |
| export | 2 | 5.8 | 8.8 | 8.8 | 8.8 |
| update | 2 | 7.2 | 7.4 | 7.4 | 7.4 |

### 5 concurrent sessions

| Operation | n | p50 | p95 | p99 | max |
| --- | --- | --- | --- | --- | --- |
| list | 10 | 12.1 | 20.0 | 20.0 | 20.0 |
| recent | 10 | 93.3 | 136.6 | 136.6 | 136.6 |
| detail | 10 | 12.5 | 21.1 | 21.1 | 21.1 |
| content | 10 | 12.2 | 42.5 | 42.5 | 42.5 |
| search | 10 | 23.0 | 30.6 | 30.6 | 30.6 |
| permissions | 10 | 13.6 | 27.0 | 27.0 | 27.0 |
| export | 10 | 11.5 | 33.6 | 33.6 | 33.6 |
| update | 10 | 15.6 | 23.4 | 23.4 | 23.4 |

### 10 concurrent sessions

| Operation | n | p50 | p95 | p99 | max |
| --- | --- | --- | --- | --- | --- |
| list | 20 | 22.0 | 31.0 | 31.3 | 31.3 |
| recent | 20 | 171.3 | 188.6 | 188.8 | 188.8 |
| detail | 20 | 21.3 | 38.0 | 40.5 | 40.5 |
| content | 20 | 18.2 | 34.8 | 42.2 | 42.2 |
| search | 20 | 37.5 | 72.6 | 96.0 | 96.0 |
| permissions | 20 | 17.6 | 25.9 | 29.2 | 29.2 |
| export | 20 | 17.8 | 27.8 | 38.5 | 38.5 |
| update | 20 | 28.9 | 37.7 | 69.7 | 69.7 |

### 25 concurrent sessions

| Operation | n | p50 | p95 | p99 | max |
| --- | --- | --- | --- | --- | --- |
| list | 50 | 55.8 | 121.1 | 144.5 | 144.5 |
| recent | 50 | 279.9 | 465.5 | 479.6 | 479.6 |
| detail | 50 | 81.2 | 188.2 | 232.6 | 232.6 |
| content | 50 | 68.4 | 130.1 | 136.4 | 136.4 |
| search | 50 | 118.7 | 206.7 | 257.3 | 257.3 |
| permissions | 50 | 18.6 | 81.0 | 96.5 | 96.5 |
| export | 50 | 16.5 | 64.3 | 78.3 | 78.3 |
| update | 50 | 13.7 | 112.9 | 150.4 | 150.4 |

Observed behaviour: every operation stayed below 0.5 seconds at every tested
level, and the worst single measurement in the whole run was 479.6 ms
(`recent` at 25 sessions). Latency grew with concurrency but without a cliff.
`recent` was consistently the heaviest read, and `permissions` and `export`
were the lightest.

## Throughput

Measured operations per second for the paced workload, computed from the
measured elapsed time for each level:

| Concurrency | Operations | Elapsed | Ops/sec | Rate-limited |
| --- | --- | --- | --- | --- |
| 1 | 16 | 0.2 s | 75.01 | 0 |
| 5 | 80 | 0.5 s | 166.56 | 0 |
| 10 | 160 | 35.8 s | 4.47 | 0 |
| 25 | 400 | 71.7 s | 5.58 | 0 |

These figures are **not** a throughput ceiling of the system. The 10 and 25
session levels exceed the paced budget of 240 requests per minute, so their
elapsed time is dominated by the harness pacing rule rather than by server
capacity, and the levels share one rolling budget in sequence. The
`pacingQueueMs` values in the artifact show this directly: at 25 sessions the
pacing queue reached 36 to 47 seconds while the corresponding request latency
stayed at 13 to 480 ms. No throughput number is extrapolated.

## Resource use

Container CPU percentage and resident memory in MiB, sampled at the baseline and
at peak during each level. Level 25 is shown because it is the highest tested
concurrency; the lower levels are in the artifact.

| Container | Baseline CPU | Baseline RSS | Peak CPU | Peak RSS |
| --- | --- | --- | --- | --- |
| api | 0.0 % | 292.7 MiB | 0.0 % | 293.0 MiB |
| collab | 0.0 % | 116.9 MiB | 0.0 % | 115.9 MiB |
| worker | 0.2 % | 127.0 MiB | 8.8 % | 126.0 MiB |
| postgres | 0.3 % | 42.3 MiB | 0.2 % | 47.6 MiB |
| clamav | 0.0 % | 1006.0 MiB | 0.0 % | 1006.0 MiB |
| valkey | 0.1 % | 10.0 MiB | 0.1 % | 10.0 MiB |

Memory was stable across levels: the API moved from 284.9 MiB at the 1-session
baseline to 293.0 MiB at the 25-session peak, and no container showed growth
that would suggest a leak over the run. CPU stayed low because the paced request
rate is far below what the host can serve.

ClamAV accounts for about 1006 MiB of steady resident memory and is the largest
single consumer, which matters for single-host sizing. The malware scan path is
also exercised by the deployed acceptance job separately, including the EICAR
detection check and the antivirus scan counters.

## PostgreSQL

Sampled at baseline and peak per level. Level 25:

| Metric | Baseline | Peak |
| --- | --- | --- |
| Connections | 3 | 4 |
| Active | 1 | 1 |
| Waiting | 2 | 3 |
| Locks | 5 | 5 |
| Non-granted locks | 0 | 0 |
| Lock waits | 0 | 0 |
| Deadlocks | 0 | 0 |
| Rollbacks (server lifetime) | 33 | 33 |
| max_connections | 100 | 100 |

The same values were observed at 1, 5 and 10 sessions, with connections
between 3 and 4. The result worth stating plainly: at every tested level
there were **zero non-granted locks, zero lock waits and zero deadlocks**, and
PostgreSQL used at most 4 of its 100 connections. The workload did not create
lock pressure.

`xact_rollback` is a cumulative counter reported since the PostgreSQL server
started and did not change across the levels, so it is not a measurement of
this workload's failures.

## Backlog

Worker, webhook and cleanup queues, sampled before and after each level:

| Queue | 1 | 5 | 10 | 25 |
| --- | --- | --- | --- | --- |
| jobs pending / running / failed / cancelled / dead | 0 | 0 | 0 | 0 |
| webhook deliveries pending / dead | 0 | 0 | 0 | 0 |
| event outbox pending | 1 then 0 | 0 | 0 | 0 |
| object deletions pending | 0 | 0 | 0 | 0 |

The only visible movement was a single pending outbox event that was dispatched
during the first level. That confirms the worker and dispatcher were alive and
draining, rather than merely reporting empty queues.

## Supported envelope

Derived only from the evidence above. The tested envelope is the ceiling of what
this document claims.

| Category | Evidence |
| --- | --- |
| Small or evaluation deployment | Validated. 1 and 5 concurrent sessions completed with sub-150 ms latencies and negligible resource movement on a 4 vCPU host. |
| Normal single-host deployment | Validated at up to 25 concurrent authenticated sessions for the tested read and light-write operations, with p95 at or below 466 ms across all operations, API RSS stable at about 293 MiB, PostgreSQL at 4 of 100 connections and no lock waits. |
| Tested upper envelope | 25 concurrent sessions on a 4 vCPU, 15.6 GiB runner. Beyond that, untested. |

What this does not establish: the tested envelope is bounded by the harness's
own pacing rule, so it does not state the request rate the host could actually
sustain if the limiter allowed it. The dataset is small, so nothing here speaks
to performance on a 10,000-record workspace, and nothing here speaks to multiple
tenants competing on one host.

Do not publish a hardware sizing matrix from these numbers. The measurement
records one runner class; a sizing recommendation needs a repeatable host with
controlled hardware.

## Limitations

- **CI-host variability.** These are GitHub-hosted runner measurements. Runner
  hardware, neighbours and scheduling vary between runs.
- **One principal, paced.** All sessions share a single authenticated principal
  and its shared read budget, so the harness paces to 240 requests per minute.
  Throughput figures reflect that rule, not server capacity.
- **Local network only.** All traffic crossed the local Docker network. This is
  not a WAN or real-client benchmark, and no TLS/ACME proxy path was measured.
- **Short run.** Each level lasted under 75 seconds in total. This is not a
  soak test and says nothing about multi-hour behaviour, connection churn or
  long-term memory growth.
- **Small dataset.** One page per session in one space. Large-table pagination,
  sorting and export scale are covered by separate W08 native scale work, not
  by this run.
- **Single tenant.** One tenant, one principal. No multi-tenant contention was
  measured.
- **Not a production SLO.** No universal performance guarantee should be
  inferred from this document.

## Reproducing

The qualification runs only in the deployed acceptance job, not in a local
`npm test` run:

```bash
E2E_BASE_URL=http://localhost:8080 E2E_W24_WHOLE_STACK=1 \
  npx playwright test e2e/w24-capacity.spec.ts
```

It requires the deployed Compose stack, the shared sign-in budget to have been
replenished, and the same environment variables the other deployed acceptance
steps use. It writes `capacity-results/w24-reference-host.json`.

## W09e durable database export

**CI-host qualification evidence only, captured from the native backend job. This is not a universal production SLO.**

The W24 evidence above is unchanged. This section adds the W09e durable export
measurement. It is produced by the native PostgreSQL integration suite
(`tests/integration.test.ts`, test `W09e durable database export is bounded,
permission-safe and cancellable`), which runs under the restricted
`workspace_runtime` role. The export source is a deterministic 10,001-row
database (10,000 bulk rows plus one anchor). The worker reads rows in fixed
keyset batches, so the measurement covers the bounded path rather than the
synchronous 10,000-row export.

The backend job prints one line prefixed `W09E_EXPORT_BENCH` with the captured
figures. Values from the accepted exact head are recorded below.

| Property | Measured |
| --- | --- |
| Rows exported | 10,001 |
| Batch size | 500 |
| CSV batches | 21 |
| CSV artifact bytes | 286,720 |
| JSON artifact bytes | 786,755 |
| CSV export duration | to be captured from the accepted run |
| Peak worker RSS | to be captured from the accepted run |
| PostgreSQL connections before | to be captured from the accepted run |
| PostgreSQL connections after | to be captured from the accepted run |
| PostgreSQL locks observed | to be captured from the accepted run |

### Scope and limitations

- **Native backend, not the deployed stack.** The figures come from the native
  integration suite, not from `docker compose`, so they measure the worker and
  PostgreSQL path rather than the containerised deployment.
- **Peak RSS is the worker process.** The worker runs in-process with the test
  harness, so its RSS includes the harness. Treat it as an upper bound.
- **One shape of dataset.** A single wide-free schema (title, number, text) is
  measured; nothing here speaks to many-column tables or relation-heavy rows.
- **No throughput claim.** One run on one host is a bounded statement, not a
  commitment to a requests-per-second or rows-per-second figure.

### Reproducing

The qualification runs only under a native PostgreSQL test database, not on the
default embedded PGlite path:

```bash
TEST_DATABASE_URL=postgres://postgres:***@127.0.0.1:5432/workspace \
  node --import tsx --test --test-concurrency=1 --test-timeout=120000 \
  --test-name-pattern W09e tests/integration.test.ts
```

It logs the `W09E_EXPORT_BENCH` line and writes no artifact; the deployed
browser journey is covered separately by `e2e/workspace.spec.ts`.
