---
phase: 01-foundation-auth-media-plane
plan: 04
subsystem: realtime
tags: [cloudflare-turn, webrtc, websocket, fastify-websocket, zod, signaling, sessions]

requires:
  - phase: 01-01
    provides: Fastify app factory, config loader, SQLite sessions, test helpers
  - phase: 01-02
    provides: requireUser rolling session, originGuard, login rate limit pattern, logout
  - phase: 01-03
    provides: deployed container at https://duet.brkn.me via Cloudflare Tunnel, smoke scripts
provides:
  - deploy/cloudflare/turn-key.sh (API-only, idempotent Cloudflare TURN key create/reuse/cleanup, atomic env write, mint check, exit 3 on billing errors)
  - POST /api/rtc/ice-servers (login-gated, 30/min, no-store, never STUN-only; 503 turn_unconfigured / 502 turn_unavailable)
  - GET /ws signaling hub (Origin + non-renewing session check before the upgrade, rooms of two, relay to the other member, size/rate limits, heartbeat, logout 4401)
  - shared zod protocol: IceServer, IceServersResponse, RoomId, SignalData, ClientFrame, ServerFrame, WS limits and close codes
  - requireUserNoRenew preHandler
  - Package gate approval covering 01-04 and 01-05
affects: [01-05 call-test page and smokes, phase-02 chat realtime over /ws, phase-03 calls]

actuals:
  tokens: 18500
  tasks: 3
  commits: 3
plan_head_before: 83aab13c7300b173836687f7a283ec8a6ffacd2d
plan_head_after: 511ac27d79c3be0ede3589ae990e8fed949e4ffb

tech-stack:
  added: ["@fastify/websocket 11.3.3", "ws 8.22.0 (transitive)", "@types/ws 8.18.1 (dev)", "duplexify 4.1.3 + end-of-stream, readable-stream 3.6.2, stream-shift, string_decoder, safe-buffer 5.2.1 (transitive)"]
  patterns:
    - "WebSocket routes check Origin and session in preHandler, before the 101; GET is not covered by the global originGuard"
    - "No session renewal over /ws (requireUserNoRenew): a 101 cannot carry Set-Cookie"
    - "Hub addresses connections (connId), not users; userId is an attribute of a connection"
    - "Client frames are strict zod objects (unknown key = bad_frame); server frames are non-strict for old installed PWAs"
    - "Signaling payloads are relayed and dropped: never logged, never stored, hub imports no DB code"
    - "Tests drive /ws with injectWS via openWs(app, cookie, origin); the message listener is attached in onInit"

key-files:
  created:
    - deploy/cloudflare/turn-key.sh
    - shared/src/rtc.ts
    - shared/src/ws.ts
    - server/src/rtc/turn.ts
    - server/src/rtc/routes.ts
    - server/src/ws/hub.ts
    - server/src/ws/routes.ts
    - server/test/turn.test.ts
    - server/test/ws.test.ts
  modified:
    - server/src/app.ts
    - server/src/config.ts
    - server/src/auth/session.ts
    - server/src/auth/routes.ts
    - server/test/helpers.ts
    - shared/src/index.ts
    - scripts/smoke-local.sh
    - scripts/smoke-public.sh
    - .env.example
    - server/package.json
    - package-lock.json

key-decisions:
  - "turn-key.sh reads the bearer as .result.key // .result.secret because the live Cloudflare API returns it as result.secret"
  - "ServerFrame variants are non-strict zod objects (ClientFrame stays strict) so an installed PWA running an older client tolerates fields a newer server adds"
  - "requireUserNoRenew also leaves the cookie alone on an expired session (row deleted, 401, no Set-Cookie); requireUser keeps its exact previous behavior"
  - "A socket over the frame limit is marked closing and ignored until it closes, so frames already buffered after the 101st are not processed"

patterns-established:
  - "openWs test helper: injectWS client that answers pings like a browser; disconnect with terminate() in tests"
  - "AppDeps injection: fetch, turnTimeoutMs, logStream, heartbeatMs"

requirements-completed: []

