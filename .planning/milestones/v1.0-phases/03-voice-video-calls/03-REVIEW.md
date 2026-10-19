---
phase: 03-voice-video-calls
reviewed: 2026-10-18T20:53:30Z
depth: standard
files_reviewed: 28
files_reviewed_list:
  - server/src/app.ts
  - server/src/calls/registry.ts
  - server/src/calls/routes.ts
  - server/src/config.ts
  - server/src/push/routes.ts
  - server/src/push/sender.ts
  - server/src/ws/hub.ts
  - shared/src/call.ts
  - shared/src/index.ts
  - shared/src/push.ts
  - shared/src/ws.ts
  - web/components/app/call-provider.tsx
  - web/components/app/call-screen.tsx
  - web/components/app/incoming-call.tsx
  - web/components/app/on-call-bar.tsx
  - web/components/app/permission-drawer.tsx
  - web/components/app/shell.tsx
  - web/lib/call/media.ts
  - web/lib/call/session.ts
  - web/lib/call/store.ts
  - web/lib/call/tones.ts
  - web/lib/call/wake-lock.ts
  - web/lib/chat/events.ts
  - web/lib/chat/push.ts
  - web/lib/chat/realtime.ts
  - web/lib/rtc/peer.ts
  - web/lib/rtc/stats.ts
  - web/public/sw.js
findings:
  critical: 1
  warning: 9
  info: 5
  total: 15
status: issues_found
---

# Phase 3: Code Review Report

**Reviewed:** 2026-10-18T20:53:30Z
**Depth:** standard
**Files Reviewed:** 28
**Status:** issues_found

## Summary

I reviewed the Phase 3 call stack (diff `89896a9..HEAD`). On the server that is the call registry, the hub's call hooks, call pushes and `GET /api/calls/:id`. On the client it is the call store, session, peer, tones, wake lock, the realtime hooks, the call UI and the service worker.

The security boundaries hold:
- Call rooms are server-managed (`room_reserved`).
- `rtc.signal` and `call.media` only reach bound connections.
- A rejoin requires the same session.
- The SW only builds its own two URLs.
- Push logs carry no endpoints.

The defects are in the state machines, in the races the code says it handles:
- **One blocker:** the server's caller-absence timer keeps running after the callee answers. An answered call can end as `cancelled` within 10 s, and the callee then sees "Missed call".
- **Client warnings:** several transitions drop server frames the server sends on purpose (`call.stop-ringing` after a concurrent accept, a re-ring after a lost accept, a ring that arrives while this device is still setting up its own call). Each one leaves a stuck "Connecting…" screen, a ring nobody sees, or the wrong terminal text.
- **Other warnings:** logout never ends the call, and the service worker's "close everything" drops call notifications whenever a chat push arrives.

## Narrative Findings (AI reviewer)

## Critical Issues

### CR-01: Accepting while the caller's socket is away leaves the "cancelled" timer armed, so an answered call ends as cancelled and the callee gets "Missed call"

**File:** `server/src/calls/registry.ts:280-294` (with `onClose` at `428-438`)

**Issue:** While a call rings, `onClose` of the caller's connection arms `call.absentTimer = timer(() => end(call, "cancelled"), callerAbsentMs)` (10 s). `bind()` clears only `ringTimer`; it never touches `absentTimer`. Take a caller whose socket blinks during the ring (a network switch on cellular, exactly the CALL-07 case) while the callee taps Accept within those 10 s:

1. The call becomes `active`. `serverJoin(call.callerConn)` is a no-op because that conn is gone. The callee joins the room and enters "Connecting…".
2. Because `onClose` returns early when `absentTimer !== undefined`, no 35 s `ABSENT_GRACE_MS` timer ever replaces the 10 s one.
3. If the caller has not sent `call.rejoin` by the 10 s mark, `end(call, "cancelled")` runs on an **active** call. The caller gets 10 s from the drop instead of the 35 s an active call should get, and the end reason is wrong.
4. On the callee, `handleEnded` treats `cancelled` + role callee + phase `connecting` as `tapped` (`web/lib/call/store.ts:550-557`). The person who answered sees "Missed call from X". The `call_end` log records `reason: "cancelled"` with a non-zero duration.

No test covers accept-during-caller-absence.

