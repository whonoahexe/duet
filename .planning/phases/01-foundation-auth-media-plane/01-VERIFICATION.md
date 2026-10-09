---
phase: 01-foundation-auth-media-plane
verified: 2026-10-09T21:59:19Z
status: gaps_found
score: 33/46 must-haves verified
covered_files: [".dockerignore",".env.example",".planning/phases/01-foundation-auth-media-plane/01-01-PLAN.md",".planning/phases/01-foundation-auth-media-plane/01-01-SUMMARY.md",".planning/phases/01-foundation-auth-media-plane/01-02-PLAN.md",".planning/phases/01-foundation-auth-media-plane/01-02-SUMMARY.md",".planning/phases/01-foundation-auth-media-plane/01-03-PLAN.md",".planning/phases/01-foundation-auth-media-plane/01-03-SUMMARY.md",".planning/phases/01-foundation-auth-media-plane/01-04-PLAN.md",".planning/phases/01-foundation-auth-media-plane/01-04-SUMMARY.md",".planning/phases/01-foundation-auth-media-plane/01-05-PLAN.md",".planning/phases/01-foundation-auth-media-plane/01-05-SUMMARY.md","Dockerfile","compose.yaml","deploy/cloudflare/turn-key.sh","deploy/cloudflared/setup.sh","package.json","scripts/check-call-smoke.sh","scripts/check-live-db.sh","scripts/check-preset.sh","scripts/gen-icons.mjs","scripts/smoke-call.mjs","scripts/smoke-call.sh","scripts/smoke-local.sh","scripts/smoke-persistence.sh","scripts/smoke-public.sh","server/drizzle.config.ts","server/drizzle/0000_amusing_bishop.sql","server/package.json","server/scripts/seed-users.ts","server/src/app.ts","server/src/auth/password.ts","server/src/auth/routes.ts","server/src/auth/session.ts","server/src/config.ts","server/src/db/client.ts","server/src/db/schema.ts","server/src/db/seed.ts","server/src/http/guards.ts","server/src/index.ts","server/src/routes/users.ts","server/src/rtc/routes.ts","server/src/rtc/turn.ts","server/src/ws/hub.ts","server/src/ws/routes.ts","server/test/auth.test.ts","server/test/call-report.test.ts","server/test/db.test.ts","server/test/helpers.ts","server/test/seed.test.ts","server/test/session.test.ts","server/test/static.test.ts","server/test/turn.test.ts","server/test/users.test.ts","server/test/ws.test.ts","server/vitest.config.ts","shared/package.json","shared/src/api.ts","shared/src/index.ts","shared/src/rtc.ts","shared/src/ws.ts","web/app/debug/call/page.tsx","web/app/layout.tsx","web/app/manifest.ts","web/app/page.tsx","web/components.json","web/components/app/call-test.tsx","web/components/app/login-tiles.tsx","web/components/app/password-step.tsx","web/components/app/shell.tsx","web/components/app/sw-register.tsx","web/components/theme-provider.tsx","web/lib/api.ts","web/lib/rtc/ice.ts","web/lib/rtc/peer.ts","web/lib/rtc/stats.ts","web/lib/utils.ts","web/lib/ws.ts","web/next.config.ts","web/package.json","web/public/sw.js"]
covered_digest: "v3:sha256:904e1bab6f30837029cf4dcb50bfdf9a5898c1c1cf3f0a0802d59e82d1da1ec0"
behavior_unverified: 5
overrides_applied: 0
gaps:
  - truth: "Any non-GET /api/* request whose Origin header is not exactly APP_ORIGIN (including a missing Origin) is rejected 403 {error:'bad_origin'} before any handler runs (01-02 must-have; CSRF control T-01-08)"
    status: failed
    reason: "originGuard classifies requests with isApiUrl(request.url) on the RAW, undecoded URL, while find-my-way percent-decodes before routing. A percent-encoded /api prefix skips the guard and still reaches the /api handler. Reproduced independently by the verifier (scratch app.inject probe): POST /api/logout + foreign Origin + valid cookie -> 403 bad_origin; POST /%61pi/logout + foreign Origin + same cookie -> 200 {ok:true} and the session is revoked (GET /api/me then 401). Also live on https://duet.brkn.me: POST /%61pi/logout with Origin https://evil.example answers 401 unauthenticated (handler reached) instead of 403 bad_origin. Matches 01-REVIEW.md CR-01 (disposition: open)."
    artifacts:
      - path: "server/src/http/guards.ts"
        issue: "isApiUrl(request.url) on lines 6-8/16 uses the raw URL; percent-encoded paths bypass the Origin check"
      - path: "server/src/app.ts"
        issue: "setNotFoundHandler uses the same raw-URL prefix test (line ~117), so /%61pi/x gets the HTML 404 instead of the JSON one"
      - path: "server/test/auth.test.ts"
        issue: "Origin tests only exercise the literal /api/ prefix; no percent-encoded regression case"
    missing:
      - "Require Origin === APP_ORIGIN for every non-safe method regardless of path (the server has no non-API state-changing routes), or classify by request.routeOptions.url instead of request.url"
      - "Regression test: POST /%61pi/logout (and /%61pi/login) with a foreign Origin and a valid cookie -> 403 bad_origin, session survives"
      - "Apply the same decoding/route-based check in the not-found handler"
      - "Redeploy so the live origin enforces it, then re-run scripts/smoke-public.sh"
