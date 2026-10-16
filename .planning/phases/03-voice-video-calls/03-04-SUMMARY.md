---
phase: 03-voice-video-calls
plan: 04
subsystem: calls
tags: [webrtc, ice-restart, websocket, reconnect, getstats, playwright, vitest, docker]

requires:
  - phase: 03-voice-video-calls
    provides: "03-01 registry absence timers, sessionOf / callerSession / calleeSession, sendFrame / onRealtimeFrame, fixed caller/callee roles; 03-03 call.media camera flags, on-call bar, call-screen structure, minimized endings as toasts"
provides:
  - "call.rejoin client frame and call.state {callId, status, peerCamera} server frame"
  - "registry rejoin: same-session check, stale-connection eviction (serverLeave before serverJoin), absence timer cleared, log evt call_rejoin"
  - "onRealtimeLive / onRealtimeDown / realtimeLive seams on the tab's single socket"
  - "Peer.restart(): rollback of a pending local offer, then restartIce"
  - "CallSession: connectionState, restartIce, peerPresent, ICE watch (failed at once, disconnected after 2 s, retry every 5 s), setMic"
  - "reconnect controller in the call store: reconnecting state, CALL_GIVE_UP_MS (30 s) shared give-up timer, Call dropped + Call back, track re-acquire on resume, poor flag"
  - "qualityStep, QUALITY_START, POOR_LOSS_FRACTION, POOR_RTT_MS, POOR_ON_SAMPLES, POOR_OFF_SAMPLES"
  - "CallSample.packetsLost / packetsReceived"
  - "Poor connection badge (WifiLowIcon), Reconnecting… status line and on-call bar, Call dropped layout"
  - "smoke-calls scenarios reconnect, dropped, relay (18 in total); routeWebSocket helpers"
  - "README Calls section"
affects: [phase 3 verification, end-of-phase device UAT]

actuals:
  tokens: 18000
  tasks: 3
  commits: 4
plan_head_before: 190d3284628009940df9d9d4b2776231e05efb63
plan_head_after: e6fcdcd44725a48d6105ffe60c7714f06a3e2197

tech-stack:
  added: []
  patterns:
    - "One give-up timer for every drop trigger; recovery = ICE connected AND socket live AND (after a socket drop) call.state received"
    - "The caller alone restarts ICE (fixed roles); a pending local offer is rolled back first, so a lost offer never strands the call"
    - "Rejoin moves a party to its new connection only for the session bound at invite/accept; the stale connection leaves the call room before the new one joins"
    - "In-page MutationObserver records transient UI states for E2E (a reconnect can recover faster than a poll sees it)"

key-files:
  created:
    - .planning/phases/03-voice-video-calls/.tdd/03-04-task2-red.json
  modified:
    - shared/src/ws.ts
    - shared/src/call.ts
    - server/src/calls/registry.ts
    - server/src/ws/hub.ts
    - server/test/calls.test.ts
    - server/test/call-logic.test.ts
    - web/lib/chat/realtime.ts
    - web/lib/rtc/peer.ts
    - web/lib/rtc/stats.ts
    - web/lib/call/session.ts
    - web/lib/call/store.ts
    - web/components/app/call-screen.tsx
    - web/components/app/on-call-bar.tsx
    - web/components/app/call-provider.tsx
    - scripts/smoke-calls.mjs
    - README.md

key-decisions:
  - "The caller retries the ICE restart every 5 s while the connection stays disconnected or failed (after the first restart at 2 s), so a restart offer lost on a live socket is retried too"
  - "A rejoin re-arms the shared absence timer when the other party is still away, because the registry keeps only one absence timer per call"
  - "call.state active while this side still rings out means the call.accepted was lost during the outage: it starts the caller session like call.accepted"
  - "A device sends call.rejoin only for a call the server knows from it (the invite reached the socket, or it is the callee), so a reconnect between the Start tap and the invite never closes the call"
  - "A rejoin naming an ended call answers its stored reason only to one of that call's two parties; anyone else gets dropped (same party-only rule as GET /api/calls/:id)"
  - "The Poor connection badge also keeps the auto-hiding controls on screen (UI-SPEC lists it as a non-timer status) and has its own aria-live region, so it is announced once and its removal says nothing"

