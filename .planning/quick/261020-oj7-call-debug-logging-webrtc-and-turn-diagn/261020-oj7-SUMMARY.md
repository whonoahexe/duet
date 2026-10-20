---
phase: 261020-oj7
plan: 01
subsystem: calls
status: complete
tags: [calls, logging, webrtc, turn, privacy, diagnostics]
requires: []
provides:
  - "POST /api/calls/diag writing call_diag lines (strict enum/int/boolean schema)"
  - "Server call story lines: call_frame, call_refused, call_absent_start/stop, call_ws_close/open, call_end by/cause/ringMs/totalMs, turn_mint ms/ttlSeconds"
  - "Client call log: web/lib/call/diag-log.ts (startCallLog, callLog, callLogSample, endCallLog, gumName)"
  - "smoke-calls scenario call-log with a privacy scan"
affects: [web/lib/call/store.ts, web/lib/call/session.ts, server/src/calls/registry.ts]
tech-stack:
  added: []
  patterns:
    - "Privacy by schema: z.strictObject with enums/bounded ints/booleans only, logged field by field"
    - "Fire-and-forget client logging: bounded buffer, fetch keepalive, every export swallows errors"
    - "Route logLevel 'warn' to keep Fastify request lines (remoteAddress/remotePort) out of call greps"
key-files:
  created:
    - shared/src/call-diag.ts
    - server/test/call-diag.test.ts
    - web/lib/call/diag-log.ts
  modified:
    - shared/src/index.ts
    - server/src/calls/routes.ts
    - server/src/calls/registry.ts
    - server/src/ws/hub.ts
    - server/src/rtc/routes.ts
    - server/test/call-registry.test.ts
    - server/test/turn.test.ts
    - web/lib/call/store.ts
    - web/lib/call/session.ts
    - web/lib/call/media.ts
    - web/lib/rtc/stats.ts
    - scripts/smoke-calls.sh
    - scripts/smoke-calls.mjs
    - README.md
decisions:
  - "Client logs post with fetch keepalive (not sendBeacon: Chrome refuses an application/json Blob; not apiPost: no keepalive)"
  - "GET /api/calls/:id also runs at logLevel warn so a callId grep never shows a request line with the client address"
  - "call_absent_stop names the absent party (the one the timer waited for), by accept or rejoin"
  - "ws down/live client events are logged whenever a call log is active (not only when boundHere), so a ringing-in phone's socket blinks are visible too"
metrics:
  duration: "16 min"
  completed: 2026-10-20
  tasks: 3
  files: 17
actuals:
  tokens: 27500
  tasks: 3
  commits: 3
plan_head_before: ec98a3c7d9b99d25dd350cac8bfb7534ccbfd1f0
plan_head_after: abbc51e6fabdfe34bfb12a9b44a672a8212d66ba
---

# Phase 261020-oj7 Plan 01: Call debug logging (WebRTC and TURN diagnostics) Summary

One `docker logs duet-duet-1 2>&1 | grep <callId>` now shows the whole call: the server's lines (who sent each frame, who ended the call and why, absence timers, each party's socket closing with its close code, ring time, TURN mint latency) and both phones' `call_diag` lines (phases, peer connection states, ICE restarts, selected candidate pair, stats every ~6 s, toggles, getUserMedia errors, page lifecycle, socket and reconnect events, TURN fetch timing, end cause). Personal data can't be logged: the client schema holds only enums, bounded integers and booleans.

## Tasks

| Task | Name | Commit | Key files |
|------|------|--------|-----------|
| 1 (tracer) | End-to-end call_diag: shared contract, POST /api/calls/diag, client logger, store phase/end wiring, call-log smoke | aed3c45 | shared/src/call-diag.ts, server/src/calls/routes.ts, server/test/call-diag.test.ts, web/lib/call/diag-log.ts, web/lib/call/store.ts, scripts/smoke-calls.{sh,mjs} |
| 2 | Server call story: frames, who ended it, absence timers, sockets, timing, TURN mint latency | 05e0e87 | server/src/calls/registry.ts, server/src/ws/hub.ts, server/src/rtc/routes.ts, server/test/call-registry.test.ts, server/test/turn.test.ts |
| 3 | Full client coverage plus the README "Reading a call's log" section | abbc51e | web/lib/rtc/stats.ts, web/lib/call/{diag-log,session,media,store}.ts, scripts/smoke-calls.mjs, README.md |