behavior_unverified_items:
  - truth: "turn-key.sh creates or reuses exactly one Cloudflare TURN key named duet via the API, stores CF_TURN_KEY_ID / CF_TURN_KEY_API_TOKEN, mints a 60 s test credential and prints 'turn-key ok' (01-04 truth 1)"
    test: "Run `bash deploy/cloudflare/turn-key.sh` on the box"
    expected: "'turn-key: reused key ...', 'turn keys named duet: 1', 'turn-key ok'; no secret printed"
    why_human: "The verifier did not call the Cloudflare account API (state-changing surface). Only the boot log line turn_config configured:true was observed, which proves the env vars are present, not that the key mints"
  - truth: "turn-key.sh is safe to re-run or interrupt: second run reuses, env file replaced atomically, stale duet keys deleted (01-04 truth 2)"
    test: "Re-run turn-key.sh a second time (same as above)"
    expected: "No new key created; 'reused' and 'turn keys named duet: 1'"
    why_human: "Idempotency is a runtime property against the live Cloudflare account; code shows umask 077 + mv -f and list/delete calls but no automated test exercises it"
  - truth: "`bash scripts/smoke-call.sh` gets PASS on both headless peers in normal and forced-relay mode with real TURN and prints 'smoke-call ok' (01-05 truth 3)"
    test: "Run `bash scripts/smoke-call.sh` on the box"
    expected: "'smoke-call normal ok', 'smoke-call relay ok (relay-relay)', 'smoke-call reports ok (8)', 'smoke-call ok'"
    why_human: "Starts a local server and two headless Chrome instances against real Cloudflare TURN; outside the verifier's no-server constraint. Only the SUMMARY claims it passed"
  - truth: "Each harness instance POSTs its CallReport on the first PASS of a run and again when the run stops (01-05 truth 6)"
    test: "Covered by the smoke-call.sh run above (it asserts >= 8 reports, all 204)"
    expected: "'smoke-call reports ok (8)'"
    why_human: "Ordering/cleanup invariant in the browser run loop (stopRun, pagehide); only the e2e smoke exercises it"
  - truth: "Negotiation is glare-safe (perfect negotiation, polite = own connId > peer connId) and rtc.signal frames arriving before the peer exists are buffered and replayed (01-05 truth 9)"
    test: "Covered by the smoke-call.sh run above (both peers click Start at the same moment)"
    expected: "Both modes converge to PASS"
    why_human: "Ordering invariant in browser WebRTC code; no unit test, only the headless e2e smoke"