patterns-established:
  - "call-diag carries data-reconnecting and data-poor"
  - "Realtime down/live listeners are module-level like frame listeners; stopRealtime (logout) never fires down"

requirements-completed: [CALL-07, CALL-09]

coverage:
  - id: D1
    description: "A WebSocket drop mid-call shows Reconnecting… (status line and on-call bar), the socket reconnects and rejoins with stale-connection eviction, the timer returns without resetting, the same call continues and the relay reaches the new socket"
    requirement: CALL-07
    verification:
      - kind: e2e
        ref: "bash scripts/smoke-calls.sh voice reconnect"
        status: pass
      - kind: integration
        ref: "server/test/calls.test.ts#call.rejoin (CALL-07, D-17, T-03-17, T-03-18)"
        status: pass
    human_judgment: false
  - id: D2
    description: "A vanished peer ends as Call dropped with Call back and Close within 50 s, with the microphone released; Close returns to the chat"
    requirement: CALL-07
    verification:
      - kind: e2e
        ref: "bash scripts/smoke-calls.sh dropped"
        status: pass
    human_judgment: false
  - id: D3
    description: "Poor connection badge thresholds: loss above 5% or RTT above 400 ms is bad, 2 bad on, 3 good off, missing values good"
    requirement: CALL-07
    verification:
      - kind: unit
        ref: "server/test/call-logic.test.ts#qualityStep (D-20 Poor connection badge)"
        status: pass
      - kind: e2e
        ref: "bash scripts/smoke-calls.sh relay (no badge on a healthy link)"
        status: pass
    human_judgment: false
  - id: D4
    description: "Relay forced on both sides connects through Cloudflare TURN with relay local candidates and audio both ways"
    requirement: CALL-09
    verification:
      - kind: e2e
        ref: "bash scripts/smoke-calls.sh relay"
        status: pass
      - kind: e2e
        ref: "SKIP_BUILD=1 bash scripts/smoke-call.sh (relay-relay)"
        status: pass
    human_judgment: false
  - id: D5
    description: "Production at https://duet.brkn.me runs the complete Phase 3: container healthy, smoke-public, live DB check, the deployed bundle contains call.rejoin"
    requirement: CALL-09
    verification:
      - kind: e2e
        ref: "bash scripts/smoke-public.sh && bash scripts/check-live-db.sh --existing ./data"
        status: pass
    human_judgment: false
  - id: D6
    description: "A real call with one phone on cellular and the other on Wi-Fi through the relay; airplane-mode and Wi-Fi/cellular switch recovery; Call dropped after 30 s offline; iOS lock/background resume and capture re-acquire (A4); plus every device item deferred by 03-01..03-03"
    requirement: CALL-09
    verification: []
    human_judgment: true
    rationale: "Headless E2E proves relay-only through Cloudflare from one host (hairpin) and drops only the WebSocket; real cellular paths, radio switches, iOS capture interruptions, push delivery and audio routing need the end-of-phase device UAT"

duration: 16min
completed: 2026-10-16
status: complete
---

# Phase 3 Plan 04: Reconnect, Call Dropped, Poor Connection and Relay Proof Summary

**Calls now survive network blips. A dropped socket or media path shows "Reconnecting…" and recovers by itself: the socket rejoins with `call.rejoin`, the server evicts the stale connection from the call room, and the caller restarts ICE after rolling back any lost offer. The timer never resets. A single 30 s give-up ends the call as "Call dropped" with Call back. A Poor connection badge follows real getStats loss and RTT, and ended iOS capture tracks are re-acquired on resume. Relay-only calls are proven through Cloudflare TURN, and the whole phase is live in production with 18 call scenarios green.**

## Performance

- **Duration:** 16 min
- **Started:** 2026-10-16T06:59:22Z
- **Completed:** 2026-10-16T07:15:59Z
- **Tasks:** 3
- **Files modified:** 17 (16 source/test/script/doc files plus 1 RED evidence record)

## Accomplishments

