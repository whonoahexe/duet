---
phase: 03-voice-video-calls
plan: 03
subsystem: calls
tags: [webrtc, replaceTrack, video, wake-lock, pwa, playwright, vitest, base-ui]

requires:
  - phase: 03-voice-video-calls
    provides: "03-01 CallSession with audio+video transceivers negotiated once, callStore, CallScreen, smoke-calls harness with pooled logins; 03-02 checkCall and clearNotifications wiring in the store"
provides:
  - "call.media {callId, camera} client (strict) and server frames; registry relay between the two bound connections only (callerCamera / calleeCamera kept)"
  - "getCallMedia (audio+video with an audio-only fallback when the camera is refused), getCamera, flipCamera (facingMode exact, deviceId cycling on OverconstrainedError)"
  - "CallSession.setCamera(track | null) over replaceTrack (previous track stopped), onRemoteVideo, micTrack / cameraTrack"
  - "store: camera, peerCamera, facing, localVideo, remoteVideo, cameraDenied, muted, swapped, pipCorner, screen; toggleCamera, toggleMute, flip, swap, setPipCorner, minimize, restore"
  - "Mode B call screen (full-screen remote video gated on peerCamera + a decoded frame), draggable/swappable self-view PiP, auto-hiding top bar and pill, Mute / Camera / Switch camera / Hang up, Back to chat"
  - "OnCallBar under the chat header; header Video call button"
  - "holdWakeLock / releaseWakeLock with re-acquire on visibilitychange"
  - "CALL_INVITE_LIMIT server config (unset = INVITE_LIMIT 10)"
  - "launchBrowser({ videoDevices }); smoke-calls scenarios video, controls, camera-denied, minimize"
affects: [03-04 reconnect and device UAT]

actuals:
  tokens: 22500
  tasks: 3
  commits: 3
plan_head_before: 7cc34a48348267fcc979b6ca6576916a4bf6bc5a
plan_head_after: 15c6412dcbafd5d0b0561f56117e2806e523c7dc

tech-stack:
  added: []
  patterns:
    - "Camera on/off and flip are replaceTrack on the video transceiver negotiated at call start, never a renegotiation; the camera state travels in call.media"
    - "Mode B = peer camera flag AND videoWidth > 0 (Pitfall 7); the remote <video> stays mounted (opacity-0) so its first frame is seen before Mode B shows"
    - "Video srcObject attached by ref callbacks, so videos re-attach when the minimized Dialog reopens; call audio stays in CallProvider's <audio>"
    - "Endings while minimized become toasts with the same copy; the call screen never reopens for them"

key-files:
  created:
    - web/lib/call/wake-lock.ts
    - web/components/app/on-call-bar.tsx
  modified:
    - shared/src/ws.ts
    - server/src/calls/registry.ts
    - server/src/ws/hub.ts
    - server/src/config.ts
    - server/src/app.ts
    - server/test/calls.test.ts
    - server/test/call-registry.test.ts
    - web/lib/call/media.ts
    - web/lib/call/session.ts
    - web/lib/call/store.ts
    - web/components/app/call-screen.tsx
    - web/components/app/call-provider.tsx
    - web/components/app/shell.tsx
    - scripts/lib/e2e.mjs
    - scripts/smoke-calls.mjs
    - scripts/smoke-calls.sh

key-decisions:
  - "Camera-off order: replaceTrack(null), stop the track, then send call.media false, so the peer never hears 'off' while the camera is still capturing"
  - "Swap works in either mode: whichever video is large uses the video layout (translucent top bar); in Mode A the swapped PiP shows the peer's initials. The swap resets when this camera turns off or the peer's camera goes from on to off"
  - "Auto-hide only counts keyboard focus (:focus-visible) as 'focus inside', so Base UI's initial focus and tapped buttons never pin the controls on screen"
  - "PiP top corners also clear the 56px top bar (the spec names only the safe area), so the PiP never covers Back to chat"
  - "The camera-denied toast lasts 10 s so its How to allow action is still there once the call connects"
  - "CALL_INVITE_LIMIT is an optional server env (production keeps 10); only smoke-calls.sh raises it to 100"

patterns-established:
  - "call-diag carries data-camera, data-peer-camera, data-mic, data-camera-device, data-swapped as the E2E observation points"
  - "A wake-lock stub counting active sentinels (window.__duetWakeLocks) proves request/release headlessly"

requirements-completed: [CALL-02, CALL-05, CALL-06, CALL-08]

