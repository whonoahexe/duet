# Phase 3: Voice & Video Calls - Research

**Researched:** 2026-10-16
**Domain:** 1:1 browser WebRTC calls (P2P + Cloudflare TURN), WS call signaling, Web Push ringing, iOS Safari / Android Chrome PWA media quirks
**Confidence:** MEDIUM-HIGH. The code seams were read this session and the core WebRTC mechanics were verified in headless Chrome 153. iOS-specific behaviour is MEDIUM/LOW and needs device UAT.

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions

#### Carried forward (still binding)
- UI comes only from shadcn preset `b51GFhBEQ` (Base UI + Phosphor, added through `npx shadcn add`). Always dark, rose accent. No lucide, no Radix snippets.
- Media plane: P2P `RTCPeerConnection` with perfect negotiation (`web/lib/rtc/peer.ts`). ICE servers come from `POST /api/rtc/ice-servers` (Cloudflare TURN, minted server-side), and signaling uses `rtc.signal` frames in WS rooms (`shared/src/ws.ts`). No SFU, no `@sideby-me/rtc`.
- Push: every push must show a notification (iOS revokes permission otherwise). The SW closes the open notifications before it shows a new one, because iOS ignores `tag`. Payload helpers are in `server/src/push/sender.ts`.

#### Call screen & controls
- **D-01:** Calls start from **two icons in the chat header**: phone (voice) and video camera (video), next to the existing menu. One tap starts the call.
- **D-02:** Video layout: the **remote video is full-screen** and the **self-view is a small draggable PiP**. **Tapping the PiP swaps** the large and small views. Controls auto-hide after a few seconds of inactivity and a tap brings them back.
- **D-03:** **The camera toggle works in any call.** A voice call is just a call that starts with the camera off, and either side can turn video on mid-call (renegotiation through perfect negotiation). There is one call screen and one code path for both kinds.
- **D-04:** When there's no remote video (a voice call, or the remote camera is off), show a **big initials Avatar, the other person's name, the running call timer and the status line** (Ringing… / Connecting… / Reconnecting… / Poor connection). The control bar sits at the bottom: mute, camera, flip (only while video is on), speaker, hang up.
- **D-05:** **Speaker toggle**: show it **only where switching the audio output actually works** (e.g. `setSinkId`/`selectAudioOutput` on Chrome/Pixel). Hide it where it can't work, which is likely the iOS PWA. Defaults: speaker for video, earpiece for voice where the OS allows the choice.
- **D-06:** **The call screen can be minimized back to the chat.** A slim "On call · 2:14" bar at the top of the chat returns to the call when tapped, so you can chat or send a photo during a call. The call state must therefore live above the chat route (an app-level provider), not inside a page.

#### Ringing & answering
- **D-07:** **Ring timeout is 45 seconds.** The server owns the timer. When it fires, the caller sees "No answer" and the callee's ringing stops.
- **D-08:** While the app is in the foreground, an incoming call **loops a ringtone** and **vibrates where supported** (Android; iOS has no Vibration API). The caller hears a **ringback tone**. iOS may block audio autoplay until there's been a user gesture. If it does, the incoming screen still shows silently.
- **D-09:** Incoming-call push: the **title is the caller's name** and the body is **"📞 Incoming voice call"** or **"🎥 Incoming video call"**. It replaces any chat notification that's showing. Use a short TTL (≈45 s) and high urgency. Tapping it opens or focuses the app on the incoming-call screen (Accept / Decline) for that call (CALL-03).
- **D-10:** **Stale push**: if the call has already ended (cancelled or timed out) when the app opens from the push, land on the chat and show a short **sonner toast "Missed call from X"** with a **Call back** action. Nothing is stored.
- **D-11:** **All of the callee's devices ring**: every open WS connection plus every push subscription. **The first device to accept or decline wins**, and the server tells the others to stop ringing.
- **D-12:** **Ring cleanup**: when a call ends unanswered (timeout or caller cancel), the server sends a second push that **replaces the "Incoming call" notification with "Missed call from X"**. This brings only the *missed-call push* part of CALL-10 into scope. Timeline/call-log entries stay v2.

