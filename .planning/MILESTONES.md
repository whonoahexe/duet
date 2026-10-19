# Milestones

## v1.0 MVP (Shipped: 2026-10-19)

**Phases completed:** 3 phases, 15 plans, 43 tasks

**Delivered:** A private two-person messenger at https://duet.brkn.me. It has text chat, photos, clips, voice notes, web push, and P2P voice/video calls over Cloudflare TURN, installed as a PWA on an iPhone and a Pixel.

**Stats:** 162 commits · 314 files · ~20.9k LOC TypeScript · 2026-10-08 → 2026-10-19 (11 days)
**Closeout:** verified (all 3 phases passed verification; 37/37 v1 requirements; no deferred items)

**Key accomplishments:**
- One Fastify 5 process serves the locked-preset Next static export, the API, `/ws` and `/media` from SQLite (WAL) in Docker behind a Cloudflare Tunnel. Everything was provisioned through the Cloudflare API.
- Password login for exactly two seeded accounts (argon2id, a 90-day rolling session, rate limits, an Origin guard). The installable dark PWA was checked on both phones.
- Idempotent, cursor-synced chat with an offline outbox, reactions, swipe-to-reply, typing and read receipts.
- Photos/albums (HEIC → WebP), video (HDR → H.264 MP4) and voice notes (→ AAC) play on both phones. Chunked uploads get past Cloudflare's 100 MB cap.
- Web push for messages and calls. iPhone push was fixed by dropping the Topic header that Apple rejects.
- P2P voice/video calls with push-to-answer, camera flip, minimize-to-chat, and auto-reconnect via `call.rejoin` and ICE restart. Relay-only calls are proven through Cloudflare TURN.

---
