# Phase 3: Voice & Video Calls - Context

**Gathered:** 2026-10-15
**Status:** Ready for planning

<domain>
## Phase Boundary

1:1 peer-to-peer voice and video calls between the two users. Signaling rides duet's own `/ws`, and Cloudflare TURN acts as the relay (Phase 1 D-16). An incoming call reaches a closed app as a web push, and tapping it opens the app to an incoming-call screen. In a call you can mute, toggle the camera, flip front/back camera and hang up. The screen stays awake, and a dropped connection reconnects automatically. Calls work on Wi-Fi and on cellular. Requirements: CALL-01 … CALL-09.

Not in this phase: call-log or missed-call entries in the chat timeline (CALL-10, v2), native ringing/CallKit, group calls.

</domain>

<decisions>
## Implementation Decisions

### Carried forward (still binding)
- UI comes only from shadcn preset `b51GFhBEQ` (Base UI + Phosphor, added through `npx shadcn add`). Always dark, rose accent. No lucide, no Radix snippets.
- Media plane: P2P `RTCPeerConnection` with perfect negotiation (`web/lib/rtc/peer.ts`). ICE servers come from `POST /api/rtc/ice-servers` (Cloudflare TURN, minted server-side), and signaling uses `rtc.signal` frames in WS rooms (`shared/src/ws.ts`). No SFU, no `@sideby-me/rtc`.
- Push: every push must show a notification (iOS revokes permission otherwise). The SW closes the open notifications before it shows a new one, because iOS ignores `tag`. Payload helpers are in `server/src/push/sender.ts`.

### Call screen & controls
- **D-01:** Calls start from **two icons in the chat header**: phone (voice) and video camera (video), next to the existing menu. One tap starts the call.
- **D-02:** Video layout: the **remote video is full-screen** and the **self-view is a small draggable PiP**. **Tapping the PiP swaps** the large and small views. Controls auto-hide after a few seconds of inactivity and a tap brings them back.
- **D-03:** **The camera toggle works in any call.** A voice call is just a call that starts with the camera off, and either side can turn video on mid-call (renegotiation through perfect negotiation). There is one call screen and one code path for both kinds.
- **D-04:** When there's no remote video (a voice call, or the remote camera is off), show a **big initials Avatar, the other person's name, the running call timer and the status line** (Ringing… / Connecting… / Reconnecting… / Poor connection). The control bar sits at the bottom: mute, camera, flip (only while video is on), speaker, hang up.
- **D-05:** **Speaker toggle**: show it **only where switching the audio output actually works** (e.g. `setSinkId`/`selectAudioOutput` on Chrome/Pixel). Hide it where it can't work, which is likely the iOS PWA. Defaults: speaker for video, earpiece for voice where the OS allows the choice.
- **D-06:** **The call screen can be minimized back to the chat.** A slim "On call · 2:14" bar at the top of the chat returns to the call when tapped, so you can chat or send a photo during a call. The call state must therefore live above the chat route (an app-level provider), not inside a page.

### Ringing & answering
- **D-07:** **Ring timeout is 45 seconds.** The server owns the timer. When it fires, the caller sees "No answer" and the callee's ringing stops.
- **D-08:** While the app is in the foreground, an incoming call **loops a ringtone** and **vibrates where supported** (Android; iOS has no Vibration API). The caller hears a **ringback tone**. iOS may block audio autoplay until there's been a user gesture. If it does, the incoming screen still shows silently.
- **D-09:** Incoming-call push: the **title is the caller's name** and the body is **"📞 Incoming voice call"** or **"🎥 Incoming video call"**. It replaces any chat notification that's showing. Use a short TTL (≈45 s) and high urgency. Tapping it opens or focuses the app on the incoming-call screen (Accept / Decline) for that call (CALL-03).
- **D-10:** **Stale push**: if the call has already ended (cancelled or timed out) when the app opens from the push, land on the chat and show a short **sonner toast "Missed call from X"** with a **Call back** action. Nothing is stored.
- **D-11:** **All of the callee's devices ring**: every open WS connection plus every push subscription. **The first device to accept or decline wins**, and the server tells the others to stop ringing.
- **D-12:** **Ring cleanup**: when a call ends unanswered (timeout or caller cancel), the server sends a second push that **replaces the "Incoming call" notification with "Missed call from X"**. This brings only the *missed-call push* part of CALL-10 into scope. Timeline/call-log entries stay v2.