#### Busy / decline / end states
- **D-13:** On **decline**, the caller's screen shows **"Declined"** for about 2 s and then returns to the chat.
- **D-14:** **Glare** (both call each other at the same moment): the server **auto-merges the two attempts into one connected call** and neither side sees "busy". (Claude's discretion: if one attempt was video and the other voice, merge as video-capable, or as voice with the camera toggle available, since D-03 makes this a camera-state question.)
- **D-15:** **Call end** (either side hangs up): show **"Call ended · m:ss"** for about 1.5 s, then return to the chat. Nothing goes into the timeline.
- **D-16:** If the callee **has no push subscription and no open connection**, the call still **rings until the 45 s timeout** and then shows "No answer". It doesn't fail early.
- Busy (a third call while already in one) can't really happen with two users, except as glare (D-14) or another device of the same user. Handle it minimally: a person already in a call gets no second ring.

#### Reconnect & failure
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

### Deferred Ideas (OUT OF SCOPE)
- Call log / missed-call entries in the chat timeline: CALL-10 (v2). Only the missed-call push is pulled into Phase 3 (D-12).
- Native full-screen ringing / CallKit: out of scope (PROJECT.md).
</user_constraints>

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|------------------|
| CALL-01 | User can start a 1:1 voice call | §Pattern 1 (call registry + `call.invite`), §Pattern 3 (transceiver setup with camera off), header buttons per UI-SPEC §1 |
| CALL-02 | User can start a 1:1 video call | Same path as CALL-01 with the camera on at start (§Pattern 3). One code path (D-03) |
| CALL-03 | Recipient gets an "incoming call" push; tapping it (or opening the app) shows the incoming-call screen to accept or decline | §Pattern 2 (ring-on-attach: the server re-sends `call.ring` to every new callee connection, so it does not depend on iOS deep links), §Pattern 6 (call push + SW branch), Pitfall 4 |
| CALL-04 | Unanswered calls stop ringing after a timeout; caller can cancel while ringing | §Pattern 1 (server-owned 45 s timer, `call.end` while ringing = cancel, missed-call push D-12) |
| CALL-05 | Mute/unmute, camera on/off, hang up | §Pattern 3 (`track.enabled`, `replaceTrack` on a pre-negotiated video transceiver, verified with no renegotiation), §Pattern 4 (`call.media` camera flag) |
| CALL-06 | Switch front/back camera | §Pattern 5 (stop → `getUserMedia({facingMode:{exact}})` → `replaceTrack`, with a deviceId fallback) |
| CALL-07 | Survives brief network blips with "Reconnecting…" and rejoins automatically | §Pattern 7 (ICE restart via perfect negotiation, WS re-hello → `call.rejoin`, stale-connection eviction, rollback of a lost offer, 30 s give-up), Pitfalls 1-3 |
| CALL-08 | Screen stays awake during a call | §Pattern 8 (Wake Lock, re-acquired on `visibilitychange`). iOS standalone needs iOS ≥ 18.4 |
| CALL-09 | Calls connect over cellular (TURN relay) as well as Wi-Fi | Reuses the Phase 1 proven TURN mint (`fetchIceServers`) + `iceTransportPolicy` switch. §Validation: forced-relay E2E + cellular UAT |
</phase_requirements>

## Project Constraints (from CLAUDE.md)

- **UI is locked to shadcn preset `b51GFhBEQ`** (base-luma, Base UI, Phosphor, Space Grotesk). Components only via `npx shadcn add`. No lucide, no Radix, no third-party call-UI libraries. [CITED: .claude/CLAUDE.md]
- **Media plane: 1:1 P2P WebRTC + Cloudflare TURN minted by the duet server.** The SFU / `@sideby-me/rtc` / mediasoup / jose join-token / coturn sections of CLAUDE.md are historical. Do not install or build them. [CITED: .claude/CLAUDE.md, Phase 1 D-16]
- **Speed first.** Prefer the simplest thing that works. The roadmap is capped at 3 phases (this is the last). [CITED: CLAUDE.md, user memory]
- **Self-hosted** in the one Docker `duet` service. No new services. [CITED: CLAUDE.md]
- **HTTPS/WSS everywhere.** [CITED: CLAUDE.md]
- **Every push must `showNotification`** (no silent pushes). [CITED: CLAUDE.md "What NOT to Use"]
- **TypeScript stays `^5`.** Server runs via `tsx`. Shared zod protocol lives in `shared/`. [CITED: CLAUDE.md]
- **GSD workflow:** file edits only through GSD commands (`/gsd-execute-phase`). [CITED: CLAUDE.md]
- `web/AGENTS.md`: "This is NOT the Next.js you know". Read `node_modules/next/dist/docs/` before writing Next-specific code. This phase adds no Next routing features (everything is client components in the existing `/` page). [CITED: web/AGENTS.md]
- Phase 2 convention: no react-query. Client state is a `useSyncExternalStore` store (`chatStore`). Mirror that for the call store. [VERIFIED: STATE.md decision "02-01: No react-query; one useSyncExternalStore chat store"]

## Summary

The Phase 1 primitives are reused, not rebuilt: TURN minting (`server/src/rtc/turn.ts`, `web/lib/rtc/ice.ts`), the perfect-negotiation peer (`web/lib/rtc/peer.ts`), the WS hub rooms and `rtc.signal` relay (`server/src/ws/hub.ts`), `getStats` sampling (`web/lib/rtc/stats.ts`) and the Phase 2 push sender and SW. Phase 3 needs **no new npm packages**. It adds four things. (1) A small **server call registry**, attached to the hub. With exactly two users there is at most one call in the whole system, so the registry holds a single `current` call. It owns the 45 s ring timer, multi-device "first wins", glare merging, ring-on-reconnect and stale-connection eviction. (2) New `call.*` WS frames in `shared/src/ws.ts`. (3) A call push branch in `sender.ts` + `sw.js`. (4) An app-level `CallProvider` and call screens on the client.

The most important design choice: **negotiate the audio and video transceivers once, at call setup, and never renegotiate media again.** Camera on/off and front/back flip become `RTCRtpSender.replaceTrack()` on the pre-negotiated video transceiver. In headless Chrome 153 this session I verified that `replaceTrack` fires **no** `negotiationneeded` on either side and that video bytes start flowing immediately. The camera toggle (D-03) therefore can never collide with an ICE restart. Perfect negotiation stays in place for the initial offer/answer and for ICE restarts. The same probe showed that after `replaceTrack(null)` the remote track does **not** go `muted` (0 mute events in 4 s). So the remote "camera on/off" state must be signalled explicitly (a `call.media` WS frame), never inferred from the track.

Three platform findings change the plan. **(a) The speaker toggle (D-05) works on neither target phone.** MDN compat data marks `HTMLMediaElement.setSinkId` as *not available on Chrome Android* (Android limitation, crbug 41276355). iOS Safari 18.4+ *has* `setSinkId` but enumerates no audio outputs, and `selectAudioOutput` is unsupported in both browsers. A naive `'setSinkId' in HTMLMediaElement.prototype` check would wrongly show a dead toggle on iPhone. **(b) Screen Wake Lock does not work in iOS Home Screen apps before iOS 18.4** (WebKit 254545). **(c) On iOS, `notificationclick` → `openWindow(url)` / `postMessage` / `navigate` is unreliable for Home Screen apps** (the app often opens at its root). Answer-from-push must therefore not depend on the URL: the server re-sends `call.ring` to every new connection of the callee while the call is ringing.

**Primary recommendation:** Build a server-side single-call registry plus `call.*` frames on the existing `/ws`. Ride call signaling on the tab's one `Realtime` socket (not a second socket like `/debug/call`). Roles are fixed: caller = impolite offerer, callee = polite answerer, stable across reconnects. Pre-negotiate `audio` + `video` transceivers and use `replaceTrack` for every camera change. Recover with `restartIce()` + `call.rejoin`.

## Architectural Responsibility Map

| Capability | Primary Tier | Secondary Tier | Rationale |
|------------|-------------|----------------|-----------|
| Call lifecycle (invite, ring, accept/decline, cancel, 45 s timeout, glare, busy, multi-device first-wins) | API / Backend (in-memory registry next to the hub) | Browser (renders state) | D-07 "server owns the timer". Only the server sees every device of both users |
| Who may join a call room / receive call signals | API / Backend | — | Rooms are join-by-name today. Call rooms must be server-managed (access control) |
| Ringing push + missed-call push | API / Backend (`sender.ts`) | Service worker (shows, collapses, routes tap) | Push suppression and payloads are server-side by convention (Phase 2) |
| TURN credentials | API / Backend (`/api/rtc/ice-servers`) | — | Already built (INFR-03) |
| Media capture, peer connection, ICE restart, replaceTrack, stats | Browser / Client | — | WebRTC is client-only; server relays opaque SDP/candidates |
| Remote camera-on/off state | Browser (sender) → API relay (`call.media`) → Browser | — | Track mute is unreliable (verified), so explicit state is needed |
| Wake lock, ringtone/ringback, vibration, permission UX | Browser / Client | — | Device APIs |
| Call state above the chat route (minimize, on-call bar) | Browser / Client (`CallProvider` in `Shell`) | — | D-06 |

## Standard Stack

### Core (all already installed, no new packages)
| Library / API | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| Browser `RTCPeerConnection` | Chrome Android / iOS Safari built-in | 1:1 media | Phase 1 proved it from cellular in normal and relay mode [VERIFIED: 01-VERIFICATION.md SC5] |
| `@fastify/websocket` + in-memory hub | 11.3.3 | Signaling + call frames | Already serving `/ws` with rooms + relay [VERIFIED: server/package.json] |
| `zod` | 4.6.5 | `call.*` frame schemas in `shared/src/ws.ts` | Existing convention: client frames strict, server frames lenient [VERIFIED: shared/src/ws.ts:4-8] |
| `web-push` | 3.6.7 | Call push (TTL 45, urgency high) | Already used by `sender.ts` [VERIFIED: server/package.json] |
| Web Audio API | built-in | Ringtone / ringback (generated tones, no asset files) | UI-SPEC default. No asset pipeline or autoplay-of-file issues |
| Screen Wake Lock API | built-in | CALL-08 | Standard. Fallback: do nothing (UI-SPEC default) |
| `playwright-core` | 1.62.1 (root devDependency) | Two-browser call E2E with fake media, `routeWebSocket` to drop the WS | Already used by `scripts/smoke-call.mjs`. `page.routeWebSocket` exists in the installed types [VERIFIED: node_modules/playwright-core/types/types.d.ts:4458] |
| `vitest` | 5.0.3 | Registry + WS + push + SW unit/integration tests | Existing server test runner with `injectWS` helpers [VERIFIED: server/package.json, server/test/helpers.ts] |

### Alternatives Considered
| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| `replaceTrack` on a pre-negotiated video transceiver (camera toggle) | `addTrack`/`removeTrack` + renegotiation via perfect negotiation (literal D-03 wording) | Renegotiation per toggle can collide with an ICE restart during a blip, and needs m-line reuse logic on both sides. replaceTrack is verified to need no negotiation. **Same UX, same single code path.** Treat this as the implementation of D-03's "one code path"; renegotiation still works if it is ever needed |
| `call.media` WS frame for the remote camera state | `RTCDataChannel` (survives a WS outage) | A data channel needs another m-line and its own open/close handling. The WS is re-established within the 30 s window anyway; resend state on rejoin |
| Server re-sending `call.ring` on connect | Deep link `/?call=<id>` from `notificationclick` only | Deep links/`postMessage` are unreliable on iOS Home Screen apps (Pitfall 4). Keep the deep link only as a best-effort hint for the D-10 stale toast |
| WebAudio-generated tones | Bundled MP3/OGG | A file adds an asset and has the same autoplay rules. Tones are ~20 lines |
| Single `current` call in the registry | Map of calls keyed by id | Two users means at most one call. Keep a small `recent` map of ended calls only for the stale-push status lookup |
| simple-peer / PeerJS / LiveKit | — | Rejected in Phase 1 ("Don't Hand-Roll": plain RTCPeerConnection). No SFU (D-16) |

**Installation:** none. No `npm install` in this phase.

## Package Legitimacy Audit

No external packages are installed in this phase. Every capability uses browser APIs or packages already in the lockfile (`web-push`, `zod`, `@fastify/websocket`, `playwright-core`, `vitest`).

**Packages removed due to [SLOP] verdict:** none
**Packages flagged as suspicious [SUS]:** none

## Architecture Patterns

### System Architecture Diagram

```
 CALLER device (A)                         duet server (one Fastify process)                    CALLEE devices (B1..Bn)
 ─────────────────                         ─────────────────────────────────                    ────────────────────────
 tap Voice/Video ──► getUserMedia (in tap)
   │                 fetchIceServers ─────► POST /api/rtc/ice-servers ─► Cloudflare TURN mint
   │
   └─ call.invite{callId,kind} ──WS──► Hub.onMessage ─► CallRegistry
                                         │  current==null ─► create {ringing}, start 45 s timer
                                         │  current ringing & callee==inviter ─► GLARE: merge = accept
                                         │  current active ─► reply call.ended{busy}
                                         ├─► call.ring ──WS──► every open conn of B ──► Incoming screen + ringtone
                                         ├─► web-push (TTL 45, urgency high) ──► push svc ──► SW: close old, show "📞 Incoming…"
                                         │                                                  │ tap → open/focus app
                                         │◄── new WS conn of B (hello) ◄───────────────────────┘
                                         │    ring-on-attach: send call.ring again
                                         │
 Ringing… + ringback                     │◄── call.accept{callId} (first device wins) ◄── B1 Accept (gUM in tap, fetch ICE)
                                         ├─► call.stop-ringing ──► B2..Bn (close incoming, toast if accepted elsewhere)
                                         ├─► server joins A.conn + B1.conn to room "call-<callId>"
                                         ├─► call.accepted ──► A, B1
 createPeer(role=caller, impolite)       │
   addTransceiver(audio mic), addTransceiver(video, track|null)
   negotiationneeded → offer ──rtc.signal──► relay to other room member ──► B1 createPeer(role=callee, polite)
                                                                              setRemote(offer) → attach mic/cam via
                                                                              replaceTrack → answer
   ◄──────────────────────── answer / candidates (rtc.signal relay) ◄─────────
 ═══════════ media: P2P host/srflx, or via Cloudflare TURN relay (cellular / CGNAT) ═══════════
 camera toggle: replaceTrack + call.media{camera} ──► relay ──► remote switches Mode A/B
 drop: ICE disconnected/failed or WS close ─► "Reconnecting…"
   WS re-hello ─► call.rejoin{callId} ─► registry rebinds conn, evicts stale conn from room, re-joins
   caller: rollback lost offer if any → restartIce() → new offer via relay
   30 s without media ─► "Call dropped" (client) / server party-absent timer ends call
 end: call.end{callId} ─► registry ─► call.ended{reason} ─► both (+ missed push if it was still ringing)
```

### Recommended Project Structure (new files in **bold**)
```
shared/src/
├── ws.ts              # + call.* ClientFrame/ServerFrame variants, CallKind, CallEndReason, new WsErrorCodes
├── push.ts            # PushPayload.t + "call" | "call-missed"; optional callId/kind
└── **call.ts**        # CallStatusResponse for GET /api/calls/:id (optional, see Pattern 6)
server/src/
├── ws/hub.ts          # delegate call.* frames; attach/close hooks; server-side join/evict; sendToUser
├── **calls/registry.ts**  # pure state machine (injected timers/now, transport, push) - unit-testable
├── **calls/routes.ts**    # GET /api/calls/:id (party-only status for the D-10 stale toast)
└── push/sender.ts     # + notifyCall(recipientId, call, callerName) / notifyMissedCall(...), per-send TTL
web/
├── lib/rtc/peer.ts    # extend: role-based setup hook, per-track onTrack, beforeAnswer hook, rollback helper
├── lib/rtc/stats.ts   # + inbound packet loss for the D-20 badge
├── lib/chat/realtime.ts  # expose sendFrame(), onFrame(), onLive() for the call store
├── **lib/call/store.ts**     # useSyncExternalStore call store (mirrors chatStore)
├── **lib/call/session.ts**   # one call's media + peer + reconnect controller (framework-free class)
├── **lib/call/media.ts**     # getUserMedia helpers, flip, permission error mapping
├── **lib/call/tones.ts**     # WebAudio ringtone/ringback + navigator.vibrate loop
├── **lib/call/wake-lock.ts** # acquire/release/re-acquire on visibilitychange
├── components/app/shell.tsx  # header icons, mount <CallProvider>, on-call bar slot
├── **components/app/call-provider.tsx**  # context, <audio> sink (always mounted), dialogs
├── **components/app/call-screen.tsx**    # Mode A/B, PiP, controls, terminal states
├── **components/app/incoming-call.tsx**
├── **components/app/on-call-bar.tsx**
├── **components/app/permission-drawer.tsx**
└── public/sw.js       # call push branch + notificationclick routing
scripts/
├── **smoke-calls.sh / smoke-calls.mjs**  # two-browser E2E of the real call flow (normal + forced relay)
```

### Pattern 1: Server call registry (single current call)

**What:** A pure module that receives `(connId, userId, frame)` plus `onAttach(conn)` and `onClose(conn)` events, and emits frames through a small transport interface `{ sendToConn, sendToUser(userId, frame, exceptConnId?), joinRoom(connId, room), evictFromRoom(room, userId) }` and push through `{ notifyCall, notifyMissed }`. Timers are injected (`ringTimeoutMs = 45_000`, `absentGraceMs`) so tests use short values, following the hub's existing injected `heartbeatMs` pattern [VERIFIED: server/src/app.ts:95 `heartbeatMs: deps.heartbeatMs ?? 25_000,`].

**State:**
```ts
// server/src/calls/registry.ts (sketch; names are recommendations, not existing code) [ASSUMED]
type CallKind = "voice" | "video"
interface Call {
  id: string                 // client-generated crypto.randomUUID() (lowercase), validated z.uuid()
  kind: CallKind             // initial camera state of the caller; used for push copy + UI defaults
  callerId: string; calleeId: string
  status: "ringing" | "active"
  callerConn: string         // connId that invited
  calleeConn?: string        // connId that accepted (first wins)
  absent: Set<"caller" | "callee">  // party whose bound conn closed; grace timer running
  ringTimer?: Timeout; absentTimer?: Timeout
}
let current: Call | null = null
const recent = new Map<string, { status: "ended"; reason: CallEndReason; kind; callerId; calleeId; endedAt }>() // ~10 min, for GET /api/calls/:id
```

**Transitions:**
| Event | Condition | Effect |
|-------|-----------|--------|
| `call.invite {callId, kind}` from A | `current == null` | create ringing call, callee = the other user (server-derived; there is no target in the frame). `call.ring` to every conn of B. Push to B (Pattern 6). Start the 45 s ring timer. The caller's conn joins room `call-<id>` immediately, or at accept (either works; joining at accept keeps signal-before-peer cases away) |
| `call.invite` from B | `current.ringing && current.callerId == B's other party && current.calleeId == B` (**glare**) | Treat as B accepting `current` from this conn. Send B `call.accepted {callId: current.id, replaces: B's callId}`, and send A `call.accepted`. Each side keeps its own camera choice (D-14 resolved as a camera-state question: no kind merge needed) |
| `call.invite` | `current` exists otherwise (busy) | `call.ended {callId: invitedId, reason: "busy"}` to the inviter only. No ring (CONTEXT: "gets no second ring") |
| `call.accept {callId}` | ringing, sender is callee, first | `status = active`, bind `calleeConn`, clear ring timer. Join both conns to `call-<id>`. `call.accepted` to both bound conns. `call.stop-ringing {callId, reason:"answered-elsewhere"}` to the callee's other conns |
| `call.decline {callId}` | ringing, sender is callee | end(`declined`). `call.stop-ringing {reason:"declined-elsewhere"}` to other callee conns (silent) |
| `call.end {callId}` | caller while ringing | end(`cancelled`) + **missed push** (D-12) |
| `call.end {callId}` | either party while active | end(`hangup`) |
| ring timer fires | ringing | end(`no-answer`) + **missed push** (D-12). Also covers D-16 (no devices) |
| `onAttach(conn)` of the callee user | ringing | **send `call.ring` to that conn** (ring-on-connect, the CALL-03 "or opening the app" path) |
| `onClose(conn)` | conn is a bound party conn | mark absent and start the grace timer (caller-while-ringing ≈10 s, active 35 s). On expiry: end(`cancelled`/`dropped`) |
| `call.rejoin {callId}` | sender's user is a party, call active (or caller while ringing) | rebind the party conn to the sender. **Evict that user's previous conn from the room**, then join the sender to the room. Clear absent. Send `call.state` (status, peer camera flag) to the sender |
| `call.media {callId, camera}` | sender is a bound party conn | relay `call.media {callId, camera}` to the other bound conn |
| end(reason) | — | `call.ended {callId, reason}` to every conn of both users that knew about the call (bound conns + ringing devices). Remove the room. Move to `recent`. `current = null` |

**Reserve room names:** client `room.join` for any room starting with `call-` must be refused (new error code `room_reserved`), so the `/debug/call` harness and any other client cannot enter a real call room. `RoomId` already allows `call-` + a 36-char UUID (41 chars) [VERIFIED: shared/src/ws.ts:19 `export const RoomId = z.string().regex(/^[a-z0-9-]{1,64}$/)`].

### Pattern 2: Call frames in `shared/src/ws.ts`

Client frames are `z.strictObject` and server frames are lenient `z.object`, per the file header [VERIFIED: shared/src/ws.ts:4-8 "Client frames are strict (an unknown key is a bad frame); server frames are plain objects so an older installed PWA tolerates added fields."]. New server `t` values **must** be added to `ServerFrame`, or the client's `SignalingClient` drops them as "unknown frame" [VERIFIED: web/lib/ws.ts:49-53].

```ts
// Recommended additions (names are recommendations) [ASSUMED]
export const CallId = z.uuid()
export const CallKind = z.enum(["voice", "video"])
export const CallEndReason = z.enum(["declined", "no-answer", "cancelled", "hangup", "dropped", "busy"])
// ClientFrame additions
z.strictObject({ t: z.literal("call.invite"), callId: CallId, kind: CallKind }),
z.strictObject({ t: z.literal("call.accept"), callId: CallId }),
z.strictObject({ t: z.literal("call.decline"), callId: CallId }),
z.strictObject({ t: z.literal("call.end"), callId: CallId }),          // cancel while ringing = end
z.strictObject({ t: z.literal("call.rejoin"), callId: CallId }),
z.strictObject({ t: z.literal("call.media"), callId: CallId, camera: z.boolean() }),
// ServerFrame additions
z.object({ t: z.literal("call.ring"), callId: CallId, kind: CallKind, from: z.uuid() }),
z.object({ t: z.literal("call.accepted"), callId: CallId, replaces: CallId.optional() }),
z.object({ t: z.literal("call.stop-ringing"), callId: CallId, reason: z.enum(["answered-elsewhere", "declined-elsewhere"]) }),
z.object({ t: z.literal("call.ended"), callId: CallId, reason: CallEndReason }),
z.object({ t: z.literal("call.media"), callId: CallId, camera: z.boolean() }),
z.object({ t: z.literal("call.state"), callId: CallId, status: z.enum(["ringing", "active"]), peerCamera: z.boolean() }),
```
The current error enum is closed [VERIFIED: shared/src/ws.ts:65 `export const WsErrorCode = z.enum(["bad_frame", "not_in_room", "too_many_rooms"])`]. Add `"room_reserved"` and `"no_such_call"`. Older PWAs will drop an `error` frame with an unknown code, which is harmless.

`rtc.signal` stays exactly as is (media path, CONTEXT). The client accepts `rtc.signal` for room `call-<id>` from **any** `from` connId: after a reconnect the peer's connId changes, and the room membership is server-controlled anyway.

### Pattern 3: Peer setup with fixed roles and pre-negotiated transceivers

**What:** Extend `createPeer` (keep `/debug/call` behaviour unchanged when no role is passed):
- `polite` = **callee**, impolite = **caller**. The role is fixed for the call's lifetime. Do **not** use the Phase 1 `myConnId > peerConnId` rule for calls, because connIds change on every WS reconnect [VERIFIED: server/src/ws/hub.ts:227 `const connId = randomUUID()` per attach].
- **Caller** setup (before the first offer):
  `pc.addTransceiver(micTrack, { direction: "sendrecv", streams: [local] })` and `pc.addTransceiver(camTrack ?? "video", { direction: "sendrecv", streams: [local] })`. Then `negotiationneeded` sends the offer.
- **Callee** adds nothing up front. In `handleSignal`, between `setRemoteDescription(offer)` and `setLocalDescription()` (first offer only), run a `beforeAnswer(pc)` hook: for each transceiver set `direction = "sendrecv"`, call `sender.setStreams(local)`, `replaceTrack(mic)` on audio, and `replaceTrack(cam)` on video if the camera is on.
- `ontrack`: handle **per track kind**. Audio goes to the always-mounted `<audio>` (`new MediaStream([track])`), video to the remote `<video>`. Do not use "remote video track exists" as the Mode B signal (see below).

Verified in headless Chrome 153 (two local PCs, this session):
```
connected a=connected b=connected sigA=stable sigB=stable
b ontrack audio:streams=1 video:streams=1 | a ontrack audio:streams=1 video:streams=1
b video bytes before camera 0
b video bytes after camera 65341
negotiationneeded after replaceTrack: a=0 b=0
after replaceTrack(null): remote muted=false muteEvents=0
after restartIce a=connected
```
[VERIFIED: headless Chrome 153.0.8010.52 probe, scratchpad probe.mjs]. Consequences:
1. The callee gets a remote video track at setup with **0 bytes** while the caller's camera is off, so Mode B must be driven by the `call.media` camera flag **and** the first decoded frame (`loadeddata`/`resize`, `videoWidth > 0`).
2. Camera on/off and flip never renegotiate, so they cannot glare with an ICE restart.
3. `replaceTrack(null)` does not mute the remote track, so the camera-off state must be sent explicitly.

Safari supports `replaceTrack` (11+), `setStreams` (14.1+) and `restartIce` (14.1+) [VERIFIED: MDN browser-compat-data api/RTCRtpSender.json, api/RTCPeerConnection.json]. Runtime behaviour of a track-less video transceiver on iOS is [ASSUMED] and needs UAT.

### Pattern 4: Controls
- **Mute:** `micTrack.enabled = !muted`. No negotiation. Silence is sent and the mic indicator stays on. [ASSUMED: standard behaviour]
- **Camera on:** `getUserMedia({ video: { facingMode: current, width: { ideal: 1280 }, height: { ideal: 720 } } })` → `videoSender.replaceTrack(track)` → local PiP `srcObject` → send `call.media {camera:true}`. NotAllowedError → toast "duet can't use the camera." with "How to allow" (UI-SPEC §8); the call continues audio-only.
- **Camera off:** `videoSender.replaceTrack(null)`, then `track.stop()` (camera LED off), then `call.media {camera:false}`.
- **Resend** the current camera flag after every `call.accepted`, `call.rejoin`/`call.state` and `room.peer-joined`.
- **Hang up:** `call.end`, then close the peer, stop all tracks, release the wake lock, and stop the tones.

### Pattern 5: Flip camera (CALL-06)
```ts
// [ASSUMED] ordering; the fallback is VERIFIED necessary for headless tests
async function flip(s: CallSession) {
  const next = s.facing === "user" ? "environment" : "user"
  s.camTrack?.stop()                       // Android cannot open two cameras at once (NotReadableError) [ASSUMED]
  let track: MediaStreamTrack
  try {
    track = (await navigator.mediaDevices.getUserMedia({ video: { facingMode: { exact: next } } })).getVideoTracks()[0]
  } catch (e) {
    if ((e as DOMException).name !== "OverconstrainedError") throw e
    // Fake devices / some desktops have no facingMode: cycle videoinput deviceIds instead.
    const cams = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === "videoinput")
    const i = cams.findIndex((d) => d.deviceId === s.camDeviceId)
    track = (await navigator.mediaDevices.getUserMedia({ video: { deviceId: { exact: cams[(i + 1) % cams.length].deviceId } } })).getVideoTracks()[0]
  }
  await s.videoSender.replaceTrack(track)
  s.facing = (track.getSettings().facingMode as "user" | "environment" | undefined) ?? next  // mirror only "user"
}
```
Headless Chrome with `--use-fake-device-for-media-stream=device-count=2` exposes 2 `videoinput` devices, but `facingMode: {exact:"environment"}` throws `OverconstrainedError` [VERIFIED: headless probe "videoinputs 2 / environment exact failed OverconstrainedError"]. The deviceId fallback is what makes flip testable headlessly. On iOS, use `facingMode`, because device ids/labels can be empty [CITED: peerlist.io camera-switch write-up, MEDIUM]. WebKit has had regressions where `environment` returned the front camera (bug 252560, fixed) [CITED: bugs.webkit.org/show_bug.cgi?id=252560].

### Pattern 6: Ringing push + SW branch + tap routing (CALL-03, D-09, D-10, D-12)
- `PushPayload` today [VERIFIED: shared/src/push.ts:42-46 `export interface PushPayload { t: "chat" | "test"; title: string; body: string }`]. Extend `t` with `"call" | "call-missed"` and add optional `callId`, `kind`. Bodies per UI-SPEC §9: "📞 Incoming voice call" / "🎥 Incoming video call" / "📞 Missed voice call" / "🎥 Missed video call". Title = caller display name.
- TTL is a module constant today [VERIFIED: server/src/push/sender.ts:27 `const PUSH_TTL_SECONDS = 86_400`] and is applied in `sendOne` [VERIFIED: sender.ts:159-163 `TTL: PUSH_TTL_SECONDS, urgency: "high", timeout: PUSH_TIMEOUT_MS`]. Make TTL a `sendOne` parameter: **45** for incoming, the default for missed. Do **not** add a Topic header (Apple rejects it) [VERIFIED: sender.ts:22-26 comment, STATE.md 02-06].
- **Who gets the call push (D-11):** every subscription of the callee, **except sessions that currently have a visible, fresh WS connection** (they already show the in-app incoming screen; a heads-up notification on top would double-alert that phone). Push subscriptions are bound to `sessionId` and hub conns carry `sessionId` [VERIFIED: hub.ts:46 `sessionId: string`], so add `hub.isSessionViewing(sessionId)`. Do **not** reuse the per-user `isViewing`, which would silence the user's *other* phone. [ASSUMED: design recommendation; confirm it matches D-11's "every push subscription"]
- **SW (`web/public/sw.js`):** keep close-before-show [VERIFIED: sw.js:26-32]. For `t === "call"`, use `tag: "duet-call"` and `data: { url: "/?call=" + callId, callId }`. For `t === "call-missed"`, use `data: { url: "/?missed=" + callId }`. The current tag logic only knows test/chat [VERIFIED: sw.js:35 `tag: d.t === "test" ? "duet-test" : "duet-chat",`]. Keep the "only four listeners" rule.
- **notificationclick:** keep the existing focus + `postMessage` path [VERIFIED: sw.js:52-62], but post `{ t: "open-call", callId }` for call notifications, and `openWindow(data.url)` when there is no window. On iOS treat both as **hints only** (Pitfall 4). The authoritative path is ring-on-attach (Pattern 1).
- **Client:** on load read `?call=`/`?missed=` and `history.replaceState` it away. On the `open-call` message or param: `GET /api/calls/:id` (party-only). If `ringing`, the incoming screen shows anyway via `call.ring`. If `ended` with reason `no-answer`/`cancelled`, show the toast "Missed call from {peer}" + Call back (D-10). If unknown/answered, do nothing.

