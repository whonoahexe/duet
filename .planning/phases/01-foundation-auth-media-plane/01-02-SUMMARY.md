---
phase: 01-foundation-auth-media-plane
plan: 02
subsystem: auth
tags: [fastify, session-cookie, rate-limit, csrf-origin, argon2, base-ui, phosphor, vitest, tdd]

requires:
  - phase: 01-01
    provides: "buildApp, users/sessions tables, verifyPassword/hashPassword (NFC), makeTestApp, apiGet/apiPost/ApiError, LoginTiles, preset UI components"
provides:
  - "POST /api/login (5 per 5 min per CF-Connecting-IP + userId), GET /api/me, POST /api/logout"
  - "Opaque rolling session: duet_session cookie (HttpOnly, SameSite=Lax, Path=/, Max-Age 7776000, Secure when COOKIE_SECURE), sha256 at rest, 24 h renewal that re-issues the cookie"
  - "requireUser preHandler + FastifyRequest.user / request.session (decorateAuth)"
  - "originGuard (onRequest: non-GET /api/* needs Origin === APP_ORIGIN) and securityHeaders (onSend)"
  - "Root error handler: unparseable bodies -> 400 invalid_body; plugin-built error objects (rate limiter) sent with their statusCode"
  - "Shared zod schemas LoginBody, MeResponse, OkResponse, ErrorResponse"
  - "Web: PasswordStep, Shell (peer header + Log out DropdownMenu + Empty), page state machine driven by /api/me"
affects: [01-03, 01-04, 01-05, phase-02, phase-03]

actuals:
  tokens: 9536
  tasks: 3
  commits: 5
plan_head_before: f7329868209d16caa9458ca14543e7d5e031b2be
plan_head_after: ed533d8d678b7791a7109c59d0a8e17487fc82a2

tech-stack:
  added: []
  patterns:
    - "Authenticated routes use { preHandler: requireUser } and read request.user / request.session"
    - "Every non-GET /api/* request must carry Origin === APP_ORIGIN (tests inject it explicitly)"
    - "Per-route rate limits via config.rateLimit with hook preHandler so the key can read the body"
    - "Inject tests set cf-connecting-ip per call (freshIp) so the login limiter never couples tests"

key-files:
  created:
    - server/src/auth/session.ts
    - server/src/auth/routes.ts
    - server/src/http/guards.ts
    - server/test/auth.test.ts
    - server/test/session.test.ts
    - web/components/app/password-step.tsx
    - web/components/app/shell.tsx
  modified:
    - shared/src/api.ts
    - server/src/app.ts
    - server/test/users.test.ts
    - web/app/page.tsx
    - scripts/smoke-local.sh

key-decisions:
  - "A root setErrorHandler maps FST_ERR_CTP_* (malformed JSON, bad content type) to 400 invalid_body and sends @fastify/rate-limit's thrown plain object with its own statusCode. Rethrowing that object to Fastify's default handler produced a 200, so it has to be handled explicitly"
  - "The logout UI treats a 401 from /api/logout as already logged out. Other failures show a sonner toast; the Toaster is mounted in Shell with theme=dark because layout.tsx mounts none"
  - "The renewal and expiry-cleanup code paths were held back from the Task 1 tracer so that the Task 3 RED tests could fail for real"

patterns-established:
  - "Error codes: wrong_password 401, invalid_body 400, rate_limited 429 (+retryAfterSeconds, Retry-After), bad_origin 403, unauthenticated 401"
  - "Login UI copy: 'Wrong password' / 'Too many attempts. Try again in a few minutes.' / 'Can't reach duet. Check your connection.'"

requirements-completed: [AUTH-02, AUTH-03, AUTH-04]

