#!/usr/bin/env bash
# [BLOCKING] schema-push proof: migrations apply to a LIVE SQLite file through the real boot path.
#
#   bash scripts/check-live-db.sh                 boot the real server twice on a fresh DATA_DIR and inspect the file
#   bash scripts/check-live-db.sh --existing DIR  read-only inspection of DIR/duet.sqlite (e.g. the Docker volume)
#
# Uses python3's sqlite3 module (there is no sqlite3 CLI on this box). Prints "live-db ok" on success.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

MIGRATIONS_DIR="$ROOT/server/drizzle"
expected_migrations="$(find "$MIGRATIONS_DIR" -maxdepth 1 -name '*.sql' | wc -l | tr -d ' ')"

# Prints the __drizzle_migrations row count on success; exits non-zero with a reason otherwise.
inspect() {
  python3 - "$1" "$expected_migrations" <<'PY'
import os, sqlite3, sys, urllib.parse
data_dir, expected = sys.argv[1], int(sys.argv[2])
db_path = os.path.join(data_dir, "duet.sqlite")
def die(msg):
    print(f"check-live-db: {msg}", file=sys.stderr); sys.exit(1)
if not os.path.isfile(db_path):
    die(f"{db_path} does not exist")
if not os.path.isdir(os.path.join(data_dir, "media")):
    die(f"{data_dir}/media does not exist")
uri = "file:" + urllib.parse.quote(os.path.abspath(db_path)) + "?mode=ro"
con = sqlite3.connect(uri, uri=True)
try:
    tables = {r[0] for r in con.execute("SELECT name FROM sqlite_master WHERE type='table'")}
    required = {
        "users", "sessions", "__drizzle_migrations",
        # Phase 2 (migration 0001_chat_media_push, D-07 shape)
        "messages", "attachments", "reactions", "read_state", "push_subscriptions",
    }
    missing = required - tables
    if missing:
        die(f"missing tables: {sorted(missing)}")
    mode = con.execute("PRAGMA journal_mode").fetchone()[0]
    if mode.lower() != "wal":
        die(f"journal_mode is {mode}, expected wal")
    n = con.execute("SELECT count(*) FROM __drizzle_migrations").fetchone()[0]
    if n != expected:
        die(f"__drizzle_migrations has {n} rows, expected {expected} (one per .sql file)")
    print(n)
finally:
    con.close()
PY
}

if [ "${1:-}" = "--existing" ]; then
  dir="${2:-}"
  [ -n "$dir" ] || { echo "usage: $0 --existing DIR" >&2; exit 2; }
  inspect "$dir" >/dev/null
  echo "live-db ok"
  exit 0
fi

PORT="${LIVE_DB_PORT:-3198}"
BASE="http://127.0.0.1:${PORT}"
tmp="$(mktemp -d)"
server_pid=""

stop_server() {
  if [ -n "$server_pid" ] && kill -0 "$server_pid" 2>/dev/null; then
    kill "$server_pid" 2>/dev/null || true
    wait "$server_pid" 2>/dev/null || true
  fi
  server_pid=""
}
cleanup() { stop_server; rm -rf "$tmp"; }
trap cleanup EXIT

start_server() {
  (
    cd server
    DATA_DIR="$tmp" PORT="$PORT" HOST=127.0.0.1 NODE_ENV=production \
      APP_ORIGIN="http://127.0.0.1:${PORT}" COOKIE_SECURE=false LOG_LEVEL=warn \
      exec node --import tsx src/index.ts
  ) &
  server_pid=$!
  for _ in $(seq 1 40); do
    if curl -fsS "${BASE}/healthz" >/dev/null 2>&1; then return 0; fi
    if ! kill -0 "$server_pid" 2>/dev/null; then echo "check-live-db: server exited early" >&2; exit 1; fi
    sleep 0.5
  done
  echo "check-live-db: /healthz not ready after 20 s" >&2
  exit 1
}

start_server
first="$(inspect "$tmp")"
stop_server

start_server
second="$(inspect "$tmp")"
stop_server

if [ "$first" != "$second" ]; then
  echo "check-live-db: migration rows changed across boots ($first -> $second)" >&2
  exit 1
fi

echo "live-db ok"
