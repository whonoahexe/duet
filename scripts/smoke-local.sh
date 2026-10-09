#!/usr/bin/env bash
# Walking-skeleton smoke test: static export -> one Fastify process -> SQLite, plus the seed write path.
# Usage: bash scripts/smoke-local.sh          (SKIP_BUILD=1 to reuse an existing web/out; SMOKE_PORT to change the port)
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

PORT="${SMOKE_PORT:-3199}"
BASE="http://127.0.0.1:${PORT}"

if [ "${SKIP_BUILD:-}" != "1" ]; then
  NEXT_EXPORT=1 npm --prefix web run build
fi

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
  DATA_DIR="$tmp" PORT="$PORT" HOST=127.0.0.1 NODE_ENV=production \
    APP_ORIGIN="http://127.0.0.1:${PORT}" COOKIE_SECURE=false LOG_LEVEL=warn \
    exec node --import tsx src/index.ts
) &
server_pid=$!

ready=""
for _ in $(seq 1 40); do
  if curl -fsS "${BASE}/healthz" >/dev/null 2>&1; then ready=1; break; fi
  if ! kill -0 "$server_pid" 2>/dev/null; then echo "smoke-local: server exited early" >&2; exit 1; fi
  sleep 0.5
done
[ -n "$ready" ] || { echo "smoke-local: /healthz not ready after 20 s" >&2; exit 1; }

users_json="$(curl -fsS "${BASE}/api/users")"
echo "$users_json" | jq -e '
  (.users | length == 2)
  and (.users | map(.displayName) | index("Ada Smoke") != null)
  and ([.. | objects | keys[] | select(test("password"; "i"))] | length == 0)
' >/dev/null || { echo "smoke-local: unexpected /api/users payload" >&2; exit 1; }

# Login round-trip through the real server process: tile id + password -> cookie -> /api/me.
ada_id="$(echo "$users_json" | jq -r '.users[] | select(.username == "smoke-ada") | .id')"
[ -n "$ada_id" ] || { echo "smoke-local: smoke-ada missing from /api/users" >&2; exit 1; }
jar="$tmp/cookies.txt"
login_status="$(curl -sS -o "$tmp/login.json" -w '%{http_code}' -c "$jar" \
  -H "Origin: ${BASE}" -H 'Content-Type: application/json' \
  --data "$(jq -cn --arg id "$ada_id" '{userId: $id, password: "smoke-test-pass-0001"}')" \
  "${BASE}/api/login")"
[ "$login_status" = "200" ] || { echo "smoke-local: POST /api/login returned $login_status" >&2; exit 1; }
grep -q 'duet_session' "$jar" || { echo "smoke-local: login set no duet_session cookie" >&2; exit 1; }
me_json="$(curl -fsS -b "$jar" "${BASE}/api/me")" || { echo "smoke-local: GET /api/me failed" >&2; exit 1; }
echo "$me_json" | jq -e '.user.displayName == "Ada Smoke" and .peer.displayName == "Bob Smoke"' >/dev/null \
  || { echo "smoke-local: unexpected /api/me payload" >&2; exit 1; }

status="$(curl -sS -o "$tmp/index.html" -w '%{http_code}' "${BASE}/")"
[ "$status" = "200" ] || { echo "smoke-local: GET / returned $status" >&2; exit 1; }
grep -Eq '<html[^>]*class="[^"]*\bdark\b' "$tmp/index.html" \
  || { echo "smoke-local: html element is not dark" >&2; exit 1; }

echo "smoke-local ok"
