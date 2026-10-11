#!/usr/bin/env bash
# Idempotent VAPID keypair for duet's Web Push (NOTF-01, T-02-16).
#
#   bash deploy/vapid-keys.sh
#
# - When VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY are both already in the repo env file, they are kept
#   and "vapid-keys: reused" is printed. Rotating the pair would invalidate every phone's push
#   subscription, so this script never replaces a complete pair.
# - Otherwise a new pair is generated with web-push's generateVAPIDKeys() (node, run in server/),
#   any half-written pair is removed, both lines are appended and "vapid-keys: created" is printed.
# - VAPID_SUBJECT is appended when absent and APP_ORIGIN in the env file is https (Pitfall 4: Apple
#   rejects a subject that is not an https: URL or mailto:). The server falls back to the same value.
# - The env file is rewritten atomically (temp file + mv) under umask 077, mode 600.
# - Never enables shell tracing and never prints a key value. Last line: "vapid-keys ok".
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="$ROOT/.env"

die() { echo "vapid-keys: $*" >&2; exit 1; }
command -v node >/dev/null || die "node is required"
[ -f "$ENV_FILE" ] || die "copy .env.example to the env file first"

umask 077
env_tmp=""
cleanup() {
  if [ -n "$env_tmp" ]; then rm -f "$env_tmp"; fi
}
trap cleanup EXIT

# env_value KEY -> the last KEY= value in the env file (never echoed by callers).
env_value() {
  sed -n "s/^$1=//p" "$ENV_FILE" | tail -n 1 | tr -d '[:space:]"'"'"
}

# rewrite_env PATTERN LINES -> drop lines matching PATTERN, append LINES, replace the file atomically.
rewrite_env() {
  env_tmp="$ENV_FILE.tmp.$$"
  grep -v -E "$1" "$ENV_FILE" > "$env_tmp" || true
  printf '%s' "$2" >> "$env_tmp"
  chmod 600 "$env_tmp"
  mv -f "$env_tmp" "$ENV_FILE"
  env_tmp=""
}

have_pub="$(env_value VAPID_PUBLIC_KEY)"
have_priv="$(env_value VAPID_PRIVATE_KEY)"

if [ -n "$have_pub" ] && [ -n "$have_priv" ]; then
  echo "vapid-keys: reused"
else
  # generateVAPIDKeys() returns base64url strings: a 65-byte P-256 public key and a 32-byte private key.
  pair="$(cd "$ROOT/server" && node -e '
    const webpush = require("web-push")
    const k = webpush.generateVAPIDKeys()
    process.stdout.write(k.publicKey + " " + k.privateKey)
  ')" || die "key generation failed (is web-push installed? run npm ci)"
  new_pub="${pair%% *}"
  new_priv="${pair#* }"
  unset pair
  [[ "$new_pub" =~ ^[A-Za-z0-9_-]{80,100}$ ]] || die "generated public key has an unexpected shape"
  [[ "$new_priv" =~ ^[A-Za-z0-9_-]{40,50}$ ]] || die "generated private key has an unexpected shape"
  rewrite_env '^(VAPID_PUBLIC_KEY|VAPID_PRIVATE_KEY)=' "$(printf 'VAPID_PUBLIC_KEY=%s\nVAPID_PRIVATE_KEY=%s' "$new_pub" "$new_priv")
"
  unset new_pub new_priv
  echo "vapid-keys: created"
fi
unset have_pub have_priv

if [ -z "$(env_value VAPID_SUBJECT)" ]; then
  origin="$(env_value APP_ORIGIN)"
  case "$origin" in
    https://*)
      rewrite_env '^VAPID_SUBJECT=' "VAPID_SUBJECT=${origin%/}
"
      echo "vapid-keys: subject set to the APP_ORIGIN"
      ;;
    *)
      echo "vapid-keys: VAPID_SUBJECT not set (APP_ORIGIN is not https); set it to https://… or mailto:…" >&2
      ;;
  esac
fi

[ -n "$(env_value VAPID_PUBLIC_KEY)" ] && [ -n "$(env_value VAPID_PRIVATE_KEY)" ] || die "env file has no complete VAPID pair"
echo "vapid-keys ok"
