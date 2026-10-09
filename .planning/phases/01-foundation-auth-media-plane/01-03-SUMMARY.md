---
phase: 01-foundation-auth-media-plane
plan: 03
subsystem: infra
tags: [docker, compose, cloudflare-tunnel, cloudflare-api, pwa, manifest, service-worker, imagemagick, phosphor]

requires:
  - phase: 01-02
    provides: "Login/me/logout, rolling duet_session cookie, Origin guard, security headers, CF-Connecting-IP rate-limit key"
  - phase: 01-01
    provides: "buildApp + static web/out serving with sw.js/webmanifest no-cache, seed CLI (--stdin), check-live-db.sh --existing"
provides:
  - "duet live at https://duet.brkn.me: Docker (node:24-bookworm-slim, USER node) behind an API-created, locally-managed Cloudflare Tunnel 'duet' (b338db16-c068-4c4e-bbc1-3ea53a027cd8)"
  - "compose project 'duet': duet (no published port, ./data:/data) + cloudflared 2026.10.0 as uid 1000"
  - "deploy/cloudflared/setup.sh: idempotent tunnel + credentials (0400) + config.yml + single proxied CNAME upsert with a whole-zone diff guard"
  - "scripts/smoke-public.sh (public checks + optional real login round-trip) and scripts/smoke-persistence.sh (sentinel/users/sessions/migrations across down/up, optional live-session survival)"
  - "Two real accounts seeded in ./data/duet.sqlite; seed file shredded"
  - "Installable PWA: /manifest.webmanifest, generated heart icons (180/192/512/maskable 512, favicon 16/32/48), apple/theme/viewport head tags, /sw.js (install/activate only) registered by SwRegister"
affects: [01-04, 01-05, phase-02, phase-03]

actuals:
  tokens: 9200
  tasks: 2
  commits: 2
plan_head_before: 38595f1acbdbddfffc5e8f99f76f87a9ad9b276a
plan_head_after: 4e5fc3bd923d1cdfab943aab4c09a6f342d057ca

tech-stack:
  added:
    - "cloudflare/cloudflared:2026.10.0 image (compose service)"
    - "node:24-bookworm-slim base image (build stage adds python3/make/g++)"
  patterns:
    - "Cloudflare work is API-only: Authorization header written to a mode-600 temp file and passed with curl -H @file, never on argv or in output"
    - "Ops scripts print '<name> ok' as their last line and die with a reason otherwise"
    - "Icons are generated offline from the Phosphor defs path and committed; colors derived from the preset's .dark oklch tokens"

key-files:
  created:
    - Dockerfile
    - .dockerignore
    - compose.yaml
    - .env.example
    - deploy/cloudflared/setup.sh
    - scripts/smoke-public.sh
    - scripts/smoke-persistence.sh
    - README.md
    - scripts/gen-icons.mjs
    - web/app/manifest.ts
    - web/public/sw.js
    - web/public/icons/apple-touch-icon.png
    - web/public/icons/icon-192.png
    - web/public/icons/icon-512.png
    - web/public/icons/icon-maskable-512.png
    - web/components/app/sw-register.tsx
    - server/test/static.test.ts
  modified:
    - web/app/layout.tsx
    - web/app/favicon.ico

key-decisions:
  - "The build stage installs python3/make/g++: better-sqlite3 13.0.3 has no prebuilt binary for Node 24.21 (ABI 137) and falls back to node-gyp. The runtime stage has no toolchain"
  - "Tunnel created via the Cloudflare API (config_src local), never `cloudflared tunnel create/route dns`; host ~/.cloudflared untouched"
  - "setup.sh uses CF_ACCOUNT_ID from ~/.config/duet/cloudflare.env when present (account-owned token), else the zone's account id"
  - "SW registered with updateViaCache 'none' because Cloudflare's zone Browser Cache TTL rewrites the origin's no-cache on .js to max-age=14400 at the edge (zone setting left untouched)"
  - "smoke-persistence.sh optionally holds a real session across down/up and proves the same cookie still authenticates afterwards"

patterns-established:
  - "Deploy = cp .env.example .env; bash deploy/cloudflared/setup.sh; docker compose up -d --build"
  - "Password reset = re-run the seed inside the container (interactive: docker compose exec -it duet node --import tsx server/scripts/seed-users.ts)"

requirements-completed: [INFR-01, INFR-02, SHEL-02]