coverage:
  - id: D1
    description: "Tap a tile, enter only that person's password, land in the chat-shaped shell naming the other person"
    requirement: AUTH-02
    verification:
      - kind: integration
        ref: "server/test/auth.test.ts#login happy path"
        status: pass
      - kind: e2e
        ref: "bash scripts/smoke-local.sh"
        status: pass
      - kind: e2e
        ref: "headless Chrome CDP flow against the built app (tiles -> password -> shell -> menu -> log out)"
        status: pass
    human_judgment: false
  - id: D2
    description: "Wrong password and unknown userId give an identical 401; invalid or malformed bodies give 400 invalid_body with no cookie and never a 500; NFD/NFC passwords both log in"
    requirement: AUTH-02
    verification:
      - kind: integration
        ref: "server/test/auth.test.ts#login errors"
        status: pass
      - kind: integration
        ref: "server/test/auth.test.ts#Unicode normalization"
        status: pass
    human_judgment: false
  - id: D3
    description: "The 6th attempt within 5 min for the same CF-Connecting-IP + userId gets 429; the other person and other IPs are unaffected"
    requirement: AUTH-02
    verification:
      - kind: integration
        ref: "server/test/auth.test.ts#login rate limit (5 per 5 minutes per CF-Connecting-IP + userId)"
        status: pass
    human_judgment: false
  - id: D4
    description: "Non-GET /api/* without Origin === APP_ORIGIN gets 403 bad_origin; nosniff / DENY / Referrer-Policy are set, with HSTS only when Secure"
    requirement: AUTH-02
    verification:
      - kind: integration
        ref: "server/test/auth.test.ts#Origin check on non-GET /api/*"
        status: pass
      - kind: integration
        ref: "server/test/auth.test.ts#security headers"
        status: pass
    human_judgment: false
  - id: D5
    description: "90-day rolling session: no cookie on a fresh session; after 24 h expires_at is extended and the cookie re-issued with Max-Age=7776000; an expired session gets 401, its row is deleted and the cookie cleared"
    requirement: AUTH-03
    verification:
      - kind: integration
        ref: "server/test/session.test.ts#rolling renewal"
        status: pass
      - kind: integration
        ref: "server/test/session.test.ts#expiry"
        status: pass
    human_judgment: false
  - id: D6
    description: "Log out in the header menu deletes only this device's session, clears the cookie, returns to the tiles; the old token gets 401"
    requirement: AUTH-04
    verification:
      - kind: integration
        ref: "server/test/session.test.ts#POST /api/logout"
        status: pass
      - kind: e2e
        ref: "headless Chrome CDP flow: menu -> Log out -> tiles, still logged out after reload"
        status: pass
    human_judgment: false
  - id: D7
    description: "'Still logged in days later' on the installed iOS home-screen app (flagged AUTH-03 assumption) and preset look and feel on real phones"
    requirement: AUTH-03
    verification: []
    human_judgment: true
    rationale: "Real-time multi-day persistence in the iOS home-screen cookie jar and on-device visual fidelity cannot be observed inside the phase; this needs a force-quit/reopen UAT on the phones"

duration: 8min
completed: 2026-10-09
status: complete
---

# Phase 1 Plan 02: Password Login and Rolling Session Summary

**You tap your tile and enter your password (argon2id). That creates an opaque 256-bit `duet_session` cookie with a 90-day lifetime that renews daily and re-issues the cookie each time. The login is throttled per IP and per person via CF-Connecting-IP, state-changing requests must pass an Origin check, and you land in a chat-shaped shell with a Log out menu.**

## Performance

- **Duration:** 8 min
- **Started:** 2026-10-09T08:59:34Z
- **Completed:** 2026-10-09T09:07:48Z
- **Tasks:** 3 (1 tracer + 2 TDD)
- **Files modified:** 12

## Accomplishments

- The full login slice works end to end: tile, password, `POST /api/login`, session row plus cookie, `GET /api/me`, shell. It is proven through the real server process (smoke-local) and through a headless Chrome run of the built UI.
- Abuse controls stand in for the dropped TOTP (D-05):
  - a rate limit of 5 attempts per 5 minutes per CF-Connecting-IP + userId (with `hook: "preHandler"`, Pitfall 3/4);
  - a dummy argon2 verify for unknown ids;
  - generic `wrong_password` and `invalid_body` errors;
  - an Origin guard on every non-GET `/api/*`;
  - baseline security headers.
