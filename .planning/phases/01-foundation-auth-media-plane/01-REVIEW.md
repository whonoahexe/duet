---
phase: 01-foundation-auth-media-plane
reviewed: 2026-10-09T21:54:35Z
depth: standard
files_reviewed: 70
files_reviewed_list:
  - .dockerignore
  - .env.example
  - Dockerfile
  - compose.yaml
  - deploy/cloudflare/turn-key.sh
  - deploy/cloudflared/setup.sh
  - package.json
  - scripts/check-call-smoke.sh
  - scripts/check-live-db.sh
  - scripts/check-preset.sh
  - scripts/gen-icons.mjs
  - scripts/smoke-call.mjs
  - scripts/smoke-call.sh
  - scripts/smoke-local.sh
  - scripts/smoke-persistence.sh
  - scripts/smoke-public.sh
  - server/drizzle.config.ts
  - server/drizzle/0000_amusing_bishop.sql
  - server/package.json
  - server/scripts/seed-users.ts
  - server/src/app.ts
  - server/src/auth/password.ts
  - server/src/auth/routes.ts
  - server/src/auth/session.ts
  - server/src/config.ts
  - server/src/db/client.ts
  - server/src/db/schema.ts
  - server/src/db/seed.ts
  - server/src/http/guards.ts
  - server/src/index.ts
  - server/src/routes/users.ts
  - server/src/rtc/routes.ts
  - server/src/rtc/turn.ts
  - server/src/ws/hub.ts
  - server/src/ws/routes.ts
  - server/test/auth.test.ts
  - server/test/call-report.test.ts
  - server/test/db.test.ts
  - server/test/helpers.ts
  - server/test/seed.test.ts
  - server/test/session.test.ts
  - server/test/static.test.ts
  - server/test/turn.test.ts
  - server/test/users.test.ts
  - server/test/ws.test.ts
  - server/vitest.config.ts
  - shared/package.json
  - shared/src/api.ts
  - shared/src/index.ts
  - shared/src/rtc.ts
  - shared/src/ws.ts
  - web/app/debug/call/page.tsx
  - web/app/layout.tsx
  - web/app/manifest.ts
  - web/app/page.tsx
  - web/components/app/call-test.tsx
  - web/components/app/login-tiles.tsx
  - web/components/app/password-step.tsx
  - web/components/app/shell.tsx
  - web/components/app/sw-register.tsx
  - web/components/theme-provider.tsx
  - web/lib/api.ts
  - web/lib/rtc/ice.ts
  - web/lib/rtc/peer.ts
  - web/lib/rtc/stats.ts
  - web/lib/utils.ts
  - web/lib/ws.ts
  - web/next.config.ts
  - web/package.json
  - web/public/sw.js
findings:
  critical: 1
  warning: 3
  info: 9
  total: 13
status: issues_found
---

# Phase 1: Code Review Report

**Reviewed:** 2026-10-09T21:54:35Z
**Depth:** standard
**Files Reviewed:** 70
**Status:** issues_found

## Summary

I reviewed the Phase 1 foundation: the Fastify server (auth, sessions, Origin guard, TURN minting, the `/ws` signaling hub), the shared zod protocol, the static-export web client (login, shell, call test, perfect-negotiation peer), the Docker and Compose setup, and the Cloudflare provisioning and smoke scripts. Most of it is careful work. Session tokens are 256-bit and stored only as sha256. Argon2id runs on the unknown-user path too. TURN responses are validated and never logged. WS frames are strictly validated and re-serialized before relay. The container has no published ports, and the provisioning scripts never echo secrets. All 113 server tests pass.

There is one proven defect in a security control. The CSRF Origin guard matches on the raw, undecoded `request.url`, but Fastify's router decodes percent-escapes. So `POST /%61pi/logout` with a foreign Origin reaches the logout handler and returns 200. I reproduced this with a throwaway `app.inject` probe, which I deleted afterwards. Three warnings follow:

- The login brute-force limit is keyed only on (IP, user), so a client with many IPs (for example an IPv6 /64) can get around it.
- Sessions revoked by the seed CLI (password reset) or by expiry keep their open `/ws` sockets indefinitely.
- `APP_ORIGIN` is compared verbatim and never normalized. A trailing slash locks out every POST and `/ws`.

## Critical Issues

### CR-01: Origin (CSRF) guard bypassed by percent-encoding the path

**File:** `server/src/http/guards.ts:6-8,16` (same pattern in `server/src/app.ts:117`)
**Issue:** `originGuard` decides whether a request is an API call with `isApiUrl(request.url)`, and `request.url` is the raw, undecoded request target. The router (find-my-way) percent-decodes the path before matching. Any unreserved character in the `/api` prefix can therefore be encoded so the guard skips the request while the router still dispatches it to the `/api/*` handler. I verified this against `buildApp` with `app.inject`:

