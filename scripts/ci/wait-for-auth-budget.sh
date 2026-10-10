#!/usr/bin/env bash
# CI helper: wait for the server-directed auth/rate-limit budget to recover.
#
# The API keeps its production rate limiting enabled and unchanged. Chromium,
# Firefox, WebKit and the preceding deployed-browser workflows share Caddy's
# inbound IP in CI, so the sign-in route's strict production budget (10 attempts
# / 5 minutes per network) can be exhausted before a qualification step that
# needs a fresh authenticated session. This helper adapts CI sequencing to that
# limiter: it waits only for the interval the server itself directs, within
# bounded attempts, and fails closed.
#
# It never raises a limit, bypasses authentication, or disables rate limiting.
#
# Usage: scripts/ci/wait-for-auth-budget.sh [base-url]
set -euo pipefail

BASE_URL="${1:-${E2E_BASE_URL:-http://localhost:8080}}"

# General API budget: read from real response headers.
GENERAL_MIN_REMAINING="${AUTH_BUDGET_MIN_REMAINING:-240}"
GENERAL_ATTEMPTS="${AUTH_BUDGET_GENERAL_ATTEMPTS:-24}"
GENERAL_INTERVAL="${AUTH_BUDGET_GENERAL_INTERVAL:-5}"

# Sign-in probe: honor the server's own retry directive, bounded.
SIGNIN_ATTEMPTS="${AUTH_BUDGET_SIGNIN_ATTEMPTS:-12}"
MAX_WAIT="${AUTH_BUDGET_MAX_WAIT:-60}"
FALLBACK_WAIT="${AUTH_BUDGET_FALLBACK_WAIT:-10}"

probe_headers="/tmp/auth-budget-probe.headers"
probe_body="/tmp/auth-budget-probe.json"

# 1. General API rate-limit budget from real response headers.
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

# 2. Probe the real sign-in endpoint. The sign-in route keeps its own strict
#    production budget which the shared IP can exhaust during preceding browser
#    workflows; wait for the server's own retry hint instead of weakening or
#    bypassing that limiter.
for attempt in $(seq 1 "$SIGNIN_ATTEMPTS"); do
  code="$(curl -sS -o "$probe_body" -D "$probe_headers" -w '%{http_code}' \
    -X POST -H 'Content-Type: application/json' \
    -d '{"email":"rate-limit-probe@example.test","password":"probe-not-a-real-credential"}' \
    "$BASE_URL/api/v1/auth/login")"
  if [ "$code" != "429" ]; then
    echo "Sign-in rate-limit budget available (status $code)"
    exit 0
  fi
  wait="$(awk 'tolower($1)=="retry-after:"{gsub("\r","",$2); print $2; exit}' "$probe_headers")"
  if ! [[ "$wait" =~ ^[0-9]+$ ]]; then
    wait="$(sed -n 's/.*retry in \([0-9][0-9]*\) second.*/\1/p' "$probe_body" | head -1)"
  fi
  [[ "$wait" =~ ^[0-9]+$ ]] || wait="$FALLBACK_WAIT"
  if [ "$wait" -gt "$MAX_WAIT" ]; then
    echo "Server-directed retry interval ${wait}s exceeds the bounded maximum ${MAX_WAIT}s" >&2
    exit 1
  fi
  echo "Sign-in limited; waiting ${wait}s before retry $attempt"
  sleep "$((wait + 2))"
done
echo "Sign-in rate-limit window did not recover" >&2
exit 1
