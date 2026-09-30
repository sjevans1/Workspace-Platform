# First independent WSL host acceptance — completed except TLS

Final Hermes report received 30 September 2026. This is **Hermes-reported host evidence** from the user's WSL2 workstation, not a second reproduction by the primary engineering environment.

- Tested application commit: `b392f4113099788816250b3ee7e3a1d9573f1d9d`.
- Host: Ubuntu 24.04 / WSL2, kernel 6.6.87.2-microsoft-standard-WSL2.
- Docker 29.1.3, Compose v2.40.3, Node v22.23.2, npm 10.9.8.
- Reported host capacity: 1007 GiB disk with ~3% used; 15 GiB RAM with ~2.5 GiB used.
- Source Compose project: `openjm_workspace_source`.
- Recovery Compose project: `openjm_workspace_recovery`.
- Source and recovery volumes were reported separate.
- Recovery used distinct host ports 8081/8444.
- Source logical backup was reported at approximately 50 KiB. Backup contents and credentials must remain private and must never be committed to this public repository.

## Hermes-reported phase outcomes

| Phase | Outcome |
|---|---|
| Host evidence | PASS |
| Fresh local deployment | PASS; migration succeeded, API/collaboration/worker healthy, `/ready` 200, Caddy serving |
| Deployed browser acceptance | PASS; 2/2 Playwright workflows |
| Service restart persistence | PASS; source content survived Compose restart |
| TLS/LAN | NOT EXECUTED; no trusted TLS environment available |
| Host migration integrity | PASS; migrations ran twice, second run idempotent, checksums present |
| Source backup | PASS; archive created and source remained healthy |
| Separate recovery | PASS; backup restored into isolated recovery project/volumes/ports; recovered sign-in and content verified |
| Operational monitoring | PASS; operations status showed no failed jobs or dead queues; worker/services healthy |

## Recovery incident and resolution

The first recovery attempt failed before restore because the recovery Caddy service attempted to use the same host HTTP port as the still-running source deployment. The follow-up used distinct recovery host ports (8081/8444) and completed the restore successfully.

This is classified as a deployment-configuration issue rather than an application restore defect. The runbook now requires explicit recovery port/APP_URL isolation, a different Compose project name, and restore-before-full-stack startup.

## What this independently establishes

For the tested WSL2 host and tested application commit, Hermes reported successful:

- fresh Docker Compose installation;
- service health/readiness;
- two-browser collaboration acceptance;
- persistence through Compose restart;
- repeated/idempotent migration execution with checksums;
- logical backup creation;
- restore into a separate Compose project with separate volumes and ports;
- recovered application sign-in/content verification;
- operational queue/health inspection with no dead work observed.

The source deployment was reported to remain healthy through the exercise.

## Remaining host-level gap

Trusted TLS/LAN acceptance was not executed. A future customer-like host test should validate real trusted HTTPS, secure cookies, same-origin API/WSS behavior and certificate lifecycle without disabling certificate verification.

The successful WSL recovery does not replace:
- a production-selected S3/object-store recovery drill;
- external metrics/alerting validation;
- encryption-at-rest integration;
- release image scanning;
- identity/SSO lifecycle testing;
- load/reconnect fault-injection and multi-browser/accessibility coverage.
