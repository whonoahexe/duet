# duet

## What This Is

A private, self-hosted chat app for exactly two people — the owner and their girlfriend. Text chat, images, short video clips, voice notes, and 1:1 voice/video calls, delivered as an installable PWA on an iPhone and a Pixel. Calls are peer-to-peer WebRTC, relayed through Cloudflare TURN when a direct path fails (switched from the self-hosted SFU on 2026-10-09 because the home connection is CGNAT); everything else runs on the same machine.

## Core Value

The two of us can reliably message and call each other — on both phones, including over cellular — on infrastructure we fully control.

## Requirements

### Validated

- ✓ Exactly two fixed accounts; log in with a password (tap your name); no public sign-up — v1.0
- ✓ Installable PWA on iOS (Safari, 16.4+) and Android (Chrome) — v1.0
- ✓ Real-time 1:1 text chat with persistent history (kept forever) — v1.0
- ✓ Send images (kept forever, normal history) — v1.0
- ✓ Send short video clips — v1.0
- ✓ Record and send voice notes — v1.0
- ✓ Read receipts and typing indicator — v1.0
- ✓ Emoji reactions and reply-to-message — v1.0
- ✓ New-message web push on iPhone and Pixel; tapping opens the chat — v1.0
- ✓ 1:1 voice calls (peer-to-peer WebRTC) — v1.0
- ✓ 1:1 video calls (peer-to-peer WebRTC) — v1.0
- ✓ Incoming call delivered as a web push notification; tapping opens the app into the call — v1.0
- ✓ Calls work over cellular (Cloudflare TURN relay) — v1.0

### Active

(None. Define the next milestone with `/gsd-new-milestone`.)

### Out of Scope

- End-to-end encryption / client-side crypto — user chose "private & self-hosted"; TLS + self-hosting is the bar
- View-once / disappearing / screenshot-blocking media — images are normal, kept forever
- Native apps / CallKit full-screen ringing — push-to-answer is acceptable; native wrapper adds days
- Group chats, more than two users, sign-up flows — the user base is exactly two people forever
- Third-party hosting of data (Vercel, managed DB/Blob) — everything lives on the owner's machine
- Any UI deviation from the locked shadcn preset

## Current State

**Shipped:** v1.0 MVP on 2026-10-19. It is live at https://duet.brkn.me and installed on both phones.

- About 20.9k LOC of TypeScript across the `web/` (Next 16 static export, locked shadcn preset), `server/` (Fastify 5, SQLite/Drizzle) and `shared/` (zod protocol) workspaces. One Docker container runs behind a Cloudflare Tunnel.
- Media pipeline in the image: sharp + heif-convert for photos, ffmpeg for video and voice.
- Calls are P2P WebRTC with Cloudflare TURN, signaled over duet's own `/ws`. A server-owned call registry handles ringing, push-to-answer and reconnect.

## Next Milestone Goals

Not defined yet. Candidates from v1.0 notes: password reset without re-running the seed script (AUTH-06), and any polish that comes up in daily use.

## Context

- Scale: 2 users. No horizontal scaling, queues or multi-tenant concerns.
- iOS PWA constraints: push only works once the app is on the home screen (16.4+). There is no background ringing. Camera and mic permissions are re-prompted per session.
- Apple's push service rejects any Topic header (since mid-Sept 2026), so duet never sends one.
- The Cloudflare API token at `~/.config/duet/cloudflare.ini` expires 2026-12-08. TURN key minting and tunnel management depend on it.
- The SFU (`sfu.sideby.me`) and the `@sideby-me/rtc` SDK are not used. They were dropped on 2026-10-09 because the home connection is CGNAT.

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
| Installable PWA (Next.js) over native/Capacitor | Fastest; one codebase; reuses shadcn preset directly; push works on iOS 16.4+ | ✓ Good — installs and pushes on both phones |
| Private & self-hosted, no E2EE | User's chosen security bar; avoids key-management and SFU insertable-streams work | ✓ Good |
| Password-only login (TOTP dropped 2026-10-08), two seeded accounts | User's choice in Phase 1 discussion; argon2id + rate limit compensate; no sign-up surface | ✓ Good (password reset is still the seed script) |
| Push-to-answer for incoming calls | Avoids native CallKit; user accepted | ✓ Good — ring push + ring-on-attach |
| Self-host app + DB + media on this machine | Keeps data off third parties | ✓ Good |
| New domain (not sideby.me) for duet + SFU/TURN | sideby.me expired 2026-08-20 (redemption); user chose brkn.me (portfolio domain, on Cloudflare): duet.brkn.me (tunnel), sfu./turn.brkn.me (DNS-only) | ✓ Good — only duet.brkn.me used |
| Run SFU + coturn on this machine | User choice; GCP VM-B is down. Requires UDP port-forwards + a non-CGNAT public IP — verify first | ✗ Reversed 2026-10-09: home is CGNAT (outer router PPPoE WAN 172.18.28.128, egress 103.198.98.196, no public IPv6) |
| P2P WebRTC + Cloudflare TURN instead of an SFU (2026-10-09) | Two people only, so an SFU adds nothing; no VPS/router/cert ops; media E2E-encrypted between phones; existing Cloudflare account/token can manage TURN keys (verified). Trade-off: drops the @sideby-me/rtc SDK, so signaling and ICE-restart are hand-written over duet's WS; TURN is a third party but only relays encrypted packets | ✓ Good — relay-only calls proven over cellular |
| Web Push sent without a Topic header (2026-10-15) | Apple's push service rejected every push that had a Topic header (HTTP 400). The service worker already collapses notifications on the device | ✓ Good — iPhone push confirmed in UAT |
| Media normalized server-side: sharp WebP for photos, ffmpeg H.264/AAC MP4 for video, AAC m4a for voice (Phase 2) | iPhone HEIC/HEVC HDR and Pixel WebM must play on both phones | ✓ Good — device UAT passed |
| Chunked uploads (8 MiB) to get past Cloudflare's 100 MB request cap (Phase 2) | Clips and albums go through the tunnel | ✓ Good |
| Cloudflare Tunnel for duet app ingress (HTTPS/WSS) | Matches existing staging setup; no port-forward for the app. Accepted: Cloudflare sees app traffic in transit. Tunnel cannot carry SFU UDP media | ✓ Good |

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
*Last updated: 2026-10-19 after v1.0 milestone*