coverage:
  - id: D1
    description: "https://duet.brkn.me serves the dark login over HTTPS via the tunnel; /healthz 200, /api/me 401 JSON, /api/users lists exactly 2 people, X-Frame-Options DENY"
    requirement: INFR-01
    verification:
      - kind: e2e
        ref: "bash scripts/smoke-public.sh"
        status: pass
    human_judgment: false
  - id: D2
    description: "Real login round-trip through the public URL: POST /api/login 200 with Secure duet_session, GET /api/me 200, POST /api/logout 200, then 401"
    requirement: INFR-01
    verification:
      - kind: e2e
        ref: "DUET_SEED_FILE=... bash scripts/smoke-public.sh -> login roundtrip ok"
        status: pass
    human_judgment: false
  - id: D3
    description: "docker compose down/up keeps the sentinel, both users, sessions (a live session cookie still works) and applies no migration again"
    requirement: INFR-02
    verification:
      - kind: e2e
        ref: "bash scripts/smoke-persistence.sh (with and without DUET_SEED_FILE)"
        status: pass
    human_judgment: false
  - id: D4
    description: "No published duet port; tailscale 100.97.55.101:443 and the 3 sideby-staging containers unchanged; DNS diff shows only duet.brkn.me changed"
    requirement: INFR-01
    verification:
      - kind: other
        ref: "docker compose config | jq ports==0; ss -ltn; docker ps count; setup.sh zone diff"
        status: pass
    human_judgment: false
  - id: D5
    description: "Manifest MIME + fields, 4 icons image/png, head tags (manifest, apple-touch-icon, black-translucent, theme-color, viewport-fit=cover), sw.js no-cache, immutable _next/static"
    requirement: SHEL-02
    verification:
      - kind: integration
        ref: "server/test/static.test.ts"
        status: pass
      - kind: e2e
        ref: "headless Chrome CDP against https://duet.brkn.me: SW activated, Page.getInstallabilityErrors = []"
        status: pass
    human_judgment: false
  - id: D6
    description: "Installs to the iPhone and Pixel home screens as 'duet' with the heart icon, launches standalone and dark, stays logged in after force-quit, logs out from the header menu, /signup is not found"
    requirement: SHEL-02
    verification: []
    human_judgment: true
    rationale: "Home-screen install and standalone launch on real iOS/Android devices cannot be automated cheaply; end-of-phase device UAT (Task 2 human-check)"

duration: 12min
completed: 2026-10-09
status: complete
---

# Phase 1 Plan 03: Docker + Cloudflare Tunnel Deploy and Installable PWA Summary

**duet now runs from Docker on this box at https://duet.brkn.me. It sits behind a Cloudflare Tunnel that was created entirely through the API, its SQLite data survives restarts on a `./data` bind mount, and the two real accounts are seeded and proven by a public login round-trip. It installs as a standalone dark PWA named "duet" with a Phosphor heart icon, and headless Chrome reports zero installability errors.**

## Performance

- **Duration:** 12 min
- **Started:** 2026-10-09T09:10:03Z
- **Completed:** 2026-10-09T09:22:01Z
- **Tasks:** 2 (1 tracer + 1 auto)
- **Files modified:** 19

## Accomplishments

- **Public path proven end to end:** phone → Cloudflare edge → tunnel `duet` → cloudflared (uid 1000) → `duet:3100` → SQLite on `./data`. The duet service publishes no host port.
- **Cloudflare via API only:**
  - Tunnel `b338db16-c068-4c4e-bbc1-3ea53a027cd8` was created as locally managed.
  - The proxied CNAME `duet.brkn.me` → `<id>.cfargotunnel.com` was upserted. A whole-zone before/after diff shows no other record changed. The 14 existing brkn.me records, the `sideby-staging` and `studio-server` tunnels, and `~/.cloudflared` were not touched.
  - Running `setup.sh` a second time is a no-op.
- **Accounts:** both real accounts were seeded from `~/.config/duet/seed-users.json` through stdin (output: `created`, `created`). After a successful public login round-trip, the file was removed with `shred -u`.
- **Persistence:** the sentinel, the 2 users, the session rows and the migration count all survive `docker compose down && up -d`. A session cookie issued before the restart still authenticates afterwards.
- **PWA:**
  - The manifest uses `id`/`start_url` `/`, `standalone`, and `#090b0c` for both colors, and is served as `application/manifest+json`.
  - Icons were generated from the Phosphor fill Heart in `#fff1f2` on `#a50036`. Those colors were re-derived from the preset's `.dark` oklch tokens and match the research values exactly.
  - The head tags are verified, and `/sw.js` has only install/activate listeners.