**Fix:** When the call becomes active, swap the ringing-phase absence timer for the active-call grace:
```ts
function bind(connId: string, call: Call, replaces?: string): void {
  call.status = "active"
  if (call.ringTimer !== undefined) clearTimeout(call.ringTimer)
  call.ringTimer = undefined
  const callerWasAway = call.absentTimer !== undefined
  if (call.absentTimer !== undefined) clearTimeout(call.absentTimer)
  call.absentTimer = undefined
  // ...existing binding...
  if (callerWasAway || transport.sessionOf(call.callerConn) === undefined) {
    call.absentTimer = timer(() => end(call, "dropped"), absentGraceMs)
  }
}
```
Add a registry test for this: caller closes while ringing, callee accepts, `callerAbsentMs` elapses, and the call must still be active.

## Warnings

### WR-01: A device whose `call.accept` crossed another device's accept ignores `call.stop-ringing` and stays on "Connecting…" with the mic on for 20 s

**File:** `web/lib/call/store.ts:1026-1031` (with `answer()` at `613-614`)

**Issue:** The server sends `call.stop-ringing` to a callee device that accepts after another device already won (`registry.ts:265-270`, D-11). `answer()` moves the losing device to `phase: "connecting"` synchronously after `sendFrame({t:"call.accept"})`. So when that `stop-ringing` arrives, the handler's guard `state.phase !== "ringing-in"` returns and the frame is ignored. The broadcast `stop-ringing` from `bind()` is ignored the same way if it lands after the local accept. The losing device keeps a callee `CallSession`, the captured mic and the wake lock until `CONNECT_TIMEOUT_MS` (20 s) fires. It then sends `call.end`, which the server rejects with `not_allowed`, and shows "Couldn't connect" for a call that is actually running on the other device.

**Fix:** Accept `stop-ringing` in any pre-media callee phase:
```ts
case "call.stop-ringing":
  if (frame.callId !== state.callId || state.role !== "callee") return
  if (state.phase !== "ringing-in" && !(state.phase === "connecting" && state.mediaStartedAt === null)) return
  closeNow()
  toast("Answered on another device")
  return
```

### WR-02: A `call.accept` lost to a down socket is never retried; the callee is stuck on "Connecting…" while the caller keeps ringing

**File:** `web/lib/call/store.ts:613-614`, `962-963`, `732-735`; `server/src/calls/registry.ts:352-358`

**Issue:** `answer()` ignores the boolean returned by `sendFrame({ t: "call.accept" })` and moves to "connecting" anyway. If the socket was reconnecting at the tap, the server never sees the accept:
- On the next hello, `onRealtimeLive` sends `call.rejoin`. Because the server call is still `ringing`, `asCallee` is false and the answer is `not_allowed`, which the client ignores.
- Ring-on-attach re-sends `call.ring` for the same call, but the handler drops it because the phase is not `ringing-in` or idle.

The callee shows "Connecting…" for 20 s, then "Couldn't connect" (its `call.end` is also `not_allowed`). The caller hears ringback until the 45 s "No answer".

**Fix:** Check the send result. If it fails, either stay in `ringing-in` with `accepting` and resend the accept on the next `onRealtimeLive`, or treat a `call.ring` for the current call while `role === "callee" && phase === "connecting" && !invitedCallId` as "the server never got my accept" and resend `call.accept`:
```ts
if (!sendFrame({ t: "call.accept", callId })) { pendingAccept = callId }  // resend from onRealtimeLive()
```

### WR-03: The other side hanging up during "Connecting…" shows "Couldn't connect / Check your connection" instead of "Call ended"

**File:** `web/lib/call/store.ts:536-542`

**Issue:** For `hangup`, a `connecting` call with no media yet falls through to `showFailure()`:
```ts
else if (state.phase === "ringing-out" && frame.reason !== "failed") closeNow()
else showFailure()
```
When the caller (or callee) deliberately hangs up before media flows, the peer gets the network-failure terminal state with a Retry button and "Check your connection and try again." This is a wrong user-facing state for an intentional action, and it happens often (whenever someone hangs up within the first seconds).

**Fix:** Only `failed` should map to the failure screen:
```ts
case "hangup":
  if (state.phase === "ringing-in") closeNow()
  else showEnded(callEndedText(), ENDED_SHOW_MS)  // "Call ended · 0:00" when no media
  return
case "failed":
  if (state.phase === "ringing-in") closeNow()
  else if (!noMedia) showEnded(callEndedText(), ENDED_SHOW_MS)
  else showFailure()
  return
```

