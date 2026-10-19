---
phase: 03-voice-video-calls
verified: 2026-10-19T07:20:04Z
status: human_needed
score: 76/77 must-haves verified
covered_files: [".planning/phases/03-voice-video-calls/03-01-PLAN.md", ".planning/phases/03-voice-video-calls/03-01-SUMMARY.md", ".planning/phases/03-voice-video-calls/03-02-PLAN.md", ".planning/phases/03-voice-video-calls/03-02-SUMMARY.md", ".planning/phases/03-voice-video-calls/03-03-PLAN.md", ".planning/phases/03-voice-video-calls/03-03-SUMMARY.md", ".planning/phases/03-voice-video-calls/03-04-PLAN.md", ".planning/phases/03-voice-video-calls/03-04-SUMMARY.md", "README.md", "scripts/lib/e2e.mjs", "scripts/smoke-calls.mjs", "scripts/smoke-calls.sh", "server/src/app.ts", "server/src/calls/registry.ts", "server/src/calls/routes.ts", "server/src/config.ts", "server/src/push/routes.ts", "server/src/push/sender.ts", "server/src/ws/hub.ts", "server/test/call-logic.test.ts", "server/test/call-push.test.ts", "server/test/call-registry.test.ts", "server/test/calls.test.ts", "server/test/helpers.ts", "server/test/sw.test.ts", "shared/src/call.ts", "shared/src/index.ts", "shared/src/push.ts", "shared/src/ws.ts", "web/components/app/call-provider.tsx", "web/components/app/call-screen.tsx", "web/components/app/incoming-call.tsx", "web/components/app/on-call-bar.tsx", "web/components/app/permission-drawer.tsx", "web/components/app/shell.tsx", "web/lib/call/media.ts", "web/lib/call/session.ts", "web/lib/call/store.ts", "web/lib/call/tones.ts", "web/lib/call/wake-lock.ts", "web/lib/chat/events.ts", "web/lib/chat/push.ts", "web/lib/chat/realtime.ts", "web/lib/rtc/peer.ts", "web/lib/rtc/stats.ts", "web/public/sw.js"]
covered_digest: "v3:sha256:06a5b1310688bb433ceb859598b558c5a1cceb745ce71df29590718ed8b26925"
behavior_unverified: 0
overrides_applied: 0
human_verification:
  - test: "WR-01: Ada calls Bob; Bob taps Accept on two of his devices at almost the same moment"
    expected: "The losing device leaves 'Connecting…', toasts 'Answered on another device' and releases its microphone; the winner goes live"
    why_human: "The two-Accept race is a client state-machine path (call.stop-ringing in 'connecting') with no unit harness; the multi-device smoke accepts on one device only"
  - test: "WR-05: Bob rings Ada while Ada's own Start tap is still setting up (before its invite is sent); repeat with Ada's ICE fetch failing"
    expected: "The attempts merge into one live call; when Ada's attempt fails before its invite, Bob's held-back ring is shown on Ada's device"
    why_human: "The deferredRing replay is client-only and the glare smoke does not force the pre-invite window"
  - test: "WR-08: Bob's ICE-server fetch fails after he taps Accept"
    expected: "Ada sees 'Couldn't connect' with Retry, never 'Declined'"
    why_human: "The server side is tested; which client failure paths send decline reason 'failed' has no test"
  - test: "WR-03: either side hangs up while the call still shows 'Connecting…'"
    expected: "Both show 'Call ended · 0:00', not 'Couldn't connect'"
    why_human: "The handleEnded hangup branch before media has no test; no smoke scenario hangs up during Connecting…"
  - test: "WR-04: Ada cancels while Bob's app is open on the incoming screen; separately, let a ring time out with Bob's app open"
    expected: "Cancel: Bob's incoming screen closes with no toast. Timeout: Bob gets 'Missed call from Ada' with Call back"
    why_human: "The cancel smoke proves the no-toast half; the timeout toast on the callee is not asserted by any test"
  - test: "WR-06: log out on one phone during a live call"
    expected: "The other phone shows 'Call ended' at once (not Reconnecting… then Call dropped), and the logging-out iPhone's microphone indicator turns off"
    why_human: "The logout path of the CALL-01 mic prohibition has no test; WR-06 rewrote it"
  - test: "CR-01: lock the caller's iPhone while the call rings, then accept on the other phone"
    expected: "The call connects (or resumes via Reconnecting… when the caller returns) and never ends as 'cancelled' with a 'Missed call' on the callee"
    why_human: "Registry regression tests cover the timer swap; a real iOS socket loss while ringing is only observable on the device"
  - test: "Backstop: let a call run past one hour (or set mediaStartedAt back in devtools)"
    expected: "'1:02:09'-style timer stays on one line with no layout shift"
    why_human: "formatCallDuration is unit-tested; the h:mm:ss rendering was never observed (the UAT used a 3-minute call)"