### Pattern 7: Reconnect (CALL-07, D-17)
1. **Triggers:** `pc.connectionState === "disconnected" | "failed"`, or the realtime socket closes. Status → "Reconnecting…". Start a single 30 s give-up timer (cleared when `connectionState === "connected"` again).
2. **ICE:** on `failed`, call `restartIce()` immediately (peer.ts already does this on `iceConnectionState === "failed"` [VERIFIED: web/lib/rtc/peer.ts:70-72]). On `disconnected` lasting more than ~2 s, the **caller** calls `restartIce()`. Per MDN, `restartIce()` fires `negotiationneeded`, the next offer restarts ICE on both ends, media continues meanwhile, and if signaling is not stable the request is remembered until it is [CITED: developer.mozilla.org/en-US/docs/Web/API/RTCPeerConnection/restartIce].
3. **WS:** `Realtime` already reconnects with 500 ms → 8 s backoff [VERIFIED: web/lib/chat/realtime.ts:7-8 `const BACKOFF_MIN_MS = 500` / `const BACKOFF_MAX_MS = 8000`] and pings on resume. On every hello while a call is live, send `call.rejoin {callId}`.
4. **Lost signals:** the hub relays `rtc.signal` only when another member is present and silently drops it otherwise [VERIFIED: hub.ts:174-175 `const other = otherMember(frame.room, connId)` / `if (other) sendTo(other, ...)`]. An offer sent while the peer was away is lost, and the caller then sits in `have-local-offer`, where `negotiationneeded` will not fire. Rule: when the caller sees the peer (re)join the room (`room.peer-joined`, or `room.joined` with a peer) during an active call and the PC is not `connected`: if `pc.signalingState === "have-local-offer"`, run `await pc.setLocalDescription({ type: "rollback" })`, then `pc.restartIce()`.
5. **Stale conn eviction (server):** see Pitfall 1.
6. **TURN creds:** minted with a 24 h TTL by default [VERIFIED: server/src/config.ts:48 `TURN_CREDENTIAL_TTL_SECONDS: z.coerce.number().int().min(60).max(172800).default(86400),`], so a restart inside one call can reuse the creds fetched at call start. No refresh is needed.
7. **iOS resume:** on `visibilitychange` → visible, if the local mic or camera track has `readyState === "ended"` (iOS capture interruption, for example after a phone call), re-acquire it with `getUserMedia` and `replaceTrack` [ASSUMED; WebKit has a history of muted/black capture after backgrounding, bugs 232599/230922 — CITED, MEDIUM].
8. **Give up:** after 30 s show "Call dropped" + Call back, and send `call.end` if the socket is live. The server's absent timer (35 s) ends the call if the client could not.

