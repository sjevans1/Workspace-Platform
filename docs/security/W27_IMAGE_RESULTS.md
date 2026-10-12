# W27 image-security results (local qualification, same policy as the CI gate)

Policy: `--severity HIGH,CRITICAL --ignore-unfixed --vuln-type os,library`, identical to the accepted release gate.

| Image | Fixable HIGH/CRITICAL | Component(s) carrying them | Severity split |
| --- | --- | --- | --- |
| postgres | 25 | gosu | {'CRITICAL': 1, 'HIGH': 24} |
| caddy | 21 | caddy | {'HIGH': 21} |
| valkey | 0 | none | none |
| seaweedfs | 5 | weed | {'HIGH': 5} |

## Reading

- PostgreSQL's entire fixable set is attributable to the single bundled `gosu` 1.19 binary, adjudicated not-affected by binary reachability (see `docs/security/vex-gosu-postgres-17.11-bookworm.json`).
- Caddy's fixable set is in `usr/bin/caddy`, which is the running TLS terminator binary. Reachability there is NOT assumed and no VEX disposition exists for it; per the accepted decision it requires its own component identification and reachability evaluation, and it remains blocking until then.
- SeaweedFS's fixable set is in `usr/bin/weed` (acceptance infrastructure). Same rule: separately evaluated, no automatic reuse of the gosu disposition.
- Valkey is clean under the blocking policy.
- Workspace and ClamAV passed their blocking scans in FULL 38250970609.

Raw Trivy JSON and tables for every image are retained as CI evidence under the run artefacts; they are not duplicated into the repository because CI regenerates them per run.

## Reachability adjudication (binary mode, govulncheck)

Adjudication was attempted separately for each component; none of the gosu evidence was reused.

| Component | Binary sha256 (prefix) | Reachable findings | Outcome |
| --- | --- | --- | --- |
| `gosu` 1.19 (PostgreSQL) | `52c8749d0142edd2` | **0** (3 import-level, 54 module-level, none called) | adjudicated `not_affected` by the bounded VEX record |
| `usr/bin/caddy` v2.11.4 (Caddy) | `b7105518e3ed1c07` | **4** reachable (GO-2026-6629, GO-2026-6617, GO-2026-6613, GO-2026-6612) | **REMAINS BLOCKING** |
| `usr/bin/weed` (SeaweedFS) | `dc7f0bd80235fa27` | **3** reachable (GO-2026-6617, GO-2026-6613, GO-2026-6612) | **REMAINS BLOCKING** |

The distinction is exactly the one the release policy is meant to draw: `gosu` is an anonymous
setuid helper whose affected code is never executed on any path reachable from it, while Caddy is
the running TLS terminator and SeaweedFS is the running object-storage service, and both have
vulnerable code that reachability analysis proves is actually executed.

Consequences, stated plainly:

- The PostgreSQL gosu disposition stands on its own evidence and does not extend to Caddy or
  SeaweedFS. No VEX rule was broadened.
- The expanded W27 gate has surfaced a genuine release blocker for the Caddy image (21 fixable
  HIGH, 4 of them reachable) and for the SeaweedFS image (5 fixable HIGH, 3 reachable).
- Clearing either requires refreshed upstream images whose embedded Go component carries the
  fixes, promoted through the existing reviewed CI-H1 manifest process. That is an image-refresh
  decision, not a code or VEX decision, and it is not mine to take unilaterally.
- Until then the aggregate blocking policy must fail the release, which is the correct behaviour.