---

# Phase 3: Voice & Video Calls Verification Report

**Phase Goal:** We can call each other by voice or video, peer-to-peer with Cloudflare TURN relay, on Wi-Fi or cellular, with push-to-answer ringing
**Verified:** 2026-10-19T07:20:04Z (updated after the redeploy; first pass 2026-10-19T03:18:50Z returned gaps_found)
**Status:** human_needed
**Re-verification:** Update of the same verification. The deploy gap is closed; no code changed (covered_digest unchanged).

## Verdict in one paragraph

The phase goal is achieved in the code and in production. All four roadmap success criteria are implemented, wired and supported by evidence:
- **Server tests** I ran: 387 passed, 1 skipped.
- **Typecheck:** clean.
- **Device UAT:** approved on the iPhone and Pixel, including a cellular call through the relay.
- **Call E2E on HEAD:** all 18 smoke-calls scenarios pass in the coordinator's post-redeploy run.

The deploy gap from the first pass is closed. HEAD (`e670605`, all review fixes) now runs in production, and I confirmed this independently. What remains is the short phone spot check of the post-review race fixes and the one-hour timer backstop. Those paths were never exercised on devices, and no automated test covers them.

## Gap closure evidence (re-check after redeploy)

| Check | Who ran it | Result |
|---|---|---|
| Container health and image age | verifier (`docker inspect`) | `healthy`. The image was created 2026-10-19T12:46:46+05:30, after the HEAD commit `e670605` (2026-10-19 08:38 +0530) |
| Production has the WR-07 service worker | verifier (`curl https://duet.brkn.me/sw.js \| grep -c 'n.tag === "duet-call"'`) | 1 (was 0) |
| Public smoke | verifier (`BASE=https://duet.brkn.me bash scripts/smoke-public.sh`) | `smoke-public ok` |
| Live DB check | coordinator (`bash scripts/check-live-db.sh --existing ./data`) | `live-db ok` (reported) |
| Two-browser call E2E on HEAD | coordinator (`bash scripts/smoke-calls.sh`) | 18/18 scenarios ok (reported) |
| Working tree equals the verified code | verifier (`git status`) | No source changes. Only `.planning/config.json` is modified. covered_digest is unchanged |

## Goal Achievement

### Roadmap Success Criteria (the contract)

| # | Success criterion | Status | Evidence |
|---|---|---|---|
| SC1 | Either person can start a voice or video call from the chat, and both hear and see each other, including one phone on cellular through TURN | ✓ VERIFIED | `shell.tsx:75-90` buttons call `callStore.startCall`. `session.ts:76-95` sets fixed roles and pre-negotiated transceivers. `peer.ts:49` forces relay. Server tests in calls.test. E2E: voice, video, relay. Device UAT steps 1 and 3 (Wi-Fi to cellular) |
| SC2 | With the recipient's app closed an incoming-call push arrives; tapping it or opening the app shows Accept and Decline; an unanswered call stops after a timeout; the caller can cancel | ✓ VERIFIED | `registry.ts:279-282,454-459`. `sender.ts:33,194,272`. `sw.js:29-42,61-79`. `call-provider.tsx:51-61`. Tests: call-push, sw, ring timeout. E2E: ring-on-open, stale, no-answer, cancel. UAT step 2 |
| SC3 | Mute/unmute, camera on/off, switch front/back camera, hang up; the screen does not lock | ✓ VERIFIED | `store.ts:830-996`, `media.ts:117-147`, `wake-lock.ts`. The D-05 negative grep finds 0 matches. E2E: controls, video, minimize (wake-lock stub). UAT steps 3 and 5 |
| SC4 | A brief network drop shows "Reconnecting…" and the call resumes without redialing | ✓ VERIFIED | `realtime.ts:143,192`, `store.ts:774-822`, `registry.ts:376-417`, `peer.ts:132-143`. calls.test has 5 rejoin cases. E2E: reconnect, dropped. UAT step 4 |

