# OCP-1 source enrichment: operational source semantics

Release-operations package for Workspace #198. It replaces honestly-unknown OCP-1A
telemetry fields with real local operational data where a trustworthy source exists,
and documents exactly what each value means so OCP-2 can interpret them correctly.
It does not change the accepted `openjm.workspace.operator-telemetry.v1` wire
format, it adds no new field or version, and it does not raise the 16384-byte
payload ceiling.

## Source matrix

`field | authoritative source | populated? | exact meaning | unknown conditions`

`signals.queue.depth` | `public.workspace_queue_depth()` | yes | deployment-wide
sum of pending + retry + dead entries across `webhook_deliveries` and
`object_deletions` | `null` when the helper call fails (source unavailable).

`signals.queue.state` | `public.workspace_queue_depth()` | yes | factual observation
in the accepted vocabulary: `healthy` means no pending, retryable or dead work
exists; `degraded` means such work exists; `unknown` when the source is unavailable |
`unknown` when the helper call fails.

`signals.capacity.storage` | `fs.statfs` on the configured local storage root | only
for `STORAGE_PROVIDER=local` | filesystem utilisation percentage of the filesystem
backing the Workspace storage root, a bounded 0..100 scalar | `null` for S3/R2 or any
non-local backend, when the root is unreadable, or when totals are zero/invalid.

`signals.capacity.database` | none | deliberately **no** | always `null`. The only
cheap portable local signal is application connection-pool pressure, which is not
database capacity; publishing it under a capacity-named field would misrepresent it
to an OCP-2 consumer. This is an accepted, intentional limitation. |

`readiness.last_backup_at` | `verifyBackup()` on the newest verifiable archive | yes
when configured and verified | the `created_at` of the most recent archive in the
configured backup directory that passes the existing integrity verification | `null`
when the directory is unset, unreadable, empty, or no candidate verifies.

`readiness.backup_state` | `verifyBackup()` | yes | adapter vocabulary `verified`,
`failed`, `never_verified`, `unknown`, mapped into the accepted wire field whose
vocabulary is `healthy`/`degraded`/`unhealthy`/`unknown` | `unknown` when the
directory is unset or unreadable; `never_verified` becomes `unknown` on the wire.

## Queue enrichment and why the helper is required

`webhook_deliveries` and `object_deletions` are `FORCE ROW LEVEL SECURITY` with a
`tenant_isolation` policy. A tenant-less direct aggregate therefore sees no rows and
would report a false zero for a deployment with real backlog, which is worse than an
honest unknown. `public.workspace_queue_depth()` is a count-only `SECURITY DEFINER`
helper that crosses tenant boundaries solely to produce three integers.

Security posture, as verified: owner `postgres` (`rolsuper`, `rolbypassrls`); no
arguments, so it cannot be parameterized into a general cross-tenant query; fixed
`search_path`; no dynamic SQL; schema-qualified tables; `REVOKE ALL ... FROM PUBLIC`;
`GRANT EXECUTE ... TO workspace_app`. The runtime role reaches it only through
inherited membership in `workspace_app` (`pg_auth_members`:
`workspace_runtime -> workspace_app`), and it remains `rolsuper = false` and
`rolbypassrls = false`. Direct tenant-less reads by that role return zero rows, and
RLS remains enabled and forced on both tables. Nothing was weakened.

## Semantics that are deliberately factual

- Queue `degraded` means **queue work exists**. It is not an SLA breach, an outage
  indicator or a severity judgment. The factual magnitude is carried by `depth`.
- No numerical backlog threshold exists anywhere, because the product has no agreed
  threshold to encode.
- No backup freshness or staleness SLA is asserted. Where a timestamp is present it
  is factual; no unhealthy status is derived from age.
- Runtime backup verification (integrity of the newest archive) is distinct from the
  W23 isolated restore drill, which remains CI/release evidence and is not
  represented as current runtime state.

## Bounded backup discovery

Discovery is metadata-first and explicitly bounded: the directory listing is capped,
candidates are ordered newest-first by modification time, and at most
`BACKUP_CANDIDATE_LIMIT` (currently 5) of them are opened for verification. Contents
are read only when the verification path requires them. Filename, modification time,
directory existence and partial archives can never establish success; only a
`verifyBackup()` success can populate `last_backup_at`. There is no scheduler and no
recursive or unbounded scan.

## Fail-soft behaviour

Each adapter fails independently to `unknown` or its documented equivalent: queue
helper error, database or source error, `statfs` error, backup directory error,
malformed archive, and verification failure. Composition still succeeds and
serializes, and no enrichment source is a dependency of API requests, `/health`,
`/ready`, worker product jobs or OCP-1B transport beyond the affected field becoming
unknown.

## Performance evidence, recorded as measured

Representative dataset: 20 000 `object_deletions` plus 5 000 `webhook_deliveries`.
Observed plan: `Aggregate -> Append -> HashAggregate` over two **sequential scans**
with `Filter: status = ANY ('{pending,retry,dead}')`. Execution **~8.5 ms**,
planning 1.24 ms, 365 shared buffers. The query is **not index-backed** at this size,
which is the correct choice for this volume, and cost presently scales with total
table size including historical rows. This is acceptable at the tested scale; no new
index is justified by current evidence. Re-measure when historical queue volume
becomes materially larger, and only then consider a partial index on the live
statuses, which would change no claim semantics.

## Privacy treatment

Only bounded counts, percentages, timestamps and enums enter telemetry. No tenant,
user, resource, document or object identifiers, no queue row ids, no URLs, no
payloads, no filenames or filesystem paths, no bucket names, no database
identifiers, no connection strings and no raw errors. The enriched payload is
regression-tested against the hostile OCP-1A fixture and stays within the 16384-byte
ceiling.
