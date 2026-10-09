#!/usr/bin/env bash
# Idempotent, API-only Cloudflare TURN key provisioning for duet (INFR-03, D-16, D-03).
#
#   bash deploy/cloudflare/turn-key.sh
#
# - Reads the account API token from ${DUET_SECRETS_DIR:-~/.config/duet}/cloudflare.ini
#   (line "dns_cloudflare_api_token = ..."). The token is never echoed or passed on a command line.
# - Creates (or reuses) exactly one TURN key named ${DUET_TURN_KEY_NAME:-duet} through
#   /accounts/{id}/calls/turn_keys and stores its id and bearer as CF_TURN_KEY_ID /
#   CF_TURN_KEY_API_TOKEN in the repo env file (gitignored, mode 600, atomic temp file + mv).
#   The bearer (documented as result.key; the live API returns result.secret) is returned ONLY
#   by the create call (Pitfall M9), so the env file is rewritten
#   immediately after create; the next run deletes any key named duet whose uid differs.
# - Mints a 60-second test credential with the stored bearer and prints "turn-key ok".
# - Calls no Cloudflare endpoint besides the zone lookup and /accounts/{id}/calls/turn_keys
#   (COVERAGE.md). No DNS, zone, account or billing state is changed (D-01).
# - Exit 3: Cloudflare reported a billing/plan error. Nothing is worked around; the owner decides.
# - Never enables shell tracing and never prints a token, bearer or credential.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SECRETS_DIR="${DUET_SECRETS_DIR:-$HOME/.config/duet}"
INI="$SECRETS_DIR/cloudflare.ini"
API="https://api.cloudflare.com/client/v4"
TURN_API="${CF_TURN_API_BASE:-https://rtc.live.cloudflare.com}"
TURN_API="${TURN_API%/}"
NAME="${DUET_TURN_KEY_NAME:-duet}"
ENV_FILE="$ROOT/.env"

die() { echo "turn-key: $*" >&2; exit 1; }
billing() { echo "turn-key: Cloudflare billing/plan error: $*" >&2; exit 3; }
command -v jq >/dev/null || die "jq is required"
command -v curl >/dev/null || die "curl is required"

[ -f "$INI" ] || die "$INI not found (see README: secrets)"
[ -f "$ENV_FILE" ] || die "copy .env.example to the env file first"

# APP_ORIGIN: environment first, then the env file (D-03: the domain only lives in env).
if [ -z "${APP_ORIGIN:-}" ]; then
  APP_ORIGIN="$(sed -n 's/^APP_ORIGIN=//p' "$ENV_FILE" | tail -n 1 | tr -d '[:space:]"'"'")"
fi
[ -n "${APP_ORIGIN:-}" ] || die "APP_ORIGIN is not set in the env file"
APP_HOST="${APP_ORIGIN#*://}"
APP_HOST="${APP_HOST%%/*}"
APP_HOST="${APP_HOST%%:*}"
case "$APP_HOST" in *.*.*) ;; *) die "APP_ORIGIN host '$APP_HOST' must be a subdomain (e.g. duet.example.com)" ;; esac
ZONE="$(echo "$APP_HOST" | awk -F. '{print $(NF-1)"."$NF}')"

umask 077
work="$(mktemp -d)"
env_tmp=""
cleanup() {
  rm -rf "$work"
  if [ -n "$env_tmp" ]; then rm -f "$env_tmp"; fi
}
trap cleanup EXIT
token="$(sed -n 's/^[[:space:]]*dns_cloudflare_api_token[[:space:]]*=[[:space:]]*//p' "$INI" | head -n 1 | tr -d '[:space:]')"
[ -n "$token" ] || die "no dns_cloudflare_api_token line in $INI"
printf 'Authorization: Bearer %s\n' "$token" > "$work/auth.hdr"
unset token

BILLING_RE='billing|payment|subscription|plan|entitle'

# cf METHOD PATH [JSON-BODY] -> prints the response body; dies unless success == true.
# A 402 or a billing-like error message exits 3. Only Cloudflare's errors array is ever printed.
cf() {
  local method="$1" path="$2" body="${3:-}" out="$work/resp.json" code
  if [ -n "$body" ]; then
    code="$(curl -sS -X "$method" -H @"$work/auth.hdr" -H 'Content-Type: application/json' \
      --data-binary "$body" -o "$out" -w '%{http_code}' "$API$path")" || die "$method $path: request failed"
  else
    code="$(curl -sS -X "$method" -H @"$work/auth.hdr" -o "$out" -w '%{http_code}' "$API$path")" \
      || die "$method $path: request failed"
  fi
  if [ "$(jq -r '.success' "$out" 2>/dev/null)" != "true" ]; then
    local errors
    errors="$(jq -c '.errors // []' "$out" 2>/dev/null || echo '"non-JSON response"')"
    if [ "$code" = "402" ] || jq -e --arg re "$BILLING_RE" \
      '[.errors[]?.message // empty | tostring] | any(test($re; "i"))' "$out" >/dev/null 2>&1; then
      billing "$errors"
    fi
    die "$method $path failed (HTTP $code): $errors"
  fi
  cat "$out"
}

