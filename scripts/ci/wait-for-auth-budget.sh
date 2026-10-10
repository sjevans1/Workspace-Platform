#!/usr/bin/env bash
# CI helper: wait for the general API rate-limit budget to recover.
#
# The API keeps its production rate limiting enabled and unchanged. Chromium,
# Firefox, WebKit and the preceding deployed-browser workflows share Caddy's
# inbound IP in CI.
#
# THIS HELPER MUST NEVER PROBE SIGN-IN AVAILABILITY BY SUBMITTING CREDENTIALS.
# The sign-in route keeps its own strict production budget (10 attempts /
# 5 minutes per network). Any request to it - valid or invalid - consumes one of
# those attempts, so a probe can spend the final remaining attempt and cause the
# legitimate qualification login to be rejected with 429. That is what happened
# in CI run 38038208838: the invalid probe returned 401, the helper declared the
# budget available, and the real W24-R login was then 429.
#
# Non-mutating alternatives were investigated before choosing this design:
#   A. The limiter exposes no introspection endpoint, and its x-ratelimit-*
#      headers are emitted only on responses FROM the limited route itself, so
#      observing the sign-in budget would require issuing the very request this
#      helper must avoid. Reading the Redis store's private key layout would
#      couple CI to another service's internal storage format.
#   B. There is no prior 429 available at this point, so there is no
#      server-directed reset boundary to wait on.
#   C. Chosen. The qualification's own legitimate login is the only sign-in
#      request; it honors a 429 with the server-directed Retry-After before a
#      bounded single retry (see the shared readiness contract in the spec).
#
# So this helper performs only the non-mutating general budget check, which also
# confirms the API is serving. It does not raise a limit, bypass authentication,
# or disable rate limiting.
#
# Usage: scripts/ci/wait-for-auth-budget.sh [base-url]
set -euo pipefail

BASE_URL="${1:-${E2E_BASE_URL:-http://localhost:8080}}"

# General API budget: read from real response headers on a read-only route.
GENERAL_MIN_REMAINING="${AUTH_BUDGET_MIN_REMAINING:-240}"
GENERAL_ATTEMPTS="${AUTH_BUDGET_GENERAL_ATTEMPTS:-24}"
GENERAL_INTERVAL="${AUTH_BUDGET_GENERAL_INTERVAL:-5}"

remaining=""
for attempt in $(seq 1 "$GENERAL_ATTEMPTS"); do
  headers="$(curl -sS -D - -o /dev/null "$BASE_URL/api/v1/auth/methods")"
  remaining="$(printf '%s\n' "$headers" | awk 'tolower($1)=="x-ratelimit-remaining:" { gsub("\r","",$2); print $2; exit }')"
  if [[ "$remaining" =~ ^[0-9]+$ ]] && [ "$remaining" -ge "$GENERAL_MIN_REMAINING" ]; then
    break
  fi
  sleep "$GENERAL_INTERVAL"
done
if ! { [[ "$remaining" =~ ^[0-9]+$ ]] && [ "$remaining" -ge "$GENERAL_MIN_REMAINING" ]; }; then
  echo "Shared test rate-limit window did not recover" >&2
  exit 1
fi
echo "Rate-limit budget available for browser acceptance: $remaining"
echo "Sign-in budget left untouched: no credential probe is issued."
