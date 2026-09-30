# First independent WSL host acceptance — partial recovery follow-up

Report received 30 September 2026 from the Hermes real-host test. This is **Hermes-reported evidence**, not a second independently witnessed run or a reproduction of the failure by the primary engineering environment.

- Tested application commit: `b392f4113099788816250b3ee7e3a1d9573f1d9d`.
- Host class: Ubuntu 24.04 / WSL2, 15 GiB available RAM.
- Docker 29.1.3, Compose v2.40.3, Node v22.23.2, npm 10.9.8.
- Docker Compose source project: `openjm_workspace_source`.
- Isolated recovery project: `openjm_workspace_recovery`; separate source/recovery volumes reported.
- Source logical backup: reported created and approximately 50 KiB. Backup must remain private; this public repository must never contain backup contents or source credentials.

## Hermes-reported phase outcomes

| Phase | Outcome |
|---|---|
| Host evidence | PASS |
| Fresh local deployment | PASS; migration, API/collaboration/worker health, /ready and Caddy |
| Deployed browser acceptance | PASS; 2/2 Playwright workflows |
| Service restart persistence | PASS; source content survived Compose restart |
| TLS/LAN | NOT EXECUTED; trusted TLS not available |
| Host migration integrity | PASS; repeated migrations idempotent and checksums present |
| Source backup | PASS; archive created and source recovered health |
| Separate recovery | INCOMPLETE; premature full-stack startup returned exit code 1, no restore or restored-content verification |
| Operational monitoring | PARTIAL; status reachable/worker healthy; log and queue audit incomplete |

## Recovery incident assessment

The reported sequence executed `docker compose up -d` in the recovery project **before** performing the archive restore, while reusing source `.env` defaults. This differs from the documented recovery order (start only PostgreSQL/Valkey, run migrations, restore, then start full stack). The source and recovery Caddy services likely tried to claim the same host port mappings, but the actual root cause has not been established without the nonsecret Docker exit/error output.

This is **not** evidence that the restore algorithm failed: Hermes reported not invoking or completing the restore. Do not label it a failed restore until restore has actually been attempted in an isolated target.

The runbook `docs/HERMES_HOST_ACCEPTANCE.md` was clarified with explicit recovery port/APP_URL preflight and restore-before-full-stack ordering. It recommends a fresh recovery `.env` with new DB credentials and setup token while securely retaining the source encryption key required by the backup.

## Bounded follow-up

1. Do not repeat the already-passing host installation and first-run Playwright tests unless a change requires it.
2. Preserve the source Compose project, source volumes and original backup.
3. Inspect only the recovery project and capture the exact previous container error if available (with secrets redacted).
4. Verify distinct recovery ports, APP_URL, Docker project/volumes and archive file permissions before proceeding.
5. Inspect whether the premature recovery startup created any application rows or stored objects. If the target is no longer empty, do not force restore or remove volumes without confirming they are exclusively disposable recovery resources.
6. Start only recovery postgres/valkey, run migrations, restore the archive, then launch the full recovery stack.
7. Verify login using the restored disposable user, page content/history, attachments, database records and two-user collaboration. Do not rerun first-run setup tests on a restored database.
8. Reverify source remains available and its retained source data unchanged.
9. Complete nonsecret operational log and queue-status checks. Mark TLS/LAN not executed unless a separately trusted test environment is available.

Return PASS/FAIL/NOT EXECUTED by remaining phase, nonsecret command/output evidence, verified source/recovery isolation, and any reproducible application defects. CI passing does not substitute for independent host recovery acceptance.
