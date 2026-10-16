#!/usr/bin/env bash
# Headless two-browser E2E of the real call flow (CALL-01, CALL-04) against a local duet with the REAL
# Cloudflare TURN key and two fixture accounts.
# Usage: bash scripts/smoke-calls.sh [scenario ...]   (no arguments runs every scenario)
#   SKIP_BUILD=1 reuses web/out; SMOKE_PORT changes the port (default 3196); CHROME names another
#   Chrome/Chromium binary.
# The TURN vars are read here and handed to the server process only; they are never printed.
# The server rings for 10 s instead of 45 s (CALL_RING_TIMEOUT_MS) so the no-answer scenario is quick, and
# allows 100 invites a minute instead of 10 (CALL_INVITE_LIMIT): a full run starts more calls than that.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

PORT="${SMOKE_PORT:-3196}"
BASE="http://127.0.0.1:${PORT}"

turn_id=""
turn_tok=""
if [ -f "$ROOT/.env" ]; then
  turn_id="$(sed -n 's/^CF_TURN_KEY_ID=//p' "$ROOT/.env" | tail -n 1 | tr -d '[:space:]"'"'")"
  turn_tok="$(sed -n 's/^CF_TURN_KEY_API_TOKEN=//p' "$ROOT/.env" | tail -n 1 | tr -d '[:space:]"'"'")"
fi
if [ -z "$turn_id" ] || [ -z "$turn_tok" ]; then
  echo "smoke-calls: no TURN key: run deploy/cloudflare/turn-key.sh" >&2
  exit 1
fi

chrome="${CHROME:-/usr/bin/google-chrome}"
[ -x "$chrome" ] || { echo "smoke-calls: Chrome not found at $chrome (set CHROME)" >&2; exit 1; }

if [ "${SKIP_BUILD:-}" != "1" ]; then
  NEXT_EXPORT=1 npm --prefix web run build >/dev/null
fi
[ -f web/out/index.html ] || { echo "smoke-calls: web/out/index.html missing (build first)" >&2; exit 1; }

tmp="$(mktemp -d)"
server_pid=""
cleanup() {
  if [ -n "$server_pid" ] && kill -0 "$server_pid" 2>/dev/null; then
    kill "$server_pid" 2>/dev/null || true
    wait "$server_pid" 2>/dev/null || true
  fi
  rm -rf "$tmp"
}
trap cleanup EXIT

# Two throwaway test accounts with 20-character test passwords (never real credentials).
printf '%s' '[{"username":"smoke-ada","displayName":"Ada Smoke","password":"smoke-test-pass-0001"},{"username":"smoke-bob","displayName":"Bob Smoke","password":"smoke-test-pass-0002"}]' \
  | DATA_DIR="$tmp" npm --prefix server run --silent seed -- --stdin >/dev/null

(
  cd server
  export CF_TURN_KEY_ID="$turn_id" CF_TURN_KEY_API_TOKEN="$turn_tok"
  exec env -u TURN_CREDENTIAL_TTL_SECONDS \
    DATA_DIR="$tmp" PORT="$PORT" HOST=127.0.0.1 NODE_ENV=production \
    APP_ORIGIN="$BASE" COOKIE_SECURE=false LOG_LEVEL=warn CALL_RING_TIMEOUT_MS=10000 CALL_INVITE_LIMIT=100 \
    node --import tsx src/index.ts
) >"$tmp/server.log" 2>&1 &
server_pid=$!
unset turn_tok

ready=""
for _ in $(seq 1 40); do
  if curl -fsS "${BASE}/healthz" >/dev/null 2>&1; then ready=1; break; fi
  if ! kill -0 "$server_pid" 2>/dev/null; then echo "smoke-calls: server exited early" >&2; tail -n 20 "$tmp/server.log" >&2; exit 1; fi
  sleep 0.5
done
[ -n "$ready" ] || { echo "smoke-calls: /healthz not ready after 20 s" >&2; exit 1; }

if ! CHROME="$chrome" node scripts/smoke-calls.mjs "$BASE" "$@"; then
  echo "smoke-calls: server log tail:" >&2
  tail -n 30 "$tmp/server.log" >&2
  exit 1
fi

echo "smoke-calls ok"