coverage:
  - id: D1
    description: "Cloudflare TURN key created and reused through the API only (turn-key.sh), stored in the gitignored env file, verified with a real 60 s mint"
    requirement: "INFR-03"
    verification:
      - kind: integration
        ref: "bash deploy/cloudflare/turn-key.sh -> 'turn-key: reused key 379785b7', 'turn keys named duet: 1', 'turn-key ok'"
        status: pass
    human_judgment: false
  - id: D2
    description: "POST /api/rtc/ice-servers mints Cloudflare TURN credentials for logged-in users only (401/403/429/503/502 mapping, no-store, port-53 filter, never STUN-only)"
    requirement: "INFR-03"
    verification:
      - kind: unit
        ref: "server/test/turn.test.ts"
        status: pass
      - kind: integration
        ref: "TURN_SMOKE=1 bash scripts/smoke-local.sh -> 'turn mint ok'"
        status: pass
      - kind: e2e
        ref: "bash scripts/smoke-public.sh -> ice-servers 401 without a session, 'smoke-public ok'; newest turn_config log line configured true"
        status: pass
    human_judgment: false
  - id: D3
    description: "GET /ws signaling hub: Origin and non-renewing session checked before the upgrade, rooms of two, relay to the other member only, size/rate limits, logout 4401, no frame logging"
    requirement: "INFR-04"
    verification:
      - kind: unit
        ref: "server/test/ws.test.ts (24 cases)"
        status: pass
    human_judgment: false
  - id: D4
    description: "/ws over a real phone network through Cloudflare (production rollout and two-device call path)"
    requirement: "INFR-04"
    verification: []
    human_judgment: true
    rationale: "Owned by plan 01-05 (headless two-peer smoke, public /ws rollout, cellular UAT); not exercised by this plan"

duration: 7h 11m (wall clock, including the package gate wait)
completed: 2026-10-10
status: complete
---

# Phase 1 Plan 04: Cloudflare TURN credentials and /ws signaling hub Summary

**Login-gated Cloudflare TURN credential minting (API-provisioned key, deployed at duet.brkn.me) plus an authenticated `/ws` hub that relays WebRTC offer/answer/ICE between the two members of a room, with no session renewal over the socket**

## Performance

- **Duration:** about 7h 11m wall clock, mostly waiting on the Task 2 package gate. Active Task 3 work took about 15 minutes.
- **Started:** about 2026-10-09T14:23:00Z
- **Completed:** 2026-10-09T21:34:11Z
- **Tasks:** 3 of 3 (Task 2 was a gate with no code)
- **Files modified:** 20 (including package-lock.json)

## Accomplishments

- `deploy/cloudflare/turn-key.sh` creates or reuses exactly one TURN key named `duet` through the Cloudflare API, writes `CF_TURN_KEY_ID` / `CF_TURN_KEY_API_TOKEN` atomically to the env file, deletes stale `duet` keys, checks the key with a real 60 s mint, and never prints a secret. A re-run prints `reused key 379785b7` and `turn keys named duet: 1`.
- `POST /api/rtc/ice-servers` returns Cloudflare TURN credentials (TTL 86400 by default, 60..172800 enforced by config) only to a logged-in user with the right Origin. It is limited to 30 requests per minute per IP and sends `Cache-Control: no-store`. It drops `:53` URLs and never answers with a STUN-only list: 503 when TURN is unconfigured, 502 when Cloudflare errors or times out. This is deployed, and the container logs `turn_config configured: true`.
- `GET /ws` checks `Origin === APP_ORIGIN` (403) and the session (401) before the upgrade. The session check is `requireUserNoRenew`, so an open socket never moves `expiresAt` ahead of the browser cookie, while `GET /api/me` still renews it.
- The hub works per connection:
  - It sends `hello { connId, userId }` on connect. Rooms hold two members, and a same-tick join race admits exactly two.
  - `rtc.signal` goes to the other member only, unchanged. `room.peer-left` frees the slot.
  - Error frames: `not_in_room`, `too_many_rooms` (more than 4 rooms), and `bad_frame` (the socket stays open).
  - Size limits: SDP up to 65536 characters, candidate up to 2048, room id up to 64.
  - Close codes: 1008 above 100 frames per second, 1009 above 131072 bytes, and 4401 for every socket of a session that logs out.
  - A heartbeat ping runs every 25 s and terminates dead sockets. Frame contents are never logged.
- Shared zod protocol (`shared/src/ws.ts`, `shared/src/rtc.ts`) that Phase 2 chat and Phase 3 calls extend.

## Task Commits

1. **Task 1: Logged-in user gets Cloudflare TURN credentials (turn-key.sh → env → config → mint → POST /api/rtc/ice-servers → deployed)**: `c18cebb` (feat)
2. **Task 2: Package legitimacy gate**: no commit (checkpoint:human-verify, gate blocking-human). The user's reply, verbatim: "approved"
3. **Task 3: Two logged-in devices exchange WebRTC signaling through /ws (TDD)**
   - RED: `cf55e95` (test). This adds the failing `server/test/ws.test.ts` and the `openWs` helper.
   - GREEN: `511ac27` (feat). This adds the packages, `shared/src/ws.ts`, `requireUserNoRenew`, the hub, `/ws` and the logout cut-off.
   - REFACTOR: none needed.

**Plan metadata:** recorded in the docs commit that adds this SUMMARY.

## TDD Gate Compliance (Task 3)