coverage:
  - id: D1
    description: "Video call from the header: both sides see each other full-screen (Mode B); the peer turning the camera off falls back to the avatar within seconds and the camera track is stopped"
    requirement: CALL-02
    verification:
      - kind: e2e
        ref: "bash scripts/smoke-calls.sh video"
        status: pass
      - kind: integration
        ref: "server/test/calls.test.ts#call.media (D-03, T-03-14)"
        status: pass
    human_judgment: false
  - id: D2
    description: "Mute (track.enabled), Camera on in a voice call (peer sees it), Switch camera to another device with video still flowing, swap views, exactly four pill controls and no speaker control"
    requirement: CALL-05
    verification:
      - kind: e2e
        ref: "bash scripts/smoke-calls.sh controls"
        status: pass
      - kind: command
        ref: "D-05 negative grep for SpeakerHigh|setSinkId|selectAudioOutput in web/components/app and web/lib/call"
        status: pass
    human_judgment: false
  - id: D3
    description: "Switch camera between front and back with replaceTrack; deviceId fallback on OverconstrainedError"
    requirement: CALL-06
    verification:
      - kind: e2e
        ref: "bash scripts/smoke-calls.sh controls"
        status: pass
    human_judgment: false
  - id: D4
    description: "Refused camera keeps the call audio-only with Camera unpressed, the 'duet can't use the camera.' toast and 'How to allow' opening 'Allow the camera'"
    requirement: CALL-02
    verification:
      - kind: e2e
        ref: "bash scripts/smoke-calls.sh camera-denied"
        status: pass
    human_judgment: false
  - id: D5
    description: "Minimize to the chat (audio keeps flowing, chat usable), on-call bar 'On call · m:ss' returns to the call, ending while minimized arrives as a toast, one wake lock held per phone during the call and released after"
    requirement: CALL-08
    verification:
      - kind: e2e
        ref: "bash scripts/smoke-calls.sh minimize"
        status: pass
    human_judgment: false
  - id: D6
    description: "On the real iPhone and Pixel: front/back camera flip and mirroring, the track-less video transceiver plus replaceTrack on iOS Safari (assumption A2), PiP drag clear of the notch/home indicator and the pill, four controls fitting a 360-380px viewport, the screen staying awake for a 3-minute call, the iOS keep-open tip, and the mute indicator behaviour"
    requirement: CALL-06
    verification: []
    human_judgment: true
    rationale: "Headless Chrome has fake cameras without facingMode, no touch drag on a notched screen and no real screen to keep awake; these are the plan's backstop truths and flagged assumptions, covered by the 03-04 device UAT"

duration: 7h 46m (wall clock, includes an API session-limit pause mid-plan)
completed: 2026-10-16
status: complete
---

# Phase 3 Plan 03: Video, In-Call Controls, Minimize and Wake Lock Summary

**Video calls on the one call path: camera on/off and front/back flip via replaceTrack on the pre-negotiated video transceiver with a relayed call.media flag, a full-screen remote video with a draggable, swappable self-view and auto-hiding controls, Mute / Camera / Switch camera / Hang up (no speaker control), minimize-to-chat with an accent on-call bar, and a screen wake lock held for the whole call. All of it is proven by a 15-scenario two-browser E2E.**

## Performance

- **Duration:** 7h 46m wall clock, including an API session-limit interruption between Task 2's code and its smoke run
- **Started:** 2026-10-15T23:09:11Z
- **Completed:** 2026-10-16T06:55:25Z
- **Tasks:** 3
- **Files modified:** 18

## Accomplishments

- **Starting video:** the header has a "Video call" button next to "Voice call". A video call captures mic and camera in one prompt, and so does accepting one. If the camera is refused, the call continues audio-only and shows the "How to allow" toast (D-19).
- **Camera state (D-03):** any call can turn its camera on or off. `CallSession.setCamera` uses `replaceTrack` on the video transceiver from call start, with no renegotiation. The replaced track is always stopped (T-03-13). Each side's state reaches the other through `call.media`, which the server relays only between the two bound connections of an active call. Anything else gets `not_allowed`, and malformed frames get `bad_frame`.
- **Mode B (D-02):** shown when the peer's camera flag is on and the remote video has decoded a frame (Pitfall 7). The remote video fills the screen under a translucent top bar (name, then timer).
  - **Self-view:** a 96x128 button, mirrored only for the front camera. A drag of 8px or more snaps it to the nearest corner (FLIP animation, 200ms, instant under reduced motion). A tap swaps the views.
  - **Auto-hide:** the bar and pill fade after 4 s, are inert while hidden, and return on a tap or key press.
- **In-call controls:**
  - **Mute** uses `track.enabled`.
  - **Switch camera** stops the current camera, opens `facingMode {exact}`, and cycles `videoinput` deviceIds on OverconstrainedError. The self-view mirroring follows the new track's settings.
  - **D-05 dropped:** there is no audio-output control anywhere; the negative grep is clean.
