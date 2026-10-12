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