### WR-04: A call missed while duet is in the foreground leaves no trace: the push is suppressed and the in-app ring closes silently

**File:** `server/src/app.ts:131-135`; `web/lib/call/store.ts:547-558`

**Issue:** `notifyMissed` skips every session for which `hub.isSessionViewing(sid)` is true. On the client, `no-answer`/`cancelled` for a callee only toasts when `tapped` (Accept was in flight); otherwise it runs `closeNow()` with no message. If the callee's phone sat with duet open (screen on, `presence visible`) and nobody answered within 45 s, nothing records the miss: no "Missed call" push, no toast. D-12 requires a missed-call indication.

**Fix:** Show the missed-call toast for every callee-side `no-answer`/`cancelled` (the push suppression assumes the in-app surface covers it):
```ts
const kind = state.kind
const callee = state.role === "callee"
closeNow()
if (callee) missedCallToast(kind, frame.callId)
```

### WR-05: The other person's ring is dropped while this device is setting up its own call, and is never shown if that attempt then fails

**File:** `web/lib/call/store.ts:673-691`, `959-963`

**Issue:** `startCall` commits `ringing-out` before `fetchIceServers()` and before the invite is sent. A `call.ring` that arrives in that window is discarded (`state.phase !== "idle" && state.phase !== "ended"`). The D-14 merge only happens if this device's invite later reaches the server. If the ICE fetch fails (`showFailure`), the user cancels (`hangUp` → `closeNow`), or the invite send fails (`closeNow` + offline toast), the other person's call keeps ringing for 45 s while this device shows nothing. The push is skipped too because this session is "viewing", and the eventual `call.ended` is ignored (callId mismatch). The caller gets "No answer" from someone who was holding the app.

**Fix:** Remember a ring that was ignored during local setup, and surface it once the local attempt ends without merging:
```ts
let deferredRing: Extract<ServerFrame, { t: "call.ring" }> | null = null
// in call.ring: if (state.phase === "ringing-out" && invitedCallId !== state.callId) { deferredRing = frame; return }
// in closeNow()/showFailure(): if (deferredRing) { const r = deferredRing; deferredRing = null; callStore.handleFrame(r) }
// clear deferredRing on call.ended for its callId
```

### WR-06: Logging out (or a session expiring) during a call never ends it; the peer sits in "Reconnecting…" and then sees "Call dropped"

**File:** `web/components/app/shell.tsx:167-171`, `180-184`, `204-208`; `web/lib/call/store.ts:1041-1048`

**Issue:** Every logout path calls `stopRealtime()` before `callStore.reset()`, and `reset()` never sends `call.end` anyway. The server only learns from the socket close:
- An active call takes the 35 s absence grace, so the peer sees "Reconnecting…" and then "Call dropped" with Call back.
- A ringing call keeps ringing the callee for another 10 s and then sends them a "Missed call" push.

**Fix:** End the call before tearing down the socket:
```ts
reset(): void {
  const { callId, phase } = state
  if (callId && phase === "ringing-in") sendFrame({ t: "call.decline", callId })
  else if (callId && (phase === "ringing-out" || phase === "connecting" || phase === "live")) sendFrame({ t: "call.end", callId })
  // ...existing teardown
}
```
In `Shell`, call `callStore.reset()` before `stopRealtime()` on the user-initiated logout path.

### WR-07: The service worker closes every notification on every push, so a chat message during a ring removes "Incoming call" and a later message erases "Missed call"

**File:** `web/public/sw.js:37-43`

**Issue:** The push handler unconditionally closes every open notification before it shows the new one. During a ring, a chat push from the caller ("pick up!") replaces the "Incoming call" notification on the locked phone, so the ring disappears while the call is still ringing. After a missed call, the next chat push silently destroys the "Missed call from X" notification. That notification is the only record of the miss (CALL-10 is v2), so the D-12 guarantee is lost.

**Fix:** Collapse per tag. A chat push closes only `duet-chat` and `duet-test` notifications, and a call push closes only `duet-call`:
```js
const open = await self.registration.getNotifications()
for (const n of open) if (isCall ? n.tag === "duet-call" : n.tag !== "duet-call") n.close()
```
Collapsing is done on the device because iOS ignores tags. Filtering by tag here still works, since it decides which notifications get closed.

### WR-08: Callee-side technical failures are reported to the caller as "Declined"