- **Box undisturbed:** the tailscale `100.97.55.101:443` listener is still present, and the `sideby-staging` container count is still 3, both before and after.

## Task Commits

1. **Task 1: Docker → Cloudflare Tunnel → Fastify → SQLite on a persistent volume (tracer):** `9197112` (feat). Tracer gate: `<verify>` is automated-only and human_verify_mode is end-of-phase, so I re-ran smoke-public, smoke-persistence and the ports/tailscale check. All three were green, and work then expanded to Task 2.
2. **Task 2: Installable on iPhone and Pixel (manifest, icons, head tags, SW):** `4e5fc3b` (feat)

## Files Created/Modified

- `Dockerfile`, `.dockerignore`, `compose.yaml`, `.env.example`: the image (build toolchain in the build stage only), ignore lists (secrets, data, ops, .planning), and the two-service compose with no published app port.
- `deploy/cloudflared/setup.sh`: API-driven tunnel, credentials and config, plus the single-CNAME DNS upsert with the diff guard. It also creates a host-owned `./data`.
- `scripts/smoke-public.sh`, `scripts/smoke-persistence.sh`: public and restart proofs. Neither prints passwords or cookies.
- `README.md`: dev, full stack, deploy, secrets, seeding/reset, smoke scripts, and a pointer to `ops/sfu/README.md`.
- `scripts/gen-icons.mjs`, `web/public/icons/*.png`, `web/app/favicon.ico`: offline icon generation and its committed output.
- `web/app/manifest.ts`, `web/app/layout.tsx`, `web/public/sw.js`, `web/components/app/sw-register.tsx`: PWA identity, head tags and SW.
- `server/test/static.test.ts`: 8 tests against the real `web/out`.

## Decisions Made

See `key-decisions` in the frontmatter.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] `npm ci` failed in the Docker build stage (better-sqlite3 needs node-gyp)**
- **Found during:** Task 1
- **Issue:** better-sqlite3 13.0.3 has no prebuilt binary for `node:24-bookworm-slim` (Node 24.21.0, ABI 137). Its install fell back to node-gyp, which found no Python.
- **Fix:** The build stage now runs `apt-get install --no-install-recommends python3 make g++`. The runtime stage is unchanged and has no toolchain. Both stages use the same base, so the compiled addon matches the ABI. No package or version change.
- **Files modified:** Dockerfile
- **Commit:** 9197112

**2. [Rule 1 - Bug] Cloudflare rewrites `/sw.js` Cache-Control at the edge**
- **Found during:** Task 2 (public verification)
- **Issue:** The origin sends `Cache-Control: no-cache` for `/sw.js` (static.test.ts passes). The zone's Browser Cache TTL makes Cloudflare return `max-age=14400` for `.js`. The edge itself does not store the file (`cf-cache-status: MISS` on every request). HTML and the manifest keep `no-cache` through the edge.
- **Fix:** `SwRegister` registers with `updateViaCache: "none"`, so browsers always bypass the HTTP cache for SW update checks. I left the zone-wide Browser Cache TTL setting alone because it would also affect the portfolio (D-01). If a strict header is ever wanted, a duet-host-only Cache Rule (`browser_ttl: respect_origin`) is the option. It needs a Cache Rules permission on the token.
- **Files modified:** web/components/app/sw-register.tsx
- **Verification:** headless Chrome over the public URL reports `updateViaCache: "none"` and an activated SW.
- **Commit:** 4e5fc3b

**3. [Rule 2 - Missing critical] Host `./data` must exist before `compose up`**
- **Found during:** Task 1
- **Issue:** If `./data` is missing, Docker creates it as root, and the uid-1000 `node` user then cannot write the DB.
- **Fix:** `setup.sh` runs `mkdir -p ./data` as the invoking user, and the README deploy steps run setup first.
- **Commit:** 9197112

**4. [Enhancement within scope] smoke-persistence holds a live session across the restart**
- With `DUET_SEED_FILE`, the script logs in before `down`, then checks after `up` that `/api/me` is 200 with the same cookie and logs out. Without this, "sessions ≥ before" is trivially true once smoke-public has logged out. I ran it with the seed file before shredding it, then again without.

---