- **Minimize (D-06):** Back to chat or Escape minimizes the call and never hangs up. The bar under the header reads "Ringing…", "Connecting…" or "On call · m:ss" and reopens the call in the same mode and swap state. Endings while minimized arrive as toasts.
- **Wake lock (CALL-08, D-21):** held from the Start/Accept tap, requested again when the call goes live, re-acquired on `visibilitychange`, and released on every end path and in `reset()`.
- **iOS tip (D-18):** iOS devices get the one-time "Keep duet open during calls" toast.

## Task Commits

1. **Task 1: End-to-end video call (tracer):** `1c634f5` (feat)
2. **Task 2: Mute, Switch camera, PiP drag/snap/swap, auto-hide, camera denied:** `dee861c` (feat)
3. **Task 3: Minimize + on-call bar, wake lock, iOS tip:** `15c6412` (feat)

**Plan metadata:** the docs(03-03) commit that adds this file.

## Tracer Gate

Task 1 is `type="tracer"` and the mode is end-of-phase with an automated-only `<verify>`. Its full verify was re-run green before expansion: calls.test 14/14, `smoke-calls.sh voice video` ok, server suite 360 passed / 1 skipped, typecheck clean, preset ok.

## Files Created/Modified

- `shared/src/ws.ts`: `call.media` client (strict boolean) and server frames
- `server/src/calls/registry.ts`: `call.media` relay and the callerCamera / calleeCamera flags. The `inviteLimit` option makes the flood guard's limit configurable
- `server/src/ws/hub.ts`: routes `call.media` to the registry
- `server/src/config.ts`, `server/src/app.ts`: optional `CALL_INVITE_LIMIT`
- `server/test/calls.test.ts`: call.media relay, not_allowed (unbound socket, ringing) and bad_frame cases. They run on their own app so the file stays under the flood guard
- `server/test/call-registry.test.ts`: CALL_INVITE_LIMIT config cases
- `web/lib/call/media.ts`: getCallMedia, getCamera, flipCamera
- `web/lib/call/session.ts`: camera on the video transceiver, setCamera, onRemoteVideo, micTrack / cameraTrack
- `web/lib/call/store.ts`:
  - camera / mute / flip / swap / corner / minimize state and actions
  - the call.media send rules (after call.accepted, on every change, on room.peer-joined)
  - endings while minimized become toasts
  - wake lock calls and the iOS tip
- `web/lib/call/wake-lock.ts` (new): hold/release with re-acquire on visibilitychange
- `web/components/app/call-screen.tsx`: Mode B, StreamVideo, the remote-frame detector, SelfViewPip, auto-hide, the control pill, Back to chat, minimize on close
- `web/components/app/on-call-bar.tsx` (new): the accent "Return to call" bar
- `web/components/app/call-provider.tsx`: call-diag gets data-camera, data-peer-camera, data-mic, data-camera-device and data-swapped
- `web/components/app/shell.tsx`: the Video call button and OnCallBar under the header
- `scripts/lib/e2e.mjs`: `launchBrowser({ videoDevices })`
- `scripts/smoke-calls.mjs`, `scripts/smoke-calls.sh`: scenarios video, controls, camera-denied and minimize (wake-lock stub, deny-camera init script), lazy failure messages, and `CALL_INVITE_LIMIT=100`

## Decisions Made

