#!/usr/bin/env bash
# Restart-persistence proof (INFR-02): committed data in ./data survives `docker compose down/up`.
#
#   bash scripts/smoke-persistence.sh
#   DUET_SEED_FILE=~/.config/duet/seed-users.json bash scripts/smoke-persistence.sh
#        ... additionally logs in before the restart and proves the same session cookie
#            still works afterwards (then logs it out).
#
# Checks: /data/.persist-sentinel unchanged, users == 2 and unchanged, sessions >= before,
# migrations not re-applied (check-live-db.sh --existing ./data). Last line: "persistence ok".
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
die() { echo "smoke-persistence: $*" >&2; exit 1; }

if [ -z "${BASE:-}" ]; then
  BASE="$(sed -n 's/^APP_ORIGIN=//p' "$ROOT/.env" | tail -n 1 | tr -d '[:space:]"'"'")"
fi
[ -n "$BASE" ] || die "no BASE / APP_ORIGIN"
BASE="${BASE%/}"
DATA="$ROOT/data"

umask 077
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

counts() {
  python3 -I - "$DATA/duet.sqlite" <<'PY'
import os, sqlite3, sys, urllib.parse
uri = "file:" + urllib.parse.quote(os.path.abspath(sys.argv[1])) + "?mode=ro"
con = sqlite3.connect(uri, uri=True)
try:
    u = con.execute("SELECT count(*) FROM users").fetchone()[0]
    s = con.execute("SELECT count(*) FROM sessions").fetchone()[0]
    print(u, s)
finally:
    con.close()
PY
}

wait_healthy() {
  for _ in $(seq 1 60); do
    if [ "$(curl -sS -m 5 -o /dev/null -w '%{http_code}' "$BASE/healthz" 2>/dev/null || true)" = "200" ]; then return 0; fi
    sleep 2
  done
  die "$BASE/healthz not 200 within 120 s"
}

wait_healthy

# Optional: hold a real session across the restart.
jar="$tmp/jar"
if [ -n "${DUET_SEED_FILE:-}" ]; then
  username="$(jq -r '.[0].username' "$DUET_SEED_FILE")"
  user_id="$(curl -fsS -m 20 "$BASE/api/users" | jq -r --arg u "$username" '.users[] | select(.username == $u) | .id')"
  [ -n "$user_id" ] || die "the first seed account is not listed by /api/users"
  jq -c --arg id "$user_id" '{userId: $id, password: .[0].password}' "$DUET_SEED_FILE" > "$tmp/login.json"
  st="$(curl -sS -m 20 -o /dev/null -w '%{http_code}' -c "$jar" -H "Origin: $BASE" \
    -H 'Content-Type: application/json' --data-binary @"$tmp/login.json" "$BASE/api/login")"
  rm -f "$tmp/login.json"
  [ "$st" = "200" ] || die "pre-restart login returned $st"
fi

sentinel="$(openssl rand -hex 16)"
printf '%s' "$sentinel" | docker compose exec -T duet sh -c 'cat > /data/.persist-sentinel'
read -r users_before sessions_before < <(counts)
[ "$users_before" = "2" ] || die "expected 2 users before the restart, found $users_before"

docker compose down >/dev/null 2>&1
docker compose up -d >/dev/null 2>&1
wait_healthy

got="$(docker compose exec -T duet cat /data/.persist-sentinel)"
[ "$got" = "$sentinel" ] || die "sentinel changed across down/up"
read -r users_after sessions_after < <(counts)
[ "$users_after" = "$users_before" ] || die "users changed: $users_before -> $users_after"
[ "$sessions_after" -ge "$sessions_before" ] || die "sessions dropped: $sessions_before -> $sessions_after"

if [ -n "${DUET_SEED_FILE:-}" ]; then
  st="$(curl -sS -m 20 -o "$tmp/me.json" -w '%{http_code}' -b "$jar" "$BASE/api/me")"
  [ "$st" = "200" ] || die "the pre-restart session no longer works ($st)"
  [ "$(jq -r '.user.id' "$tmp/me.json")" = "$user_id" ] || die "/api/me returned a different user after restart"
  st="$(curl -sS -m 20 -o /dev/null -w '%{http_code}' -b "$jar" -X POST -H "Origin: $BASE" "$BASE/api/logout")"
  [ "$st" = "200" ] || die "logout after restart returned $st"
  echo "session survived restart"
fi

bash "$ROOT/scripts/check-live-db.sh" --existing "$DATA" >/dev/null
echo "users=$users_after sessions_before=$sessions_before sessions_after=$sessions_after sentinel=unchanged migrations=unchanged"
echo "persistence ok"
