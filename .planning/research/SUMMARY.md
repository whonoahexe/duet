# Project Research Summary

**Project:** duet
**Domain:** Self-hosted private 2-user chat PWA with 1:1 voice/video calls over an existing mediasoup SFU
**Researched:** 2026-10-08
**Confidence:** MEDIUM overall. Stack and architecture are HIGH; infra is blocked and iOS behavior on the real devices is unverified.

> **User decisions made after research (2026-10-08). These supersede the open questions below:**
> - **Domain:** move to a **different domain** (not sideby.me). Exact domain TBD.
> - **SFU host:** run SFU + coturn **on this machine** (Option B). This requires router UDP port-forwards and a non-CGNAT public IPv4, which Phase 1 must verify first.
> - **Ingress:** **Cloudflare Tunnel** for the duet app (HTTPS/WSS). The user accepts that Cloudflare sees app traffic in transit. The tunnel cannot carry SFU UDP media, so the SFU/TURN need direct exposure.

## Executive Summary

duet is a private two-person messenger: a WhatsApp-lite PWA for one iPhone and one Pixel, with calls going through the owner's mediasoup SFU. At this scale the right design is deliberately boring:
- **One Node process (Fastify)** serves a static Next.js export, a REST API, a WebSocket hub, auth-gated media files, and web push.
- **Storage** is a single SQLite file plus a disk volume.
- **Calls** go straight from the browser to the SFU. duet's server only mints HS256 join tokens and tracks call state. It never proxies media and never calls the SFU admin API.

Two infra blockers have to be cleared before any code ships, so they are a day-one gate:
1. **`sideby.me` expired on 2026-08-20** and is in its redemption period (NXDOMAIN). Every HTTPS origin depends on a domain: PWA install, push, WSS and getUserMedia. → User chose a new domain.
2. **The SFU isn't running anywhere reachable.** It's not on this machine, and GCP VM-B times out. Its media gates have never been proven. → User chose to run it on this machine.

Chat, auth, push and rich media don't need the SFU, so they ship first. Calls come last, gated on "media plane green".

## Key Findings

### Recommended Stack

One Node 24 container (`node:24-bookworm-slim`) plus a `/data` disk volume. Versions were checked against npm on 2026-10-08.

**Core technologies:**
- **shadcn 4.21.4 preset `b51GFhBEQ`** (`npx shadcn@4.21.4 init -t next -p b51GFhBEQ`). Brings Next 16.3.6, React 19.3, **Base UI** (not Radix), Tailwind v4, **Phosphor** icons (not lucide) and Space Grotesk. Add components only via `npx shadcn add`.
- **Next.js `output: 'export'`** as a static SPA. No Server Actions, no custom server, no `next/image` loader.
- **Fastify 5.12 + @fastify/websocket** in one process for `/api`, `/ws`, `/media` (Range requests via @fastify/static) and the static UI. Raw `ws` with zod-typed JSON; no Socket.IO.
- **SQLite (WAL) + better-sqlite3 + Drizzle.** No Postgres, Redis or MinIO.
- **Hand-rolled auth:** @node-rs/argon2 (argon2id), otplib **v13** (new functional API), an opaque session cookie, and CLI seed/reset scripts.
- **web-push (VAPID)** plus a hand-written `sw.js` of about 60 lines. No Serwist.
- **@sideby-me/rtc 0.9.0**, which wraps **mediasoup-client 3.20.0** (exact pin), plus `jose` to mint HS256 join tokens. The SDK lives in a private GitHub Packages registry, so the build needs `NODE_AUTH_TOKEN` with `read:packages`.
- **TanStack Query** for history and cache, patched by WebSocket events. **zod 4** schemas shared between client and server.
- **Server-side ffmpeg** to transcode video to H.264 MP4 with a poster frame, and to normalize voice notes to AAC.

### Expected Features

