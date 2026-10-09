#!/usr/bin/env bash
# Headless two-peer call smoke (INFR-04 mechanics) against a local duet with the REAL Cloudflare TURN key.
# Two Chrome contexts log in as two fixture accounts, open /debug/call/ in the same room and must both
# reach PASS: once with normal ICE, once with forced relay (iceTransportPolicy "relay").
# Usage: bash scripts/smoke-call.sh   (SKIP_BUILD=1 reuses web/out; SMOKE_PORT changes the port;
#                                      CHROME names another Chrome/Chromium binary)
# The TURN vars are read here and handed to the server process only; they are never printed.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

PORT="${SMOKE_PORT:-3198}"
BASE="http://127.0.0.1:${PORT}"

turn_id=""
turn_tok=""
if [ -f "$ROOT/.env" ]; then
  turn_id="$(sed -n 's/^CF_TURN_KEY_ID=//p' "$ROOT/.env" | tail -n 1 | tr -d '[:space:]"'"'")"
  turn_tok="$(sed -n 's/^CF_TURN_KEY_API_TOKEN=//p' "$ROOT/.env" | tail -n 1 | tr -d '[:space:]"'"'")"
fi
if [ -z "$turn_id" ] || [ -z "$turn_tok" ]; then
  echo "smoke-call: no TURN key: run deploy/cloudflare/turn-key.sh" >&2
  exit 1
fi

chrome="${CHROME:-/usr/bin/google-chrome}"
[ -x "$chrome" ] || { echo "smoke-call: Chrome not found at $chrome (set CHROME)" >&2; exit 1; }

if [ "${SKIP_BUILD:-}" != "1" ]; then
  NEXT_EXPORT=1 npm --prefix web run build
fi
[ -f web/out/debug/call/index.html ] || { echo "smoke-call: web/out/debug/call/index.html missing (build first)" >&2; exit 1; }

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
  | DATA_DIR="$tmp" npm --prefix server run --silent seed -- --stdin

(
  cd server
  export CF_TURN_KEY_ID="$turn_id" CF_TURN_KEY_API_TOKEN="$turn_tok"
  exec env -u TURN_CREDENTIAL_TTL_SECONDS \
    DATA_DIR="$tmp" PORT="$PORT" HOST=127.0.0.1 NODE_ENV=production \
    APP_ORIGIN="$BASE" COOKIE_SECURE=false LOG_LEVEL=warn \
    node --import tsx src/index.ts
) &
server_pid=$!
unset turn_tok

ready=""
for _ in $(seq 1 40); do
  if curl -fsS "${BASE}/healthz" >/dev/null 2>&1; then ready=1; break; fi
  if ! kill -0 "$server_pid" 2>/dev/null; then echo "smoke-call: server exited early" >&2; exit 1; fi
  sleep 0.5
done
[ -n "$ready" ] || { echo "smoke-call: /healthz not ready after 20 s" >&2; exit 1; }

CHROME="$chrome" node scripts/smoke-call.mjs "$BASE"

echo "smoke-call ok"
