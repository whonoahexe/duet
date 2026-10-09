#!/usr/bin/env bash
# Idempotent, API-driven Cloudflare Tunnel setup for duet (INFR-01, D-02, D-13).
#
#   bash deploy/cloudflared/setup.sh
#
# - Reads the API token from ${DUET_SECRETS_DIR:-~/.config/duet}/cloudflare.ini
#   (line "dns_cloudflare_api_token = ..."). The token is never echoed or passed on a command line.
# - Creates (or reuses) a locally-managed tunnel named "duet" via the API. It never runs
#   `cloudflared tunnel create` or `cloudflared tunnel route dns`, so the host ~/.cloudflared
#   (sideby.me cert.pem, other tunnels) is never touched.
# - Writes deploy/cloudflared/credentials.json (0400) and config.yml (both gitignored).
# - Upserts exactly ONE DNS record: <APP_HOST> CNAME <TunnelID>.cfargotunnel.com, proxied.
#   A before/after snapshot diff of the whole zone fails the run if anything else changed (D-01).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
HERE="$ROOT/deploy/cloudflared"
SECRETS_DIR="${DUET_SECRETS_DIR:-$HOME/.config/duet}"
INI="$SECRETS_DIR/cloudflare.ini"
API="https://api.cloudflare.com/client/v4"
TUNNEL_NAME="${DUET_TUNNEL_NAME:-duet}"

die() { echo "setup: $*" >&2; exit 1; }
command -v jq >/dev/null || die "jq is required"
command -v curl >/dev/null || die "curl is required"
command -v openssl >/dev/null || die "openssl is required"

[ -f "$INI" ] || die "$INI not found (see README: secrets)"

# APP_ORIGIN: environment first, then .env (D-03: the domain only lives in env).
if [ -z "${APP_ORIGIN:-}" ] && [ -f "$ROOT/.env" ]; then
  APP_ORIGIN="$(sed -n 's/^APP_ORIGIN=//p' "$ROOT/.env" | tail -n 1 | tr -d '[:space:]"'"'")"
fi
[ -n "${APP_ORIGIN:-}" ] || die "APP_ORIGIN is not set (copy .env.example to .env)"
APP_HOST="${APP_ORIGIN#*://}"
APP_HOST="${APP_HOST%%/*}"
APP_HOST="${APP_HOST%%:*}"
case "$APP_HOST" in *.*.*) ;; *) die "APP_ORIGIN host '$APP_HOST' must be a subdomain (e.g. duet.example.com)" ;; esac
ZONE="$(echo "$APP_HOST" | awk -F. '{print $(NF-1)"."$NF}')"

umask 077
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
token="$(sed -n 's/^[[:space:]]*dns_cloudflare_api_token[[:space:]]*=[[:space:]]*//p' "$INI" | head -n 1 | tr -d '[:space:]')"
[ -n "$token" ] || die "no dns_cloudflare_api_token line in $INI"
printf 'Authorization: Bearer %s\n' "$token" > "$work/auth.hdr"
unset token