### Plan must-have truths

Status key:
- ✓ VERIFIED
- ⚠️ insufficient_spec (backstop)

Evidence key:
- **T**: a server test I ran, and it passed
- **C**: I read the code at HEAD
- **U**: the device UAT approved 2026-10-19, which ran on the pre-fix build
- **E**: a smoke-calls scenario. The coordinator ran all 18 green on HEAD after the redeploy

**03-01 (CALL-01, CALL-04): 27 truths**

| # | Truth (short) | Status | Evidence |
|---|---|---|---|
| 1 | D-01 header phone button: the microphone is requested inside the tap, then Mode A shows "Ringing…" | ✓ | C `shell.tsx:75-81`, `store.ts:675-713`; E voice; U1 |
| 2 | Accept connects P2P with TURN credentials over the one /ws; the timer starts at the first inbound media | ✓ | C `store.ts:452-456`; T calls.test; E voice; U1 |
| 3 | D-03 fixed roles: 1 audio + 1 video transceiver, and the callee's microphone goes in with replaceTrack | ✓ | C `session.ts:76-95`, `peer.ts:56,114-118`; E controls (camera on in a voice call); U3 |
| 4 | D-04 Mode A layout; Hang up / Cancel call labels | ✓ | C `call-screen.tsx:36-38,517`; U |
| 5 | Server-owned single call, not_allowed, room_reserved | ✓ | C `registry.ts`, `hub.ts:191-193`; T calls.test |
| 6 | D-07 server ring timeout of 45 s; the caller sees "No answer" | ✓ | T call-registry; E no-answer; U2 |
| 7 | D-16 rings the full time when the callee has no device | ✓ | T call-registry |
| 8 | CALL-04: cancel closes every callee screen, with no toast | ✓ | C `store.ts:579-593` (after WR-04); E cancel asserts that Bob has 0 toasts (`smoke-calls.mjs:432`) on HEAD; U2 |
| 9 | D-13: Declined shows for 2 s | ✓ | C `store.ts:574-577`; E decline; U |
| 10 | D-15: "Call ended · m:ss" for 1.5 s; nothing is stored | ✓ | C `store.ts:563-568,994`; E voice; U1 |
| 11 | D-08: tones and vibration stop on every exit | ✓ | C `store.ts:171-192`, `tones.ts`; E no-answer (data-tone); U8 |
| 12 | D-11: every device rings and the first one wins; "Answered on another device" | ✓ | T server multi-device; E multi-device on HEAD (after WR-01); the two-Accept race is a human spot check |
| 13 | D-14: glare merges into one call | ✓ | T server glare; E glare on HEAD (after WR-05); the pre-invite window is a human spot check |
| 14 | Busy: no second ring, toast shows | ✓ | T busy + WR-09 second tab; E busy |
| 15 | Invite flood guard | ✓ | T call-registry |
| 16 | Pitfall 3: absence grace | ✓ | T call-registry (including CR-01) |
| 17 | No peer account means no call icon | ✓ | C `shell.tsx:224` |
| 18 | Outgoing: "Ringing…" plus ringback | ✓ | C `store.ts:172,713`; E no-answer; U |
| 19 | "Connecting…", then the timer from 0:00 | ✓ | C `call-screen.tsx:131-139`; E voice; U |
| 20 | Accept spinner, disabled | ✓ | C `incoming-call.tsx:50-53` |
| 21 | "Couldn't connect" on setup/ICE failure or no media in 20 s | ✓ | C `call-screen.tsx:155-170`, `store.ts:220-240,485-491,612-654`; E couldnt-connect on HEAD (after WR-03/WR-08); the callee-side failure and hang-up while connecting are human spot checks |
| 22 | Mic denied → drawer | ✓ | C `store.ts:619-627,706-709`; E mic-denied; U7 |
| 23 | Offline toast | ✓ | C `store.ts:213,679-682,729-733` |
| 24 | Header icons disabled during a call | ✓ | C `shell.tsx:79,88` |
| 25 | Peer name truncates | ✓ | C `call-screen.tsx:36,433` |
| 26 | /debug/call still works | ✓ | C `hub.ts:191`; T calls.test (`smoke-n-1`) |
| 27 | Backstop: "1:02:09" renders without wrapping | ⚠️ insufficient_spec | T call-logic covers the formatter. The rendering was never observed. This is a human item |