```
POST /%61pi/logout   Origin: https://evil.example  + valid cookie  -> 200 {"ok":true}   (session revoked)
POST /api/logout     Origin: https://evil.example  + valid cookie  -> 403 {"error":"bad_origin"}
POST /%61pi/login    Origin: https://evil.example                 -> 401 wrong_password (handler reached, no 403)
```

The Origin check is the documented CSRF control (T-01-08) for every state-changing endpoint, including `/api/login`, `/api/logout`, `/api/rtc/ice-servers` and `/api/debug/call-report`, plus every endpoint later phases add (message send, uploads, push subscribe). Today `SameSite=Lax` on the cookie and the JSON-only body parser are what stop cross-site exploitation. Same-site origins (any other `*.brkn.me` host) still send Lax cookies, so this is a real hole in the primary control, and it will silently cover every new POST route.
**Fix:** Don't classify by path at all. Every non-safe method should require the exact Origin, since the server has no non-API state-changing routes. If path scoping is wanted, use the matched route pattern, not the raw URL:

```ts
export function originGuard(config: Config): onRequestHookHandler {
  return function originGuardHook(request, reply, done) {
    if (!SAFE_METHODS.has(request.method) && request.headers.origin !== config.APP_ORIGIN) {
      reply.code(403).send({ error: "bad_origin" })
      return
    }
    done()
  }
}
// or, if scoping is needed: const route = request.routeOptions.url ?? ""; route.startsWith("/api/")
```

Add a regression test for `POST /%61pi/logout` with a bad Origin. In `app.ts:117`, decode the path the same way (or use `request.routeOptions.url`) so `/%61pi/x` gets the JSON 404, not the HTML one.

## Warnings

### WR-01: Login rate limit keyed only on (client IP, userId) can be bypassed by rotating IPs

**File:** `server/src/auth/routes.ts:25-30,38-48`
**Issue:** The only brute-force control on `/api/login` is 5 attempts per 5 minutes per `${CF-Connecting-IP}:${userId}`. Cloudflare passes the client's full IPv6 address, so any attacker with an ordinary IPv6 /64 gets about 2^64 independent buckets. A small proxy or botnet pool multiplies the rate the same way. Nothing caps attempts per account. The user ids that make up the second half of the key are public (`GET /api/users`), and the only remaining defense is the 12-character minimum password.
**Fix:** Add a second limit keyed on `userId` alone, for example 20 per hour per account regardless of IP. Collapse IPv6 addresses to their /64 in the IP key. For example, register a second `onRequest`/`preHandler` check against an in-memory counter, or call the rate-limit plugin twice with different `keyGenerator`s via `app.rateLimit()` route hooks:

```ts
function ipBucket(ip: string): string {
  return ip.includes(":") ? ip.split(":").slice(0, 4).join(":") + "::/64" : ip
}
// key A: `${ipBucket(ip)}:${userId}` max 5 / 5 min
// key B: `acct:${userId}`              max 20 / 1 h
```

### WR-02: Revoked or expired sessions keep their /ws sockets open indefinitely

