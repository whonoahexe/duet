---
created: 2026-10-20T12:09:13.550Z
title: Add call debug logging (WebRTC + TURN, no personal data)
area: calls
severity: major
order: 2
files:
  - server/src/calls/registry.ts
  - web/lib/call/store.ts
  - web/lib/call/session.ts
notes:
  - .planning/notes/2026-10-20-call-debug-logging-webrtc-turn.md
---

## Problem

On 2026-10-20 00:18–00:25 IST three calls in 8 minutes each ended in "hangup" followed by an immediate redial, and the Pixel's WS dropped (1001 mid-call 1, 1006 after call 2). Server logs only record signaling (call_invite/accept/end with reason + duration), so we can't tell who hung up, whether media was P2P or relayed, or when/why ICE failed. Everything client-side (connection state, candidate types, stats) is invisible.

## Solution

See the note for the full list. Server: log which side sent each call frame and who ended the call; timing of each setup step; TURN cred TTL + mint latency; each party's WS presence during the call. Client, batched to a server endpoint: pc connection/ICE/signaling state changes; selected candidate pair type (host/srflx/relay) + protocol (udp/tcp/tls); getStats every few seconds (RTT, loss, jitter, bitrate, fps); mute/camera toggles, device switches, visibility/background/foreground; getUserMedia errors; browser + OS version. Off limits: IP addresses (strip from candidates, keep type + protocol), message content, names (user ids only), SDP text, TURN credentials. All entries share the callId so one grep shows a whole call.