- The session rolls for real (Pitfall 5). Renewal after 24 h extends the row and also re-issues `Set-Cookie` with a fresh `Max-Age=7776000`. Expired sessions are deleted and their cookie cleared.
- Log out in the header DropdownMenu (Base UI `render` trigger) revokes only this device's session server-side.

## Task Commits

1. **Task 1: tile -> password -> shell tracer:** `67b0696` (feat). The tracer gate re-ran the `<verify>` checks (auth.test + smoke-local) and both were green, then work expanded to the next tasks.
2. **Task 2: login error states and abuse controls (TDD):** RED `0dc6dda` (test), GREEN `cacbc3b` (feat)
3. **Task 3: session lifecycle and header-menu logout (TDD):** RED `6920e05` (test), GREEN `ed533d8` (feat)

No REFACTOR commits were needed.

## TDD Gate Compliance

| Task | RED target | Evidence | Semantic assessment |
|---|---|---|---|
| 2 | `test/auth.test.ts > login rate limit (...) > answers the 6th attempt for the same person from the same IP with 429, without affecting others` | `gsd-tools check tdd-red-evidence` → `RED_EVIDENCE_OK` (target_test_failed), vitest `--reporter=tap-flat`, exit 1 | The target ran and failed on `expected 401 to be 429`, which is the planned assertion: no limiter was registered yet. The first full-file TAP report was rejected as `invalid_record` because vitest's multi-line diff for an unrelated failure broke the TAP format. I re-ran only the target (`-t`) with the same reporter, and that run produced the accepted record. |
| 3 | `test/session.test.ts > rolling renewal > after 24 h extends expires_at to now + 90 days and re-issues a 90-day cookie` | `RED_EVIDENCE_OK` (target_test_failed), `-t` target run, exit 1 | The target ran and failed on `expected '' to contain 'duet_session=…'`, meaning no renewal Set-Cookie was sent. That is the Pitfall 5 behavior under test. |

Every `test(01-02)` commit comes before its `feat(01-02)` commit. Some RED tests passed on their first run because Task 1 already covered them: wrong password, identical unknown-id body, NFC login, APP_ORIGIN allowed, GET exempt, fresh session with no cookie, and logout without Origin returning 403 (the guard already existed from Task 2). The named targets above failed as intended.

## Files Created/Modified

- `shared/src/api.ts`: adds `LoginBody`, `MeResponse`, `OkResponse`, `ErrorResponse`.
- `server/src/auth/session.ts`: constants, `hashToken`, `issueSession`, `setSessionCookie`, `clearSessionCookie`, `requireUser` (renewal and expiry), `decorateAuth`, and the type augmentation.
- `server/src/auth/routes.ts`: login (rate-limited, `DUMMY_HASH`), me, logout.
- `server/src/http/guards.ts`: `originGuard`, `securityHeaders`.
- `server/src/app.ts`: registers the guards, error handler, cookie, rate-limit (global false) and auth routes.
- `server/test/auth.test.ts` (21 tests) and `server/test/session.test.ts` (6 tests).
- `server/test/users.test.ts`: the sign-up 404 probes now send APP_ORIGIN.
- `web/components/app/password-step.tsx`, `web/components/app/shell.tsx`, `web/app/page.tsx`.
- `scripts/smoke-local.sh`: adds a cookie-jar login round-trip that checks `/api/me` for peer "Bob Smoke".

## Decisions Made

See `key-decisions` in the frontmatter. `web/components/app/login-tiles.tsx` needed no change, because `onSelect` already passed the full `UserSummary`.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] users.test.ts sign-up probes hit the new Origin guard**
- **Found during:** Task 2 (GREEN)
- **Issue:** `POST /api/register` and `/api/signup` without Origin now return 403 `bad_origin`, because the guard also runs on the 404 route. That broke the 01-01 test, which expects a JSON 404.
- **Fix:** The probes now send `Origin: APP_ORIGIN`, so the missing route is still what answers. The intent (no sign-up path) is unchanged. The file was outside `files_modified`.
- **Files modified:** server/test/users.test.ts
- **Commit:** cacbc3b