**File:** `web/lib/call/store.ts:582-590`, `601-606`, `608-611`

**Issue:** In `answer()`, an unavailable mic, a failed TURN-credential fetch or a session setup error all send `call.decline`. The caller's screen then shows "Declined" (`handleEnded` → `showEnded("Declined")`) even though the callee tapped Accept and hit an error. That status is wrong and misleading for the two-person use case.

**Fix:** Send `call.accept` and then `call.end` (the caller then sees the failure path, or "Call ended" after WR-03), or add a dedicated client reason. Only a real Decline tap (or a denied mic, if that is the intended product choice) should send `call.decline`.

### WR-09: After a reload or crash mid-call, the stale server call blocks new calls with the wrong "on another device" message

**File:** `server/src/calls/registry.ts:213-229`; `web/lib/call/store.ts:524-528`

**Issue:** A reloaded page has no call state, so it never sends `call.rejoin`. Meanwhile the server keeps the old call (10 s if ringing, 35 s if active). Any `startCall` from the reloaded page gets `busy`, and the client shows "You're already in a call on another device." That is false: it is the same device and the same session. While ringing, the callee can still accept the zombie call in that window (and then hit CR-01).

**Fix:** In `invite()`, when the inviting connection's session equals the bound session of the current call's party (`callerSession`/`calleeSession`), end the old call first (`end(call, "dropped")`) and then process the invite normally. Alternatively, answer with a specific reason so the client can say "Finishing your previous call…" and retry.

## Info

### IN-01: The callee still restarts ICE itself, contradicting the "callee never offers" invariant

**File:** `web/lib/rtc/peer.ts:94-96`; `web/lib/call/session.ts:183-187`

**Issue:** `pc.oniceconnectionstatechange` calls `pc.restartIce()` on ICE `failed` on both roles. On the callee this fires `negotiationneeded` and sends an offer, while `CallSession` documents that the callee only answers. Perfect negotiation resolves the collision, but a callee offer that goes out while the caller is away leaves the callee in `have-local-offer`, and only the caller's `restart()` has rollback handling.

**Fix:** Skip the generic restart when `o.role === "callee"`, and let `CallSession.watchIce` own restarts.

### IN-02: The incoming-call push TTL is fixed at 45 s while the ring timeout is configurable up to 120 s

**File:** `server/src/push/sender.ts:33`; `server/src/config.ts` (`CALL_RING_TIMEOUT_MS` max 120000)

**Issue:** With a longer ring, a phone that comes online after 45 s never gets the ring push.

**Fix:** Derive the TTL from `config.CALL_RING_TIMEOUT_MS` (`Math.ceil(ms / 1000)`).

### IN-03: `serverJoin` failures are invisible to the registry

**File:** `server/src/ws/hub.ts:365-372`, `590-593`

**Issue:** If a party's connection already holds `WS_MAX_ROOMS_PER_CONN` rooms (possible from the `/debug/call` harness), `join` answers `too_many_rooms` or `room.full`. `bind()` and `rejoin()` still treat the call as connected, so signaling silently goes nowhere.

**Fix:** Exempt `call-` rooms from the per-connection cap, or have `serverJoin` return a boolean so the registry can end the call with `failed`.

### IN-04: The caller's call closes silently when the server cancels or drops it during ringing

**File:** `web/lib/call/store.ts:529-535`, `547-558`

**Issue:** A caller whose socket was away longer than 10 s gets `cancelled` (or `dropped` on a rejoin to an unknown call). `handleEnded` just runs `closeNow()` with no text, so the call screen vanishes without explanation.

**Fix:** For role caller, show "Couldn't connect" (or a "Call ended" toast) for these server-originated ends.

### IN-05: "Incoming call" notifications stay on the callee's other phone after an answer or decline elsewhere

**File:** `server/src/calls/registry.ts:199-202`

**Issue:** Only `cancelled`/`no-answer` sends a cleanup push. A ring answered or declined on one device leaves a stale "Incoming call" on the person's other device until it is tapped.

**Fix:** Send a low-TTL cleanup push (for example `t: "call-ended"`, shown as a quiet "Call ended" notification so iOS keeps push permission) to sessions that received the ring, or accept the gap and document it.

---

_Reviewed: 2026-10-18T20:53:30Z_
_Reviewer: Claude (gsd-code-reviewer)_
_Depth: standard_