## Verification

- `npm test`: 25 files, 417 passed and 1 skipped. New tests: call-diag.test.ts (auth, origin, a strict schema that rejects IPs, candidates and SDP, the 100-event and 48 KiB caps, the rate limit at 60/min per IP, and an allowed-key whitelist on every line), 9 registry log tests and a turn_mint ms/ttlSeconds test.
- `npm --prefix server run typecheck`, `npm --prefix web run typecheck` and `npm --prefix web run lint -- lib/call lib/rtc` all exit 0.
- `bash scripts/smoke-calls.sh`: all 19 scenarios pass, including the new `call-log`, and it printed "smoke-calls ok". I checked the real lines of a call by hand. They had batch, phase, pc, pair (host/prflx → host/host, udp, ethernet), stats, turn, media, end and every server line, and the privacy scan matched nothing.
- No package or lockfile changed. `web/lib/rtc/peer.ts` and `call-provider.tsx` are untouched.

## TDD Gate Compliance

- Task 1: I wrote call-diag.test.ts first and confirmed it failed (18 failed, the route answered 404). Then I implemented the endpoint and the tests passed.
- Task 2: I wrote the registry and turn log tests first and confirmed they failed (9 failed). Then I implemented the logging and they passed.
- Task 3: verified through the call-log smoke scenario (real browsers). The web package has no unit test harness.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 2 - Privacy] Silenced Fastify request lines for GET /api/calls/:id**
- **Found during:** Task 1
- **Issue:** Fastify's "incoming request" line for `GET /api/calls/<callId>` puts the callId in the URL next to remoteAddress/remotePort, so `grep <callId>` could show a client address.
- **Fix:** `logLevel: "warn"` on that route, the same treatment as the new diag route, with a doc comment explaining why.
- **Files modified:** server/src/calls/routes.ts
- **Commit:** aed3c45

**2. [Rule 2 - Coverage] Connecting-guard timeout logs end cause setup_failed**
- **Found during:** Task 3
- **Issue:** The store's connecting guard timer ends a call with "Couldn't connect", and the plan listed no end cause for it, so that phone's log would have no `end` line.
- **Fix:** It now logs `end {cause: "setup_failed"}` before showFailure.
- **Commit:** abbc51e

**3. [Minor] Client ws down is logged whenever a call log is active**
- The plan said to log it only when `boundHere()`. I logged both down and live whenever a call log is active, so a ringing-in phone's socket blinks show up too. `callLog` does nothing when no call log is active.

## Known Stubs

None.

## Threat Flags

None. The only new surface is POST /api/calls/diag, which the plan's threat model covers (T-oj7-01..09).

## Manual check for the user (after redeploy)

The production container must be rebuilt and redeployed before real calls write these lines: `docker compose up -d --build`. I did not do this. The orchestrator handles the deploy.

1. Call between the iPhone and the Pixel with one phone on cellular. Toggle mute and the camera, lock one phone for about 10 s, unlock it and hang up.
2. Get the callId from the latest `call_invite` line (see README "Reading a call's log"), then run `docker logs duet-duet-1 2>&1 | grep <callId>`.
3. Expect server lines plus `call_diag` lines from both user ids:
   - batch lines with os `ios` / `android` and standalone true
   - a `pair` line (relay, or srflx/host)
   - `stats` lines about every 6 s
   - `page` hidden/visible around the lock (and `freeze` on the Pixel)
   - `call_ws_close`/`call_ws_open` if the socket blinked
   - `call_end` with `by` = whoever hung up
4. Make sure no line shows an IP address, a name, SDP or a candidate string.

## Self-Check: PASSED

- FOUND: shared/src/call-diag.ts, server/test/call-diag.test.ts, web/lib/call/diag-log.ts
- FOUND commits: aed3c45, 05e0e87, abbc51e (ancestors of HEAD)