# cf METHOD PATH [JSON-BODY] -> prints the response body; dies unless success == true.
cf() {
  local method="$1" path="$2" body="${3:-}" out="$work/resp.json"
  if [ -n "$body" ]; then
    curl -sS -X "$method" -H @"$work/auth.hdr" -H 'Content-Type: application/json' \
      --data-binary "$body" -o "$out" "$API$path" || die "$method $path: request failed"
  else
    curl -sS -X "$method" -H @"$work/auth.hdr" -o "$out" "$API$path" || die "$method $path: request failed"
  fi
  if [ "$(jq -r '.success' "$out" 2>/dev/null)" != "true" ]; then
    die "$method $path failed: $(jq -c '.errors // .' "$out" 2>/dev/null || echo 'non-JSON response')"
  fi
  cat "$out"
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

# --- Tunnel (API-created, locally managed) ---------------------------------
CREDS="$HERE/credentials.json"
existing="$(cf GET "/accounts/$ACCOUNT/cfd_tunnel?name=$TUNNEL_NAME&is_deleted=false")"
count="$(echo "$existing" | jq '.result | length')"
TUNNEL_ID=""
if [ "$count" -gt 1 ]; then
  die "more than one live tunnel is named '$TUNNEL_NAME'; resolve this in Cloudflare first (nothing was changed)"
elif [ "$count" -eq 1 ]; then
  TUNNEL_ID="$(echo "$existing" | jq -r '.result[0].id')"
  local_id=""
  [ -f "$CREDS" ] && local_id="$(jq -r '.TunnelID // empty' "$CREDS" 2>/dev/null || true)"
  if [ "$local_id" != "$TUNNEL_ID" ]; then
    die "tunnel '$TUNNEL_NAME' ($TUNNEL_ID) exists but $CREDS does not hold its credentials. Not deleting it automatically: delete it in Cloudflare (or restore credentials.json) and re-run."
  fi
else
  secret="$(openssl rand -base64 32)"
  body="$(jq -nc --arg name "$TUNNEL_NAME" --arg s "$secret" '{name: $name, config_src: "local", tunnel_secret: $s}')"
  created="$(cf POST "/accounts/$ACCOUNT/cfd_tunnel" "$body")"
  TUNNEL_ID="$(echo "$created" | jq -r '.result.id')"
  [ -n "$TUNNEL_ID" ] && [ "$TUNNEL_ID" != "null" ] || die "tunnel creation returned no id"
  [ -f "$CREDS" ] && chmod 600 "$CREDS"
  jq -n --arg a "$ACCOUNT" --arg s "$secret" --arg t "$TUNNEL_ID" \
    '{AccountTag: $a, TunnelSecret: $s, TunnelID: $t}' > "$CREDS"
  unset secret body
  chmod 400 "$CREDS"
fi

cat > "$HERE/config.yml" <<EOF
tunnel: $TUNNEL_ID
credentials-file: /etc/cloudflared/credentials.json
no-autoupdate: true
ingress:
  - hostname: $APP_HOST
    service: http://duet:3100
  - service: http_status:404
EOF
chmod 644 "$HERE/config.yml"

# The duet container (uid 1000) needs a host-owned ./data; Docker would create it as root.
mkdir -p "$ROOT/data"

# --- DNS: allowlist of exactly one name (D-01) -----------------------------
snapshot() {
  cf GET "/zones/$ZONE_ID/dns_records?per_page=5000" \
    | jq -r '.result[] | "\(.name)\t\(.type)\t\(.content)\t\(.proxied)"' | LC_ALL=C sort
}
snapshot > "$work/before.tsv"

TARGET="$TUNNEL_ID.cfargotunnel.com"
others="$(awk -F'\t' -v h="$APP_HOST" '$1 == h && $2 != "CNAME"' "$work/before.tsv" | wc -l)"
[ "$others" -eq 0 ] || die "$APP_HOST already has non-CNAME records; refusing to touch them"
record="$(cf GET "/zones/$ZONE_ID/dns_records?type=CNAME&name=$APP_HOST")"
record_id="$(echo "$record" | jq -r '.result[0].id // empty')"
rec_body="$(jq -nc --arg n "$APP_HOST" --arg c "$TARGET" '{type: "CNAME", name: $n, content: $c, proxied: true, ttl: 1, comment: "duet app via Cloudflare Tunnel"}')"
if [ -n "$record_id" ]; then
  cf PATCH "/zones/$ZONE_ID/dns_records/$record_id" "$rec_body" >/dev/null
else
  cf POST "/zones/$ZONE_ID/dns_records" "$rec_body" >/dev/null
fi

snapshot > "$work/after.tsv"
if ! diff <(awk -F'\t' -v h="$APP_HOST" '$1 != h' "$work/before.tsv") \
          <(awk -F'\t' -v h="$APP_HOST" '$1 != h' "$work/after.tsv") >"$work/diff.txt"; then
  cat "$work/diff.txt" >&2
  die "DNS records other than $APP_HOST changed during setup"
fi
mine="$(awk -F'\t' -v h="$APP_HOST" '$1 == h' "$work/after.tsv")"
expected="$(printf '%s\tCNAME\t%s\ttrue' "$APP_HOST" "$TARGET")"
[ "$mine" = "$expected" ] || die "$APP_HOST is not exactly one proxied CNAME to the tunnel after the upsert"
echo "dns diff: no record other than $APP_HOST changed; $APP_HOST = proxied CNAME -> tunnel"

echo "dns ok"
echo "tunnel ok $TUNNEL_ID"