### Pattern 8: Wake lock, tones, vibration
```ts
// web/lib/call/wake-lock.ts [CITED: MDN Screen Wake Lock API]
let sentinel: WakeLockSentinel | null = null
async function acquire() { try { sentinel = await navigator.wakeLock?.request("screen") ?? null } catch { sentinel = null } }
document.addEventListener("visibilitychange", () => { if (active && document.visibilityState === "visible" && !sentinel) void acquire() })
// sentinel "release" event: set sentinel = null (the OS releases it when the page is hidden)
```
- Acquire on call start/accept (inside the tap) and on connect. Release on end. If the API is missing, do nothing (UI-SPEC default).
- **Tones:** create/resume the `AudioContext` inside the Start/Accept tap. For the callee's incoming ringtone **before** any tap, try `ctx.resume()` and accept failure (D-08 silent fallback). Chrome mobile allows sound autoplay when "the user has added the site to their home screen", and a pre-gesture `AudioContext` is created `suspended` [CITED: developer.chrome.com/blog/autoplay]. The installed Pixel PWA can therefore probably ring audibly. iOS cannot until a tap.
- **Vibrate:** `navigator.vibrate?.([800, 400])` on an interval. Since Chrome 60 it **requires a user gesture, otherwise it returns false**, and Safari has no support [VERIFIED: MDN browser-compat-data api/Navigator.json `vibrate`]. Vibration therefore only works when the user has already interacted with the open page. Treat it as best effort.

