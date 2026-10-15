---
phase: 03-voice-video-calls
plan: 01
subsystem: calls
tags: [webrtc, websocket, zod, fastify, perfect-negotiation, webaudio, playwright, vitest]

requires:
  - phase: 01-foundation-auth-media-plane
    provides: Cloudflare TURN mint (POST /api/rtc/ice-servers), /ws hub with rooms and rtc.signal relay, perfect-negotiation createPeer, getStats sampling
  - phase: 02-chat-media-push
    provides: the tab's single reconnecting Realtime socket, useSyncExternalStore store pattern, Shell header and Toaster, NotificationsDrawer pattern
provides:
  - shared call contract (CallId, CallKind, CallEndReason, StopRingingReason, CALL_ROOM_PREFIX, callRoom, CALL_RING_TIMEOUT_MS, formatCallDuration)
  - call.* WS frames (invite/accept/decline/end; ring/accepted/stop-ringing/ended) and error codes room_reserved, not_allowed
  - server single-call registry (createCallRegistry) with 45 s ring timer, absence grace, multi-device first wins, glare merge, busy, invite flood guard
  - hub call hooks (setCallHooks, sendToConn, sendToUser, serverJoin, serverLeave, sessionOf) and call- room reservation
  - client seams sendFrame/onRealtimeFrame and createPeer role/setup/beforeAnswer/onTrack
  - client call layer (callStore/useCall, CallSession, getMic, tones), CallProvider, CallScreen, IncomingCall, PermissionDrawer, header Voice call button
  - scripts/smoke-calls.sh + .mjs two-browser E2E with real TURN (nine scenarios)
affects: [03-02 push ringing and ring-on-attach, 03-03 video and in-call controls, 03-04 reconnect and device UAT]

actuals:
  tokens: 32800
  tasks: 3
  commits: 5
plan_head_before: 89896a9cb8504d073f3ed42d1b7d67600638591b
plan_head_after: 6108cbddaeb571cf59e69b38c770f4728d5cde44

tech-stack:
  added: []
  patterns:
    - "Server-owned call lifecycle: one in-memory current call, every timer unref'd and cleared in end()/close()"
    - "Fixed WebRTC roles (caller impolite offerer, callee polite answerer) with audio+video transceivers negotiated once"
    - "Calls ride the tab's one Realtime socket through sendFrame/onRealtimeFrame (no second socket)"
    - "Call store commit(): tones and guard timers follow phase transitions in one place"

key-files:
  created:
    - shared/src/call.ts
    - server/src/calls/registry.ts
    - server/test/calls.test.ts
    - server/test/call-registry.test.ts
    - server/test/call-logic.test.ts
    - web/lib/call/media.ts
    - web/lib/call/session.ts
    - web/lib/call/store.ts
    - web/lib/call/tones.ts
    - web/components/app/call-provider.tsx
    - web/components/app/call-screen.tsx
    - web/components/app/incoming-call.tsx
    - web/components/app/permission-drawer.tsx
    - scripts/smoke-calls.sh
    - scripts/smoke-calls.mjs
  modified:
    - shared/src/ws.ts
    - shared/src/index.ts
    - server/src/ws/hub.ts
    - server/src/app.ts
    - server/src/config.ts
    - server/test/helpers.ts
    - web/lib/chat/realtime.ts
    - web/lib/rtc/peer.ts
    - web/components/app/shell.tsx

key-decisions:
  - "CallId is a lowercase-only z.uuid(), so callRoom(id) is always a valid RoomId for rtc.signal"
  - "Rate limit counts only invites that would ring (busy, glare and repeated invites are not counted)"
  - "A ring that arrives while this device's own Start tap waits for the microphone is answered with that microphone (client-side D-14), so glare merges whichever side the race lands on"
  - "Callee setup failures (no mic, no ICE servers, session throw) send call.decline before showing Couldn't connect, so the caller is never left ringing"
  - "smoke-calls pools one login per session slot across scenarios because POST /api/login allows 5 per 5 minutes per account and IP"

patterns-established:
  - "Registry transport interface: the registry never touches sockets; the hub implements CallTransport"
  - "call-diag hidden element (phase, call id, local candidate type, inbound bytes, tone) as the E2E observation point; never ICE servers or credentials"

requirements-completed: [CALL-01, CALL-04]

