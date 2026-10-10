---
status: testing
phase: 01-foundation-auth-media-plane
source: [01-01-SUMMARY.md, 01-02-SUMMARY.md, 01-03-SUMMARY.md, 01-04-SUMMARY.md, 01-05-SUMMARY.md]
started: 2026-10-10T12:58:49Z
updated: 2026-10-10T13:23:31Z
---

## Current Test

number: 30
name: Re-run TURN key and headless call smoke scripts on the box
expected: |
  `bash deploy/cloudflare/turn-key.sh` prints `reused key …`, `turn keys named duet: 1`, `turn-key ok`; then `bash scripts/smoke-call.sh` prints `smoke-call reports ok (8)` and `smoke-call ok`
awaiting: user response

## Tests

### 1. Cold Start Smoke Test
expected: On the box run `docker compose down && docker compose up -d --build`. The duet container comes back healthy with no errors in `docker compose logs duet` and no migration re-applied. https://duet.brkn.me loads the dark login screen with the two name tiles.
result: pass
note: run by Claude 2026-10-10 - down/up --build, healthy, no migration re-applied, smoke-public ok, live-db ok, CR-01 fix live (/%61pi/logout + foreign Origin -> 403 bad_origin)

### 2. Login screen looks right on a phone
expected: On a phone, https://duet.brkn.me shows two name tiles in the locked preset look (dark mist/rose, Space Grotesk, large radius, Phosphor icons). Tapping a tile asks only for that person's password, and logging in lands on a chat-shaped shell that names the other person. (01-01 D6, SHEL-01 visual fidelity)
result: pass

### 3. Install to home screen on iPhone and Pixel
expected: iPhone Safari: Share, then Add to Home Screen. Pixel Chrome: menu, then Install app. On both the icon is the light heart on rose labelled "duet". It launches standalone (no address bar), dark, with a black-translucent status bar on iOS. You can log in inside the installed app. Opening https://duet.brkn.me/signup in the browser shows the not-found page. (01-03 D6, SHEL-02)
result: pass

### 4. Stays logged in after force-quit, and logs out from the menu
expected: In the installed app on each phone, force-quit and reopen: you are still logged in, with no password prompt. Header menu, then Log out, returns you to the two name tiles, and you stay logged out after reopening. Then log back in. The "still logged in days later" half is checked again when you reopen it in a few days. (01-02 D7, AUTH-03/AUTH-04)
result: pass

### 5. "Call test" menu item opens inside the installed app
expected: In the installed app, the header menu has a "Call test" item. Tapping it opens the call test page inside the app (room field, "Force relay (TURN only)" switch, Start button) without dropping out to the browser. (01-05 D4)
result: pass

### 6. Cellular call passes in normal and forced-relay mode (INFR-04 gate)
expected: Phone A has Wi-Fi OFF and is on cellular in the installed app; client B is the other phone or a laptop, both on Call test with the same room. Normal mode: tap Start on both, both reach PASS and you see and hear each other; then Stop. Force relay ON: Start on both, both reach PASS with Local candidate "relay"; then Stop. Afterwards, on the box and before any redeploy, `bash scripts/check-call-smoke.sh` prints "call-smoke normal ok", "call-smoke relay ok" and "call-smoke ok". (01-05 D5, also covers 01-04 D4 for /ws over a real phone network)
result: pass
note: user reported "the calls went well"; check-call-smoke.sh run by Claude 2026-10-10 -> 6 reports, "call-smoke normal ok (room debug, local types host,prflx)", "call-smoke relay ok (room debug)", "call-smoke ok" (exit 0)

### 7. Camera and mic stay off until Start and turn off after Stop
expected: During test 6, the phone's camera/mic indicator is off when the call test page opens. It turns on only after you tap Start, and turns off after Stop, after you leave the page, and after a run that fails. (01-05 D6, privacy prohibition)
result: pass

### 8. Server serves the login screen and lists the two people
expected: One Fastify process serves the static dark login screen and GET /api/users lists the two seeded people from SQLite
result: pass
source: automated
coverage_id: 01-01/D1

### 9. Seed rules
expected: Seed creates at most two accounts, is idempotent, rejects <12 code-point passwords, and a password change revokes that user's sessions
result: pass
source: automated
coverage_id: 01-01/D2

### 10. No sign-up path
expected: No sign-up path: POST /api/register and /api/signup are JSON 404; /api/users exposes only id, username, displayName
result: pass
source: automated
coverage_id: 01-01/D3

### 11. DB boot and migrations
expected: Boot creates duet.sqlite in WAL mode with users, sessions, __drizzle_migrations and a media dir; a second boot applies nothing
result: pass
source: automated
coverage_id: 01-01/D4

### 12. Preset lock
expected: Preset lock: components.json base-luma/phosphor, no forbidden packages or imports, forcedTheme dark, no nested web/.git
result: pass
source: automated
coverage_id: 01-01/D5

### 13. Tile and password login
expected: Tap a tile, enter only that person's password, land in the chat-shaped shell naming the other person
result: pass
source: automated
coverage_id: 01-02/D1

