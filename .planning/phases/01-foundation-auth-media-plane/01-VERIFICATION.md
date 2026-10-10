---
phase: 01-foundation-auth-media-plane
verified: 2026-10-10T13:21:14Z
status: human_needed
score: 44/46 must-haves verified
covered_files: [".dockerignore",".env.example",".planning/phases/01-foundation-auth-media-plane/01-01-PLAN.md",".planning/phases/01-foundation-auth-media-plane/01-01-SUMMARY.md",".planning/phases/01-foundation-auth-media-plane/01-02-PLAN.md",".planning/phases/01-foundation-auth-media-plane/01-02-SUMMARY.md",".planning/phases/01-foundation-auth-media-plane/01-03-PLAN.md",".planning/phases/01-foundation-auth-media-plane/01-03-SUMMARY.md",".planning/phases/01-foundation-auth-media-plane/01-04-PLAN.md",".planning/phases/01-foundation-auth-media-plane/01-04-SUMMARY.md",".planning/phases/01-foundation-auth-media-plane/01-05-PLAN.md",".planning/phases/01-foundation-auth-media-plane/01-05-SUMMARY.md","Dockerfile","compose.yaml","deploy/cloudflare/turn-key.sh","deploy/cloudflared/setup.sh","package.json","scripts/check-call-smoke.sh","scripts/check-live-db.sh","scripts/check-preset.sh","scripts/gen-icons.mjs","scripts/smoke-call.mjs","scripts/smoke-call.sh","scripts/smoke-local.sh","scripts/smoke-persistence.sh","scripts/smoke-public.sh","server/drizzle.config.ts","server/drizzle/0000_amusing_bishop.sql","server/package.json","server/scripts/seed-users.ts","server/src/app.ts","server/src/auth/password.ts","server/src/auth/routes.ts","server/src/auth/session.ts","server/src/config.ts","server/src/db/client.ts","server/src/db/schema.ts","server/src/db/seed.ts","server/src/http/guards.ts","server/src/index.ts","server/src/routes/users.ts","server/src/rtc/routes.ts","server/src/rtc/turn.ts","server/src/ws/hub.ts","server/src/ws/routes.ts","server/test/auth.test.ts","server/test/call-report.test.ts","server/test/db.test.ts","server/test/helpers.ts","server/test/seed.test.ts","server/test/session.test.ts","server/test/static.test.ts","server/test/turn.test.ts","server/test/users.test.ts","server/test/ws.test.ts","server/vitest.config.ts","shared/package.json","shared/src/api.ts","shared/src/index.ts","shared/src/rtc.ts","shared/src/ws.ts","web/app/debug/call/page.tsx","web/app/layout.tsx","web/app/manifest.ts","web/app/page.tsx","web/components.json","web/components/app/call-test.tsx","web/components/app/login-tiles.tsx","web/components/app/password-step.tsx","web/components/app/shell.tsx","web/components/app/sw-register.tsx","web/components/theme-provider.tsx","web/lib/api.ts","web/lib/rtc/ice.ts","web/lib/rtc/peer.ts","web/lib/rtc/stats.ts","web/lib/utils.ts","web/lib/ws.ts","web/next.config.ts","web/package.json","web/public/sw.js"]
covered_digest: "v3:sha256:aed23234fe8a0a19641faace33cc0b448aa1dfa00efd892e4be602b2a4717687"
behavior_unverified: 2
overrides_applied: 0
re_verification:
  previous_status: gaps_found
  previous_score: 33/46
  gaps_closed:
    - "Any non-GET /api/* request whose Origin header is not exactly APP_ORIGIN (including a missing Origin) is rejected 403 {error:'bad_origin'} before any handler runs (CR-01, fixed in 26c7cfa)"
  previously_human_now_verified:
    - "SC3 installed app stays logged in / explicit logout (UAT 4)"
    - "SC4 install to home screen on iPhone and Pixel, standalone (UAT 3)"
    - "SC5 / 05-8 cellular call PASS in normal and forced-relay mode (UAT 6 + check-call-smoke.sh re-run by the verifier: exit 0)"
    - "03-4 real login round-trip through the public URL (UAT 20 + login inside the installed app, UAT 3/4)"
    - "03-7 installs as 'duet', standalone, logged in after force-quit, header logout (UAT 3/4)"
    - "05-1 Call test page and menu item on device (UAT 5/6)"
  previously_behavior_unverified_now_verified:
    - "04-1 turn-key.sh outcome: exactly one Cloudflare TURN key named duet, its uid equals the stored CF_TURN_KEY_ID, env file mode 600 and gitignored, and the key mints working credentials (live relay-relay PASS)"
    - "05-6 CallReport on the first PASS and on Stop (observed in the live call_smoke log lines)"
    - "05-9 glare-safe perfect negotiation (both sides always offer at once in this design; real-device runs converged in both modes)"
  gaps_remaining: []
  regressions: []