- **Rejoin (server):** `call.rejoin` from a new connection of the session bound at invite or accept moves that party to the new connection.
  - The stale connection leaves `call-<id>` before the new one joins, so there is no `room.full` after a Wi-Fi/cellular switch and no signals go to a half-open socket.
  - The absence timer stops, and the new connection gets `call.state {callId, status, peerCamera}`.
  - Another session, even the same person's other phone, gets `not_allowed`.
  - A call that is over answers `call.ended` with its stored reason, or `dropped` if unknown.
  - Each rejoin logs `call_rejoin`.
- **Reconnect controller (client):**
  - **Triggers:** a socket drop (`onRealtimeDown`), or the peer connection going disconnected or failed. Any trigger shows "Reconnecting…" in the status line and on-call bar, and they all share one 30 s give-up timer.
  - **Recovery** needs three things: ICE connected, a live socket, and `call.state` received after a socket drop.
  - **ICE restarts** come from the caller only: at once on failed, after 2 s disconnected, every 5 s after that, and when the peer comes back into the room while not connected. Each restart rolls back a pending offer first.
  - The RTCPeerConnection is never recreated.
  - **Camera flag:** resent after every `call.state`.
- **Call dropped:** shows a muted WarningCircleIcon, the title "Call dropped", then Call back (accent) and Close (ghost) stacked. It appears on a 30 s give-up, which also sends `call.end` when the socket is live, or when the server ends a call as dropped after 35 s away. While minimized it is a toast with Call back.
- **Poor connection (D-20):** each 2 s sample's inbound loss delta and RTT go into `qualityStep`. The `secondary` Badge with WifiLowIcon sits in the top bar's right slot in both modes. It is hidden during Reconnecting… and announced once per appearance.
- **iOS resume (D-18):** when duet returns to the foreground, an ended microphone, or an ended camera while the camera is on, is captured again and swapped in with replaceTrack. Mute and camera state are kept.
- **E2E (18 scenarios):**
  - `reconnect` cuts Ada's `/ws` from both ends through `page.routeWebSocket`.
  - `dropped` closes Bob's page.
  - `relay` forces TURN on both pages and asserts `relay` local candidates.
- **Ship:** README "Calls" section added. Deployed: container healthy, smoke-public and the live DB check pass, and the production bundle contains `call.rejoin`.

## Task Commits

1. **Task 1: Reconnecting… and auto-recovery (tracer):** `90350c6` (feat)
2. **Task 2: Call dropped, Poor connection, iOS resume, relay E2E**
   - RED: `bfc413f` (test)
   - GREEN: `2b832fe` (feat)
3. **Task 3: README Calls section, deploy, full verification:** `e6fcdcd` (docs)

**Plan metadata:** the docs(03-04) commit that adds this file.

## Tracer Gate

Task 1 is `type="tracer"`. Mode is end-of-phase with an automated-only `<verify>`, so the gate re-ran that verify before any expansion. Everything passed:
- calls.test: 19/19
- `smoke-calls.sh voice reconnect`: both scenarios ok, plus "smoke-calls ok"
- server suite: 367 passed, 1 skipped
- typecheck: clean
- preset: ok

## TDD Gate Compliance

- **RED** (`bfc413f`): the target `test/call-logic.test.ts > qualityStep (D-20 Poor connection badge) > turns poor on the second consecutive bad sample` failed on `expected false to be true`.
  - Classifier verdict: `RED_EVIDENCE_OK (target_test_failed)`.
  - Semantic assessment: the target executed and failed on its planned assertion, with no load, import or fixture faults.
  - The RED commit included an interface-only `qualityStep` stub (it returned the previous state unchanged) plus the exported thresholds. Without it, the failure would have been a TypeError rather than an assertion.
  - Record: `.planning/phases/03-voice-video-calls/.tdd/03-04-task2-red.json`.
- **GREEN** (`2b832fe`): 19/19 call-logic tests pass.
- **REFACTOR:** none needed.

## Files Created/Modified

- `shared/src/ws.ts`:
  - `call.rejoin`, a strict client frame
  - `call.state`, a lenient server frame
- `shared/src/call.ts`:
  - poor-connection thresholds
  - `QualityState` / `QualitySample`
  - `QUALITY_START`
  - `qualityStep`
- `server/src/calls/registry.ts`:
  - `rejoin()` with the session check
  - stale-connection eviction
  - absence clear and re-arm
  - `call.state`