**File:** `server/src/ws/hub.ts:172-220`, `server/src/db/seed.ts:122-124`, `server/src/auth/session.ts:136-140`
**Issue:** The session is checked once, at upgrade. After that, the only path that closes sockets is `/api/logout` → `hub.closeSession`. Two other revocation paths don't reach the hub:
- A password reset through the seed CLI (`seedUsers` deletes the user's `sessions` rows). It runs in a separate process (`npm run seed` / `docker compose exec`), so it can't reach the in-memory hub, and a stolen session's open socket keeps relaying signaling. The reset is meant to evict exactly that attacker.
- Session expiry. The heartbeat keeps the socket alive for as long as the client answers pings, well past `expires_at`.

Phase 2 will put chat traffic on this socket, so a revoked session would keep receiving messages.
**Fix:** Re-validate every open connection's session periodically from the heartbeat. A single indexed lookup per socket every 25 s is cheap. Close with `WS_CLOSE_LOGGED_OUT` when the row is gone or expired. Store `sessionId` in `Conn` (already there) and inject a `isSessionLive(sessionId): boolean` callback into `createHub` so the hub stays DB-free:

```ts
// in the heartbeat loop
if (!conn.closing && !opts.isSessionLive(conn.sessionId)) {
  conn.closing = true
  conn.socket.close(WS_CLOSE_LOGGED_OUT, "logged_out")
  continue
}
```

### WR-03: APP_ORIGIN is not normalized, so a trailing slash, uppercase host or path locks out every POST and /ws

**File:** `server/src/config.ts:18,45`, used verbatim in `server/src/http/guards.ts:16` and `server/src/ws/routes.ts:14`
**Issue:** `z.url()` accepts `https://duet.brkn.me/`, `https://Duet.brkn.me` and `https://duet.brkn.me/app`, and `loadConfig` returns them unchanged (verified). Browsers send `Origin` as a lowercase, slash-free serialized origin, so any of those values makes `request.headers.origin !== config.APP_ORIGIN` true for every request. Login, logout, TURN and `/ws` then all return 403, with no boot-time error. The provisioning scripts strip the path when they derive the host, so the deploy otherwise looks healthy.
**Fix:** Normalize at config load and reject values that are not a bare origin:

```ts
APP_ORIGIN: z.url().optional().refine(
  (v) => v === undefined || new URL(v).origin === v.replace(/\/$/, "").toLowerCase(), // or simply transform
  "APP_ORIGIN must be a bare origin like https://duet.example.com",
),
// ...in .transform():
APP_ORIGIN: new URL(env.APP_ORIGIN ?? "http://localhost:3000").origin,
```

## Info

### IN-01: Unhandled 5xx errors echo internal error messages to the client

**File:** `server/src/app.ts:68`
**Issue:** Anything that isn't a content-type or rate-limit error is rethrown into Fastify's default handler. For 5xx errors that handler serializes `error.message` into the body (for example a SQLite `database is locked`, or a native addon message).
**Fix:** In the custom error handler, map `statusCode >= 500` (or errors without a statusCode) to `reply.code(500).send({ error: "internal" })` after `request.log.error(error)`.

### IN-02: Sessions are never pruned and can't be listed or revoked individually

**File:** `server/src/auth/session.ts:67-87,136-140`
**Issue:** A row is deleted only when its own cookie is presented after expiry, on logout, or on a password reset. Cookies lost by clearing site data or reinstalling the PWA stay valid server-side for up to 90 days, and the table grows with every login.
**Fix:** On each login, delete expired rows (`DELETE FROM sessions WHERE expires_at <= now`). Consider a per-user cap, for example keeping the newest 10.

### IN-03: Seed allows 1024 code points but login allows only 1024 UTF-16 units

**File:** `server/src/db/seed.ts:57-63` vs `shared/src/api.ts:19`
**Issue:** `passwordLength` counts code points, while `z.string().max(1024)` counts UTF-16 units. A long seeded password containing astral characters (emoji) can never log in: the request gets a 400 `invalid_body`.
**Fix:** Use the same measure in both places, or cap the seed at 512 code points.

### IN-04: SignalingClient.connect() has no timeout

**File:** `web/lib/ws.ts:30-68`
**Issue:** If the upgrade stalls (the tunnel is half-open, or the server never sends `hello`), `connect()` never settles. The call test then sits in "Starting camera and connection" with the camera live until the user taps Stop.
**Fix:** Reject and close after about 10 s without `hello`.

### IN-05: Candidate-pair fallback may report the wrong local type on Safari

**File:** `web/lib/rtc/stats.ts:34-40`
**Issue:** The fallback takes the first `succeeded` pair with `nominated` true. Several pairs can be nominated over a call's lifetime, so `localType` and `relayProtocol` may describe a pair that isn't the active one. This doesn't affect forced-relay mode, where every pair is relay. It does affect normal-mode reports (MA4 is still unverified).
**Fix:** Prefer the pair whose `bytesReceived`/`bytesSent` is highest, or the one with the latest `lastPacketReceivedTimestamp`.

### IN-06: The INFR-04 cellular gate trusts client-reported fields

**File:** `scripts/check-call-smoke.sh:33-52`, `server/src/rtc/routes.ts:79-91`
**Issue:** `pass`, `clientId` and `localType` are whatever the browser POSTs, so a logged-in user can satisfy the gate with two curl calls from a cellular IP. That's acceptable for a self-test, but the gate output should not be read as server-side proof.
**Fix:** Document this in the script header. Optionally cross-check against `turn_mint` and `ws_open` log lines for the same user in the same window.

### IN-07: Unused font import

**File:** `web/app/layout.tsx:2`
**Issue:** `Geist` is imported but never used. Only `Geist_Mono` and `Space_Grotesk` are.
**Fix:** Remove `Geist` from the import.

### IN-08: Theme hotkey is dead code under forcedTheme="dark"

**File:** `web/components/theme-provider.tsx:37-69`
**Issue:** Pressing "d" calls `setTheme("light")` and persists it to localStorage. `forcedTheme="dark"` (D-10) overrides it, so the hotkey has no visible effect, but it leaves a stale preference behind. This is scaffold code, not preset tokens.
**Fix:** Drop `<ThemeHotkey />` from the provider.

### IN-09: No Content-Security-Policy and a hard-coded cloudflared uid

**File:** `server/src/http/guards.ts:25-35`, `compose.yaml:22`
**Issue:** The baseline headers have no CSP or `Permissions-Policy`. That will matter once Phase 2 renders user content and media. Separately, `user: "1000:1000"` in Compose assumes the operator's uid is 1000. On any other uid, cloudflared can't read the 0400 credentials file.
**Fix:** Add a restrictive CSP for the static export (`default-src 'self'; connect-src 'self' wss:; img-src 'self' blob: data:; media-src 'self' blob:`), adjusted to whatever inline scripts Next emits. Parameterize the uid (`user: "${UID:-1000}:${GID:-1000}"`).

---

_Reviewed: 2026-10-09T21:54:35Z_
_Reviewer: Claude (gsd-code-reviewer)_
_Depth: standard_