- **RED (`cf55e95`):** I ran `npm --prefix server run --silent test -- test/ws.test.ts --reporter=tap-flat`. It exited 1 with 24 tests discovered and 24 failing. The target test was `GET /ws auth and Origin (before the upgrade) > rejects a connection without a session with 401`. `gsd-tools check tdd-red-evidence` returned `RED_EVIDENCE_OK` (`target_test_failed`); the record is at `.planning/phases/01-foundation-auth-media-plane/.tdd/01-04-T3-red.json`.
  - Semantic assessment: this is a valid RED. The target ran and failed on its planned assertion. `rejects.toThrow("Unexpected server response: 401")` received `app.injectWS is not a function`, because `/ws` and `@fastify/websocket` did not exist yet. That missing endpoint is the behavior under test, and there was no load, syntax or fixture fault.
- **GREEN (`511ac27`):** `test/ws.test.ts` passes 24 of 24, and the full server suite passes 90 of 90 across 8 files.
- **Order:** the `test(01-04)` commit comes before the `feat(01-04)` commit.

## Package gate (Task 2)

The user replied, verbatim: "approved". The approval covered these packages:
- `@fastify/websocket@11.3.3` (server dependency, exact pin)
- `ws`, transitive, resolved to 8.22.0
- `@types/ws@8.18.1` (server devDependency, exact pin)
- `playwright-core@1.62.1` (root devDependency, used by 01-05)
- The duplexify transitives (end-of-stream, readable-stream@3, stream-shift, string_decoder)
- The shadcn registry items switch and badge, added through the approved shadcn@4.21.4 CLI

The single gate covers 01-05 as well. This plan does not install `playwright-core`; that is left to 01-05 as planned.

## Files Created/Modified

- `deploy/cloudflare/turn-key.sh`: API-only TURN key create/reuse/cleanup, atomic env write, mint check, exit 3 on billing errors
- `shared/src/rtc.ts`: `IceServer` and `IceServersResponse` schemas
- `shared/src/ws.ts`: `RoomId`, `SignalDescription`, `SignalCandidate`, `SignalData`, `ClientFrame`, `Peer`, `WsErrorCode`, `ServerFrame`, plus the `WS_MAX_PAYLOAD`, `WS_CLOSE_LOGGED_OUT`, `WS_MAX_FRAMES_PER_SECOND` and `WS_MAX_ROOMS_PER_CONN` constants
- `shared/src/index.ts`: re-exports rtc and ws
- `server/src/config.ts`: `CF_TURN_KEY_ID`, `CF_TURN_KEY_API_TOKEN` (must be set together), `TURN_CREDENTIAL_TTL_SECONDS` (60..172800, default 86400) and `CF_TURN_API_BASE`, each added to both EnvSchema and the keys array
- `server/src/rtc/turn.ts`: `mintIceServers` and `TurnError` (timeout, zod validation, port-53 filter, no STUN-only fallback)
- `server/src/rtc/routes.ts`: `POST /api/rtc/ice-servers`
- `server/src/auth/session.ts`: a private `authenticate(renew)`, used by `requireUser` (behavior unchanged) and the new `requireUserNoRenew`
- `server/src/ws/hub.ts`: in-memory signaling hub with no DB imports
- `server/src/ws/routes.ts`: `GET /ws` with `wsOriginCheck` and `requireUserNoRenew` as preHandlers
- `server/src/app.ts`: `AppDeps` (`fetch`, `turnTimeoutMs`, `logStream`, `heartbeatMs`), registers `@fastify/websocket` with `maxPayload`, decorates `app.hub`, closes the hub on shutdown, registers `rtcRoutes` and `wsRoutes`, and logs `turn_config` at boot
- `server/src/auth/routes.ts`: logout calls `app.hub.closeSession(sessionId)`
- `server/test/helpers.ts`: `testConfig(extraEnv)`, `makeTestApp` options, `loginCookie`, `TURN_TEST_ENV` and `openWs`
- `server/test/turn.test.ts`, `server/test/ws.test.ts`: the new test suites
- `scripts/smoke-local.sh`: the default run checks for `turn unconfigured ok`; `TURN_SMOKE=1` checks for `turn mint ok`
- `scripts/smoke-public.sh`: checks that the public ice-servers endpoint answers 401 without a session
- `.env.example`: TURN variable names only
- `server/package.json`, `package-lock.json`: the exact-pinned websocket packages

## Decisions Made

