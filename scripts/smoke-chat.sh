#!/usr/bin/env bash
# Headless two-browser chat e2e against a local duet with two fixture accounts (CHAT-01..05).
# Usage: bash scripts/smoke-chat.sh [scenario ...]   (no arguments runs every scenario)
#   SKIP_BUILD=1 reuses web/out; SMOKE_PORT changes the port (default 3197); CHROME names another
#   Chrome/Chromium binary; SMOKE_SCRIPT runs another scenario file against the same server.
# The scenario script gets the base URL as its first argument and SMOKE_TMP (the server's data dir).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

PORT="${SMOKE_PORT:-3197}"
BASE="http://127.0.0.1:${PORT}"

chrome="${CHROME:-/usr/bin/google-chrome}"
[ -x "$chrome" ] || { echo "smoke-chat: Chrome not found at $chrome (set CHROME)" >&2; exit 1; }

if [ "${SKIP_BUILD:-}" != "1" ]; then
  NEXT_EXPORT=1 npm --prefix web run build >/dev/null
fi
[ -f web/out/index.html ] || { echo "smoke-chat: web/out/index.html missing (build first)" >&2; exit 1; }

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
  exec env -u CF_TURN_KEY_ID -u CF_TURN_KEY_API_TOKEN \
    DATA_DIR="$tmp" PORT="$PORT" HOST=127.0.0.1 NODE_ENV=production \
    APP_ORIGIN="$BASE" COOKIE_SECURE=false LOG_LEVEL=warn REMINDER_TICK_MS="${REMINDER_TICK_MS:-1000}" \
    node --import tsx src/index.ts
) >"$tmp/server.log" 2>&1 &
server_pid=$!

ready=""
for _ in $(seq 1 40); do
  if curl -fsS "${BASE}/healthz" >/dev/null 2>&1; then ready=1; break; fi
  if ! kill -0 "$server_pid" 2>/dev/null; then echo "smoke-chat: server exited early" >&2; tail -n 20 "$tmp/server.log" >&2; exit 1; fi
  sleep 0.5
done
[ -n "$ready" ] || { echo "smoke-chat: /healthz not ready after 20 s" >&2; exit 1; }

export SMOKE_TMP="$tmp"
CHROME="$chrome" node "${SMOKE_SCRIPT:-scripts/smoke-chat.mjs}" "$BASE" "$@"

echo "smoke-chat ok"
