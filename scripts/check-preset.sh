#!/usr/bin/env bash
# SHEL-01 / D-05 guard: the UI stays on the locked shadcn preset b51GFhBEQ and no dropped dependency sneaks in.
# Prints "preset ok" on success.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

fail() { echo "check-preset: $*" >&2; exit 1; }

# 1. Locked preset descriptor.
jq -e '.style == "base-luma" and .iconLibrary == "phosphor"' web/components.json >/dev/null \
  || fail "web/components.json is not style base-luma / iconLibrary phosphor"

# 2. Forbidden packages in any workspace manifest.
for manifest in package.json web/package.json server/package.json shared/package.json; do
  [ -f "$manifest" ] || continue
  bad="$(jq -r '
    [(.dependencies // {}), (.devDependencies // {})] | add // {} | keys[]
    | select(
        . == "lucide-react" or startswith("@radix-ui/")
        or . == "otplib" or . == "qrcode" or . == "input-otp"
        or . == "serwist" or startswith("@serwist/")
      )' "$manifest")"
  [ -z "$bad" ] || fail "$manifest lists forbidden package(s): $(echo "$bad" | tr '\n' ' ')"
done

# 3. Forbidden imports in app code.
if grep -rnE --include='*.ts' --include='*.tsx' --include='*.js' --include='*.jsx' --include='*.mjs' \
  "from ['\"](lucide-react|@radix-ui)|require\(['\"](lucide-react|@radix-ui)|import\(['\"](lucide-react|@radix-ui)" \
  web/app web/components web/lib; then
  fail "lucide-react / @radix-ui import found (see above)"
fi

# 4. Always dark (D-10).
grep -q 'forcedTheme="dark"' web/app/layout.tsx || fail 'web/app/layout.tsx lacks forcedTheme="dark"'

# 5. No nested repo from the scaffold.
[ ! -e web/.git ] || fail "web/.git exists (nested repository from the scaffold)"

echo "preset ok"