### Busy / decline / end states
- **D-13:** On **decline**, the caller's screen shows **"Declined"** for about 2 s and then returns to the chat.
- **D-14:** **Glare** (both call each other at the same moment): the server **auto-merges the two attempts into one connected call** and neither side sees "busy". (Claude's discretion: if one attempt was video and the other voice, merge as video-capable, or as voice with the camera toggle available, since D-03 makes this a camera-state question.)
- **D-15:** **Call end** (either side hangs up): show **"Call ended · m:ss"** for about 1.5 s, then return to the chat. Nothing goes into the timeline.
- **D-16:** If the callee **has no push subscription and no open connection**, the call still **rings until the 45 s timeout** and then shows "No answer". It doesn't fail early.
- Busy (a third call while already in one) can't really happen with two users, except as glare (D-14) or another device of the same user. Handle it minimally: a person already in a call gets no second ring.

### Reconnect & failure
- **D-17:** On a connection drop (ICE `disconnected`/`failed`, or the WS dropping), show **"Reconnecting…"** and recover automatically (ICE restart, plus WS reconnect and re-join of the call room). **Give up after 30 s** and show **"Call dropped"** with a **Call back** button (CALL-07).
- **D-18:** **iOS background/lock is best effort.** Expect audio to often keep running and video to pause. If the app comes back inside the 30 s window, the call resumes through D-17. On the **first call on iOS**, show a **one-time tip**: "Keep duet open during calls" (stored per device, e.g. in localStorage).
- **D-19:** **Failures get a clear message plus an action.** If mic or camera permission is denied, explain how to allow it, with steps for iOS Settings and for Chrome site settings. If ICE fails or the call can't connect, show "Couldn't connect" with **Retry**.
- **D-20:** **Quality indicator**: show a small **"Poor connection"** badge only when stats show high packet loss or RTT. Show nothing otherwise. Reuse `web/lib/rtc/stats.ts`.
- **D-21:** **Screen stays awake** during a call through the Screen Wake Lock API (re-acquired on `visibilitychange`) (CALL-08). Claude decides the fallback if the API is missing.

### Claude's Discretion
- Call-state machine and protocol details. Expect new WS frames along the lines of `call.invite` / `call.ring` / `call.accept` / `call.decline` / `call.cancel` / `call.end` / `call.stop-ringing`, and a server-side call registry that owns the 45 s timer, the multi-device "first wins" rule and glare merging. Keep the existing `room.*` + `rtc.signal` relay as the media path.
- How the push tap reaches the incoming-call screen: the SW `notificationclick` posts a message or opens a deep link with the call id, and the client fetches the live call state from the server.
- Ringtone/ringback audio: generated with WebAudio or a small bundled file. The thresholds for "Poor connection". Control auto-hide timing. PiP drag snapping.
- Glare when the media kinds don't match (see D-14).
- Whether `/debug/call` stays (it's useful for diagnostics). It must not conflict with the real call flow's rooms.

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Scope & requirements
- `.planning/ROADMAP.md` §Phase 3: goal and the 4 success criteria
- `.planning/REQUIREMENTS.md`: CALL-01 … CALL-09 (CALL-10 is v2; only its missed-call push is pulled in by D-12)
- `.planning/PROJECT.md`: constraints (locked preset, P2P + Cloudflare TURN, iOS PWA limits)

### Media plane decisions
- `.planning/phases/01-foundation-auth-media-plane/01-CONTEXT.md`: D-16 (P2P + Cloudflare TURN, signaling over duet WS), D-10 (always dark), D-12 (debug harness)
- `.planning/phases/01-foundation-auth-media-plane/01-RESEARCH.md`: P2P/perfect-negotiation patterns and pitfalls (e.g. Pattern M4)

### Push & UI conventions
- `.planning/phases/02-chat-media-push/02-CONTEXT.md`: D-13/D-14 (notification copy and single-notification collapse), D-15 (presence / "viewing"), D-16 (onboarding / push enablement)
- `.planning/phases/02-chat-media-push/02-UI-SPEC.md`: the established UI contract for the chat shell and header that the call icons and the call bar attach to

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- `web/lib/rtc/peer.ts`: `createPeer()`, a perfect-negotiation `RTCPeerConnection` wrapper (forceRelay, polite role, signal send/receive). This is the base of the real call. It needs track add/remove for the camera toggle, ICE restart and device switching.
- `web/lib/rtc/ice.ts`: fetches TURN ICE servers from `/api/rtc/ice-servers`.
- `web/lib/rtc/stats.ts`: stats polling. Reuse it for the D-20 quality badge.
- `web/components/app/call-test.tsx` + `web/app/debug/call/page.tsx`: the working two-peer harness, a reference for wiring the WS rooms and the peer.
- `server/src/rtc/turn.ts`, `server/src/rtc/routes.ts`: TURN credential minting.
- `server/src/ws/hub.ts`: connection registry per user, rooms (`WS_MAX_ROOMS_PER_CONN = 4`), signal relay and heartbeat. The call registry and the call frames attach here.
- `server/src/push/sender.ts` + `web/public/sw.js`: push sending and the SW. The SW needs a call-push branch (incoming / missed-call copy, and a click that routes to the call).
- `web/components/app/shell.tsx` / `chat-view.tsx`: the chat header that gets the call icons, and where the "On call" bar is mounted.

### Established Patterns
- Shared zod protocol in `shared/src/ws.ts`. Client frames are strict, server frames are lenient (an older PWA must tolerate added fields).
- The SW only listens for install/activate/push/notificationclick. It never intercepts fetches.
- Presence (`presence` frame, D-15 from Phase 2) already tracks foreground/visible clients. The server decides on push suppression.

### Integration Points
- New `call.*` client/server frames in `shared/src/ws.ts`, plus a server call registry next to the hub.
- A new push payload type for incoming-call / missed-call in `shared/src/push.ts` and the SW.
- An app-level call provider (above the chat route) that owns the call state, the media and the minimized bar (D-06).

</code_context>

<specifics>
## Specific Ideas

- The feel should be WhatsApp/FaceTime-like: header icons, full-screen remote video, a draggable self PiP that swaps on tap, and controls that auto-hide.
- Push copy follows Phase 2 D-13 style with emoji: "Puri", "🎥 Incoming video call".
- "Missed call from X" appears as the replacing push (D-12) and as a toast on a stale tap (D-10), both with **Call back**.

</specifics>

<deferred>
## Deferred Ideas

- Call log / missed-call entries in the chat timeline: CALL-10 (v2). Only the missed-call push is pulled into Phase 3 (D-12).
- Native full-screen ringing / CallKit: out of scope (PROJECT.md).

</deferred>

---

*Phase: 03-voice-video-calls*
*Context gathered: 2026-10-15*