**03-02 (CALL-03, CALL-04): 10 truths.** All ✓ VERIFIED.

| # | Truth | Evidence |
|---|---|---|
| 1 | Incoming-call push: copy and TTL | T call-push, sw.test; U2 |
| 2 | Per-session push skip | T call-push |
| 3 | Ring-on-attach | T call-push; E ring-on-open |
| 4 | D-12 missed-call push | T call-push |
| 5 | D-09 tap routing and replaceState | T sw.test; C `call-provider.tsx:51-61` |
| 6 | D-10 Missed toast | C `store.ts:741-751`; E stale |
| 7 | GET /api/calls/:id | T call-push |
| 8 | Tray cleared | C `store.ts:194-200` |
| 9 | Production runs voice calls with push | smoke-public ok; prod sw.js has `duet-call` |
| 10 | Stale push → Missed toast | E stale; U2 |

**03-03 (CALL-02, CALL-05, CALL-06, CALL-08): 23 truths.** All ✓ VERIFIED.

| Truths | Evidence |
|---|---|
| Video call button and Mode B | E video; U3 |
| replaceTrack + call.media | T calls.test |
| PiP drag, snap and swap; auto-hide | C `call-screen.tsx`; E controls; U3 |
| Mute, Camera, Switch camera | E controls; U3 |
| Flip fallback and mirroring | C `media.ts:103-147` |
| D-05 dropped | Negative grep finds 0 |
| Minimize and on-call bar | E minimize; U6 |
| Wake lock | E minimize stub counts; U5 |
| iOS tip | U5 |
| Camera denied | E camera-denied; U7 |
| Minimized terminal toasts | C; E minimize |
| Narrow-viewport and PiP safe-area backstops | Approved in the UAT as deferred 03-03 D6 items |

**03-04 (CALL-07, CALL-09): 13 truths.** All ✓ VERIFIED.

| Truths | Evidence |
|---|---|
| Reconnecting… and auto-recovery | E reconnect; U4 |
| Rejoin with eviction | T calls.test, 5 cases |
| Rollback + ICE restart | C `peer.ts`, `session.ts` |
| Shared 30 s give-up and Call dropped | E dropped; U4 |
| Poor badge | T qualityStep |
| iOS resume | U5 |
| Camera flag resend | C `store.ts:1051,1070,1084` |
| CALL-09 relay | E relay; U1 cellular |
| **Production runs the complete Phase 3** (was ✗ in the first pass) | Now ✓: the image is newer than HEAD and healthy, prod sw.js carries the WR-07 fix, smoke-public ok, live-db ok, smoke-calls 18/18 on HEAD; README `## Calls` |
| iOS background backstop | U5 |

**Score:** 76/77 truths verified. 0 truths are present but behavior-unverified, and 1 backstop has insufficient evidence (the one-hour timer render).

### Prohibitions (test-tier)

| Prohibition | Enforcement | Disposition |
|---|---|---|
| CALL-01: MUST NOT leave the microphone capturing after any end path | `expectTracksEnded` runs in 16 scenarios, green on HEAD | Enforced for end / decline / cancel / no-answer / failure / drop. **Flagged (unverified-prohibition, human review recommended): logout**, rewritten by WR-06, has no test. This is human item WR-06 |
| CALL-03: MUST NOT capture before Accept | ring-on-open asserts `__duetTracks` is empty until Accept, green on HEAD | Enforced |
| CALL-05: MUST NOT leave the camera capturing | video and controls assert the camera tracks ended, green on HEAD | Enforced |

### Required Artifacts / Key Links

`gsd-tools verify.artifacts` passes for every plan:

| Plan | Artifacts | Key links |
|---|---|---|
| 03-01 | 9/9 | 5/5 |
| 03-02 | 5/5 | 4/4 |
| 03-03 | 4/4 | 4/4 |
| 03-04 | 5/5 | 4/4 |

Every artifact is substantive and wired. Each data flow traces from a real source: `ontrack` for remote audio and video, getStats for the timer and the Poor badge, the registry for GET /api/calls, and the users table for the caller name in the push.

### Behavioral Spot-Checks