behavior_unverified_items:
  - truth: "turn-key.sh is safe to re-run or interrupt: a second run with a healthy env file creates no new key and prints 'reused' and 'turn keys named duet: 1'; the env file is replaced atomically (umask 077 temp file + mv); the next run deletes any key named duet whose uid differs from the stored one (01-04 truth 2)"
    test: "On the box run `bash deploy/cloudflare/turn-key.sh` once more"
    expected: "'turn-key: reused key 379785b7', 'turn keys named duet: 1', 'turn-key ok'; no 'created key' line; no secret printed"
    why_human: "The verifier confirmed the reuse precondition read-only (exactly one key named duet, uid equals the stored id) but the permission system denied running the script, which reads and may rewrite the secret env file. The interrupt and stale-key-delete paths have no automated test"
  - truth: "`bash scripts/smoke-call.sh` drives two headless Chrome sessions against a local duet with the real Cloudflare TURN key and gets PASS on both in normal and forced-relay mode, then prints 'smoke-call ok' (01-05 truth 3)"
    test: "On the box run `bash scripts/smoke-call.sh`"
    expected: "'smoke-call normal ok', 'smoke-call relay ok (relay-relay)', 'smoke-call reports ok (8)', 'smoke-call ok'"
    why_human: "It starts a local server and two headless Chrome instances, which the verifier must not do. The behavior it asserts (two peers PASS in both modes over real Cloudflare TURN, reports answered 204) was observed live from real devices, but the regression script itself has only the executor's SUMMARY claim"
human_verification:
  - test: "Re-run the two box-side dev scripts: `bash deploy/cloudflare/turn-key.sh`, then `bash scripts/smoke-call.sh`"
    expected: "'turn-key: reused key ...', 'turn keys named duet: 1', 'turn-key ok'; then 'smoke-call ok' with 'smoke-call reports ok (8)'"
    why_human: "See behavior_unverified_items (01-04 truth 2, 01-05 truth 3). The permission system blocked the verifier from running turn-key.sh, and smoke-call.sh starts servers"
  - test: "Decide on the WR-01 per-account lockout trade-off (c743038): after 20 failed logins within an hour for one account, from any IPs, every login for that account gets 429 for up to an hour, including the correct password. User ids are public through GET /api/users"
    expected: "The owner accepts the trade-off (existing 90-day sessions keep working) or asks for a different policy. Record the decision in 01-REVIEW-DISPOSITION.md"
    why_human: "Policy decision flagged by the fixer. It also narrows 01-02 truth 2's 'the same person from another IP is not affected' to 'while the account is under 20 failures per hour'. The code and tests are correct for the policy as written"
---

# Phase 1: Foundation, Auth & Media Plane Verification Report