**2. [Rule 2 - Missing critical] Malformed JSON returned Fastify's default 400 body**
- **Found during:** Task 2 (GREEN)
- **Issue:** The `{statusCode, code, error, message}` body broke the "never anything but invalid_body" contract.
- **Fix:** Added a root `setErrorHandler` that maps `FST_ERR_CTP_*` to 400 `{error:"invalid_body"}`. It also had to send the rate limiter's thrown plain object with its `statusCode`, because rethrowing it produced a 200.
- **Files modified:** server/src/app.ts
- **Commit:** cacbc3b

**3. [Rule 2 - Missing critical] Logout failure feedback and dark toast**
- **Found during:** Task 3
- **Issue:** The plan did not say what happens when `/api/logout` fails offline. A silent failure would leave the user unsure whether they were logged out.
- **Fix:** A 401 counts as logged out. Any other failure shows a preset sonner toast. The Toaster is mounted in Shell with `theme="dark"`, because the preset Toaster otherwise follows `useTheme()` and D-10 requires always-dark.
- **Files modified:** web/components/app/shell.tsx
- **Commit:** ed533d8

---

**Total deviations:** 3 auto-fixed (1 Rule 3, 2 Rule 2). **Impact:** no scope creep and no new packages. All of them protect a contract the plan already stated.

## Issues Encountered

None beyond the deviations above.

## Known Stubs

None. The 01-01 stub (`handleSelect` no-op in `web/app/page.tsx`) is now wired to the password step, and it is marked `fixed` (id 1) in `.planning/WINDOWS.md`. The shell's "No messages yet" Empty is the intended Phase 1 end state (D-11). Phase 2 fills it.

## Threat Flags

None. Every new surface (login, me, logout, cookie, guards) is already in the plan's threat register (T-01-05..T-01-12). The register's mitigations are in place and tested:
- T-01-05: rate limit;
- T-01-06: dummy hash with an identical body;
- T-01-07: 256-bit token stored as sha256, flags set, fresh token per login;
- T-01-08: Origin guard;
- T-01-09: requireUser 401s;
- T-01-11: no body logging;
- T-01-12: headers.

T-01-10 (forged CF-Connecting-IP) still depends on 01-03 not publishing the app port.

## User Setup Required

None.

## Plan-level Verification

- `npm --prefix server run test`: 5 files, 40 tests passed (db, seed, users, auth, session).
- `bash scripts/smoke-local.sh`: smoke-local ok, including the login round-trip.
- `bash scripts/check-preset.sh`: preset ok (no OTP/TOTP packages, D-05).
- `npm run typecheck`: exit 0.
- Human-check stand-in: a headless Chrome (CDP) run against the built app at 390x844 covered the following, with screenshots inspected:
  - dark tiles, and the password step with no visible username field;
  - "Wrong password" with the input cleared and refocused;
  - the shell showing "Bob Smoke" and "No messages yet", still logged in after a reload;
  - the `d` key keeping dark mode;
  - the menu's Log out returning to the tiles, still logged out after a reload.

  On-device feel is left to phase UAT (coverage D7).

## Next Phase Readiness

- 01-03 (Docker/tunnel): `COOKIE_SECURE=true` turns on Secure cookies and HSTS. `APP_ORIGIN` must exactly match the public origin, or every login POST gets 403. Don't publish port 3100, so `CF-Connecting-IP` stays trustworthy.
- Later routes: add `{ preHandler: requireUser }` and send Origin on non-GET requests (the web `apiPost` already does, since browsers attach Origin to same-origin POST fetches).

## Self-Check: PASSED

- 7 created files plus SUMMARY: FOUND
- Commits 67b0696, 0dc6dda, cacbc3b, 6920e05, ed533d8 are ancestors of HEAD: FOUND
- Commits measured from the ledger: 5 (f732986..ed533d8)