- `server/src/ws/hub.ts`: forwards `call.rejoin`.
- `server/test/calls.test.ts`: the five rejoin cases, on their own app with 300 ms absence timers.
- `server/test/call-logic.test.ts`: the qualityStep cases.
- `web/lib/chat/realtime.ts`: `onRealtimeLive`, `onRealtimeDown`, `realtimeLive()`.
- `web/lib/rtc/peer.ts`: `restart()`, which rolls back the pending offer and then calls restartIce.
- `web/lib/rtc/stats.ts`: `packetsLost` / `packetsReceived`.
- `web/lib/call/session.ts`:
  - ICE watch and restart timers
  - `peerPresent`
  - `connectionState`
  - `setMic`
- `web/lib/call/store.ts`:
  - reconnecting / poor state
  - give-up timer and Call dropped
  - `call.state` / `room.joined` handling
  - `onRealtimeLive` / `onRealtimeDown` / `onVisible`
  - `callBack`
- `web/components/app/call-screen.tsx`:
  - Reconnecting… status
  - `TerminalActions` (Couldn't connect / Call dropped)
  - `PoorBadge`
  - auto-hide exceptions
  - badge aria-live region
- `web/components/app/on-call-bar.tsx`: Reconnecting….
- `web/components/app/call-provider.tsx`:
  - live/down/visibility wiring
  - `data-reconnecting` / `data-poor`
- `scripts/smoke-calls.mjs`:
  - `routeSockets` / `dropSocket` / `watchStates`
  - the `init` script option
  - scenarios reconnect, dropped, relay
- `README.md`: the "Calls" section. The old TURN / call-test notes are now its subsection.

## Decisions Made

See `key-decisions` in the frontmatter. The two that matter most at runtime:
- The ICE restart retry every 5 s.
- The guard that sends `call.rejoin` only for a call the server knows from this device.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 2 - Correctness] Shared absence timer re-armed on rejoin**
- **Found during:** Task 1
- **Issue:** the registry keeps a single `absentTimer` per call. If party A's rejoin cleared it while party B was still away, B's absence would no longer end the call.
- **Fix:** after a rejoin, if the other party's connection is gone, the 35 s drop timer starts again.
- **Files modified:** server/src/calls/registry.ts
- **Commit:** 90350c6

**2. [Rule 2 - Correctness] ICE restart retried while still disconnected**
- **Found during:** Task 1
- **Issue:** the plan restarts once after 2 s. If that offer is lost while the socket stays live, nothing retries it, and the call would wait for the 30 s give-up.
- **Fix:** the caller restarts again every 5 s while the state stays disconnected or failed. Each restart rolls back first.
- **Files modified:** web/lib/call/session.ts
- **Commit:** 90350c6

**3. [Rule 1 - Bug] Accept lost during the caller's outage**
- **Found during:** Task 1
- **Issue:** if the callee accepted while the caller's socket was down, `call.accepted` went to the dead connection. The rejoin then answers `call.state active` while the caller still shows "Ringing…".
- **Fix:** that `call.state` starts the caller session exactly like `call.accepted`.
- **Files modified:** web/lib/call/store.ts
- **Commit:** 90350c6

**4. [Rule 1 - Bug] Rejoin before the invite**
- **Found during:** Task 1
- **Issue:** a socket reconnect between the Start tap and the invite would rejoin a call the server never saw. The server would answer `call.ended dropped`, which closes the ringing call.
- **Fix:** the client sends a rejoin only once the invite reached the socket, or when it is the callee.
- **Files modified:** web/lib/call/store.ts
- **Commit:** 90350c6

**5. [Rule 2 - Security] Party-only stored reason**
- **Found during:** Task 1
- **Issue:** a rejoin naming a recent call would have told anyone its end reason.
- **Fix:** only the call's two parties get the stored reason; anyone else gets `dropped` (same rule as T-03-09).
- **Files modified:** server/src/calls/registry.ts
- **Commit:** 90350c6

**6. [Rule 3 - Blocking] README heading**
- **Found during:** Task 3
- **Issue:** the existing "## Calls: TURN and the call test" would have made `grep -c '^## Calls' README.md` return 2.
- **Fix:** it became "### TURN and the call test" under the new "## Calls". Its content is unchanged.
- **Files modified:** README.md
- **Commit:** e6fcdcd