- `ServerFrame` variants use non-strict `z.object`, while `ClientFrame` stays strict. The plan's "strict objects" rule exists to turn unknown client keys into `bad_frame`. Non-strict server frames let an installed PWA running an older client tolerate fields a newer server adds, which matches the reversibility note on this task.
- `requireUserNoRenew` sets no cookie in any case, including the expired-session 401. `requireUser` keeps its exact earlier behavior, and session.test.ts is unchanged and green.
- Once a socket passes the frame limit it is marked `closing`. Frames already buffered behind the 101st are then ignored, and nothing more is sent to that socket.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] The Cloudflare TURN key bearer is `result.secret`, not `result.key`**
- **Found during:** Task 1
- **Issue:** The live `POST /accounts/{id}/calls/turn_keys` response returns the bearer as `result.secret`. The plan and research said `result.key`.
- **Fix:** `turn-key.sh` now reads `.result.key // .result.secret`.
- **Cleanup:** The failed attempts left two orphaned keys, `87afb685` and `8c00bdbf`. Both were deleted through the API. Key `379785b7` is now the only key named "duet".
- **Files modified:** deploy/cloudflare/turn-key.sh
- **Verification:** a re-run prints "turn-key: reused key 379785b7", "turn keys named duet: 1" and "turn-key ok".
- **Committed in:** c18cebb

**2. [Rule 3 - Blocking] The injectWS test client neither auto-pongs nor completes a graceful close**
- **Found during:** Task 3 GREEN
- **Issue:** Two limits of `injectWS`, not of the server:
  - It builds its client `WebSocket` in server mode with `autoPong` unset, so it never answers pings. The heartbeat test therefore saw the socket terminated.
  - It wires client and server through PassThrough streams that never emit `close` after a graceful close handshake. As a result `ws.close()` never reached the hub's `close` handler within a test: no `room.peer-left`, and stale members stayed in rooms.
- **Fix:** All changes are in the test harness; no assertion was weakened.
  - `openWs` answers pings the way a browser does.
  - Tests disconnect with `ws.terminate()`, which is also the abrupt-drop case phones produce.
  - The four bad-frame tests use distinct follow-up room names.
- **Verification:** A throwaway test (not committed) used `app.listen` and a real `ws` client over TCP. It confirmed that a graceful `close()` produces `hello, room.joined, room.peer-joined, room.peer-left` at the other member.
- **Files modified:** server/test/helpers.ts, server/test/ws.test.ts
- **Committed in:** 511ac27 (the test file changed between RED and GREEN only in these harness details)

**3. [Process] Commits landed on `master`, which GSD reports as a protected branch**
- This is the project's established pattern: `master` is the only branch and there is no remote. Plans 01-01 through 01-03 were committed there too. The orchestrator explicitly directed commits to `master` for this run.

---

**Total deviations:** 2 auto-fixed (1 bug, 1 blocking), plus 1 process note
**Impact on plan:** None on scope. Fix 1 was required for the TURN key to work at all. Fix 2 only changes how tests drive the socket.

## Issues Encountered

- Disclosure: the install also added `safe-buffer@5.2.1`. It is a transitive dependency of the approved `string_decoder@1.3.0` (via readable-stream@3 → duplexify → @fastify/websocket), but it was not named in the gate list. It is the well-known feross package, has no install script, and was not a substitution. No other package beyond the approved set was added, and none of the new packages has an install script.

## Plan-level verification (re-run 2026-10-09T21:3xZ)

- `bash deploy/cloudflare/turn-key.sh`: "turn-key: reused key 379785b7", "turn keys named duet: 1", "turn-key ok"
- `npm --prefix server run test`: 8 files, 90 tests, all passing (db, seed, users, auth, session, static, turn, ws)
- `TURN_SMOKE=1 bash scripts/smoke-local.sh`: "turn mint ok", "smoke-local ok". `SKIP_BUILD=1 bash scripts/smoke-local.sh`: "turn unconfigured ok", "smoke-local ok"
- `bash scripts/smoke-public.sh`: "smoke-public ok". The newest `turn_config` log line says configured true.
- `npm run typecheck`: exit 0
- The negative import grep on `server/src/ws/*.ts` printed nothing.
- `git diff --quiet HEAD -- server/test/session.test.ts`: unchanged

## User Setup Required

None. The TURN key was provisioned through the API, and `/ws` needs no configuration.

## Next Phase Readiness

- Ready for 01-05: the call-test page, the headless two-peer smoke, the public `/ws` rollout (redeploy, since the container still runs the Task 1 image without `/ws`), and the cellular UAT. The package gate for `playwright-core@1.62.1` and shadcn switch/badge is already approved.
- INFR-03 and INFR-04 are shared with 01-05, so they are not marked complete yet. `requirements.ready-ids` reported 0 of 2 ready.

## Self-Check: PASSED

- FOUND: deploy/cloudflare/turn-key.sh, shared/src/rtc.ts, shared/src/ws.ts, server/src/rtc/turn.ts, server/src/rtc/routes.ts, server/src/ws/hub.ts, server/src/ws/routes.ts, server/test/turn.test.ts, server/test/ws.test.ts
- FOUND commits: c18cebb, cf55e95, 511ac27 (`git rev-list --count 83aab13..HEAD` = 3)

---
*Phase: 01-foundation-auth-media-plane*
*Completed: 2026-10-10*