human_verification:
  - test: "01-03 device install UAT. iPhone (Safari): open https://duet.brkn.me, Share -> Add to Home Screen, launch 'duet', log in INSIDE the installed app, force-quit and reopen, header menu -> Log out, log back in. Pixel (Chrome): menu -> Install app, same steps. In each browser open https://duet.brkn.me/signup."
    expected: "Icon is the light heart on rose labelled 'duet'; launches standalone (no address bar), dark, black-translucent status bar; still logged in after force-quit; Log out returns to the two name tiles; /signup shows the not-found page; the UI looks like the locked preset (SHEL-01 visual fidelity)"
    why_human: "Home-screen install, standalone launch and the installed app's cookie jar surviving a force-quit only exist on the real devices"
  - test: "01-05 cellular call UAT (INFR-04 gate). Phone A with Wi-Fi OFF opens the installed app -> header menu -> Call test; client B (other phone or a laptop) opens Call test. Normal mode: Start on both until PASS and you see/hear each other, Stop. Then Force relay ON: Start until PASS with Local candidate 'relay' on both, Stop. Then run `bash scripts/check-call-smoke.sh`."
    expected: "check-call-smoke.sh prints 'call-smoke normal ok', 'call-smoke relay ok', 'call-smoke ok'. Today (verified 2026-10-09T21:5xZ) it prints 0 PASS reports and 'INFR-04 gate not met' (exit 1). Run it within 24 h of the test and before any redeploy: it reads `docker compose logs` of the current duet container, so recreating the container discards the evidence"
    why_human: "Only a real phone on a real cellular network can prove the CGNAT-to-cellular media path"
  - test: "Privacy prohibition (judgment tier, 01-05): during the cellular UAT watch the camera/mic indicator"
    expected: "Indicator stays off until Start is tapped and goes off after Stop, after leaving the page, and after a failed run"
    why_human: "Judgment-tier prohibition; code shows getUserMedia only inside start() and track.stop() in stopRun/pagehide, but the OS indicator is the real proof"
  - test: "Re-run `bash scripts/smoke-call.sh` and `bash deploy/cloudflare/turn-key.sh` on the box (see behavior_unverified_items)"
    expected: "'smoke-call ok' and 'turn-key ok' with 'turn keys named duet: 1'"
    why_human: "Both need real Cloudflare TURN and (for smoke-call) a local server plus headless Chrome"
---

# Phase 1: Foundation, Auth & Media Plane Verification Report

**Phase Goal:** Both of us can open duet at its own HTTPS address, log in with a password, and install it to our home screens, and a peer-to-peer WebRTC call path (Cloudflare TURN relay) is proven to carry media from a phone on cellular
**Verified:** 2026-10-09T21:59:19Z
**Status:** gaps_found
**Re-verification:** No, this is the initial verification

> **MVP-mode discrepancy:** ROADMAP marks Phase 1 `Mode: mvp`, but the goal is not in user-story form ("As a ..., I want to ..., so that ..."). Plan 01-01 already flagged this. As the orchestrator requested, verification ran goal-backward against the roadmap goal and success criteria. Run `/gsd-mvp-phase 1` if the story form matters for later tooling.

## User Flow Coverage

| Step | Expected | Evidence | Status |
|------|----------|----------|--------|
| Open duet at its HTTPS address | Dark login screen with two name tiles | Live `https://duet.brkn.me/` 200; `/api/users` returns 2 users with only id/username/displayName; `/healthz` 200 | ✓ |
| Log in with a password | Tap name, enter password, land in shell | `web/app/page.tsx` state machine -> `password-step.tsx` `apiPost('/api/login')` -> `shell.tsx`; auth.test happy path + errors + rate limit pass | ✓ |
| Stay logged in / log out | 90-day rolling cookie; Log out in header menu | session.test rolling renewal / expiry / logout pass; `shell.tsx` Log out item | ✓ server side; installed-app persistence needs a human |
| Install to home screen | Standalone PWA on iPhone and Pixel | Manifest and head tags live and correct; SW install/activate only | ? human (device UAT) |
| P2P call proven from cellular | PASS in normal and forced relay from a phone on cellular | Harness, TURN mint and /ws are in place and deployed; `check-call-smoke.sh` today reports **0 PASS reports, gate not met** | ? human (cellular UAT) |

## Goal Achievement

### Observable Truths: Roadmap Success Criteria (contract)

| # | Truth | Status | Evidence |
|---|-------|--------|----------|
| SC1 | HTTPS URL via Cloudflare Tunnel shows a login built only from preset b51GFhBEQ; app, SQLite and media dir in Docker; data survives restart | ✓ VERIFIED | Live curl of `/`, `/healthz`, `/api/me` 401; `compose.yaml` has the duet service with no `ports:` and `./data:/data`, and cloudflared ingress `duet.brkn.me -> http://duet:3100`; `web/components.json` style `base-luma`, iconLibrary `phosphor`; `check-preset.sh` prints `preset ok`. Read-only live DB: 2 users, WAL, 1 migration, `data/media` exists, the DB dates from Oct 9 and the container has restarted since (Up 10 min) with data intact. Visual fidelity goes to the device UAT |
| SC2 | Tap name + password login; wrong password rejected; repeated failures rate-limited; no sign-up path | ✓ VERIFIED | auth.test: wrong password 401, unknown id gives the identical 401, 6th attempt 429 per CF-Connecting-IP+userId. users.test: `/api/register` and `/api/signup` give JSON 404. Live `/signup` 404. No sign-up UI found (grep). See WR-01 for a limit weakness |
| SC3 | Installed app reopened days later is still logged in; explicit logout | ? UNCERTAIN (human) | Server side verified: session.test renewal re-issues a 90-day cookie, expiry gives 401 and deletes the row, logout revokes. Persistence of the installed iOS/Android app's cookie across a force-quit is device-only |
| SC4 | Add to home screen on iPhone and Pixel; launches standalone | ? UNCERTAIN (human) | Live manifest: id/start_url `/`, `standalone`, #090b0c, 192/512/maskable icons, `application/manifest+json`; head has manifest, apple-touch-icon, black-translucent, theme-color, viewport-fit=cover; `sw.js` has 2 listeners (install, activate). The install itself is device-only |
| SC5 | Server mints short-lived Cloudflare TURN creds for logged-in users; from a phone on cellular the harness reports bytesReceived > 0 in normal and relay-only | ? UNCERTAIN (human) | TURN minting is in place and gated (turn.test; live ice-servers 401 without session; boot log `turn_config configured:true`). The cellular proof is **not yet done**: `bash scripts/check-call-smoke.sh` printed `call_smoke reports in window: 0 ... INFR-04 gate not met` (exit 1) |