coverage:
  - id: D1
    description: "Voice call from the chat header rings the other open app, connects P2P through Cloudflare TURN with audio both ways, shows the running timer and ends with 'Call ended · m:ss' on both phones with every mic track stopped"
    requirement: CALL-01
    verification:
      - kind: e2e
        ref: "bash scripts/smoke-calls.sh voice"
        status: pass
      - kind: integration
        ref: "server/test/calls.test.ts"
        status: pass
    human_judgment: false
  - id: D2
    description: "Server-owned 45 s ring timeout, caller cancel while ringing, decline, no answer with no device (D-16), absence grace instead of hanging up on a socket blip"
    requirement: CALL-04
    verification:
      - kind: unit
        ref: "server/test/call-registry.test.ts"
        status: pass
      - kind: e2e
        ref: "bash scripts/smoke-calls.sh decline cancel no-answer"
        status: pass
    human_judgment: false
  - id: D3
    description: "Couldn't connect with Retry/Close on setup failure; multi-device first wins with 'Answered on another device'; glare merge; busy refusal; Allow the microphone drawer"
    requirement: CALL-01
    verification:
      - kind: e2e
        ref: "bash scripts/smoke-calls.sh couldnt-connect multi-device glare busy mic-denied"
        status: pass
      - kind: unit
        ref: "server/test/call-registry.test.ts"
        status: pass
    human_judgment: false
  - id: D4
    description: "Call audio, ringtone/ringback audibility and vibration, iOS autoplay silence and the call screen look on the real iPhone and Pixel PWAs (and over cellular)"
    requirement: CALL-01
    verification: []
    human_judgment: true
    rationale: "Headless Chrome uses fake devices and an autoplay override; real audio routing, iOS gesture rules, vibration and the visual result need the end-of-phase device UAT (03-04)"

duration: 23min
completed: 2026-10-16
status: complete
---

# Phase 3 Plan 01: Voice Calls and the Ringing Lifecycle Summary

**1:1 voice calls started from the chat header: a server-owned single-call registry on the existing /ws (45 s ring timer, multi-device first wins, glare merge, busy, flood guard), fixed-role perfect negotiation with pre-negotiated audio+video transceivers over Cloudflare TURN, and full-screen call/incoming screens with WebAudio tones, proven by a nine-scenario two-browser E2E**

## Performance

- **Duration:** 23 min
- **Started:** 2026-10-15T22:29:20Z
- **Completed:** 2026-10-15T22:51:53Z
- **Tasks:** 3
- **Files modified:** 26 (24 source/test/script files plus 2 RED evidence records)

## Accomplishments

- Tapping "Voice call" in the header rings every open device of the other person; Accept connects the two browsers peer-to-peer (real Cloudflare TURN in the smoke) and both sides show the m:ss timer from the first inbound media; Hang up shows "Call ended · m:ss" on both and stops every captured track.
- The server owns the lifecycle: one current call, call rooms joined server-side only (client `room.join` of `call-*` answers `room_reserved`), `not_allowed` for accept/decline/end from the wrong connection, a 45 s ring timer (`CALL_RING_TIMEOUT_MS`, 10 s in the smoke), caller-absent 10 s cancel, active-call 35 s dropped grace, and a recent-call map (50 entries / 24 h) for stale frames.
- Multi-device (D-11), glare (D-14), busy and a 10-invites-per-60-s flood guard are handled in the registry and reflected on the client with the UI-SPEC toasts.
- Terminal states: Declined (2 s), No answer (2 s), Call ended (1.5 s), Couldn't connect with Retry/Close; client guards (55 s ring, 50 s incoming, 20 s connect); missed-call toast with Call back when an Accept loses the race.
- WebAudio ringback (caller, started inside the tap) and ringtone with best-effort vibration (callee), stopped on every transition out of ringing; an aria-live status region; the "Allow the microphone" drawer with iOS and Android steps.

## Task Commits

1. **Task 1: End-to-end voice call (tracer)** - `332f195` (feat)
2. **Task 2: Ring timeout, absence grace, terminal states, tones**
   - RED: `aa1da39` (test)
   - GREEN: `c10c5ae` (feat)
3. **Task 3: Multi-device, glare, busy, flood guard, mic denied, offline, disabled header**
   - RED: `6d937c3` (test)
   - GREEN: `6108cbd` (feat)