**7. [Spec interpretation] Poor connection and auto-hide**
- The badge also stops the controls from auto-hiding, because UI-SPEC section 2 lists "Poor connection" among the statuses that keep them on screen.
- It has its own aria-live region, so it is announced once per appearance and its removal is silent.

**8. [Process] Commits on master**
- This was a sequential dispatch on `master` with normal commits, as in 03-01 to 03-03. No refs were rewritten.

---

**Total deviations:** 8: 2 bugs, 3 correctness/security additions, 1 blocking, 1 spec interpretation, 1 process note.
**Impact on plan:** every planned behaviour, test and scenario is in place. The additions only make recovery more robust and keep end reasons party-only.

## Issues Encountered

- **Hung command during RED:** I mistakenly ran `source` on a GSD reference markdown file (`gsd-run-resolver.md`) while recording the RED evidence. The command hung and was killed (exit 144). The RED record had already been written by then. The working tree showed no unintended changes afterwards. `gsd-tools` was then called directly to classify the evidence.

## Known Stubs

None.

## Threat Flags

None. The new surface (`call.rejoin`, `call.state`, call-diag `data-reconnecting` / `data-poor`) is the one in the threat model. Each mitigation is in place:

| Threat | Mitigation in place |
|--------|---------------------|
| T-03-17 | Rejoin requires the bound session; another session of the same person gets `not_allowed` (tested). |
| T-03-18 | The stale connection leaves `call-<id>` before the new one joins; Bob's next signal reaches only the new socket (tested). |
| T-03-19 | The client gives up at 30 s and sends `call.end`; the server drops after 35 s away (the dropped scenario). |
| T-03-20 | Every E2E, smoke-public and the live DB check ran after the deploy. |
| T-03-21 | Accepted: flags only, no addresses. |
| T-03-SC | No package was installed. |

## User Setup Required

None. The device UAT follows (see Next Phase Readiness).

## Next Phase Readiness

Phase 3 is functionally complete and deployed. Its last gate is the end-of-phase device UAT on the installed iPhone (record the iOS version) and Pixel. That UAT covers the plan's eight steps plus the device items deferred by 03-01 to 03-03:
- 03-01: tone audibility, vibration, audio routing
- 03-02: real push on locked phones, tap landing, missed push replacing the ring
- 03-03: iOS replaceTrack on a track-less transceiver (A2), flip and mirroring, PiP clear of the notch, four controls on a narrow screen, 3-minute wake lock, iOS tip, mute indicator
- 03-04: iOS capture re-acquire on resume (A4)

The flagged CALL-09 assumption (headless relay is a single-host hairpin) closes only with a real cellular-to-Wi-Fi call.

## Self-Check: PASSED

- Created file exists: `.planning/phases/03-voice-video-calls/.tdd/03-04-task2-red.json`.
- Commits 90350c6, bfc413f, 2b832fe and e6fcdcd are ancestors of HEAD; there are 4 commits since plan_head_before 190d328.
- Verification after the deploy:
  - container healthy
  - `smoke-calls.sh`: all 18 scenarios ok, plus "smoke-calls ok"
  - `smoke-chat.sh` (12 scenarios): "smoke-chat ok"
  - onboarding: "smoke-chat ok"
  - `smoke-call.sh`: "smoke-call ok"
  - `smoke-public.sh`: "smoke-public ok"
  - `check-live-db.sh`: "live-db ok"
  - server suite: 375 passed, 1 skipped
  - typecheck: clean
  - preset: ok
  - no `dangerouslySetInnerHTML` in web/components/app or web/lib
- Acceptance greps:

  | Check | Count |
  |-------|-------|
  | rollback in peer.ts | 2 |
  | CALL_GIVE_UP_MS in session/store | ≥1 |
  | call.rejoin in registry.ts | 3 |
  | Reconnecting… in on-call-bar.tsx | 1 |
  | Poor connection in call-screen.tsx | 3 |
  | packetsLost in stats.ts | 5 |
  | readyState in session/store | ≥1 |
  | `^## Calls` in README.md | 1 |

---
*Phase: 03-voice-video-calls*
*Completed: 2026-10-16*