### Observable Truths: Plan must-haves

| # | Truth (abridged) | Status | Evidence |
|---|-------|--------|----------|
| 01-1 | One Fastify process on :3100 serves login listing the two seeded people from SQLite | ✓ VERIFIED | `server/src/app.ts` registers fastifyStatic(WEB_OUT) and the API in one instance; live deploy serves both |
| 01-2 | Seed: at most two, idempotent, >=12 code points after NFC, refuses third, password change revokes sessions | ✓ VERIFIED | `seed.ts` MAX_ACCOUNTS=2, tx session delete on reset; seed.test 8 cases pass |
| 01-3 | Empty DATA_DIR boot creates WAL duet.sqlite + tables + media dir; second boot applies nothing | ✓ VERIFIED | db.test both cases pass; live DB WAL, 1 migration row |
| 01-4 | GET /api/users returns only id, username, displayName | ✓ VERIFIED | users.test; live response keys checked |
| 01-5 | Locked preset (base-luma, phosphor); html always dark | ✓ VERIFIED | components.json; `ThemeProvider forcedTheme="dark"` in layout.tsx; check-preset ok (IN-08: the d-key hotkey still writes "light" to localStorage, but it has no visible effect) |
| 01-6 | No sign-up path: /api/register and /api/signup give a 404 JSON; no create-account UI | ✓ VERIFIED | users.test; UI grep finds nothing |
| 02-1 | Tile -> password only -> shell with peer name/initials and Empty | ✓ VERIFIED | page.tsx, password-step.tsx (no visible username field; hidden autocomplete input only), shell.tsx Avatar + Empty "No messages yet" |
| 02-2 | "Wrong password" copy; 6th attempt per IP+person gives 429; others unaffected | ✓ VERIFIED | password-step.tsx copy; auth.test rate limit case |
| 02-3 | Opaque 256-bit token, httpOnly, Lax, Path=/, Secure when configured, sha256 at rest, 90 days | ✓ VERIFIED | session.ts `randomBytes(32)`, `hashToken`, setCookie flags; auth.test cookie cases |
| 02-4 | Renewal after 24 h extends expires_at and re-issues Set-Cookie | ✓ VERIFIED | session.test "after 24 h extends expires_at ... re-issues a 90-day cookie" passes |
| 02-5 | Expired session gives 401, row deleted, cookie cleared | ✓ VERIFIED | session.test expiry passes |
| 02-6 | Logout deletes row, clears cookie, returns to tiles; old token gives 401 | ✓ VERIFIED | session.test logout; shell.tsx Log out -> onLoggedOut -> loadTiles |
| 02-7 | Bad bodies give 400 invalid_body; unknown id gives the same 401; never a cookie or 500 | ✓ VERIFIED | auth.test login errors and malformed JSON cases |
| 02-8 | NFC normalization for seed and login; 12 code points | ✓ VERIFIED | auth.test Unicode case; seed.test emoji case |
| 02-9 | **Any non-GET /api/\* request without Origin === APP_ORIGIN gives 403 bad_origin before any handler runs** | ✗ FAILED | **Reproduced CR-01:** `POST /%61pi/logout` with a foreign Origin and a valid cookie returned 200 and revoked the session (scratch inject probe). Live: `POST https://duet.brkn.me/%61pi/logout` with Origin evil.example returned `unauthenticated` (handler reached), not `bad_origin` |
| 03-1 | https://duet.brkn.me shows the dark login with the two people; /api/me 401; /healthz 200 | ✓ VERIFIED | Live curl |
| 03-2 | Docker on this box, ./data bind mount, duet publishes no host port | ✓ VERIFIED | compose.yaml has no `ports:`; `docker compose ps` publisher `{3100 0}` (exposed, not published) |
| 03-3 | Restart never loses data; migrator re-applies nothing | ✓ VERIFIED | Container recently restarted (Up 10 min); the live DB still has 2 users and 1 migration; db.test covers the second boot |
| 03-4 | Real login round-trip through the public URL (Secure cookie, me 200, logout 200) | ? UNCERTAIN (human) | Not re-run: it needs a real password and mutates sessions. Only the SUMMARY claims it. The device UAT's login inside the installed app covers it |
| 03-5 | Manifest MIME + fields + icons; head tags | ✓ VERIFIED | Live manifest and head tags; static.test passes |
| 03-6 | /sw.js no-cache, install/activate only, no fetch interception | ✓ VERIFIED | sw.js has exactly 2 addEventListener calls (install, activate); static.test no-cache; SwRegister uses `updateViaCache:"none"` (Cloudflare rewrites the edge Cache-Control) |
| 03-7 | Installs on iPhone and Pixel as 'duet', standalone, logged in after force-quit, header logout | ? UNCERTAIN (human) | Device UAT |
| 04-1 | turn-key.sh creates/reuses one key via the API, stores env, mints a test credential, prints ok | ⚠️ PRESENT_BEHAVIOR_UNVERIFIED | Script is substantive (calls/turn_keys list/create/delete, `.result.key // .result.secret`, exit 3 billing). The verifier did not run it against Cloudflare. The boot log shows the env is configured |
| 04-2 | turn-key.sh idempotent and interrupt-safe | ⚠️ PRESENT_BEHAVIOR_UNVERIFIED | `umask 077` + `mv -f` temp file + stale-key delete are present; no test exercises them |
| 04-3 | POST /api/rtc/ice-servers gives 200, no-store, turn/turns with creds, TTL, no :53 | ✓ VERIFIED | turn.test mint, port-53 filter, no-store cases (mocked Cloudflare) |
| 04-4 | 401 / 403 / 429 / 503 / 502 mapping | ✓ VERIFIED | turn.test endpoint cases |
| 04-5 | TTL 60..172800 bounds; key id and token required together | ✓ VERIFIED | turn.test TURN config cases |
| 04-6 | Deployed container logs turn_config configured:true; public ice-servers 401 | ✓ VERIFIED | Live `docker compose logs` shows `"evt":"turn_config","configured":true`; public POST gives 401 |
| 04-7 | Two sessions open /ws, get hello, join a room, signal relayed only to the other, unchanged | ✓ VERIFIED | ws.test rooms and relay |
| 04-8 | /ws 401/403 before the upgrade; no renewal over /ws; logout closes with 4401 | ✓ VERIFIED | ws.test auth and logout/no-renew cases; live /ws gives 401 with Origin and 403 without |
| 04-9 | Room of two; same-tick race admits exactly two; peer-left frees the slot | ✓ VERIFIED | ws.test cases |
| 04-10 | Exact signaling limits (65536/2048, bad_frame, 1008, 1009) | ✓ VERIFIED | ws.test size/rate/payload cases |
| 05-1 | /debug/call/ (and the "Call test" menu item) shows preview, remote A/V, state, bytes, candidate types, RTT | ? UNCERTAIN (human) | call-test.tsx and page exist; the menu item is in shell.tsx; live `/debug/call/` 200. On-device view is part of the cellular UAT |
| 05-2 | Force relay gives iceTransportPolicy relay with fetched ICE servers; switch locked while running | ✓ VERIFIED | peer.ts `iceTransportPolicy: o.forceRelay ? "relay" : "all"`; call-test.tsx Switch `disabled={running}`; `fetchIceServers()` before the socket |
| 05-3 | smoke-call.sh PASS in both modes, 'smoke-call ok' | ⚠️ PRESENT_BEHAVIOR_UNVERIFIED | Script exists (71+171 lines). Not run by the verifier (starts a server and Chrome against real TURN) |
| 05-4 | callVerdict exact at thresholds | ✓ VERIFIED | call-report.test threshold table; shared/src/rtc.ts implementation matches |
| 05-5 | call-report accepts only a valid CallReport; 204 and one call_smoke log line | ✓ VERIFIED | call-report.test cases |
| 05-6 | Harness reports on the first PASS and on stop | ⚠️ PRESENT_BEHAVIOR_UNVERIFIED | Code: report on the first pass + stopRun (pagehide etc.); only the e2e smoke exercises it |
| 05-7 | Deployed: /ws 401/403, ice-servers and call-report 401, live DB passes | ✓ VERIFIED | Live curl checks; read-only DB inspection |
| 05-8 | Phone on cellular reaches PASS in both modes; check-call-smoke.sh passes | ? UNCERTAIN (human) | **Gate not met today**: 0 call_smoke reports |
| 05-9 | Glare-safe perfect negotiation; early signals buffered | ⚠️ PRESENT_BEHAVIOR_UNVERIFIED | peer.ts makingOffer/ignoreOffer pattern; call-test.tsx `run.pending` buffer and replay; only the e2e smoke exercises it |

