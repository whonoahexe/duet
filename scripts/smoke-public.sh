#!/usr/bin/env bash
# Public-URL smoke (INFR-01): Cloudflare edge -> tunnel -> cloudflared -> duet -> SQLite.
#
#   bash scripts/smoke-public.sh                                  BASE = APP_ORIGIN from .env
#   BASE=https://duet.example.com bash scripts/smoke-public.sh
#   DUET_SEED_FILE=~/.config/duet/seed-users.json bash scripts/smoke-public.sh
#        ... also does a real login -> me -> logout round-trip for the first account.
#
# Never prints passwords or session cookies (and never uses set -x). Last line: "smoke-public ok".
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
die() { echo "smoke-public: $*" >&2; exit 1; }

if [ -z "${BASE:-}" ]; then
  [ -f "$ROOT/.env" ] || die "BASE is not set and $ROOT/.env does not exist"
  BASE="$(sed -n 's/^APP_ORIGIN=//p' "$ROOT/.env" | tail -n 1 | tr -d '[:space:]"'"'")"
fi
[ -n "$BASE" ] || die "no BASE / APP_ORIGIN"
BASE="${BASE%/}"

umask 077
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

# get PATH -> sets $status, body in $tmp/body, headers in $tmp/headers
get() {
  status="$(curl -sS -m 20 -o "$tmp/body" -D "$tmp/headers" -w '%{http_code}' "$@")" || die "request failed: ${*: -1}"
}
header() { grep -i "^$1:" "$tmp/headers" | tail -n 1 | cut -d: -f2- | tr -d '\r' | sed 's/^ *//'; }

# 1. health
get "$BASE/healthz"
[ "$status" = "200" ] || die "/healthz returned $status"

# 2. dark login screen (html class contains "dark")
get "$BASE/"
[ "$status" = "200" ] || die "/ returned $status"
grep -qE '<html[^>]*class="([^"]* )?dark( [^"]*)?"' "$tmp/body" || die "/ has no dark class on <html>"
[ "$(header x-frame-options)" = "DENY" ] || die "/ is missing X-Frame-Options: DENY"

# 3. unauthenticated /api/me is a 401 JSON
get "$BASE/api/me"
[ "$status" = "401" ] || die "/api/me returned $status, expected 401"
header content-type | grep -qi 'application/json' || die "/api/me 401 is not JSON"
jq -e '.error' "$tmp/body" >/dev/null || die "/api/me 401 body has no error field"

# 4. exactly two people
get "$BASE/api/users"
[ "$status" = "200" ] || die "/api/users returned $status"
[ "$(jq '.users | length' "$tmp/body")" = "2" ] || die "/api/users does not list exactly 2 users"
[ "$(header x-frame-options)" = "DENY" ] || die "/api/users is missing X-Frame-Options: DENY"
cp "$tmp/body" "$tmp/users.json"

# 4b. the TURN credential endpoint is login-gated (INFR-03): no cookie -> 401
get -X POST -H "Origin: $BASE" "$BASE/api/rtc/ice-servers"
[ "$status" = "401" ] || die "POST /api/rtc/ice-servers without a session returned $status, expected 401"

# 5. optional real login round-trip
if [ -n "${DUET_SEED_FILE:-}" ]; then
  [ -r "$DUET_SEED_FILE" ] || die "DUET_SEED_FILE is not readable"
  username="$(jq -r '.[0].username' "$DUET_SEED_FILE")"
  user_id="$(jq -r --arg u "$username" '.users[] | select(.username == $u) | .id' "$tmp/users.json")"
  [ -n "$user_id" ] || die "the first seed account is not listed by /api/users"
  jq -c --arg id "$user_id" '{userId: $id, password: .[0].password}' "$DUET_SEED_FILE" > "$tmp/login.json"
  jar="$tmp/jar"

  get -c "$jar" -H "Origin: $BASE" -H 'Content-Type: application/json' --data-binary @"$tmp/login.json" "$BASE/api/login"
  rm -f "$tmp/login.json"
  [ "$status" = "200" ] || die "POST /api/login returned $status"
  cookie="$(grep -i '^set-cookie:' "$tmp/headers" | grep 'duet_session=' || true)"
  [ -n "$cookie" ] || die "login set no duet_session cookie"
  echo "$cookie" | grep -qi '; *secure' || die "duet_session cookie is not Secure"
  unset cookie

  get -b "$jar" "$BASE/api/me"
  [ "$status" = "200" ] || die "GET /api/me after login returned $status"
  [ "$(jq -r '.user.id' "$tmp/body")" = "$user_id" ] || die "/api/me returned a different user"

  get -b "$jar" -c "$jar" -X POST -H "Origin: $BASE" "$BASE/api/logout"
  [ "$status" = "200" ] || die "POST /api/logout returned $status"

  get -b "$jar" "$BASE/api/me"
  [ "$status" = "401" ] || die "GET /api/me after logout returned $status, expected 401"
  echo "login roundtrip ok"
fi

echo "smoke-public ok"