| Behavior | Command | Result | Status |
|---|---|---|---|
| Server suite | `npm --prefix server run test` (once) | 24 files, 387 passed / 1 skipped | ✓ PASS |
| Typecheck web + server | `npm run typecheck` | exit 0 | ✓ PASS |
| No speaker/audio-output code; no raw HTML | grep | 0 / 0 | ✓ PASS |
| Public prod smoke | `smoke-public.sh` | `smoke-public ok` | ✓ PASS |
| Production carries the review fixes | `curl …/sw.js \| grep -c 'n.tag === "duet-call"'`; `docker image inspect` | 1; image built after HEAD | ✓ PASS |
| Two-browser call E2E on HEAD | `bash scripts/smoke-calls.sh` | 18/18 (coordinator run after the redeploy) | ✓ PASS (reported) |
| Live DB | `check-live-db.sh --existing ./data` | `live-db ok` (coordinator) | ✓ PASS (reported) |
| Documented commits | `verify.commits` (26 hashes) | all valid | ✓ PASS |

### Probe Execution

No probes exist or are declared, so this step does not apply.

### Requirements Coverage

CALL-01 through CALL-09 are all ✓ SATISFIED (the evidence is in the truth tables above). Every ID in the plans' frontmatter maps to REQUIREMENTS.md, and no ID is orphaned. CALL-10 is v2: only its missed-call push ships here, as planned.

### Anti-Patterns Found

| Finding | Location | Severity | Notes |
|---|---|---|---|
| No TBD/FIXME/XXX/TODO/placeholder | 31 phase files | none | — |
| IN-01: the callee also restarts ICE on failed | `peer.ts:94-96` | ℹ️ Info (open) | — |
| IN-02: push TTL fixed at 45 s while the ring timeout can be raised to 120 s | `sender.ts:33` | ℹ️ Info (open) | Matches in production |
| IN-03: serverJoin failure is invisible | `hub.ts:355-358` | ℹ️ Info (open) | — |
| IN-04: the caller closes silently when the server ends a ring | `store.ts` | ℹ️ Info (open) | — |
| IN-05: stale "Incoming call" stays on the other phone | `registry.ts:199-202` | ℹ️ Info (open) | — |
| ~~Deployed build predates the review fixes~~ | — | Resolved | Redeployed 2026-10-19 12:46 +0530 |

### Human Verification Required

These checks need a phone pair and take about 10 minutes. They exercise the post-review race fixes that no automated test covers, plus one backstop.

1. **WR-01 two Accepts:** Bob accepts on two devices at once. The loser closes, toasts "Answered on another device", and its microphone turns off.
2. **WR-05 held-back ring:** Bob rings while Ada's own Start tap is still setting up. The calls merge. If Ada's attempt fails before its invite goes out, Bob's ring appears on Ada's phone.
3. **WR-08 callee setup failure:** Bob's ICE fetch fails after Accept. Ada sees "Couldn't connect" with Retry, not "Declined".
4. **WR-03 hang-up while connecting:** Both phones show "Call ended · 0:00", not "Couldn't connect".
5. **WR-04 cancel vs timeout:** Cancel while Bob's app is open: no toast. Timeout while it is open: "Missed call from Ada" with Call back.
6. **WR-06 logout mid-call:** The peer sees "Call ended" at once, and the iPhone microphone indicator turns off. This closes the logout half of the CALL-01 prohibition.
7. **CR-01 caller iPhone locked while ringing, then accepted:** The call connects or resumes. It never ends as "cancelled", and the callee gets no "Missed call".
8. **Backstop, timer past one hour:** "1:02:09" stays on one line with no layout shift.

### Gaps Summary

There are no gaps left. The single gap from the first pass was production running a build from before the code review, and it is closed:
- The redeploy built an image newer than HEAD.
- The container is healthy.
- The production service worker carries the WR-07 fix.
- smoke-public and live-db pass.
- smoke-calls passes 18/18 on HEAD.

The status is `human_needed`, not `passed`. Items 1–7 exercise race paths changed after the approved device UAT. No smoke scenario covers them and the client store has no unit harness. Item 8 is a backstop that was never observed.

---

_Verified: 2026-10-19T07:20:04Z (re-check after the redeploy; first pass 2026-10-19T03:18:50Z)_
_Verifier: Claude (gsd-verifier)_