**Score:** 33/46 truths verified (1 failed, 7 needing a human, 5 present but behavior-unverified)

### Prohibitions

| Prohibition | Tier | Disposition | Evidence |
|---|---|---|---|
| No third account / self-service creation (01-01) | test | ✓ enforced | seed.test refuses a third account; users.test sign-up 404s |
| No preset deviation (01-01) | test | ✓ enforced | check-preset.sh (forbidden packages/imports, forcedTheme) passes; visual check is part of the device UAT |
| No OTP/TOTP (01-02) | test | ✓ enforced | check-preset.sh rejects otplib/qrcode/input-otp |
| Only the duet CNAME changes in brkn.me (01-03) | test | ✓ mechanism wired | setup.sh whole-zone before/after diff guard; historical adherence is a SUMMARY claim |
| Don't disrupt box services (01-03) | test | ✓ observed | tailscale 100.97.55.101:443 listening; 3 sideby-staging containers running |
| Never a TURN-less 200 (01-04) | test | ✓ enforced | turn.test: STUN-only / empty / failing gives turn_unavailable or turn_unconfigured |
| Cloudflare changes limited to TURN keys named duet (01-04) | test | ✓ mechanism | turn-key.sh calls only zone lookup + calls/turn_keys |
| No logging or persisting of signaling payloads; no media through the server (01-04) | test | ✓ enforced | ws.test "never signaling contents"; hub.ts imports no DB code |
| No PASS without proven media / relay (01-05) | test | ✓ enforced | callVerdict threshold tests |
| No camera before Start; tracks stopped on Stop/exit/failure (01-05) | judgment | ⚠ unverified prohibition, human review recommended | Code: getUserMedia only in start(); track.stop() in stopRun and pagehide. Goes to the cellular UAT |

