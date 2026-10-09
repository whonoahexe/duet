# duet

## What This Is

A private, self-hosted chat app for exactly two people — the owner and their girlfriend. Text chat, images, short video clips, voice notes, and 1:1 voice/video calls, delivered as an installable PWA on an iPhone and a Pixel. Calls are peer-to-peer WebRTC, relayed through Cloudflare TURN when a direct path fails (switched from the self-hosted SFU on 2026-10-09 because the home connection is CGNAT); everything else runs on the same machine.

## Core Value

The two of us can reliably message and call each other — on both phones, including over cellular — on infrastructure we fully control.

## Requirements

### Validated

(None yet — ship to validate)

### Active

- [ ] Exactly two fixed accounts; log in with a password (tap your name); no public sign-up
- [ ] Installable PWA on iOS (Safari, 16.4+) and Android (Chrome)
- [ ] Real-time 1:1 text chat with persistent history (kept forever)
- [ ] Send images (kept forever, normal history)
- [ ] Send short video clips
- [ ] Record and send voice notes
- [ ] Read receipts and typing indicator
- [ ] Emoji reactions and reply-to-message
- [ ] 1:1 voice calls (peer-to-peer WebRTC)
- [ ] 1:1 video calls (peer-to-peer WebRTC)
- [ ] Incoming call / new message delivered as a web push notification; tapping opens the app into the call/chat
- [ ] Calls work over cellular (Cloudflare TURN relay)

### Out of Scope

- End-to-end encryption / client-side crypto — user chose "private & self-hosted"; TLS + self-hosting is the bar
- View-once / disappearing / screenshot-blocking media — images are normal, kept forever
- Native apps / CallKit full-screen ringing — push-to-answer is acceptable; native wrapper adds days
- Group chats, more than two users, sign-up flows — the user base is exactly two people forever
- Third-party hosting of data (Vercel, managed DB/Blob) — everything lives on the owner's machine
- Any UI deviation from the locked shadcn preset

## Context

- **Existing SFU:** `https://github.com/sideby-me/sfu.sideby.me` — product-agnostic mediasoup SFU + self-hosted coturn behind an nginx SNI router on `:443`. Operates on generic rooms/participants keyed by opaque IDs. Clients join with **HS256 join tokens** (`JoinSchema`); rooms are provisioned server-to-server via an admin surface authenticated with `X-Sfu-Secret`. Signaling is raw `ws` over WSS. duet's backend must therefore mint join tokens and provision rooms — the SFU knows nothing about duet users.
- User says the SFU runs on this machine; at init time `docker ps` showed only `sideby-staging` sync/lens/redis containers, so SFU reachability/deploy location must be confirmed early (README documents it on GCP VM-B).
- Client-side mediasoup consumption needs `mediasoup-client` and the SFU's signaling protocol.
- iOS PWA constraints: push only when installed to home screen (16.4+); no background ringing; camera/mic permission prompts per session quirks.
- **Infra state at init (2026-10-08):** `sideby.me` expired 2026-08-20 (redemption, NXDOMAIN); SFU not running anywhere reachable. Both are Phase 1 blockers for calls. Research found duet only needs `SFU_TOKEN_SECRET` to mint HS256 join tokens (rooms auto-create on join), and the owner's private `@sideby-me/rtc` 0.9.0 SDK (GitHub Packages; needs `read:packages` token at build) handles the client handshake.
- Scale: 2 users. No need for horizontal scaling, queues, or multi-tenant concerns.

## Constraints

- **UI**: shadcn preset `b51GFhBEQ` (`https://ui.shadcn.com/create?preset=b51GFhBEQ`) — locked, no deviation whatsoever. Init via `npx shadcn create --preset b51GFhBEQ` (or equivalent) and only use its components/tokens.
- **Timeline**: Fast — user does not want this to drag on for days. Prefer the simplest thing that works.
- **Hosting**: Self-hosted on this machine (Docker). Database + media files on local disk.
- **Platforms**: iPhone (Safari PWA) and Pixel (Chrome PWA).
- **Media plane**: 1:1 peer-to-peer WebRTC (DTLS-SRTP, end-to-end encrypted between the phones) with Cloudflare TURN as the relay; short-lived TURN credentials minted by the duet server. No SFU. (Revised 2026-10-09; the previous "must use the existing SFU + coturn" constraint was reversed by the user after CGNAT was confirmed.)
- **Transport security**: HTTPS/WSS everywhere (required for PWA install, push, getUserMedia).

## Key Decisions

| Decision | Rationale | Outcome |
|----------|-----------|---------|
| Installable PWA (Next.js) over native/Capacitor | Fastest; one codebase; reuses shadcn preset directly; push works on iOS 16.4+ | — Pending |
| Private & self-hosted, no E2EE | User's chosen security bar; avoids key-management and SFU insertable-streams work | — Pending |
| Password-only login (TOTP dropped 2026-10-08), two seeded accounts | User's choice in Phase 1 discussion; argon2id + rate limit compensate; no sign-up surface | — Pending |
| Push-to-answer for incoming calls | Avoids native CallKit; user accepted | — Pending |
| Self-host app + DB + media on this machine | Keeps data off third parties | — Pending |
| New domain (not sideby.me) for duet + SFU/TURN | sideby.me expired 2026-08-20 (redemption); user chose brkn.me (portfolio domain, on Cloudflare): duet.brkn.me (tunnel), sfu./turn.brkn.me (DNS-only) | — Pending |
| Run SFU + coturn on this machine | User choice; GCP VM-B is down. Requires UDP port-forwards + a non-CGNAT public IP — verify first | ✗ Reversed 2026-10-09: home is CGNAT (outer router PPPoE WAN 172.18.28.128, egress 103.198.98.196, no public IPv6) |
| P2P WebRTC + Cloudflare TURN instead of an SFU (2026-10-09) | Two people only, so an SFU adds nothing; no VPS/router/cert ops; media E2E-encrypted between phones; existing Cloudflare account/token can manage TURN keys (verified). Trade-off: drops the @sideby-me/rtc SDK, so signaling and ICE-restart are hand-written over duet's WS; TURN is a third party but only relays encrypted packets | — Pending |
| Cloudflare Tunnel for duet app ingress (HTTPS/WSS) | Matches existing staging setup; no port-forward for the app. Accepted: Cloudflare sees app traffic in transit. Tunnel cannot carry SFU UDP media | — Pending |

## Evolution

This document evolves at phase transitions and milestone boundaries.

**After each phase transition** (via `/gsd-transition`):
1. Requirements invalidated? → Move to Out of Scope with reason
2. Requirements validated? → Move to Validated with phase reference
3. New requirements emerged? → Add to Active
4. Decisions to log? → Add to Key Decisions
5. "What This Is" still accurate? → Update if drifted

**After each milestone** (via `/gsd-complete-milestone`):
1. Full review of all sections
2. Core Value check — still the right priority?
3. Audit Out of Scope — reasons still valid?
4. Update Context with current state

---
*Last updated: 2026-10-08 after initialization*
