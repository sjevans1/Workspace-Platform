# W08d — live cursor consistency and multiuser capacity

**Status: candidate, unaccepted.** W08a/W08b/W08c have passed their exact-head native and deployed release gates. W08 remains unchecked until its capacity and concurrency acceptance is complete. Parent [Issue #68](https://github.com/sjevans1/Workspace-Platform/issues/68), gate [Issue #80](https://github.com/sjevans1/Workspace-Platform/issues/80), roadmap [Issue #62](https://github.com/sjevans1/Workspace-Platform/issues/62).

## Single-node initial consistency contract

Workspace database lists use **live read-committed navigation with a stable last-seen sort key**, not a cross-request snapshot. Sort/filter and parent/tenant ACL are validated on **every** page. The cursor does not preserve old permissions. When any record is revoked, deleted or moved to an inaccessible parent, it must disappear immediately, even if a continuation token was issued earlier. A changed view, membership role or token expiry rejects the cursor rather than falling back to an unauthorized result.

A record moved across the current cursor boundary while someone is browsing can be omitted or repeated between pages. Rather than promising MVCC-like no-duplicate/no-omission on moving datasets, the UI explicitly states “Live results may shift after edits or reordering” and provides **Refresh results** to clear cursor/previous-page history and restart from the first current page (also resetting the legacy sorted fallback). This is a deliberate supported first-release policy, not a hidden failure.

A full point-in-time snapshot would require expiry-scoped materialized key indexes or long-lived snapshot transactions, raising per-user storage and connection costs. Reconsider only with client requirements and a measured storage/latency impact; do not hold database transactions open over browser sessions.

## Initial bounded native concurrency benchmark

The W08d native PostgreSQL acceptance fixture creates 200 ordered records, 100 globally denied rows, and **25 independently authenticated member principals** in one tenant (12 additionally deny the first visible row). It sends 25 parallel first-page requests and 25 parallel continuation requests, verifies permitted IDs, no duplicated unchanged IDs, and captures p50/p95/p99 elapsed timings per request. It then checks a separate tenant is denied, revokes a formerly readable record after cursor issuance, moves a record before the cursor, and confirms that fresh pagination exposes the new order without ever showing revoked rows.

This benchmark measures concurrent *in-process HTTP application requests*, not 25 separate web browsers and not throughput under network latency. It is bounded to protect CI and must not be represented as a general production SLO. The existing 1k/10k native tests remain baseline evidence, not multiuser capacity results. Broader release qualification still requires 1k/10k+ mixed-ACL **concurrent workload**, PostgreSQL query plans, CPU/RAM/memory/connection use, read/edit interference, mobile browser behaviour and a documented supported host envelope.

## Release acceptance

Require green native RLS-backed PostgreSQL, E2E browser refresh/navigation, exact-head complete typecheck/build, local and S3-compatible encrypted recovery, ClamAV EICAR rejection, Trivy/SBOM vulnerability gates, Chromium/Firefox accessibility, and trusted HTTPS/WSS. No shortcuts around tenant ACLs or read-only controls.

Workspace is a fully separate installable product. No OpenJM Enterprise AI services, credentials, data stores, models or repositories are required.