### Required Artifacts

All 40 declared artifacts across the 5 plans exist and are substantive (`verify.artifacts`: 01 7/8, 02 5/5, 03 7/7, 04 9/9, 05 11/11). The one 01 "failure" is the tool rejecting a directory path (`server/drizzle/`). The directory holds `0000_amusing_bishop.sql` plus meta, so it is ✓ VERIFIED.

### Key Link Verification

| Plan | Result | Notes |
|---|---|---|
| 01 | 4/4 WIRED | |
| 02 | 5/5 WIRED | |
| 03 | 1/4 by tool, 4/4 by manual check | The tool cannot parse "compose.yaml cloudflared service" as a path. Manually: `deploy/cloudflared/config.yml` ingress `duet.brkn.me -> http://duet:3100` ✓; compose `./data:/data` + `DATA_DIR: /data` ✓; `layout.tsx` renders `<SwRegister/>`, which calls `navigator.serviceWorker.register("/sw.js")` ✓ (the pattern lives in sw-register.tsx, not in layout.tsx) |
| 04 | 6/6 WIRED | |
| 05 | 7/7 WIRED | |

### Data-Flow Trace (Level 4)

| Artifact | Data | Source | Real data | Status |
|---|---|---|---|---|
| login-tiles.tsx | users | GET /api/users -> Drizzle select on users | Live returns the 2 seeded rows | ✓ FLOWING |
| shell.tsx | me.peer | GET /api/me -> sessions join users + peer select | Tests and code | ✓ FLOWING |
| call-test.tsx | iceServers | POST /api/rtc/ice-servers -> Cloudflare generate-ice-servers | Mocked in tests; live is configured | ✓ FLOWING (live mint not observed by the verifier) |
| call-test.tsx | stats/verdict | sampleCall(pc) getStats -> callVerdict | Browser runtime | ? human |

### Behavioral Spot-Checks