See `key-decisions` in the frontmatter. The two with the most visible effect:
- **Camera-off ordering:** the track is released before the peer is told the camera is off.
- **Swap in Mode A:** swapping works in Mode A too. The plan's controls scenario swaps while the peer's camera is off, so the PiP then shows the peer's initials.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] call.media "off" could reach the peer before the camera track was stopped**
- **Found during:** Task 1 (video scenario: Bob's camera was still `live` when Ada already showed his avatar)
- **Fix:** toggleCamera now awaits `setCamera(null)` (replaceTrack, then stop) and only then sends `call.media false`.
- **Files modified:** web/lib/call/store.ts
- **Commit:** 1c634f5

**2. [Rule 3 - Blocking] The video scenario hung up before the call was marked live**
- **Found during:** Task 1
- **Issue:** the call goes live on the first 2 s getStats sample with inbound bytes. Video frames decode sooner than that, so a hang-up before that sample showed "Couldn't connect" (03-01 behaviour, unchanged).
- **Fix:** the scenario also waits for both pages to reach `live` before toggling the camera.
- **Files modified:** scripts/smoke-calls.mjs
- **Commit:** 1c634f5

**3. [Rule 3 - Blocking] calls.test.ts call.media cases hit the 10-invites-per-minute flood guard**
- **Found during:** Task 1
- **Fix:** the new describe uses its own test app and logins.
- **Files modified:** server/test/calls.test.ts
- **Commit:** 1c634f5

**4. [Rule 3 - Blocking] The 15-scenario smoke run starts more than 10 calls a minute as Ada**
- **Found during:** Task 3 (full run: `stale` failed after the flood guard refused Ada's 11th invite)
- **Fix:** added an optional `CALL_INVITE_LIMIT` server env, default unchanged at 10 (T-03-03 intact in production), with config tests. `smoke-calls.sh` sets it to 100.
- **Files modified:** server/src/config.ts, server/src/app.ts, server/src/calls/registry.ts, server/test/call-registry.test.ts, scripts/smoke-calls.sh. The plan's files list did not include these.
- **Commit:** 15c6412

**5. [Rule 3 - Blocking] The minimize scenario raced the Dialog's close animation**
- **Found during:** Task 3
- **Fix:** after the second minimize, the scenario waits for the dialog to be hidden before Bob hangs up. It was a fading dialog, not a reopen.
- **Files modified:** scripts/smoke-calls.mjs
- **Commit:** 15c6412

**6. [Spec interpretation] PiP placement, swap in Mode A, and the camera-denied toast duration**
- **Top-bar clearance:** the PiP's top corners also clear the 56px top bar.
- **Swap in Mode A:** swap is allowed in Mode A (initials in the PiP), because the plan's controls scenario swaps while the peer's camera is off.
- **Toast duration:** the camera-denied toast lasts 10 s.
- All three are recorded in key-decisions.

**7. [Process] Commits on master**
- This was a sequential dispatch on `master` with normal commits, as in 03-01 and 03-02. No refs were rewritten.

---

**Total deviations:** 7 (1 bug, 4 blocking, 1 spec interpretation, 1 process note)
**Impact on plan:** every planned behaviour, test and scenario is in place. The only production-visible additions are an optional env var that defaults to the current limit, and a toast that stays longer than the default.

## Issues Encountered

An API session limit stopped execution after Task 2's code was written but before its smoke run. On resume, the dirty tree was checked against the Task 1 commit, and Task 2 was finished and committed with its full verify.

## Known Stubs

None.

## Threat Flags

None. The new surface is the one in the threat model, and each mitigation is in place:
- **T-03-13 (camera left capturing):** the replaced track is stopped on camera off and on flip, and every end path releases it. The video and controls scenarios assert it.
- **T-03-14 (spoofed call.media):** bound-connection-only relay with a strict boolean schema (tested).
- **T-03-15 (camera deviceId in call-diag):** accepted. It is the per-origin deviceId, only in the user's own DOM.
- **T-03-16 (wake lock held after a call):** released on every end path and in reset(); the minimize scenario asserts 0 active sentinels.
- **T-03-SC (package installs):** no package was installed.

The new `CALL_INVITE_LIMIT` env only weakens T-03-03 if an operator sets it. Production leaves it unset.

## User Setup Required

None.

## Next Phase Readiness

- 03-04 should:
  - add reconnect (`call.rejoin`), which resends call.media on the rejoin path.
  - check on the real phones:
    - iOS replaceTrack on a track-less transceiver (A2)
    - facingMode flip and mirroring
    - PiP drag clear of the notch, home indicator and pill
    - the four controls fitting on a narrow viewport
    - a 3-minute call keeping the screen on (iOS 18.4+)
    - the iOS tip
    - the mute indicator (A for CALL-05)
- The flagged assumptions from the plan stay open for the device UAT: CALL-02 A2, CALL-05 mute indicator, CALL-08 OS wake-lock release.

## Self-Check: PASSED

- Created files exist: web/lib/call/wake-lock.ts, web/components/app/on-call-bar.tsx.
- Commits 1c634f5, dee861c and 15c6412 are ancestors of HEAD. There are 3 commits since plan_head_before 7cc34a4.
- Plan verification re-run after the last code commit:
  - server suite: 362 passed, 1 skipped
  - `npm run typecheck`: clean
  - `check-preset.sh`: "preset ok"
  - `smoke-calls.sh`: all 15 scenarios ok and "smoke-calls ok"
  - `smoke-chat.sh send typing-read`: "smoke-chat ok"
  - D-05 negative grep: clean
- Acceptance greps:

  | Check | Count |
  |-------|-------|
  | replaceTrack in session.ts | 5 |
  | `aria-label="Video call"` in shell.tsx | 1 |
  | call.media in registry.ts | 4 |
  | Switch camera / Swap videos in call-screen.tsx | 1 / 1 |
  | OverconstrainedError in media.ts | 2 |
  | prefers-reduced-motion / motion-reduce in call-screen.tsx | 2 |
  | Return to call in on-call-bar.tsx | 1 |
  | OnCallBar in shell.tsx | 2 |
  | visibilitychange in wake-lock.ts | 2 |
  | "Keep duet open during calls" in store.ts | 1 |
  | holdWakeLock( in store.ts | 3 |

---
*Phase: 03-voice-video-calls*
*Completed: 2026-10-16*