**Must have (v1):**
- **Auth:** password + TOTP for the two seeded accounts, rolling sessions, CLI resets.
- **PWA shell:** manifest, service worker, safe areas, and iOS onboarding for Add to Home Screen and notifications, with a test-push button.
- **Reliable text chat:**
  - Optimistic send, with a client-generated ID so retries never duplicate.
  - An outbox that retries failed sends.
  - Message states: sending, sent, read, failed.
  - Reconnect with a catch-up cursor, history pagination, a connection banner, and drafts.
- **Chat extras:** typing indicator, read receipts, a fixed set of 6 emoji reactions, reply-quote, soft delete.
- **Media:**
  - Images: downscaled on the device, with a viewer.
  - Video clips: transcoded on the server.
  - Voice notes: normalized to AAC, with a scrubber and playback speed.
- **Message push:** suppressed while the app is in the foreground, collapsed by tag, with an iOS badge.
- **Voice and video calls:**
  - A call state machine on the server, with ringback and a timeout.
  - Push-to-answer: the app checks for a ringing call whenever it opens.
  - In-call controls: mute, camera on/off, camera flip, end.
  - A reconnecting state, a call log, and a missed-call push.

**Should have (v1.x):** shared media gallery, message search (SQLite FTS5), a days-together counter, a "thinking of you" nudge, and presence.