**Plan metadata:** see the docs(03-01) commit that adds this file.

## TDD Gate Compliance

- **Task 2 RED:** `server/test/call-registry.test.ts > ring timeout (D-07) > ends an unanswered call as no-answer at 45 s ...` failed on `expected [] to have a length of 1 but got +0` (no ring timer yet); the config cases failed on `expected undefined to be 45000`. Classifier: `RED_EVIDENCE_OK (target_test_failed)`. Semantic assessment: the target executed and failed on the planned assertion; no load, syntax or fixture faults. Record: `.planning/phases/03-voice-video-calls/.tdd/03-01-task2-red.json`.
- **Task 3 RED:** `... > glare (D-14) > merges the callee's own invite into the ringing call as an accept` failed on `expected [] to have a length of 1 but got +0` (the callee's invite got busy). Multi-device stop-ringing and the flood guard also failed on assertions. Classifier: `RED_EVIDENCE_OK (target_test_failed)`. Record: `.planning/phases/03-voice-video-calls/.tdd/03-01-task3-red.json`.
- **GREEN:** `c10c5ae` and `6108cbd`, each after its `test(03-01)` commit. No REFACTOR commits were needed.
- Task 1 is `type="tracer"` (not TDD): its tests were written with the implementation. The tracer gate re-ran its full `<verify>` (calls/call-logic tests, smoke-calls voice, smoke-call, smoke-chat send/catchup, server suite, typecheck, preset) green before expansion.

## Files Created/Modified

- `shared/src/call.ts` - call ids, kinds, end reasons, call room naming, 45 s constant, formatCallDuration
- `shared/src/ws.ts` - call.* client/server frames, room_reserved / not_allowed, CallClientFrame
- `server/src/calls/registry.ts` - single-call state machine with timers, glare, busy, multi-device, flood guard
- `server/src/ws/hub.ts` - call hooks, sendToConn/sendToUser/serverJoin/serverLeave/sessionOf, call- room reservation, onAttach/onClose
- `server/src/app.ts`, `server/src/config.ts`, `server/test/helpers.ts` - registry wiring, `app.calls`, `CALL_RING_TIMEOUT_MS`, `callTimers` injection
- `server/test/calls.test.ts`, `call-registry.test.ts`, `call-logic.test.ts` - WS integration, pure registry with fake timers, contract
- `web/lib/chat/realtime.ts` - sendFrame and onRealtimeFrame on the tab's single socket
- `web/lib/rtc/peer.ts` - role / setup / beforeAnswer / onTrack (the /debug/call path unchanged)
- `web/lib/call/{media,session,store,tones}.ts` - mic capture, one call's peer and media, the call store, WebAudio tones
- `web/components/app/{call-provider,call-screen,incoming-call,permission-drawer}.tsx` - the call layer and screens
- `web/components/app/shell.tsx` - Voice call button (disabled during a call), CallProvider mount, callStore.reset on logout
- `scripts/smoke-calls.sh`, `scripts/smoke-calls.mjs` - two-browser E2E (voice, decline, cancel, no-answer, couldnt-connect, multi-device, glare, busy, mic-denied)

## Decisions Made

- `CallId` is a lowercase-only UUID so `callRoom(id)` always satisfies `RoomId`.
- Only invites that would ring count toward the flood limit.
- A ring that arrives while this device's own Start tap is still waiting for the microphone is answered with that microphone (a client-side glare merge), so the two attempts become one call whichever side the race lands on.
- A callee whose setup fails sends `call.decline` before showing "Couldn't connect", so the caller is never left ringing for 45 s.
- Busy copy (Claude's discretion, per the plan): toast "You're already in a call on another device."

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] smoke-calls pools logins instead of using loggedInPage per page**
- **Found during:** Task 3 (all nine scenarios in one run)
- **Issue:** `POST /api/login` allows 5 logins per 5 minutes per account and IP; nine scenarios opening fresh logged-in pages hit 429 at the sixth scenario.
- **Fix:** `smoke-calls.mjs` logs each fixture in once per session slot (slot 1 = a second device/session for multi-device and busy) and reuses the cookie in fresh browser contexts; `dumpErrors`, `fixtureIds` and `launchBrowser` still come from `scripts/lib/e2e.mjs`.
- **Files modified:** scripts/smoke-calls.mjs
- **Verification:** `SKIP_BUILD=1 bash scripts/smoke-calls.sh` prints all nine scenario ok lines and "smoke-calls ok".
- **Committed in:** 6108cbd

**2. [Rule 1 - Bug] A glare race on the device itself would show an incoming call instead of merging**
- **Found during:** Task 3 (client glare handling)
- **Issue:** if the other person's ring reached this device while its own Start tap was still waiting for the microphone, the store showed the incoming screen and dropped the Start tap, so D-14 would not merge.
- **Fix:** `startCall` answers the ringing call with the microphone it just captured (shared `answer()` with `acceptCall`).
- **Files modified:** web/lib/call/store.ts
- **Verification:** smoke `glare` scenario passes; typecheck clean.
- **Committed in:** 6108cbd

**3. [Process] Commits landed on master although git.base-branch reports it protected**
- The orchestrator dispatched this plan sequentially on `master` with explicit instructions to use normal commits; earlier phases did the same (STATE decision 01-01). No self-recovery or ref rewriting was done. Consider `git.allow_default_branch_commits: true`.

**4. [Rule 3 - Blocking] RED target assertions made single-line for the TAP classifier**
- **Found during:** Task 2 RED
- **Issue:** vitest's TAP output embeds multi-line `toEqual` diffs, which the RED-evidence classifier rejected as malformed TAP.
- **Fix:** the target tests assert `toHaveLength(1)` before the full `toEqual`, and the RED run filtered to the target test (`-t`).
- **Files modified:** server/test/call-registry.test.ts
- **Committed in:** aa1da39, 6d937c3

---

**Total deviations:** 4 (2 blocking, 1 bug, 1 process note)
**Impact on plan:** none of them changed scope; every planned behaviour, test and scenario is in place.

## Issues Encountered

None beyond the deviations above.

## Known Stubs

None. `onAttach` in the registry is intentionally a no-op until 03-02 adds ring-on-attach (plan text).

## Threat Flags

None. The new surface (call.* frames, call rooms, call-diag) is the one in the plan's threat model, and each mitigation is in place: T-03-01 not_allowed checks (tested), T-03-02 room_reserved (tested), T-03-03 busy + INVITE_LIMIT (tested), T-03-04 single current call, recent cap 50 / 24 h, unref'd timers cleared in end/close (tested), T-03-05 strict zod frames with lowercase uuid ids, T-03-06 registry logs only evt/callId/userIds/reason/durationMs, T-03-07 call-diag exposes phase/call id/candidate type/bytes/tone only.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

- 03-02 can hook push ringing and ring-on-attach into `CallRegistry.onAttach` and `hub.sessionOf` / `callerSession` / `calleeSession`.
- 03-03 adds the video icon, camera via `replaceTrack` on the pre-negotiated video transceiver (`CallSession`), `call.media`, minimize, and the camera permission drawer variant (`PermissionDrawer device="camera"`).
- 03-04 adds reconnect (`call.rejoin`), forced-relay E2E (`duet.forceRelay` and `data-local-type` already exist) and the device UAT.
- Not yet verified on real phones: audio routing, tone audibility, vibration and iOS gesture behaviour (coverage D4).

## Self-Check: PASSED

- All 15 created files exist on disk.
- Commits 332f195, aa1da39, c10c5ae, 6d937c3, 6108cbd are ancestors of HEAD; the evaluation scope resolves them as this plan's commits.
- Plan verification re-run after the last commit: server suite 338 passed / 1 skipped, `npm run typecheck` clean, `check-preset.sh` "preset ok", `smoke-calls.sh` all nine scenarios ok, `smoke-call.sh` "smoke-call ok", `smoke-chat.sh send catchup` ok.
- Acceptance greps: room_reserved in hub.ts 1, addTransceiver in session.ts 2, `aria-label="Voice call"` in shell.tsx 1, no SignalingClient in the call modules, CALL_RING_TIMEOUT_MS in config.ts 3, unref in registry.ts 2, aria-live in call-screen.tsx 3, "Answered on another device" in store.ts 1, "Allow the microphone" in permission-drawer.tsx 1, INVITE_LIMIT in registry.ts 3.

---
*Phase: 03-voice-video-calls*
*Completed: 2026-10-16*