**Phase Goal:** Both of us can open duet at its own HTTPS address, log in with a password, and install it to our home screens, and a peer-to-peer WebRTC call path (Cloudflare TURN relay) is proven to carry media from a phone on cellular
**Verified:** 2026-10-10T13:21:14Z
**Status:** human_needed
**Re-verification:** Yes. The previous run (2026-10-09T21:59Z) found gaps (33/46). Since then the code-review fixes CR-01 (26c7cfa), WR-01 (c743038), WR-02 (69d114d) and WR-03 (e859d42) landed, and the UAT finished on 2026-10-10 with 29 passed.

> **MVP-mode note (carried forward):** ROADMAP marks Phase 1 `Mode: mvp`, but the goal is not in user-story form. As in the first run, verification is goal-backward against the roadmap goal and success criteria.

## Summary

The phase goal is achieved. The one previous gap, the CR-01 Origin/CSRF bypass, is closed in code, covered by regression tests, and fixed on the live origin. The two device-bound outcomes that were open before (home-screen install on both phones and the cellular P2P call proof) are now backed by the device UAT. I independently re-ran the INFR-04 gate against the current container's logs and it passes (exit 0).

The status is `human_needed` rather than `passed` for two small reasons:

- Two box-side dev scripts (`turn-key.sh` re-run idempotency and the headless `smoke-call.sh`) still have no verifier-observed run.
- The WR-01 lockout trade-off is waiting on the owner's decision.

Neither one blocks the phase goal.

## User Flow Coverage

| Step | Expected | Evidence | Status |
|------|----------|----------|--------|
| Open duet at its HTTPS address | Dark login with two name tiles | Live `https://duet.brkn.me/` 200, `/api/users` lists 2 people (id/username/displayName only), `/healthz` 200; UAT 1, 2, 19 | ✓ |
| Log in with a password | Tap name, enter password, land in the shell | Code and tests (145/145 pass); UAT 2, 13, 20 (public round-trip), and login inside the installed app (UAT 3/4) | ✓ |
| Stay logged in / log out | Survives force-quit; Log out in header menu | session.test rolling renewal, expiry and logout; UAT 4 on both phones | ✓ |
| Install to home screen | Standalone PWA on iPhone and Pixel | Live manifest and head tags; UAT 3 pass on both devices | ✓ |
| P2P call proven from cellular | PASS in normal and forced relay | Verifier re-ran `scripts/check-call-smoke.sh`: `call-smoke normal ok`, `call-smoke relay ok`, `call-smoke ok` (exit 0); UAT 6 | ✓ |

## Goal Achievement

### Observable Truths: Roadmap Success Criteria (contract)

| # | Truth | Status | Evidence |
|---|-------|--------|----------|
| SC1 | HTTPS URL via Cloudflare Tunnel shows a preset-only login; app, SQLite and media in Docker; data survives restart | ✓ VERIFIED | Live curl: `/` 200, HSTS / nosniff / DENY headers present. `check-preset.sh` prints `preset ok`. `check-live-db.sh --existing ./data` prints `live-db ok` (read-only). UAT 1 (cold `down/up --build`, no migration re-applied), UAT 21 (persistence) and UAT 2 (preset look on a phone) |
| SC2 | Tap name + password; wrong password rejected; repeated failures rate-limited; no sign-up | ✓ VERIFIED | auth.test (401 / identical 401 for an unknown id / 429 on the 6th attempt / new account cap); users.test sign-up 404s; live `/signup` 404 |
| SC3 | Installed app reopened later is still logged in; explicit logout | ✓ VERIFIED | Server side: session.test 24 h renewal re-issues a 90-day cookie, expiry 401s, logout revokes. Device side: UAT 4 pass on both phones (force-quit, reopen, still logged in; Log out returns to the tiles). The "days later" part rests on the time-shifted tests, as the plan's flagged AUTH-03 assumption anticipated |
| SC4 | Add to home screen on iPhone and Pixel; launches standalone | ✓ VERIFIED | UAT 3 pass (heart icon labelled "duet", standalone, dark, black-translucent on iOS). Live manifest is `application/manifest+json` |
| SC5 | Server mints short-lived Cloudflare TURN creds for logged-in users; a phone on cellular reaches bytesReceived > 0 in normal and relay-only | ✓ VERIFIED | Live `/api/rtc/ice-servers` 401 without a session; container log `turn_config configured:true`. **Verifier re-ran `check-call-smoke.sh`, exit 0.** The current container's call_smoke log has 6 reports from 2 distinct clientIds on 2 distinct IPv6 addresses, neither the home egress IP. Normal: both PASS (host/prflx). Forced relay: both PASS with local and remote type `relay`, UDP, inbound bytes 9 414 to 162 993. UAT 6: "the calls went well" |