### Anti-Patterns to Avoid
- **Polite role from connId compare in real calls.** It flips after a WS reconnect and breaks collision handling. Use caller/callee.
- **Recreating the RTCPeerConnection on `room.peer-joined`** (what `/debug/call`'s `startPeer → dropPeer` does [VERIFIED: web/components/app/call-test.tsx:198-199]). In a real call a rejoin must keep the PC and ICE-restart it.
- **A second WebSocket for calls.** Ride the tab's single `Realtime` connection. The ring and the rejoin must use the socket that is reconnected and presence-tracked.
- **Mounting the remote `<audio>` inside the call Dialog.** `DialogContent` renders its own Portal [VERIFIED: web/components/ui/dialog.tsx `function DialogContent ... <DialogPortal>`], so minimizing unmounts it. Keep `<audio>` in `CallProvider` (UI-SPEC already says so). Re-attach `srcObject` to the videos via ref callbacks when the Dialog reopens.
- **Feature-detecting the speaker toggle with `'setSinkId' in HTMLMediaElement.prototype`.** It is true on iOS 18.4+ and in desktop Chrome, but no target phone can route earpiece/speaker (Pitfall 5).
- **Silent "stop ringing" pushes.** Not allowed (every push must show). Stop ringing over WS. The missed push is a visible replacement (D-12).
- **Logging SDP/candidates/ICE credentials.** The hub must keep the never-log rule [VERIFIED: hub.ts:20-22 "never logged, never stored (SDP and candidates carry IP addresses)"].

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Offer/answer collision, ICE restart races | caller/callee retries, custom glare logic | Existing MDN perfect negotiation in `peer.ts` + `restartIce()` | Already proven by the Phase 1 smoke (both sides click at once) [VERIFIED: scripts/smoke-call.mjs:97-98] |
| Camera toggle signaling via SDP | add/remove m-lines, munging | Pre-negotiated transceiver + `replaceTrack` | Verified to need no negotiation |
| TURN | coturn / HMAC creds | Existing Cloudflare mint (`/api/rtc/ice-servers`) | INFR-03 done |
| Ringtone assets | audio files + preload | WebAudio oscillator pattern | No asset, same autoplay rules |
| Call-UI kit / PiP drag library | — | Plain elements + pointer events + preset tokens (UI-SPEC) | Locked preset, no third-party UI |
| WebRTC wrappers (simple-peer, PeerJS) | — | Plain `RTCPeerConnection` | Phase 1 decision |
| Two-browser test plumbing | raw CDP | `playwright-core` contexts + fake media + `routeWebSocket` | Already in repo |

**Key insight:** almost every hard WebRTC problem here (glare, restart, relay) is already solved in Phase 1 code. The new complexity is **call lifecycle across devices and reconnects**, which belongs in one small, timer-injected, unit-tested server module.

## Common Pitfalls

### Pitfall 1: `room.full` on rejoin after a network switch
**What goes wrong:** The phone switches Wi-Fi → cellular. Its old TCP socket is half-open on the server, so it is still a room member until the heartbeat terminates it (up to ~2 × 25 s). The new connection's join hits capacity.
**Why:** `ROOM_CAPACITY = 2` and join refuses when `members.size >= ROOM_CAPACITY` [VERIFIED: hub.ts:15 `const ROOM_CAPACITY = 2`; hub.ts:108-110 `if (members.size >= ROOM_CAPACITY) { send(conn, { t: "room.full", room })`]. Signals are meanwhile relayed to the dead conn.
**How to avoid:** `call.rejoin` evicts the same user's previous member conn from `call-<id>` before joining the new one. Rooms are server-managed for calls.
**Warning signs:** "Reconnecting…" that never clears after a Wi-Fi/cellular handover while the other phone is fine.

### Pitfall 2: Lost offer leaves the caller stuck in `have-local-offer`
**What goes wrong:** An ICE-restart offer is sent while the callee's WS is down. The hub drops it, `negotiationneeded` never fires again, and the call never recovers.
**How to avoid:** Rollback + `restartIce()` when the peer re-joins (Pattern 7 step 4).
**Warning signs:** `pc.signalingState` remains `have-local-offer` after both sockets are back.

### Pitfall 3: Server ends a live call because a socket blinked
**What goes wrong:** Ending the call on any party `close` turns every WS blip into "Call dropped", even though P2P media survives a WS drop (Phase 1 Pitfall M8 noted this).
**How to avoid:** Use an absent-grace timer (35 s active) and end only on `call.end` or grace expiry.

### Pitfall 4: Relying on the push deep link / postMessage on iOS
**What goes wrong:** On iOS Home Screen apps, `openWindow(url)` often opens the app root instead of the URL, `navigate()` fails, and `postMessage` to an existing or just-opened client is unreliable. Reports run from iOS 16.4 to at least 17.3.1 [CITED: bugs.webkit.org 252544, 263687, 259212; developer.apple.com/forums/thread/733604 — MEDIUM].
**How to avoid:** The incoming screen is driven by the server's ring-on-attach (`call.ring` to every new callee connection while ringing). The deep link only improves the D-10 stale toast. If iOS drops it, the missed-call push (D-12) still informs the user.
**Warning signs:** On iPhone a tap opens the chat with no incoming screen. Check the server logs for `call.ring` sent on attach.

### Pitfall 5: The speaker toggle can't work on either phone (affects D-05 / UI-SPEC "Pixel 5 controls")
**What goes wrong:** `HTMLMediaElement.setSinkId` is **not available on Chrome Android** ("Not available due to a limitation in Android, see crbug 41276355"). Safari has it from 18.4 (iOS mirrors), but iOS enumerates no audio outputs. `MediaDevices.selectAudioOutput` is unsupported in Chrome and Safari [VERIFIED: MDN browser-compat-data api/HTMLMediaElement.json `setSinkId`, api/MediaDevices.json `selectAudioOutput`]. On iOS, capturing the mic routes playback to the earpiece (a voice-chat audio session), and it can stay there [CITED: bugs.webkit.org 230902, 295889 — MEDIUM]. Android browser calls generally play through the loudspeaker, with no web control [CITED: 3cx community thread — LOW].
**How to avoid:** Do not build a speaker toggle that would always be hidden. If it is kept, gate it on `setSinkId` **and** at least 2 distinct `audiooutput` devices after mic permission, so it is hidden on both phones. The UI-SPEC row "iPhone shows 4 controls, Pixel 5" becomes **4 on both**. REQUIREMENTS "Out of Scope" already lists "Speaker/earpiece toggle". **Needs user confirmation** (Open Question 1).
**Warning signs:** A toggle that changes `aria-pressed` but not the sound.

### Pitfall 6: Wake lock silently fails on older iOS Home Screen apps
**What goes wrong:** `navigator.wakeLock` exists on iOS 16.4–18.3 but "does not work in standalone Home Screen Web Apps". It is fixed from iOS 18.4 [VERIFIED: MDN browser-compat-data api/WakeLock.json `request` safari_ios: 16.4–18.4 partial, note "Does not work in standalone Home Screen Web Apps. See bug 254545"; 18.4 full].
**How to avoid:** Wrap the request in try/catch and re-acquire on `visibilitychange`. The UAT must record the iPhone's iOS version. Below 18.4, CALL-08 cannot pass on iPhone without a hack (a hidden looping video, which is not recommended).

### Pitfall 7: Treating "remote video track present" as "remote camera on"
**What goes wrong:** With pre-negotiated transceivers, the remote video track exists from setup and never mutes on `replaceTrack(null)` (verified). The screen would sit in Mode B showing black or a frozen frame.
**How to avoid:** Mode B = `peerCamera` flag (from `call.media`/`call.state`) **and** a decoded frame (`videoWidth > 0`).

### Pitfall 8: getUserMedia outside the tap, and repeated prompts on iOS
**What goes wrong:** iOS requires a user gesture and re-prompts often in standalone mode. Capture also stops on navigation [CITED: Phase 1 RESEARCH quirks table, WebKit 215884].
**How to avoid:** Call gUM first thing in the Voice/Video/Accept handlers, before any other `await`. Never change the route or hash during a call (the app is a single page, so keep it that way; stripping `?call=` uses `history.replaceState`, which is not a navigation). Map `NotAllowedError` to the permission drawer (UI-SPEC §8).

### Pitfall 9: Ringback/ringtone and the iOS audio session
**What goes wrong:** After mic capture, iOS routes WebAudio output to the earpiece (quiet ringback). Before a gesture, the AudioContext stays suspended.
**How to avoid:** Accept it (D-08 allows silence). Stop all tones the instant accept/end arrives. Create the caller's ringback context inside the Start tap. [ASSUMED: exact iOS volume/route for WebAudio during capture]

### Pitfall 10: Two notifications on the phone that is open
**What goes wrong:** The in-app incoming screen shows, and then the push heads-up arrives a second later.
**How to avoid:** Session-level push suppression (Pattern 6). Also call `clearNotifications()` (already exists [VERIFIED: web/lib/chat/push.ts:164-173]) when the incoming screen or the call ends.

## Code Examples

### Rollback + restart when the peer re-joins (caller side)
```ts
// Source: MDN restartIce semantics [CITED]; rollback is standard JSEP [ASSUMED wording]
async function onPeerRejoined(s: CallSession) {
  if (s.role !== "caller" || s.pc.connectionState === "connected") return
  if (s.pc.signalingState === "have-local-offer") await s.pc.setLocalDescription({ type: "rollback" })
  s.pc.restartIce() // -> negotiationneeded -> perfect-negotiation offer with ICE restart
}
```

### Poor-connection sample (extend stats.ts)
```ts
// inbound-rtp: packetsLost / packetsReceived deltas; RTT from the selected candidate pair (already in sampleCall)
// Badge on when 2 consecutive 2 s samples have loss > 5 % or rttMs > 400; off after 3 good samples (UI-SPEC §6)
```
`sampleCall` already returns `rttMs` from the selected pair, with a Safari fallback [VERIFIED: web/lib/rtc/stats.ts:33-53].

### Forced relay for tests
Read `localStorage.getItem("duet.forceRelay") === "1"` at call start and pass `forceRelay` to `createPeer`. `createPeer` already maps it to `iceTransportPolicy: "relay"` [VERIFIED: web/lib/rtc/peer.ts:26-29]. Playwright sets it with `context.addInitScript`. Expose the selected local candidate type as a `data-local-type` attribute on the call screen root (like the `/debug/call` testids) so E2E can assert `relay`.

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| `createOffer({iceRestart:true})` by hand | `pc.restartIce()` + `negotiationneeded` | Chrome 77 / Safari 14.1 [VERIFIED: MDN BCD] | Works with perfect negotiation |
| Wake lock broken in iOS Home Screen apps | Works from iOS 18.4 | iOS 18.4 [VERIFIED: MDN BCD] | CALL-08 depends on the iPhone's iOS version |
| `setSinkId` desktop-only | Safari 18.4 added it; Chrome Android still lacks it | Safari 18.4 [VERIFIED: MDN BCD] | No earpiece/speaker control on either phone |
| Playwright WS interception impossible | `page.routeWebSocket` | Playwright 1.48+ [VERIFIED: installed 1.62.1 types] | Headless WS-drop tests for CALL-07 |

**Deprecated/outdated:** CLAUDE.md SFU/`@sideby-me/rtc`/mediasoup/coturn material (historical, D-16).

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | Excluding sessions that are visibly viewing from the call push matches D-11's intent ("every push subscription") | Pattern 6 | Low: worst case, double alerts on the open phone. Easy to flip to "push all" |
| A2 | A track-less pre-negotiated video transceiver + later `replaceTrack` works on iOS Safari like it does in Chrome | Pattern 3 | Medium: if iOS misbehaves, fall back to D-03's literal path (`addTrack` + renegotiation via perfect negotiation) for the camera-on case |
| A3 | Android Chrome cannot open two cameras at once, so stop-before-get for flip | Pattern 5 | Low: stop-before-get also works where two cameras could open, at the cost of a ~300 ms remote freeze |
| A4 | iOS ends or mutes capture tracks after backgrounding/interruption; re-acquiring on resume fixes it | Pattern 7 | Medium: device UAT D-18 covers it; worst case "Call dropped" + Call back |
| A5 | iOS routes WebAudio to the earpiece during capture (quiet ringback); Android plays calls on the loudspeaker | Pitfalls 5, 9 | Low: cosmetic |
| A6 | Caller grace while ringing ≈10 s and active-call absent grace 35 s are acceptable | Pattern 1 | Low: tunable constants |
| A7 | Busy (another device of a user already in the call starts a call) can be answered with `call.ended {busy}` and shown with existing copy (for example "No answer") | Pattern 1 | Low: rare edge; UI-SPEC has no "Busy" copy (Open Question 3) |
| A8 | Installed Pixel PWA: AudioContext ringtone may start without a gesture (home-screen autoplay rule) | Pattern 8 | Low: D-08 allows silence |
| A9 | The iPhone runs iOS ≥ 18.4 (needed for Wake Lock in standalone) | Pitfall 6 | Medium: CALL-08 fails on iPhone otherwise |

## Open Questions

1. **Speaker toggle (D-05) on the Pixel.**
   - What we know: `setSinkId` is not available on Chrome Android, and iOS lists no outputs. No web API on either phone picks earpiece vs speaker. REQUIREMENTS "Out of Scope" already excludes the toggle.
   - What's unclear: whether the user wants the (hidden-everywhere) control built at all.
   - Recommendation: do not build it. Record D-05 as "hidden on both phones (no supporting API)". Confirm at plan-check or in the end-of-phase UAT.
2. **D-03 mechanism wording.** The recommendation is `replaceTrack` on a pre-negotiated transceiver instead of renegotiation per toggle. Same UX, single code path. The planner should note this as the implementation of D-03.
3. **Busy copy.** When a user's second device starts a call while the first device is in one, which copy shows? Recommend reusing "No answer" or a toast "You're already in a call" (needs UI-SPEC sign-off). This is extremely rare with two people.
4. **iPhone iOS version** (Wake Lock ≥ 18.4). Ask the user during UAT. It affects CALL-08 only.
5. **`/debug/call`:** keep it (diagnostics). Only the `call-` room prefix is reserved. The menu item stays as "Call test".

## Environment Availability

| Dependency | Required By | Available | Version | Fallback |
|------------|------------|-----------|---------|----------|
| Google Chrome (headless E2E) | `scripts/smoke-calls.mjs` | ✓ | 153.0.8010.52 | `CHROME=` another Chromium |
| playwright-core | E2E | ✓ | 1.62.1 | — |
| Node (local dev/tests) | vitest, scripts | ✓ | v22.23.1 locally; container is Node 24 | — |
| Cloudflare TURN key in `.env` | Real-TURN E2E + calls | ✓ (Phase 1 smoke + live container healthy) | — | none (calls need it) |
| Docker / running `duet` container | Deploy + device UAT | ✓ | `duet-duet-1 Up (healthy)`, `duet-cloudflared-1 Up` | — |
| VAPID keys | Call push | ✓ (Phase 2 push live, `push_config configured true` per STATE 02-04) | — | — |
| Two real phones (iPhone PWA, Pixel PWA), one on cellular | Push-to-answer, iOS audio/wake-lock/background, cellular relay | human-only | — | none: end-of-phase UAT (`human_verify_mode: end-of-phase`) |

**Missing dependencies with no fallback:** none for building. Device-only behaviours (push on a closed app, iOS audio route, wake lock, background) can only be verified by the user on the phones.

## Validation Architecture

Skipped: `workflow.nyquist_validation` is `false` in `.planning/config.json`. A short test map for the planner anyway:
- **Server (vitest + injectWS):** registry state machine with short injected timers (invite → ring on all callee conns + push payload `t:"call"`, TTL 45, urgency high; accept first-wins + stop-ringing; decline; cancel → missed push; timeout → `no-answer` + missed push; glare merge; busy; ring-on-attach; rejoin evicts the stale conn; absent-grace end; `room.join` of `call-*` → `room_reserved`; `GET /api/calls/:id` party-only, 404 for others). SW vm test (existing `server/test/sw.test.ts` harness): call push tag/data, notificationclick posts `open-call` / opens `/?call=`.
- **Browser E2E (`scripts/smoke-calls.sh` modelled on `smoke-call.sh`, real TURN, two fixture accounts):** A taps "Voice call" → B's incoming dialog → Accept → both show the timer and inbound audio bytes grow. A turns the camera on → B enters Mode B. Flip works (launch with `--use-fake-device-for-media-stream=device-count=2`). Mute. Hang up → "Call ended". Decline → "Declined". Forced relay (`duet.forceRelay=1`) → `data-local-type="relay"` on both. CALL-07: `page.routeWebSocket('/ws', …)` closes A's socket mid-call → "Reconnecting…" → timer returns, and a scripted `restartIce` keeps media flowing. The no-answer path uses a server env override for the ring timeout in the smoke only, or simply waits 46 s.
- **Device UAT (human):** iPhone app closed → push → tap → incoming → accept, both directions. Cellular ↔ Wi-Fi. Airplane mode for 5 s mid-call → recovers. Screen stays on through a 3-minute call. Lock the iPhone for 10 s → resumes. Flip on both phones. Permission-denied drawers.

## Security Domain

### Applicable ASVS Categories (level 1)

| ASVS Category | Applies | Standard Control |
|---------------|---------|-----------------|
| V2 Authentication | yes (inherited) | `/ws` already requires a session (`requireUserNoRenew`) + Origin check [VERIFIED: server/src/ws/routes.ts:19]. `GET /api/calls/:id` uses `requireUser` |
| V3 Session Management | yes (inherited) | Logout closes the session's sockets (existing). The registry must treat a closed conn like any close (absent grace) |
| V4 Access Control | **yes** | Only call parties may accept/decline/end/rejoin/media. Only the callee may accept/decline. `call-*` rooms are server-managed (client join refused). `GET /api/calls/:id` returns 404 unless the session user is a party |
| V5 Input Validation | yes | zod strict client frames (`callId` = `z.uuid()`, `kind` enum, `camera` boolean); existing `WS_MAX_PAYLOAD` and 100 frames/s limits |
| V6 Cryptography | no new crypto | TURN creds minted by Cloudflare (existing). VAPID via web-push |
| V7 Error/Logging | yes | Log `evt` + callId + userIds + reasons only. Never SDP, candidates, ICE creds or push endpoints (existing rules) |

### Known Threat Patterns

| Pattern | STRIDE | Standard Mitigation |
|---------|--------|---------------------|
| Joining/eavesdropping a call room by name | Information disclosure | Reserve the `call-` prefix and do server-side joins only |
| Spoofed accept/end from a non-party conn | Tampering / Spoofing | Registry checks the sender's userId against callerId/calleeId and its connId against the bound conn |
| Invite→cancel loop to spam pushes | DoS | One current call system-wide, plus an invite rate limit (for example ≤ 10 invites/min per user), plus the existing frame rate limit |
| Unbounded timers/memory | DoS | Single `current` call. `recent` map capped (for example 50 entries / 10 min) |
| Call id guessing for the status endpoint | Information disclosure | Party-only check, and uuid ids |
| IP leakage via logs | Information disclosure | Keep the hub's never-log SDP/candidates rule |

## Sources

### Primary (HIGH confidence)
- Codebase, read this session: `web/lib/rtc/{peer,stats,ice}.ts`, `shared/src/{ws,push,rtc}.ts`, `server/src/ws/{hub,routes}.ts`, `server/src/rtc/{routes,turn}.ts`, `server/src/push/{sender,routes}.ts`, `server/src/app.ts`, `server/src/config.ts`, `web/lib/ws.ts`, `web/lib/chat/{realtime,push}.ts`, `web/components/app/{shell,call-test}.tsx`, `web/components/ui/dialog.tsx`, `web/public/sw.js`, `scripts/smoke-call.{sh,mjs}`, `scripts/lib/e2e.mjs`, `server/test/{helpers,ws,sw}.test.ts`
- MDN browser-compat-data (raw GitHub JSON, fetched this session): `api/HTMLMediaElement.json` (setSinkId), `api/WakeLock.json`, `api/Navigator.json` (vibrate, wakeLock, audioSession), `api/MediaDevices.json` (selectAudioOutput), `api/RTCPeerConnection.json` (restartIce), `api/RTCRtpSender.json` (replaceTrack, setStreams), `api/AudioContext.json`
- Headless Chrome 153 probe (this session): transceiver setup, replaceTrack without negotiation, no remote mute on replaceTrack(null), fake device-count=2 with no facingMode, restartIce
- https://developer.mozilla.org/en-US/docs/Web/API/RTCPeerConnection/restartIce
- https://developer.mozilla.org/en-US/docs/Web/API/WebRTC_API/Perfect_negotiation
- https://developer.chrome.com/blog/autoplay

### Secondary (MEDIUM confidence)
- WebKit bugs: https://bugs.webkit.org/show_bug.cgi?id=254545 (wake lock in Home Screen apps), https://bugs.webkit.org/show_bug.cgi?id=230902 and https://bugs.webkit.org/show_bug.cgi?id=295889 (earpiece routing with gUM), https://bugs.webkit.org/show_bug.cgi?id=252544, https://bugs.webkit.org/show_bug.cgi?id=263687, https://onbugs.webkit.org/show_bug.cgi?id=259212 (notificationclick openWindow/postMessage/navigate), https://bugs.webkit.org/show_bug.cgi?id=232599, https://bugs.webkit.org/show_bug.cgi?id=230922 (capture after backgrounding), https://bugs.webkit.org/show_bug.cgi?id=252560 (facingMode environment regression), https://bugs.webkit.org/show_bug.cgi?id=179363 (replaceTrack camera switch)
- https://developer.apple.com/forums/thread/733604 (PWA push tap URL on iOS)
- https://developer.chrome.com/blog/media-devices/ (enumerateDevices/setSinkId)

### Tertiary (LOW confidence)
- https://www.3cx.com/community/threads/how-to-set-audio-out-on-earpiece-instead-of-speaker-on-mobile-device-live-talk.69476/ (Android browser calls on loudspeaker)
- https://peerlist.io/priyangsu/articles/solving-camera-switch-in-mobile-browsers-a-unified-approach- (facingMode toggling on iOS)
- Chromium fake capture `device-count` option: https://codereview.chromium.org/2715513008 (confirmed by the probe)

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH. No new packages; every seam was read.
- Architecture (registry, frames, transceiver/replaceTrack design): HIGH for Chrome (verified probe), MEDIUM for iOS runtime.
- Pitfalls: HIGH for setSinkId, wake lock and vibrate (MDN BCD), and for room capacity and signal drops (code read). MEDIUM for iOS push-tap and audio routing (bug trackers).

**Research date:** 2026-10-16
**Valid until:** 2026-11-15 (browser support moves; re-check the iOS version on the user's iPhone)
