---
phase: 01-foundation-auth-media-plane
fixed_at: 2026-10-10T17:40:00Z
review_path: .planning/phases/01-foundation-auth-media-plane/01-REVIEW.md
iteration: 1
findings_in_scope: 4
fixed: 4
skipped: 0
status: all_fixed
---

# Phase 1: Code Review Fix Report

**Fixed at:** 2026-10-10T17:40:00Z
**Source review:** .planning/phases/01-foundation-auth-media-plane/01-REVIEW.md
**Iteration:** 1

**Summary:**
- Findings in scope: 4 (fix scope critical_warning: CR-01, WR-01, WR-02, WR-03)
- Fixed: 4
- Skipped: 0
- Out of scope: IN-01 to IN-09 (Info). None of them were touched.

## Verification

- I ran each fix's server typecheck (`tsc --noEmit -p server`) and the full server vitest suite in the isolated worktree before committing it. The worktree resolved dependencies from the main checkout's hoisted `node_modules`. `static.test.ts` needs `web/out`, so I copied the main checkout's built `web/out` into the worktree. The copy was removed along with the worktree.
- After fast-forwarding `master`, I ran both again in the **main checkout** (`npm run typecheck` and `npm test` in `server/`). Typecheck is clean and 145/145 tests pass (113 before the fixes, plus 32 new regression tests).
- I confirmed the CR-01 regression tests fail on the pre-fix code. With the fix stashed, 5 of the new tests fail.

## Fixed Issues

### CR-01: Origin (CSRF) guard bypassed by percent-encoding the path

**Files modified:** `server/src/http/guards.ts`, `server/src/app.ts`, `server/test/session.test.ts`, `server/test/static.test.ts`
**Commit:** 26c7cfa
**Applied fix:** `originGuard` no longer classifies requests by path. Every request that isn't GET, HEAD or OPTIONS now needs `Origin === APP_ORIGIN`, which is safe because the server has no state-changing routes outside `/api`. The new exported `isApiPath()` percent-decodes the path and strips the query before checking for an `/api` prefix, and treats a path it can't decode as API. The 404 handler now uses it, so `/%61pi/...` gets the JSON 404 instead of the HTML one. New regression tests:
- `POST /%61pi/logout`, `/%61%70%69/logout` and `/api%2Flogout` with a foreign Origin each get a 403 `bad_origin`, and the session survives.
- With the real static export, `/%61pi/nope` gets the JSON 404 and an unknown page gets the HTML 404.

### WR-01: Login rate limit keyed only on (client IP, userId) can be bypassed by rotating IPs

**Files modified:** `server/src/auth/routes.ts`, `server/test/auth.test.ts`
**Commit:** c743038
**Status:** fixed: requires human verification (this is a policy decision as well as a code fix)
**Applied fix:**
- **IP key:** the per-IP key now uses `ipBucket()`. It fully expands IPv6, including `::`, zone ids and dotted IPv4 tails, and collapses the address to its /64. IPv4 and IPv4-mapped IPv6 addresses stay as single addresses.
- **Account cap:** there is a new in-memory limit of 20 failed logins per hour per existing account, regardless of IP. Only failures count, so the owner's own successful logins never use up the budget. While an account is over the cap, every attempt gets a 429 `rate_limited` with `retryAfterSeconds` and a `Retry-After` header, including one with the correct password. That is what actually bounds guessing.
- **Memory:** the map only holds existing accounts (two keys at most), so it stays tiny.
- **Trade-off to confirm:** someone who knows a user id (they are public via `GET /api/users`) can lock that account out of new logins for up to an hour. Existing 90-day sessions are not affected.
- **Tests:** unit cases for `ipBucket`, one IPv6 /64 sharing a bucket, the account cap across fresh IPs (the other account unaffected), and successful logins not counting toward the cap.

### WR-02: Revoked or expired sessions keep their /ws sockets open indefinitely

**Files modified:** `server/src/ws/hub.ts`, `server/src/auth/session.ts`, `server/src/app.ts`, `server/test/ws.test.ts`
**Commit:** 69d114d
**Status:** fixed: requires human verification (this changes connection state handling)
**Applied fix:**
- **Hub option:** `createHub` takes a new required `isSessionLive(sessionId)` callback, so the hub still has no database access.
- **Heartbeat check:** on each heartbeat, before the ping, every socket that isn't already closing has its session checked. If the session row is gone or past `expires_at`, the socket is closed with `WS_CLOSE_LOGGED_OUT` (4401). If the lookup itself throws, the socket is kept and a warning (`ws_session_check_failed`) is logged with only the error name.
- **Session lookup:** the new `isSessionLive(db, sessionId)` in `session.ts` is a read-only lookup by the sessions primary key and never renews the session. `app.ts` wires it in.
- **Tests:** deleting a session row (what the seed CLI password reset does) closes that socket with 4401 while another session's socket stays open, and an expired session's socket is closed with 4401.

### WR-03: APP_ORIGIN is not normalized, so a trailing slash, uppercase host or path locks out every POST and /ws

**Files modified:** `server/src/config.ts`, `server/test/auth.test.ts`
**Commit:** e859d42
**Applied fix:**
- **Boot check:** `loadConfig` now rejects any `APP_ORIGIN` that isn't a bare http(s) origin (no path other than `/`, no query, fragment or credentials, and no other scheme) with a readable `ConfigError`.
- **Normalization:** `APP_ORIGIN` becomes `new URL(...).origin`, which is lowercase with no trailing slash and no default port, the same form browsers send in `Origin`.
- **Tests:** normalization cases, rejection cases, and an end-to-end case where `APP_ORIGIN=https://Duet.Example.com/` still accepts `Origin: https://duet.example.com` on login.
- **Not changed:** the deploy shell scripts that derive the host from `APP_ORIGIN`. They were out of this finding's scope.

---

_Fixed: 2026-10-10T17:40:00Z_
_Fixer: Claude (gsd-code-fixer)_
_Iteration: 1_