| Behavior | Command | Result | Status |
|---|---|---|---|
| Server suite | `npm --prefix server run test` (run once) | 9 files, 113 tests passed | ✓ PASS |
| Preset lock | `bash scripts/check-preset.sh` | `preset ok` | ✓ PASS |
| Public endpoints | curl `/healthz`, `/api/me`, `/api/users`, manifest, sw.js, `/debug/call/`, `/signup` | 200 / 401 / 200 (2 users, 3 keys) / 200 manifest+json / 200 / 200 / 404 | ✓ PASS |
| Public auth gates | curl POST ice-servers, call-report; /ws upgrade with and without Origin | 401, 401, 401, 403 | ✓ PASS |
| Origin guard | scratch `app.inject` probe + live curl `POST /%61pi/logout` (foreign Origin) | 200 and session revoked (inject); `unauthenticated` (live) | ✗ FAIL |
| TURN configured in prod | `docker compose logs duet` | `turn_config configured:true` | ✓ PASS |
| INFR-04 gate | `bash scripts/check-call-smoke.sh` | 0 reports, "gate not met", exit 1 | ? human (UAT not run) |
| Live DB | python3 sqlite read-only | users 2, wal, 1 migration, tables users/sessions/__drizzle_migrations | ✓ PASS |

### Probe Execution

No `scripts/*/tests/probe-*.sh` probes exist, and no plan declares one. Step 7c: not applicable. The phase's own check scripts were run as spot-checks above (check-preset, check-call-smoke).

### Requirements Coverage

| Requirement | Source Plan | Description | Status | Evidence |
|---|---|---|---|---|
| INFR-01 | 01-03 | HTTPS URL via Cloudflare Tunnel | ✓ SATISFIED | Live https://duet.brkn.me through the cloudflared tunnel |
| INFR-02 | 01-01, 01-03 | App, SQLite, media in Docker, persistent volume | ✓ SATISFIED | compose ./data:/data; live DB + media dir; survives restart |
| INFR-03 | 01-04, 01-05 | Cloudflare TURN via API; creds only for logged-in users | ✓ SATISFIED | Endpoint gated (401/403/429), tests pass, prod configured. Live mint not re-observed (see behavior_unverified_items) |
| INFR-04 | 01-04, 01-05 | Cellular P2P smoke, normal + forced relay | ? NEEDS HUMAN | Harness, gate and deploy in place; gate currently reports 0 PASS. REQUIREMENTS.md correctly shows Pending |
| AUTH-01 | 01-01 | Exactly two seeded accounts; no sign-up | ✓ SATISFIED | seed cap tests; sign-up 404s; live 2 users |
| AUTH-02 | 01-02 | Tap name + password login | ✓ SATISFIED (functional), but see the gap | Login works and is tested. Its CSRF control (Origin guard, mapped to AUTH-02 in the 01-02 coverage) has the CR-01 bypass |
| AUTH-03 | 01-02 | Long rolling session across restarts | ✓ SATISFIED (server) + ? human | Rolling renewal tests pass; installed-app persistence goes to the device UAT. REQUIREMENTS.md already ticks it [x] before the UAT |
| AUTH-04 | 01-02 | User can log out | ✓ SATISFIED | Logout tests; header menu. Note: CR-01 also allows a cross-site forced logout via `/%61pi/logout` from same-site origins |
| SHEL-01 | 01-01 | Built only from preset b51GFhBEQ | ✓ SATISFIED | components.json, check-preset ok; visual fidelity goes to the device UAT |
| SHEL-02 | 01-03 | Installable standalone on iPhone and Pixel | ? NEEDS HUMAN | Manifest/head/SW verified; install is device-only. REQUIREMENTS.md already ticks it [x] before the UAT |

All 10 phase requirement IDs are claimed by at least one plan. REQUIREMENTS.md maps no extra IDs to Phase 1, so there are no orphans.

### Anti-Patterns Found

| File | Line | Pattern | Severity | Impact |
|---|---|---|---|---|
| server/src/http/guards.ts | 6-8, 16 | Security check on the raw `request.url` (CR-01) | 🛑 Blocker | Origin/CSRF guard bypass; fails the 02-9 truth |
| server/src/auth/routes.ts | 25-30 | Login limit keyed only on (IP, userId) (WR-01) | ⚠️ Warning | IPv6 /64 or IP rotation multiplies brute-force attempts; no per-account cap |
| server/src/ws/hub.ts | 172-220 | Session checked only at upgrade (WR-02) | ⚠️ Warning | A seed-CLI password reset or session expiry does not close open /ws sockets; matters once Phase 2 puts chat on /ws |
| server/src/config.ts | 18, 45 | APP_ORIGIN not normalized (WR-03) | ⚠️ Warning | A trailing slash or uppercase host silently 403s every POST and /ws |
| server/src/app.ts | 68 | 5xx errors echo error.message (IN-01) | ℹ️ Info | |
| web/components/theme-provider.tsx | 37-69 | Dead d-key hotkey writes "light" (IN-08) | ℹ️ Info | |
| scripts/check-call-smoke.sh | 25 | Evidence read from `docker compose logs` of the current container, 24 h window | ℹ️ Info | A redeploy before running the gate erases the UAT evidence; IN-06 also notes the reports are client-asserted |

