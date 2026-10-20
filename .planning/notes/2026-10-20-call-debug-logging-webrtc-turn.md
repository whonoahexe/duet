---
date: "2026-10-20 02:47"
promoted: true
---

Call debug logging (WebRTC + TURN, no personal data). Observed: 2026-10-20 00:18–00:25 IST, three calls in 8 min each ended in "hangup" + immediate redial; Pixel (Noah) WS dropped 1001 mid-call 1 and 1006 after call 2. Server logs couldn't say who hung up or whether media was P2P vs relayed, or when ICE failed. Want: Server — log which side sent each call signal and who ended the call; timing of each setup step; TURN cred TTL + mint latency; each party's WS presence during the call. Client (batched to server) — connection/ICE/signaling state changes; selected candidate pair type (host/srflx/relay) + protocol (udp/tcp/tls); getStats sampled every few seconds (RTT, loss, jitter, bitrate, fps); mute/camera toggles, device switches, visibility/background/foreground; getUserMedia permission errors; browser+OS version. Off limits: no IP addresses (strip from candidates, keep type+protocol), no message content or names (user IDs only), no SDP text, no TURN credentials. Output: all entries share one callId so a full call is one grep.