**Total deviations:** 3 auto-fixed (1 Rule 3, 1 Rule 1, 1 Rule 2) and 1 in-scope strengthening. **Impact:** no new packages, nothing outside `files_modified`, and no Cloudflare objects beyond the planned tunnel and CNAME.

## Authentication Gates

None. The Cloudflare token from `~/.config/duet/cloudflare.ini` worked for zone read, tunnel create and DNS edit on the first try. The token value never appeared in output, argv or commits, because it was passed via `curl -H @<mode-600 file>`.

## Issues Encountered

None beyond the deviations.

## Known Stubs

None.

## Threat Flags

None. All new surface is in the plan's register:
- T-01-13: `.dockerignore` excludes `.env*`, `data`, `credentials.json`, `config.yml`, `ops`, `.planning`.
- T-01-14: no `ports:`, checked with jq.
- T-01-15: credentials are 0400, gitignored and mounted ro.
- T-01-16: zone diff guard.
- T-01-17: the seed file was fed through stdin and shredded.
- T-01-18: the SW has 0 fetch listeners.
- T-01-19: before/after box checks.
- T-01-SC: pinned images, `npm ci` from the lockfile.

The cloudflared metrics server listens on `[::]:20241` inside its container only. It is not published.

## User Setup Required

None remaining. `~/.config/duet/seed-users.json` was **shredded** (`shred -u`) after the successful public login round-trip, as agreed in 01-04 Task 1. Password reset is the interactive seed:

```bash
docker compose exec -it duet node --import tsx server/scripts/seed-users.ts
```

## Human Verification (end-of-phase device UAT)

Task 2 human-check, to run on both phones:
1. **iPhone, Safari:** open https://duet.brkn.me, then Share → Add to Home Screen. Launch "duet" and log in **inside** the installed app (Pitfall 6: it has a separate cookie jar). Force-quit and reopen, and you should still be logged in. Header menu → Log out, then log back in.
2. **Pixel, Chrome:** open https://duet.brkn.me, then menu → Install app, and repeat the same steps.
3. In each browser, type https://duet.brkn.me/signup. It should show the not-found page.

Expected: a light heart on a rose icon, labelled "duet". The app launches standalone with no address bar, a dark background and a dark/translucent status bar. The session survives a force-quit. Logout returns to the two name tiles. No sign-up anywhere.

## Next Phase Readiness

- **01-04 (SFU ops):** the same `cloudflare.ini` token and `CF_ACCOUNT_ID` work through the API. `setup.sh`'s `cf()` + diff-guard pattern can be reused for the sfu/turn A records.
- **01-05 (debug SFU page):** add the BuildKit npm secret to `compose.yaml` `build.secrets` and `RUN --mount=type=secret` before `npm ci` (Pitfall 14). Redeploy with `docker compose up -d --build`, then re-run `scripts/smoke-public.sh`.
- **Phase 2:** the SW is registered at scope `/` with `updateViaCache: none`, ready for push handlers. Media goes in `./data/media` (already created by `openDb`).

## Plan-level Verification

- `bash scripts/smoke-public.sh`: `smoke-public ok`. With the seed file it also printed `login roundtrip ok` once. It was re-run after the Task 2 redeploy and still passed.
- `bash scripts/smoke-persistence.sh`: `persistence ok` twice. With the seed file: users=2, sessions 1→1, and the session survived the restart. Without it: users=2, sessions 0→0.
- `docker compose config --format json | jq -e '(.services.duet.ports // []) | length == 0'`: true. The tailscale `:443` listener is present, and the sideby-staging count is 3 before and after.
- `npm run build && npm --prefix server run test`: 6 files, 48 tests passed, including the 8 in static.test.ts.
- `magick identify` output: `512 512`, `512 512`, `180 180`, `192 192`.
- `grep -cE 'addEventListener\(.fetch' web/public/sw.js`: 0.
- `npm run typecheck`, `bash scripts/check-preset.sh` (`preset ok`) and `bash scripts/smoke-local.sh` (`smoke-local ok`) all passed.
- Public `/manifest.webmanifest`: 200, `application/manifest+json`, `no-cache`.
- `credentials.json` is mode 400 and gitignored. `git status --porcelain` shows no credentials, `.env` or data files.

## Self-Check: PASSED

- All 17 created files and 2 modified files: FOUND
- Commits `9197112` and `4e5fc3b` are ancestors of HEAD: FOUND
- Commits measured from the ledger: 2 (38595f1..4e5fc3b)