### 14. Login error handling
expected: Wrong password and unknown userId give an identical 401; invalid or malformed bodies give 400 invalid_body with no cookie and never a 500; NFD/NFC passwords both log in
result: pass
source: automated
coverage_id: 01-02/D2

### 15. Login rate limit
expected: The 6th attempt within 5 min for the same CF-Connecting-IP + userId gets 429; the other person and other IPs are unaffected
result: pass
source: automated
coverage_id: 01-02/D3

### 16. Origin guard and security headers
expected: Non-GET /api/* without Origin === APP_ORIGIN gets 403 bad_origin; nosniff / DENY / Referrer-Policy are set, with HSTS only when Secure
result: pass
source: automated
coverage_id: 01-02/D4

### 17. 90-day rolling session
expected: 90-day rolling session: no cookie on a fresh session; after 24 h expires_at is extended and the cookie re-issued with Max-Age=7776000; an expired session gets 401, its row is deleted and the cookie cleared
result: pass
source: automated
coverage_id: 01-02/D5

### 18. Logout
expected: Log out in the header menu deletes only this device's session, clears the cookie, returns to the tiles; the old token gets 401
result: pass
source: automated
coverage_id: 01-02/D6

### 19. Public HTTPS via the tunnel
expected: https://duet.brkn.me serves the dark login over HTTPS via the tunnel; /healthz 200, /api/me 401 JSON, /api/users lists exactly 2 people, X-Frame-Options DENY
result: pass
source: automated
coverage_id: 01-03/D1

### 20. Public login round-trip
expected: Real login round-trip through the public URL: POST /api/login 200 with Secure duet_session, GET /api/me 200, POST /api/logout 200, then 401
result: pass
source: automated
coverage_id: 01-03/D2

### 21. Data survives compose down/up
expected: docker compose down/up keeps the sentinel, both users, sessions (a live session cookie still works) and applies no migration again
result: pass
source: automated
coverage_id: 01-03/D3

### 22. No published ports, neighbours untouched
expected: No published duet port; tailscale 100.97.55.101:443 and the 3 sideby-staging containers unchanged; DNS diff shows only duet.brkn.me changed
result: pass
source: automated
coverage_id: 01-03/D4

### 23. PWA manifest, head tags and SW headers
expected: Manifest MIME + fields, 4 icons image/png, head tags (manifest, apple-touch-icon, black-translucent, theme-color, viewport-fit=cover), sw.js no-cache, immutable _next/static
result: pass
source: automated
coverage_id: 01-03/D5

### 24. Cloudflare TURN key via API
expected: Cloudflare TURN key created and reused through the API only (turn-key.sh), stored in the gitignored env file, verified with a real 60 s mint
result: pass
source: automated
coverage_id: 01-04/D1

### 25. TURN credential minting
expected: POST /api/rtc/ice-servers mints Cloudflare TURN credentials for logged-in users only (401/403/429/503/502 mapping, no-store, port-53 filter, never STUN-only)
result: pass
source: automated
coverage_id: 01-04/D2

### 26. /ws signaling hub
expected: GET /ws signaling hub: Origin and non-renewing session checked before the upgrade, rooms of two, relay to the other member only, size/rate limits, logout 4401, no frame logging
result: pass
source: automated
coverage_id: 01-04/D3

### 27. Headless two-peer call harness
expected: /debug/call/ harness: two logged-in browsers connect peer-to-peer through /ws signaling and real Cloudflare TURN, in normal mode (host/host) and forced-relay mode (relay-relay), and show PASS with growing inbound bytes
result: pass
source: automated
coverage_id: 01-05/D1

### 28. Call verdict and call-report endpoint
expected: Shared callVerdict thresholds and POST /api/debug/call-report (401/403, strict body with integer and length caps, 204 with exactly one call_smoke log line, 30/min per client IP)
result: pass
source: automated
coverage_id: 01-05/D2

### 29. Redeploy checks
expected: Redeployed at https://duet.brkn.me: /ws upgrade 401 with Origin and 403 without, ice-servers and call-report 401 without a session, live DB unchanged, playwright-core pruned from the image
result: pass
source: automated
coverage_id: 01-05/D3

### 30. Re-run TURN key and headless call smoke scripts on the box
expected: `bash deploy/cloudflare/turn-key.sh` prints `reused key …`, `turn keys named duet: 1`, `turn-key ok` (re-run safe, no duplicate key); then `bash scripts/smoke-call.sh` prints `smoke-call reports ok (8)` and `smoke-call ok`
result: [pending]
source: 01-VERIFICATION.md (re-verify 2026-10-10)
coverage_id: 01-04/T2, 01-05/T3

### 31. Decide WR-01 per-account login lockout policy
expected: Owner accepts or changes the c743038 behaviour (20 failed logins/hour from any IP locks the account for new logins for up to an hour; existing sessions unaffected; user ids are public via /api/users) and records the decision in 01-REVIEW-DISPOSITION.md
result: [pending]
source: 01-VERIFICATION.md (re-verify 2026-10-10)
coverage_id: 01-02/T2

## Summary

total: 31
passed: 29
issues: 0
pending: 2
skipped: 0
blocked: 0

## Gaps

[none yet]