# env_value KEY -> the last KEY= value in the env file (never echoed by callers).
env_value() {
  sed -n "s/^$1=//p" "$ENV_FILE" | tail -n 1 | tr -d '[:space:]"'"'"
}

# --- Zone and account ------------------------------------------------------
zone_json="$(cf GET "/zones?name=$ZONE")"
ZONE_ID="$(echo "$zone_json" | jq -r '.result[0].id // empty')"
[ -n "$ZONE_ID" ] || die "zone $ZONE not visible to this token"
ACCOUNT="$(echo "$zone_json" | jq -r '.result[0].account.id // empty')"
if [ -f "$SECRETS_DIR/cloudflare.env" ]; then
  acct_override="$(sed -n 's/^CF_ACCOUNT_ID=//p' "$SECRETS_DIR/cloudflare.env" | tail -n 1 | tr -d '[:space:]"'"'")"
  [ -n "$acct_override" ] && ACCOUNT="$acct_override"
fi
[ -n "$ACCOUNT" ] || die "could not determine the Cloudflare account id"

# --- Reuse or create the TURN key -------------------------------------------
have_id="$(env_value CF_TURN_KEY_ID)"
have_tok="$(env_value CF_TURN_KEY_API_TOKEN)"

keys_json="$(cf GET "/accounts/$ACCOUNT/calls/turn_keys")"
if [ -n "$have_id" ] && [ -n "$have_tok" ] \
  && echo "$keys_json" | jq -e --arg u "$have_id" '[.result[]? | select(.uid == $u)] | length == 1' >/dev/null; then
  echo "turn-key: reused key ${have_id:0:8}"
else
  created="$(cf POST "/accounts/$ACCOUNT/calls/turn_keys" "$(jq -cn --arg n "$NAME" '{name: $n}')")"
  have_id="$(echo "$created" | jq -r '.result.uid // empty')"
  have_tok="$(echo "$created" | jq -r '.result.key // .result.secret // empty')"
  if [ -z "$have_id" ] || [ -z "$have_tok" ]; then
    # Print only the response's key paths (never a value) so the shape can be diagnosed.
    shape="$(echo "$created" | jq -c '[paths(scalars) | map(tostring) | join(".")]' 2>/dev/null || echo '"non-JSON"')"
    die "create returned no uid/key; response fields: $shape (the orphaned key is deleted on the next run)"
  fi
  unset created
  # Pitfall M9: the bearer exists only in that response. Rewrite the env file NOW, atomically.
  env_tmp="$ENV_FILE.tmp.$$"
  grep -v -E '^(CF_TURN_KEY_ID|CF_TURN_KEY_API_TOKEN)=' "$ENV_FILE" > "$env_tmp" || true
  printf 'CF_TURN_KEY_ID=%s\nCF_TURN_KEY_API_TOKEN=%s\n' "$have_id" "$have_tok" >> "$env_tmp"
  chmod 600 "$env_tmp"
  mv -f "$env_tmp" "$ENV_FILE"
  env_tmp=""
  echo "turn-key: created key ${have_id:0:8}"
fi

# --- Stale cleanup: keys named $NAME other than the current one --------------
keys_json="$(cf GET "/accounts/$ACCOUNT/calls/turn_keys")"
for uid in $(echo "$keys_json" | jq -r --arg n "$NAME" --arg u "$have_id" '.result[]? | select(.name == $n and .uid != $u) | .uid'); do
  cf DELETE "/accounts/$ACCOUNT/calls/turn_keys/$uid" >/dev/null
  echo "turn-key: deleted stale key ${uid:0:8}"
done

# --- Mint check: a 60-second credential with the stored bearer -----------------
printf 'Authorization: Bearer %s\n' "$have_tok" > "$work/turn.hdr"
unset have_tok
code="$(curl -sS -m 15 -X POST -H @"$work/turn.hdr" -H 'Content-Type: application/json' \
  --data '{"ttl":60}' -o "$work/ice.json" -w '%{http_code}' \
  "$TURN_API/v1/turn/keys/$have_id/credentials/generate-ice-servers")" || die "mint check: request failed"
if [ "$code" != "200" ] && [ "$code" != "201" ]; then
  # Error bodies carry no credential; still, print only the error fields.
  errs="$(jq -c '.errors // .error // "unparseable error body"' "$work/ice.json" 2>/dev/null || echo '"non-JSON response"')"
  if [ "$code" = "402" ] || echo "$errs" | grep -qiE "$BILLING_RE"; then
    billing "$errs"
  fi
  die "mint check failed (HTTP $code)"
fi
# Never print ice.json: on success it holds a credential.
jq -e '[.iceServers[]?.urls | if type == "array" then .[] else . end | select(type == "string" and startswith("turn"))] | length > 0' \
  "$work/ice.json" >/dev/null 2>&1 || die "mint check returned no turn: URL (HTTP $code)"
rm -f "$work/ice.json" "$work/turn.hdr"

keys_json="$(cf GET "/accounts/$ACCOUNT/calls/turn_keys")"
count="$(echo "$keys_json" | jq --arg n "$NAME" '[.result[]? | select(.name == $n)] | length')"
echo "turn keys named $NAME: $count"
echo "turn-key ok"