**Defer / anti-features:**
- A "delivered" tick.
- A speaker/earpiece toggle (iOS can't control audio output).
- Action buttons on notifications.
- Link previews (server-side fetching is an SSRF risk).
- GIF search APIs and a custom emoji picker.
- An offline-first sync database.
- ffmpeg.wasm.
- Themes (they would break the preset).
- An admin UI.
- Upgrading a voice call to video mid-call.

### Architecture Approach

- **One server process** holds an in-memory hub. Clients **write over HTTP and are notified over WebSocket**, with a **single monotonic change cursor** for catch-up after a reconnect.
- **Call state lives on the server; media goes browser-to-SFU.** The server mints a fresh `mediaRoomId` for every call.
- **Push is sent only when the recipient isn't in the foreground**, based on the visibility state each client reports over the WebSocket.

**Major components:**
1. `web/`: static Next export with the preset UI, TanStack Query, the service worker and the rtc SDK.
2. `server/`: Fastify modules for auth, messages, hub, uploads/media, push, calls and sfu-token. Shared zod schemas live in `shared/`.
3. `/data`: `duet.sqlite` plus `media/`, with backups (SQLite `.backup` plus rsync).
4. Ingress: a dedicated `cloudflared` tunnel `duet` → `127.0.0.1:3100`.
5. External: SFU + coturn (on this machine, with direct UDP exposure) and the browser push services.

### Critical Pitfalls

1. **Domain expired and SFU not live.** Set up the new domain and bring the SFU up on this machine. Pass both media gates from the README over cellular before building any call UI.
2. **iOS calls are fragile:**
   - Rejoining after the app is suspended fails with `participant_already_active`, so mint a new participant ID on every attempt.
   - Backgrounding the app kills the call.
   - Autoplay rules block remote audio unless playback starts from the accept tap.
   - VP8/H264 codec choice and TURN credential expiry mid-call both need handling.
3. **TURN on port 443 only works over `turns:` (TLS).** Verify `relay` candidates on cellular. The SFU config may need a patch to also advertise `turn:` on 3478.
4. **iOS push silently dying:**
   - Every push must call `showNotification`, or iOS revokes the subscription.
   - Push only works once the app is installed to the home screen.
   - Tapping a notification from a cold start can lose the deep link, so the app checks for a ringing call on open.
5. **Media format mismatch.** iOS produces HEIC photos, HEVC `.MOV` clips and `audio/mp4` voice notes; Chrome produces webm/opus. Normalize on the server, serve with Range (206) behind auth, and never let the service worker cache auth, `/ws` or media responses.

Also:
- **Preset drift:** no lucide or Radix snippets.
- **TOTP self-lockout:** provide recovery codes and a CLI reset.
- **WebSockets that look connected but are dead after resume:** add a heartbeat shorter than Cloudflare's ~100 s idle limit, and reconnect on `visibilitychange`.

## Implications for Roadmap

Coarse granularity: 4 phases, plus a parallel ops track that gates Phase 4.

### Phase 1: Infra + Foundation + Auth + Installable PWA
**Rationale:** PWA install, service worker, push and getUserMedia all need a real HTTPS origin, and iOS behavior can only be verified with the app installed. Deploying first de-risks everything that follows.
**Delivers:**
- The new domain on Cloudflare, plus the Cloudflare Tunnel.
- A repo built from the exact shadcn preset scaffold.
- Fastify + SQLite + Drizzle.
- Two seeded users with argon2id, TOTP, recovery codes and a CLI reset.
- The static export served by Fastify, with a manifest and service worker, installable on both phones.
- A backup job.

**Parallel ops track (user-gated):**
- Verify the home connection has a public IPv4 that isn't behind CGNAT.
- Deploy SFU + coturn on this machine with host networking and the right announced/listen IPs, plus router UDP port-forwards.
- Write a smoke harness: mint a token, publish and consume with @sideby-me/rtc, and log `bytesReceived`.
- Pass both README gates from cellular.

### Phase 2: Realtime Chat + Web Push
**Rationale:** This is the core value, and push has to exist before calls because calls ring via push.
**Delivers:**
- Messages API, hub, catch-up cursor and outbox.
- Typing, read receipts, reactions, replies and delete.
- VAPID subscription and onboarding, message push, deep link from `notificationclick`, badge, and foreground suppression.

### Phase 3: Rich Media Messages
**Rationale:** Independent of the SFU, so it fills the schedule while the ops track may still be red.
**Delivers:**
- Uploads with a progress indicator.
- Private `/media` served with Range support.
- Images, with downscaling and a viewer.
- Video clips: ffmpeg transcode to H.264 MP4 with a poster frame, plus size caps.
- Voice notes: recorded, normalized to AAC, with a scrubber.

### Phase 4: Calls + Hardening (requires ops track GREEN)
**Delivers:**
- The calls table, state machine and timers.
- HS256 token minting, with a fresh `mediaRoomId` per call.
- @sideby-me/rtc integration.
- Ring push, plus accept, decline, cancel, missed and end.
- Call-log messages in the chat and in-call controls.
- Wake lock and reconnect handling.
- Hardening: rate limits, a cellular/relay test matrix, disk alerts, and a restore drill.

### Research Flags
- **Ops track / Phase 1 infra:** CGNAT status, SFU deploy on this host (announced vs listen IP, UDP port ranges), and why the media gates never passed.
- **Phase 2 (push):** current iOS PWA push behavior, Declarative Web Push, and cold-start deep-link behavior.
- **Phase 4:** the @sideby-me/rtc API, handling `participant_already_active`, and the iOS audio session.
- **Phase 3 (light):** voice note format strategy.

## Confidence Assessment

| Area | Confidence | Notes |
|------|------------|-------|
| Stack | HIGH | npm-verified; preset scaffold was actually run; SFU contract read from source |
| Features | MEDIUM-HIGH | Competitor analysis plus iOS platform docs |
| Architecture | HIGH | Simple, well-known patterns; infra checked with direct probes |
| Pitfalls | MEDIUM | iOS media/push behavior from docs and reports, not yet tested on the devices |

### Gaps to Address
- The exact new domain name.
- CGNAT / public IPv4 on the home connection, which is now critical because the SFU runs at home.
- A GitHub Packages token so the build can install `@sideby-me/rtc`.
- iOS behavior on the real device, to be checked in each phase's UAT.

## Sources

- npm registry (2026-10-08); a real `shadcn init -p b51GFhBEQ` scaffold run
- `sideby-me/sfu.sideby.me` v0.9.3 and `sideby-me/rtc.sideby.me` source
- Direct probes on this host: `docker ps`, `ss`, whois, DoH, TCP probes to VM-B, `~/sideby-staging` compose, `~/.cloudflared`
- Next.js 16 docs; WebKit/Apple docs and community reports; Cloudflare Tunnel and Tailscale docs

---
*Research completed: 2026-10-08*
*Ready for roadmap: yes*