No TBD/FIXME/XXX/TODO/placeholder markers in any phase file.

### Human Verification Required

### 1. Device install UAT (01-03; SC3, SC4, SHEL-01 visuals, SHEL-02, AUTH-03)

**Test:** iPhone (Safari): open https://duet.brkn.me, Share -> Add to Home Screen, launch "duet", log in inside the installed app, force-quit and reopen, header menu -> Log out, log back in. Pixel (Chrome): menu -> Install app, same steps. Open https://duet.brkn.me/signup in each browser.
**Expected:** Light heart on rose icon named "duet"; standalone, dark, no address bar; still logged in after force-quit; Log out returns to the two name tiles; /signup shows not found; looks like the locked preset.
**Why human:** Home-screen install and the installed app's cookie jar exist only on the devices.

### 2. Cellular call UAT (01-05; SC5, INFR-04)

**Test:** Phone A on cellular (Wi-Fi off) and client B both open Call test. Run normal mode to PASS on both, then Stop. Then turn Force relay on and run to PASS with Local candidate "relay" on both, then Stop. Keep both apps in the foreground. Then run `bash scripts/check-call-smoke.sh`.
**Expected:** `call-smoke normal ok`, `call-smoke relay ok`, `call-smoke ok`. It currently prints 0 PASS reports. Run the gate before any redeploy, because it reads the current container's logs.
**Why human:** Needs a real phone on a real cellular network.

### 3. Camera privacy (01-05 judgment prohibition)

**Test:** Watch the camera/mic indicator during the cellular UAT.
**Expected:** Off before Start; off after Stop, after leaving the page, and after a failed run.
**Why human:** Judgment-tier prohibition.

### 4. Re-run the live-TURN scripts (behavior-unverified truths 04-1, 04-2, 05-3, 05-6, 05-9)

**Test:** `bash deploy/cloudflare/turn-key.sh`, then `bash scripts/smoke-call.sh`.
**Expected:** `turn-key ok` with `turn keys named duet: 1`; `smoke-call ok` with `reports ok (8)`.
**Why human:** They hit the live Cloudflare account and start a local server and headless Chrome, which is outside the verifier's no-server constraint.

### Gaps Summary

One must-have fails, and it is a security control. The Origin/CSRF guard (01-02 truth 9, threat T-01-08) can be bypassed by percent-encoding the `/api` prefix, because `originGuard` checks the raw `request.url` while the router decodes it. I reproduced this myself, not just from 01-REVIEW.md: `POST /%61pi/logout` with a foreign Origin and a valid cookie returns 200 and revokes the session. The production origin also lets the request reach the handler. SameSite=Lax and JSON-only bodies stop most cross-site abuse today, but same-site origins (any other `*.brkn.me` host) still send the cookie. Every POST route Phase 2 adds (send, upload, push subscribe) would inherit the hole. The fix is small: require the exact Origin for every non-safe method, or classify by `request.routeOptions.url`. Add a regression test and redeploy. No later phase covers this, so it is not deferred.

Everything else that can be checked programmatically holds. The live HTTPS deploy, Docker persistence, two-account seed, password login, rate limit, rolling session, logout, PWA manifest and SW, TURN minting and the /ws signaling hub are all present, wired and tested (113/113 server tests pass). The phase goal's two device-bound outcomes are **not yet demonstrated**: home-screen install on both phones, and the cellular P2P call proof. `check-call-smoke.sh` currently reports the INFR-04 gate as not met, and Phase 3 is blocked on it. Per the orchestrator, these are human-verification items, not gaps. REQUIREMENTS.md already ticks SHEL-02 and AUTH-03 as complete even though the device UAT that proves them has not run.

Warnings WR-01, WR-02 and WR-03 don't fail a stated truth, but WR-02 should be fixed before Phase 2 moves chat onto /ws.

---

_Verified: 2026-10-09T21:59:19Z_
_Verifier: Claude (gsd-verifier)_
