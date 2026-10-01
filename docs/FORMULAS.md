# W06 — Safe, deterministic numeric Formula properties

**Implementation status:** Candidate under review. Do not treat this feature as released until W06's exact final-head native PostgreSQL and deployed CI gates pass and the PR is merged. Tracker: [#62](https://github.com/sjevans1/Workspace-Platform/issues/62).

## User behavior

In a database's **Properties & columns** dialog, add a property of type `formula`, name it and enter a numeric expression. The result appears as a read-only value in the table, board and record page. Existing numeric record edits recompute the result on the next read. JSON and CSV database exports use freshly computed values; client writes to a formula field are rejected.

The only accepted syntax is:

- Finite numeric constants such as `3`, `0.25`, `1e3`.
- Other **Number** properties in this same record, referenced by stable property ID in brackets: `[unit_cost]` and `[quantity]`.
- Arithmetic operators `+`, `-`, `*`, `/`, unary signs and parentheses.

Example: `[unit_cost] * [quantity] + 2.5`

## Deliberate security and accuracy boundaries

Expressions are compiled by a bounded handwritten tokenizer and parser — **no eval, JavaScript, SQL, HTTP, plugin call, shell, LLM or arbitrary execution**. Maximum expression length: 240 characters; maximum 64 tokens; maximum nesting depth 12; maximum absolute numeric result `1e12`. Missing or null operands, division by zero, overflow or nonfinite results evaluate to `null` (displayed as an em dash). Results are not persisted as independent user-editable values.

A formula may reference only non-formula Number properties. No dependencies on Person, Relation, Text, formula-to-formula values, cross-record fields or other tenants; therefore no recursive formula cycles. Reject schema updates with missing/unsafe references. Formula filters and sorting are explicitly unavailable until a permission-safe computed query contract is delivered (W08). W07 covers relation Rollups separately.

No changes or dependencies to `OpenJM-Enterprise-AI`. Workspace remains independently installable, including disconnected/local storage configurations.

## Acceptance

Native PostgreSQL suite should verify formula parse/compute, read-only submissions, recomputation after revisioned record updates, CSV/JSON exports, schema rollback, null/division/overflow behavior, and hostile expression rejection. Deployed browser acceptance should configure and persist a formula from the UI, then show a recalculated value after source field updates. All normal release gates (S3-compatible recovery, local encryption, ClamAV, SBOM/Trivy, Chromium/Firefox, trusted TLS/WSS) remain mandatory.