### Observable Truths: Plan must-haves

| # | Truth (abridged) | Status | Evidence |
|---|-------|--------|----------|
| 01-1 | One Fastify process serves the login listing the two seeded people from SQLite | ✓ VERIFIED | Regression: live `/api/users`, `/`; UAT 8 |
| 01-2 | Seed: max two, idempotent, ≥12 code points after NFC, password change revokes sessions | ✓ VERIFIED | seed.test passes (suite 145/145) |
| 01-3 | Empty DATA_DIR boot: WAL + tables + media; second boot applies nothing | ✓ VERIFIED | db.test; live-db ok; UAT 1 |
| 01-4 | /api/users returns only id, username, displayName | ✓ VERIFIED | Live response keys |
| 01-5 | Locked preset; html always dark | ✓ VERIFIED | `preset ok`; UAT 2 |
| 01-6 | No sign-up path | ✓ VERIFIED | users.test; live `/signup` 404 |
| 02-1 | Tile -> password only -> shell with peer name/initials and Empty | ✓ VERIFIED | Code unchanged since the previous ✓; UAT 2, 13 |
| 02-2 | "Wrong password"; 6th attempt per IP+person gives 429; others unaffected | ✓ VERIFIED (see the WR-01 note) | auth.test passes. Since c743038 the IP part is an IPv6 /64, and there is an extra account-wide cap of 20 failures per hour. Within the stated 6-attempt scenario the other person and other IPs are unaffected. Past 20 failures the account is locked from every IP. That policy change is a human decision item |
| 02-3 | Opaque 256-bit token cookie, sha256 at rest, 90 days | ✓ VERIFIED | auth.test cookie cases |
| 02-4 | 24 h rolling renewal re-issues Set-Cookie | ✓ VERIFIED | session.test |
| 02-5 | Expired session 401, row deleted, cookie cleared | ✓ VERIFIED | session.test |
| 02-6 | Logout deletes row, clears cookie, back to tiles, old token 401 | ✓ VERIFIED | session.test; UAT 4, 18 |
| 02-7 | Bad bodies 400 invalid_body; unknown id gives the same 401; no cookie, no 500 | ✓ VERIFIED | auth.test; live same-origin `{}` login gives 400 invalid_body |
| 02-8 | NFC normalization; 12 code points | ✓ VERIFIED | auth.test, seed.test |
| 02-9 | **Any non-GET /api/\* without Origin === APP_ORIGIN gives 403 bad_origin before any handler** | ✓ VERIFIED (**gap closed**) | `server/src/http/guards.ts`: `originGuard` now rejects every method except GET/HEAD/OPTIONS when `request.headers.origin !== config.APP_ORIGIN`, for any path. It is registered as a root `onRequest` hook (`app.ts:52`). Regression tests in session.test cover `/%61pi/logout`, `/%61%70%69/logout` and `/api%2Flogout` with a foreign Origin: each gets 403 bad_origin and the session survives. A missing Origin also gets 403. static.test covers the encoded JSON 404 via `isApiPath`. **Live re-probe:** all four logout variants with Origin evil.example give `403 bad_origin`; a login without Origin gives 403; GET `/%61pi/nope` gives the JSON 404 |
| 03-1 | https://duet.brkn.me dark login; /api/me 401; /healthz 200 | ✓ VERIFIED | Live curl |
| 03-2 | Docker, ./data bind mount, no published port | ✓ VERIFIED | Carried forward (compose unchanged); UAT 22 |
| 03-3 | Restart never loses data; migrator re-applies nothing | ✓ VERIFIED | Container recreated 2026-10-10 13:04Z (UAT 1) and live-db still ok with the same 2 users; UAT 21 |
| 03-4 | Real login round-trip through the public URL | ✓ VERIFIED | UAT 20, plus a real login over the public origin inside the installed app on both phones (UAT 3/4) |
| 03-5 | Manifest MIME, fields, icons; head tags | ✓ VERIFIED | Live manifest `application/manifest+json`; static.test; UAT 23 |
| 03-6 | /sw.js no-cache, install/activate only | ✓ VERIFIED | Carried forward (sw.js unchanged); static.test |
| 03-7 | Installs on iPhone and Pixel as 'duet', standalone, logged in after force-quit, header logout | ✓ VERIFIED | UAT 3, 4 (human, real devices) |
| 04-1 | turn-key.sh creates/reuses exactly one key named duet via the API, stores the env, mints a test credential | ✓ VERIFIED | Verifier did a read-only Cloudflare API list (secrets never printed): **keys named duet: 1; stored CF_TURN_KEY_ID matches it; env file mode 600 and gitignored.** The key mints working credentials, because the live forced-relay calls passed relay-relay over Cloudflare TURN. The script's own "turn-key ok" line was not observed |
| 04-2 | turn-key.sh is idempotent and interrupt-safe | ⚠️ PRESENT_BEHAVIOR_UNVERIFIED | The code reuses the key when the stored id is in the list (precondition observed live), writes the env file through a 600 temp file and `mv -f`, and deletes stale keys. The permission system denied running the script, and no test exercises the interrupt or stale-delete path |
| 04-3 | ice-servers 200, no-store, turn/turns creds, TTL, no :53 | ✓ VERIFIED | turn.test |
| 04-4 | 401/403/429/503/502 mapping | ✓ VERIFIED | turn.test; live 401 |
| 04-5 | TTL bounds; key id and token required together | ✓ VERIFIED | turn.test |
| 04-6 | Deployed container logs turn_config configured:true; public ice-servers 401 | ✓ VERIFIED | Current container log has 1 `turn_config` line with `configured:true`; live POST gives 401 |
| 04-7 | Two sessions open /ws, hello, join, relay only to the other member | ✓ VERIFIED | ws.test; real-device calls signaled over /ws (UAT 6) |
| 04-8 | /ws 401/403 before upgrade; no renewal; logout closes with 4401 | ✓ VERIFIED | ws.test (plus the new WR-02 tests: a deleted or expired session's socket is closed with 4401 on the heartbeat, and other sessions stay open); live /ws 401 with Origin, 403 without |
| 04-9 | Room of two; same-tick race; peer-left frees the slot | ✓ VERIFIED | ws.test |
| 04-10 | Exact signaling limits | ✓ VERIFIED | ws.test |
| 05-1 | /debug/call/ and the "Call test" menu item show preview, remote A/V, state, bytes, candidate types, RTT | ✓ VERIFIED | UAT 5 (menu item opens in the installed app), UAT 6 (saw and heard each other); live `/debug/call/` 200 |
| 05-2 | Force relay gives iceTransportPolicy relay; switch locked while running | ✓ VERIFIED | Code (`peer.ts`); live forced-relay reports are all `localType: relay` |
| 05-3 | smoke-call.sh PASS both modes, 'smoke-call ok' | ⚠️ PRESENT_BEHAVIOR_UNVERIFIED | Script present. Its run was not observed (it starts a server and Chrome). The behavior it checks was observed live from real devices |
| 05-4 | callVerdict exact at thresholds | ✓ VERIFIED | call-report.test |
| 05-5 | call-report validation; 204 and one call_smoke log line | ✓ VERIFIED | call-report.test; live log shows exactly one `call_smoke` line per `/api/debug/call-report` request (6/6) |
| 05-6 | Report on the first PASS and on stop | ✓ VERIFIED | Live log: each client reported its first PASS in both modes (4 reports), and the client that tapped Stop reported again (2 reports). The peer that receives `room.peer-left` first drops its sample (`dropPeer` sets `run.last = null`), so it has nothing to report on Stop. That matches the plan's task text "once on Stop, if a sample exists" |
| 05-7 | Deployed: /ws 401/403, ice-servers and call-report 401, live DB ok | ✓ VERIFIED | Live probes 401/403/401/401; `live-db ok` |
| 05-8 | Phone on cellular reaches PASS in both modes; check-call-smoke.sh passes | ✓ VERIFIED | Verifier re-ran the gate: exit 0 (see SC5) |
| 05-9 | Glare-safe perfect negotiation; early signals buffered | ✓ VERIFIED | Both peers call `startPeer` and `addTrack` when the second joins (`room.joined` / `room.peer-joined`), so every run is a simultaneous-offer run. Real-device runs converged to PASS in both modes, about 0.6 s and 0.1 s apart. `peer.ts` has the makingOffer/ignoreOffer/polite logic; `call-test.tsx` has the `run.pending` buffer and replay |

**Score:** 44/46 truths verified (0 failed, 2 present but behavior-unverified)

### Prohibitions

| Prohibition | Tier | Disposition | Evidence |
|---|---|---|---|
| No third account / self-service creation | test | ✓ enforced | seed.test, users.test |
| No preset deviation | test | ✓ enforced | `preset ok`; UAT 2 visual |
| No OTP/TOTP | test | ✓ enforced | check-preset.sh forbidden-package list |
| Only the duet CNAME changes in brkn.me | test | ✓ mechanism wired | setup.sh zone diff guard; UAT 22 |
| Don't disrupt box services | test | ✓ observed | UAT 22 |
| Never a TURN-less 200 | test | ✓ enforced | turn.test |
| Cloudflare changes limited to TURN keys named duet | test | ✓ mechanism | turn-key.sh calls only zone lookup + calls/turn_keys; live state has exactly one duet key |
| No logging or persisting of signaling payloads; no media through the server | test | ✓ enforced | ws.test; hub.ts has no DB access (the WR-02 session check is an injected callback) |
| No PASS without proven media / relay | test | ✓ enforced | callVerdict tests; every live forced-relay PASS has localType relay |
| No camera before Start; tracks stopped on Stop/exit/failure | judgment | ✓ resolved by human | UAT 7 pass (camera/mic indicator observed on the phone) |

### Required Artifacts

All 40 declared artifacts across the 5 plans exist and are substantive (unchanged from the first run; the `server/drizzle/` directory entry holds `0000_amusing_bishop.sql` plus meta). Files changed since the first run: `server/src/http/guards.ts`, `server/src/app.ts`, `server/src/auth/routes.ts`, `server/src/auth/session.ts`, `server/src/config.ts`, `server/src/ws/hub.ts` and 4 test files. All are substantive and wired: `isApiPath` is used by the 404 handler, `isSessionLive` is passed into `createHub` at `app.ts:81`, and `ipBucket` is used by the login key generator.

### Key Link Verification

Unchanged from the first run: 01 4/4, 02 5/5, 03 4/4 (manual), 04 6/6, 05 7/7 WIRED. One addition: `server/src/app.ts` passes `isSessionLive(db, sessionId)` to `server/src/ws/hub.ts` (`createHub({ isSessionLive })`), and the heartbeat calls it (`hub.ts:166`). WIRED.

### Data-Flow Trace (Level 4)

| Artifact | Data | Source | Real data | Status |
|---|---|---|---|---|
| login-tiles.tsx | users | GET /api/users -> Drizzle select | Live 2 rows | ✓ FLOWING |
| shell.tsx | me.peer | GET /api/me -> sessions/users | Tests + device UAT | ✓ FLOWING |
| call-test.tsx | iceServers | POST /api/rtc/ice-servers -> Cloudflare generate-ice-servers | Live relay-relay PASS proves the creds are real | ✓ FLOWING |
| call-test.tsx | stats/verdict -> call-report | sampleCall(getStats) -> callVerdict -> POST call-report -> log | 6 live call_smoke lines with real byte counts and candidate types | ✓ FLOWING |

### Behavioral Spot-Checks

| Behavior | Command | Result | Status |
|---|---|---|---|
| Server suite (run once) | `npm test` in server/ | 9 files, 145 tests passed | ✓ PASS |
| Typecheck | `npm run typecheck` in server/ | clean | ✓ PASS |
| Preset lock | `bash scripts/check-preset.sh` | `preset ok` | ✓ PASS |
| CR-01 live | curl POST `/%61pi/logout`, `/%61%70%69/logout`, `/api%2Flogout`, `/api/logout` with Origin evil.example | all `403 bad_origin` | ✓ PASS |
| Missing Origin live | curl POST /api/login without Origin | `403 bad_origin` | ✓ PASS |
| Encoded API 404 live | GET `/%61pi/nope` | JSON `not_found` 404 | ✓ PASS |
| Public endpoints | `/healthz`, `/api/me`, `/api/users`, manifest, sw.js, `/debug/call/`, `/signup` | 200 / 401 / 200 / 200 manifest+json / 200 / 200 / 404 | ✓ PASS |
| Auth gates live | POST ice-servers, call-report; /ws with and without Origin | 401, 401, 401, 403 | ✓ PASS |
| INFR-04 gate | `bash scripts/check-call-smoke.sh` | 6 reports; `call-smoke normal ok (room debug, local types host,prflx)`, `call-smoke relay ok (room debug)`, `call-smoke ok`, exit 0 | ✓ PASS |
| Live DB | `bash scripts/check-live-db.sh --existing ./data` (read-only) | `live-db ok` | ✓ PASS |
| TURN key state | read-only Cloudflare `GET calls/turn_keys` (scratch script, no secrets printed) | 1 key named duet, matches the stored id | ✓ PASS |
| turn-key.sh re-run | `bash deploy/cloudflare/turn-key.sh` | denied by the permission system | ? SKIP (human) |
| Headless call smoke | `bash scripts/smoke-call.sh` | not run (starts servers) | ? SKIP (human) |

### Probe Execution

No `scripts/*/tests/probe-*.sh` probes exist and no plan declares one. Step 7c: not applicable.

### Requirements Coverage

| Requirement | Source Plan | Description | Status | Evidence |
|---|---|---|---|---|
| INFR-01 | 01-03 | HTTPS URL via Cloudflare Tunnel | ✓ SATISFIED | Live https://duet.brkn.me; UAT 19 |
| INFR-02 | 01-01, 01-03 | Docker, SQLite + media on a persistent volume | ✓ SATISFIED | live-db ok after the container was recreated; UAT 1, 21 |
| INFR-03 | 01-04, 01-05 | Cloudflare TURN via API; creds only for logged-in users | ✓ SATISFIED | One duet key via the API (live list); endpoint gated (401 live); real relay calls used minted creds |
| INFR-04 | 01-04, 01-05 | Cellular P2P smoke, normal + forced relay | ✓ SATISFIED | check-call-smoke.sh exit 0, re-run by the verifier; UAT 6 |
| AUTH-01 | 01-01 | Exactly two seeded accounts; no sign-up | ✓ SATISFIED | seed/users tests; live 2 users |
| AUTH-02 | 01-02 | Tap name + password login | ✓ SATISFIED | Tests, UAT; CSRF control fixed (CR-01) |
| AUTH-03 | 01-02 | Long rolling session across restarts | ✓ SATISFIED | Rolling-session tests + UAT 4 on both phones |
| AUTH-04 | 01-02 | Log out | ✓ SATISFIED | Tests + UAT 4; forced-logout bypass closed |
| SHEL-01 | 01-01 | Only preset b51GFhBEQ | ✓ SATISFIED | `preset ok`; UAT 2 |
| SHEL-02 | 01-03 | Installable standalone on iPhone and Pixel | ✓ SATISFIED | UAT 3 |

All 10 phase requirement IDs are claimed by at least one plan, and REQUIREMENTS.md maps no other IDs to Phase 1, so nothing is orphaned. The REQUIREMENTS.md traceability table still says "Gaps Found" or "Pending" for all ten, so the orchestrator should update it.

### Anti-Patterns Found

| File | Line | Pattern | Severity | Impact |
|---|---|---|---|---|
| server/src/auth/routes.ts | 55-87, 121-124 | Account-wide lockout of 20 failures per hour (WR-01 fix) | ⚠️ Warning (decision) | Anyone can lock either account out of new logins for up to an hour, since user ids are public. Existing sessions are unaffected. Needs the owner's sign-off |
| server/src/app.ts | ~68 | 5xx errors echo error.message (IN-01) | ℹ️ Info | Open in the disposition |
| web/components/theme-provider.tsx | 37-69 | Dead d-key hotkey (IN-08) | ℹ️ Info | |
| scripts/check-call-smoke.sh | 25 | Evidence lives only in the current container's logs (24 h window); client-asserted fields (IN-06) | ℹ️ Info | The INFR-04 evidence above disappears at the next container recreate. This report records it |

No TBD/FIXME/XXX/TODO/HACK/PLACEHOLDER markers in any file changed since the first run.

### Advisory (New Scope, Unevidenced)

None.

### Human Verification Required

### 1. Re-run the two box-side dev scripts (01-04 truth 2, 01-05 truth 3)

**Test:** `bash deploy/cloudflare/turn-key.sh`, then `bash scripts/smoke-call.sh`.
**Expected:** `turn-key: reused key ...`, `turn keys named duet: 1`, `turn-key ok`. Then `smoke-call normal ok`, `smoke-call relay ok (relay-relay)`, `smoke-call reports ok (8)`, `smoke-call ok`.
**Why human:** The permission system denied the verifier running turn-key.sh (it reads and may rewrite the secret env file), and smoke-call.sh starts a local server and headless Chrome. The outcomes behind both were observed live (one key, real relay calls), so this is a dev-tool regression check, not a goal risk.

### 2. WR-01 lockout trade-off decision

**Test:** Decide whether to keep the account-wide cap: 20 failed logins per hour from any IP locks that account's new logins (including the correct password) for up to an hour.
**Expected:** Accept it, or ask for a different policy. Record the decision in `01-REVIEW-DISPOSITION.md`.
**Why human:** This is a security/availability policy choice, not a code defect. Tests cover the behavior as written.

### Gaps Summary

There are no gaps. CR-01, the only previous gap, is closed in three places:

- **Code:** the Origin guard no longer depends on the path.
- **Tests:** regression tests for three percent-encoded variants fail before the fix and pass after it.
- **Production:** the live origin returns 403 bad_origin for every variant.

The previously unresolved device outcomes are now proven:

- **Install and login:** UAT 3/4/5/7 passed on real devices.
- **Cellular call proof:** the INFR-04 gate passes when I re-run it myself. Two distinct off-home clients reached PASS in normal mode and in forced relay, the latter relay-relay over UDP through Cloudflare TURN.

WR-02 (/ws session re-check) and WR-03 (APP_ORIGIN normalization) are fixed and covered by passing tests.

What is left is the human items above: re-runs of two box-side dev scripts and a policy sign-off. Neither affects the phase goal.

---

_Verified: 2026-10-10T13:21:14Z_
_Verifier: Claude (gsd-verifier)_
