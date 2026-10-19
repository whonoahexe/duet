# Phase 2: Chat, Media & Push - Research

**Researched:** 2026-10-10
**Domain:** Real-time 1:1 chat over Fastify + raw WS, SQLite change-cursor sync, an offline outbox, Web Push (iOS + Android), chunked uploads through Cloudflare, and server-side media normalization (ffmpeg, libheif, sharp)
**Confidence:** HIGH for the server and media pipeline (most of it was executed in a `node:24-bookworm-slim` container this session). MEDIUM for the iOS push and gesture behaviour (documented, but not yet seen on a device).

## Summary

Phase 1 left a solid base. One Fastify process has cookie auth, a global Origin guard, a DB-free in-memory WS hub with heartbeat and session re-check, zod-typed frames in `@duet/shared`, Drizzle migrations at boot, `@fastify/static` 10.1.5, and an install-only `sw.js`. Phase 2 adds four subsystems on top. They are mostly independent and can run as parallel plans once a shared schema/protocol plan has landed:

1. **Chat core.** All durable writes go over REST: send, react, mark read. Each write is idempotent on a client-generated UUID and is fanned out over WS to every connection of both users. Every message carries `updated_seq`, a global monotonic change cursor, so `GET /api/sync?since=` can repair whatever a frozen iOS socket missed. The client keeps one external store: confirmed messages by `seq`, a persisted text outbox by `id`, and the peer's read cursor.
2. **Push.** Use `web-push` 3.6.7 with VAPID, suppressed server-side while the recipient has a *visible, fresh* WS connection. **iOS ignores `tag` and `renotify`** (MDN BCD). The D-14 "collapse into one" behaviour must therefore be done in the SW by closing existing notifications (`getNotifications()` + `close()`, both iOS 16.4+) before `showNotification`, which is mandatory every time.
3. **Uploads.** The zone `brkn.me` is on the **Cloudflare Free plan, so request bodies are capped at 100 MB**, but D-08 allows 200 MB clips. **Uploads must be chunked** (8 MiB raw `application/octet-stream` PUTs). That also makes `@fastify/multipart` unnecessary.
4. **Media normalization.** This was executed and verified. **sharp 0.35 cannot decode iPhone HEVC HEIC** (it reads the metadata, then decode fails). Debian bookworm's `heif-convert` (libheif 1.15.1 + libde265) decodes it and resets EXIF orientation to 1. Then sharp makes WebP display and thumbnail copies, autorotated with metadata stripped. ffmpeg 5.1.9 (bookworm) autorotates rotated `.MOV`, tone-maps 10-bit HLG HEVC to SDR H.264 with `zscale`+`tonemap`, writes faststart MP4, and turns WebM/Opus (no duration) or fragmented MP4/AAC voice recordings into AAC `.m4a` with correct durations. `@fastify/static` `reply.sendFile(file, root)` behind an auth check returns correct 206/416 Range responses.

**Primary recommendation:** Build it as 5 plans: shared schema + protocol + chat API first (wave 1), then in parallel chat UI, push + onboarding, and the media server pipeline, then the media UI, deploy and device UAT. Put *every* Phase 2 table in the first migration, because D-07's message → attachments(1..10) shape is the costly-to-reverse part.

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions

#### Carried forward (Phase 1, still binding)
- The UI uses only the shadcn preset `b51GFhBEQ` (Base UI + Phosphor, `npx shadcn add` only), always dark, with the rose accent. Do not use lucide, Radix snippets or emoji-picker libraries.
- Phase 2 builds on the chat-shaped shell from Phase 1 D-11: a header with the other person's name and initials Avatar, plus a logout menu.
- One Fastify process serves static `web/out`, `/api`, `/ws` and `/media`. The database is SQLite + Drizzle, and media lives on local disk under `./data`.

#### Chat feel & gestures
- **D-01:** You react and reply through **both gestures**. **Swipe right** on a bubble to reply. **Long-press** opens a menu with the reaction row, **Reply** and **Copy**.
- **D-02:** A quoted reply shows a compact quote of the original (author + snippet, or a media label/thumbnail) above the new bubble. Tapping the quote scrolls to the original and highlights it, loading older history if needed.
- **D-03:** Read receipts are **iMessage style**. A small status line ("Sending…", "Sent", "Read 9:41") shows only under **your most recent message**. A failed message shows an inline error/retry affordance on that bubble, and tapping it retries.
- **D-04:** The reactions are a **fixed set of six: 💕 💔 😋 😝 😘 😭**. Each person can have one reaction per message. Choosing a different one replaces it, and tapping your current one removes it. Reactions render as a small chip on the bubble. — **Reversibility:** reversible. The set is a constant in `shared/`. Stored emoji stay valid even if the set changes later.

#### Sending photos & videos
- **D-05:** A single **"+" attach button** in the composer opens the native OS picker (`<input type="file" accept="image/*,video/*" multiple>`), which offers Take Photo/Video, Photo Library and Files. There are no separate camera and gallery buttons.
- **D-06:** After you pick, a **preview sheet** shows the selection with an **optional caption** field, Send and Cancel. Nothing sends without an explicit Send.
- **D-07:** Several items go out as **one album message, shown as a grid**: up to **10 items**, **photos and videos mixed**, with **one caption**. Tapping any tile opens a **full-screen viewer you swipe through** that covers the album's items, which satisfies MDIA-02. A single item is just an album of one. — **Reversibility:** costly. The message → attachments (1..10) schema shape and the grid layout are hard to change once history exists, because changing them needs a data migration.
- **D-08:** The video cap is **about 3 minutes / 200 MB per clip**. The server transcodes every clip to **H.264/AAC MP4** with `ffmpeg` (added to the Docker image) and extracts a poster frame. Until the transcode finishes, the bubble shows a processing state.
- **D-09:** Photos keep the **original file forever, HEIC included**. The server generates a **display copy** (JPEG or WebP, at a sensible max dimension) plus a small thumbnail for the grid. Clients display the copy, so HEIC renders on the Pixel.

#### Voice notes
- **D-10:** Recording supports **both modes**. **Hold the mic** to record and release to send, with **slide to cancel**. You can also **lock** a recording (slide up, or tap) for hands-free long notes, which shows a timer and Cancel/Send. While the text field is empty, the mic button takes the Send button's place.
- **D-11:** Voice notes have **no length limit**. The server's per-upload size cap (the same order as the 200 MB media cap) is the only backstop.
- **D-12:** Playback is a **play button plus a waveform scrubber**. The waveform is computed (client-side at record time, or server-side) and drawn as bars, and you drag on it to seek. The duration shows. The voice note must play on both phones, so recordings from iOS (`audio/mp4`/AAC) and Chrome (`audio/webm`/Opus) need a common playable format. The server may transcode them to AAC/M4A.

#### Push & onboarding
- **D-13:** A notification shows the **sender name plus the message text**, for example "Puri: are you home yet?". Media messages show a label: "📷 Photo", "🎥 Video", "🎤 Voice note", or "📷 3 photos" for an album. A caption, if present, shows after the label.
- **D-14:** Notifications **collapse into one**. Each new message replaces the previous duet notification (same `tag`, `renotify` so the phone still buzzes), and the body shows the latest message or "N new messages". Tapping it opens or focuses the app into the chat (NOTF-02).
- **D-15:** No push is sent while the recipient is actively viewing the chat (NOTF-03). "Viewing" means a foreground, visible client with an open WS connection. The exact presence signal is Claude's discretion.
- **D-16:** Onboarding runs on **both phones until done**. On iPhone in Safari when not installed, a full-screen **Add to Home Screen guide** appears with the actual Share → Add to Home Screen steps. Once installed on either phone, an **"Enable notifications" card** appears with a **test-push button** that sends a real push through the server. It stays until permission is granted and a subscription is saved. It is reachable again later from the header menu, for re-enabling and re-testing.

### Claude's Discretion
- Timestamps: the user said "you decide". Suggested: day separators ("Today", "Yesterday", date) plus a time marker after a gap of more than ~15 minutes, with no time on each bubble.
- The typing indicator's look, Enter-to-send behaviour, and grouping of consecutive bubbles.
- The offline queue UX (a pending bubble shows "Sending…" and flushes on reconnect) and the client-generated message ID used for dedup.
- Image display copy size and format, thumbnail size, waveform sample count, the transcode presets, and how the recipient's "viewing" state is tracked.
- Copy text for the onboarding and empty states.

### Deferred Ideas (OUT OF SCOPE)
- Voice note extras (playback speed, auto-playing consecutive notes, a "played" indicator) were offered and not pursued. Revisit if wanted.
- Already in v2: delete message (CHAT-10), unread icon badge (CHAT-11), drafts (CHAT-12), search (CHAT-13).
</user_constraints>

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|------------------|
| CHAT-01 | Send/receive text in real time | REST `POST /api/messages` + `hub.publishToUsers` fan-out (Pattern 1); WS `msg` frame |
| CHAT-02 | History forever, paginated scroll-up | `GET /api/messages?before=&limit=50` by `seq`; `MessageScroller` `preserveScrollOnPrepend` (default true, verified in `@shadcn/react` dist) |
| CHAT-03 | sending / sent / read / failed | Client outbox states; "sent" = has `seq`; "read" = peer `read_state.last_read_seq >= seq`; failed after 4xx or 3 connected attempts (UI-SPEC) |
| CHAT-04 | Offline queue, retry, no duplicates | Client UUID `id` UNIQUE + transactional select-then-insert (verified with drizzle 0.45.4); text outbox persisted in `localStorage` |
| CHAT-05 | Catch up after background/reconnect | `updated_seq` change cursor + `GET /api/sync?since=`; run on every WS `hello` and every `visibilitychange→visible` (Pattern 2) |
| CHAT-06 | Typing indicator | Ephemeral WS `typing` frame relayed to the peer's connections only; receiver TTL 5 s |
| CHAT-07 | Read receipts | `POST /api/read {seq}` (monotonic max) only while visible + focused + message on screen; WS `read` frame |
| CHAT-08 | Emoji reactions | `PUT /api/messages/:seq/reaction {emoji|null}`; PK(message_seq,user_id); `REACTIONS` const in shared |
| CHAT-09 | Quoted replies | `reply_to_seq` FK; server embeds a `replyTo` preview in the DTO; jump-to-quote pages older history until `seq` is loaded |
| MDIA-01 | Photos incl. HEIC visible on Pixel | sharp metadata `format:'heif', compression:'hevc'` → `heif-convert` → sharp WebP display/thumb (executed) |
| MDIA-02 | Full-screen viewer | Dialog + Carousel (UI-SPEC); display copy 2048 px long edge |
| MDIA-03 | Video clips play on both phones | ffmpeg 5.1.9 → H.264 High/AAC MP4, faststart, autorotate, HLG tone-map, poster (executed) |
| MDIA-04 | Voice notes with scrubber | MediaRecorder (mime from candidate list) → server AAC `.m4a` + 40-bar peaks + `duration_ms` (executed) |
| MDIA-05 | Auth-gated media with Range | `GET /media/:id/:variant` → `requireUser` → `reply.sendFile(rel, mediaRoot)` → 200/206/416 (executed against @fastify/static 10.1.5) |
| NOTF-01 | Push when not foreground | `web-push` 3.6.7, VAPID, `TTL`/`urgency:'high'`/`topic`, prune 404/410 |
| NOTF-02 | Tap opens chat | SW `notificationclick` → `clients.matchAll` → `focus()` + `postMessage`, else `openWindow('/')` |
| NOTF-03 | No push while viewing | Hub tracks per-connection `visible` + `lastSeenAt` (presence frame every 20 s); `isViewing(userId)` checked at send |
| SHEL-03 | iOS onboarding + test push | Standalone detection, A2HS guide before login, notifications card, `POST /api/push/test` |
</phase_requirements>

## Project Constraints (from CLAUDE.md)

- **UI is locked to shadcn preset `b51GFhBEQ`** (`base-luma`, Base UI, Phosphor). Add components only with `npx shadcn add` in `web/`. No lucide, no `@radix-ui/*`, no emoji-picker libs. `scripts/check-preset.sh` enforces part of this; it also forbids `serwist`/`@serwist/*`.
- **No Serwist.** `public/sw.js` stays hand-written and must not intercept `/media`, `/api` or `/ws`.
- **Speed first, simplest thing that works.** At most 3 phases in total, and this is phase 2 of 3.
- **Self-hosted in Docker on this machine.** SQLite + media on the `./data` volume (`compose.yaml:13-14` mounts `./data:/data`).
- **HTTPS/WSS everywhere** (already true via the Cloudflare Tunnel at `https://duet.brkn.me`).
- **Stack picks to honour:** Fastify 5.12.5, `@fastify/static` 10.1.5 (Range), `web-push` with VAPID, zod 4 schemas in `shared/` for every REST body and WS frame, `node:24-bookworm-slim` (not Alpine), `typescript@^5` (not 7), no Server Actions, plain `<img>`/`<video>` instead of `next/image`.
- **Push rule (stack notes):** every push must `showNotification`. Delete subscriptions on 404/410.
- **SFU, `@sideby-me/rtc` and mediasoup sections are historical.** Do not install any of it.
- **GSD workflow:** edits go through `/gsd-execute-phase`.
- Two stack-note picks are **not** recommended here, with reasons in the "Alternatives Considered" table: `@fastify/multipart` (made pointless by chunking) and `@tanstack/react-query` (a plain external store fits the merge logic better). Both are listed in the Assumptions Log.

## Architectural Responsibility Map

| Capability | Primary Tier | Secondary Tier | Rationale |
|------------|-------------|----------------|-----------|
| Message persistence, dedup, ordering (`seq`, `updated_seq`) | API / Backend (Fastify + SQLite) | — | Single writer; the server is the only source of truth for order and the change cursor |
| Real-time fan-out (msg / read / typing) | API / Backend (WS hub) | Browser | The hub stays DB-free. Routes write to the DB and then call `hub.publish*` |
| Offline outbox, optimistic bubbles, merge by id | Browser | — | Must work while the server is unreachable. Persisted in `localStorage` |
| Catch-up after resume | Browser (triggers) | API (`/api/sync`) | The client knows when it was frozen. The server knows what changed |
| "Viewing" presence for push suppression | API (hub state) | Browser (presence frames) | The decision is made at send time on the server. iOS forbids SW-side suppression |
| Push send, prune dead subscriptions | API / Backend | — | VAPID private key is server-only |
| Notification display, collapse, click routing | Browser (Service Worker) | — | Only the SW can show and close notifications for a closed app |
| Upload chunking + progress | Browser | API (chunk store) | Cloudflare's 100 MB body cap forces client-side slicing |
| HEIC decode, image resize, video transcode, audio normalize, waveform | API / Backend (child processes) | — | Phones produce formats the other phone can't play. One normalization point |
| Auth-gated media with Range | API / Backend (`@fastify/static` `sendFile`) | CDN (Cloudflare, pass-through only) | Must never be cached at the edge. Extensionless URLs + `Cache-Control: private` |
| A2HS guide / standalone detection / permission prompt | Browser | — | Pure client capability checks. The permission prompt needs a user gesture |

## Standard Stack

### Core (new in this phase)

| Library / Tool | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| `web-push` (server) | **3.6.7** (latest; published 2024-01-16) | VAPID-signed, RFC 8291-encrypted push sends | De facto Node web-push library. Reading its source confirmed the options `TTL`, `urgency`, `topic`, `timeout`, `headers`, `vapidDetails` and that it rejects with `WebPushError{statusCode, headers, body, endpoint}` `[VERIFIED: npm tarball web-push-3.6.7 src/web-push-lib.js, src/web-push-error.js]` |
| `@types/web-push` (server dev) | 3.6.4 | Types | DefinitelyTyped `[VERIFIED: npm registry]` |
| `sharp` (server) | **0.35.4 exact** (2026-08-26). Latest is 0.35.5 (2026-09-27), which the legitimacy seam flags "too-new" | Resize/autorotate/strip/encode WebP for JPEG/PNG/WebP/AVIF/GIF and for heif-convert output | Prebuilt glibc binaries via `@img/sharp-linux-x64` optional deps, so no toolchain in the runtime stage. Node ≥ 20.9 `[CITED: sharp.pixelplumbing.com/install]`. Executed: 12 MP JPEG → 2048 WebP + 480 WebP in ~600 ms, EXIF stripped |
| `ffmpeg` / `ffprobe` (Debian apt, runtime stage) | **5.1.9** (`7:5.1.9-0+deb12u1`) | Video → H.264/AAC MP4, poster, voice → AAC m4a, PCM for waveform, probing | Includes `libx264`, native `aac`, `hevc`/`opus` decoders, `zscale` + `tonemap` filters `[VERIFIED: executed in node:24-bookworm-slim]` |
| `heif-convert` (Debian `libheif-examples`) | **1.15.1** | HEVC-HEIC → JPEG | libheif1 depends on `libde265-0` (HEVC decode). Its JPEG encoder resets EXIF orientation to 1 because libheif already applied the rotation `[VERIFIED: github.com/strukturag/libheif v1.15.1 examples/encoder_jpeg.cc:187-188; executed on a real 3992×2992 iPhone HEIC]` |

### Supporting (added via `npx shadcn add`, so they come from the preset)

| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| `@shadcn/react` | 0.3.1 | Headless `message-scroller` primitive (pulled in by `shadcn add message-scroller`) | Provider defaults verified from dist: `autoScroll=false`, `defaultScrollPosition="end"`, Viewport `preserveScrollOnPrepend=true`. Hooks `useMessageScroller()` → `scrollToEnd/scrollToMessage/scrollToStart`, `useMessageScrollerVisibility()` → `{currentAnchorId, visibleMessageIds}` `[VERIFIED: @shadcn/react-0.3.1 dist/message-scroller/index.d.ts]` |
| `embla-carousel-react` | 8.6.0 | Pulled in by `shadcn add carousel` (full-screen viewer) | Only through the registry |
| shadcn registry components | via CLI | message, bubble, message-scroller, marker, attachment, input-group (+textarea), drawer, dialog, carousel, popover, skeleton | Listed and approved in 02-UI-SPEC.md |

### Not added (deliberately)

| Instead of | Use | Tradeoff |
|------------|-----|----------|
| `@fastify/multipart` (stack note) | Raw `application/octet-stream` chunk PUTs with a `parseAs:'buffer'` content-type parser and route `bodyLimit` | The 100 MB Cloudflare cap forces chunking. Once chunks are ≤ 8 MiB, buffering one in memory is fine, Fastify enforces the limit (verified: 413 `FST_ERR_CTP_BODY_TOO_LARGE`), and the code is simpler than streaming multipart |
| `@tanstack/react-query` (stack note) | One external store (`useSyncExternalStore`) holding messages by `seq`, the outbox by `id`, read cursors and typing | The core logic is merging REST pages, WS events, sync deltas and outbox echoes in any order. Infinite-query page arrays make prepend/insert/patch-by-seq awkward. A pure reducer module is also unit-testable from the existing server vitest if it lives in `shared/` (precedent: `callVerdict` in Phase 1) |
| `uuid` | `crypto.randomUUID()` | Available in secure contexts on iOS 15.4+ and all current Chrome |
| `date-fns` | `Intl.DateTimeFormat` | UI-SPEC already specifies Intl |
| `idb-keyval` / IndexedDB outbox for media | In-memory media outbox | Speed. See Assumption A3 |
| Static ffmpeg builds / a trixie base | Debian bookworm apt packages | Already tested end to end. A base-image change risks the better-sqlite3 build that Phase 1 solved |

**Installation:**
```bash
npm install -w server web-push@3.6.7 sharp@0.35.4
npm install -w server -D @types/web-push@3.6.4
# web/: components only through the registry (pulls @shadcn/react, embla-carousel-react)
cd web && npx shadcn add message bubble message-scroller marker attachment input-group drawer dialog carousel popover skeleton
```
```dockerfile
# Dockerfile runtime stage, BEFORE `USER node` (adds ~431 MB, measured)
RUN apt-get update \
  && apt-get install -y --no-install-recommends ffmpeg libheif-examples \
  && rm -rf /var/lib/apt/lists/*
```

**Version verification:** `npm view` this session gave web-push 3.6.7, sharp 0.35.5 (0.35.4 published 2026-08-26), @types/web-push 3.6.4, @shadcn/react 0.3.1, embla-carousel-react 8.6.0, @fastify/multipart 10.1.3 (not used), and @tanstack/react-query 5.104.1 (not used). `apt-cache policy` in `node:24-bookworm-slim` gave ffmpeg 7:5.1.9-0+deb12u1, libheif-examples/libheif1 1.15.1-1+deb12u1 and libvips-tools 8.14.1 (not used).

## Package Legitimacy Audit

Run with `gsd-tools query package-legitimacy check --ecosystem npm …` plus `npm view <pkg> scripts.postinstall` (all empty).

| Package | Registry | Age | Downloads | Source Repo | Verdict | Disposition |
|---------|----------|-----|-----------|-------------|---------|-------------|
| web-push | npm | latest 2024-01-16 | 11.1M/wk | github.com/web-push-libs/web-push | OK | Approved (3.6.7) |
| @types/web-push | npm | 2024-10-22 | 5.1M/wk | DefinitelyTyped | OK | Approved (3.6.4) |
| sharp | npm | latest 0.35.5 is 13 days old | 114.5M/wk | github.com/lovell/sharp | **SUS (too-new)** | Flagged. Pin `0.35.4` (45 days old) and add a `checkpoint:human-verify` before install. The "too-new" signal refers to the newest release, not the package, which is the standard Node image library |
| @shadcn/react | npm | 2026-08-31 | 3.0M/wk | github.com/shadcn-ui/ui | OK | Approved (pulled in by the shadcn registry) |
| embla-carousel-react | npm | 2025-04-04 | 30.4M/wk | github.com/davidjerleke/embla-carousel | OK | Approved (pulled in by the shadcn registry) |
| ffmpeg, libheif-examples | Debian bookworm apt | security-maintained | — | debian.org | n/a (distro) | Approved |

**Packages removed due to [SLOP] verdict:** none
**Packages flagged as suspicious [SUS]:** `sharp`. It is flagged only because its latest release is recent. The planner must add a `checkpoint:human-verify` before `npm install sharp@0.35.4`.

## Architecture Patterns

### System Architecture Diagram

```
                         ┌───────────────────── phone (PWA) ──────────────────────┐
 composer / picker / mic │ store (msgs by seq, outbox by id, reads, typing)        │
        │                │   ▲ REST pages  ▲ WS frames  ▲ /api/sync deltas         │
        ▼                │   │             │            │                          │
 outbox (localStorage) ──┼─► POST /api/messages ──┐  ┌── /ws (hello/msg/read/typing/pong)
 upload queue ───────────┼─► POST /api/uploads ─┐ │  │      ▲ presence{visible}, ping, typing
   8 MiB chunks (XHR) ───┼─► PUT …/chunks/:i ───┤ │  │      │
                         │   POST …/complete ───┤ │  │  SW: push → close old → showNotification
 <img>/<video>/<audio> ──┼─► GET /media/:id/:v ─┼─┼──┼─►    notificationclick → focus/openWindow
                         └──────────────────────┼─┼──┼───────────────────────────────────┘
                     Cloudflare edge (Free: 100 MB body, no cache for private/extensionless)
                                     │ tunnel   │ │  │
 ┌──────────────────────── duet (one Fastify process) ───────────────────────────────┐
 │ onRequest: originGuard (non-GET) → route onRequest/preHandler: requireUser        │
 │                                                                                   │
 │ uploads ─► data/media/tmp/<id>/<i>.part ─► complete: concat ─► data/media/<id>/original
 │                                             │                                      │
 │                                             ▼                                      │
 │                            processing queues (image lane | video lane)             │
 │       sharp.metadata ─ heif/hevc? ─► heif-convert ─► sharp → display.webp, thumb.webp
 │       ffprobe (format allowlist) ─► ffmpeg → video.mp4 + poster.jpg | audio.m4a + peaks
 │                                             │ status ready/failed                  │
 │ messages API ── tx: insert msg (id UNIQUE), updated_seq = max+1 ─┐                 │
 │ reactions / read ── tx: update + bump updated_seq ───────────────┤                 │
 │                                                                  ▼                 │
 │                        hub.publishToUsers([me, peer], {t:'msg'|'read'})            │
 │                        hub.isViewing(peer)? ── no ──► push.sendToUser(peer, label) │
 │                                                        └► 404/410: delete sub      │
 │ GET /media/:id/:variant ── requireUser ── reply.sendFile(rel, mediaRoot) (Range)   │
 └───────────────────────────────────────────────────────────────────────────────────┘
                  SQLite WAL (users, sessions, messages, attachments, reactions,
                              read_state, push_subscriptions)
```

### Recommended Project Structure (additions)

```
shared/src/
├── chat.ts          # MessageDto, AttachmentDto, REACTIONS, request/response schemas, limits
├── chat-logic.ts    # pure: messageLabel() (D-13), albumCountLabel(), mergeMessages(), outbox transitions
└── ws.ts            # + ping/typing/presence client frames; + pong/msg/read/typing server frames
server/src/
├── chat/routes.ts   # /api/messages, /api/sync, /api/messages/:seq/reaction, /api/read
├── chat/service.ts  # sendMessage(), toDto(), bumpUpdatedSeq(), unreadCount()
├── media/uploads.ts # /api/uploads (+ chunks, complete), tmp cleanup at boot
├── media/process.ts # queues, sharp/heif-convert/ffmpeg/ffprobe wrappers, peaks
├── media/routes.ts  # GET /media/:id/:variant
├── push/sender.ts   # web-push wrapper, prune, suppression decision
├── push/routes.ts   # /api/push/vapid-public-key, /api/push/subscriptions, /api/push/test
└── ws/hub.ts        # + publishToUser(s), isViewing(), typing relay, presence, ping/pong
server/drizzle/0001_*.sql   # ONE migration with every Phase 2 table
web/lib/chat/        # store.ts, realtime.ts (reconnecting socket), outbox.ts, upload.ts, push.ts
web/components/app/  # chat-view, message-row, composer, recorder, voice-note, album, viewer,
                     # preview-drawer, a2hs-guide, notifications-card, notifications-drawer
web/public/sw.js     # + push, notificationclick (still no fetch listener)
```

### Data model (one migration, D-07 shape)

```ts
// server/src/db/schema.ts additions [ASSUMED: exact drizzle 0.45 helper syntax; the transaction/
// returning/onConflict behaviour itself was VERIFIED by execution with drizzle-orm 0.45.4]
import { sqliteTable, text, integer, index, primaryKey, type AnySQLiteColumn } from "drizzle-orm/sqlite-core"

export const messages = sqliteTable("messages", {
  seq: integer("seq").primaryKey({ autoIncrement: true }),          // total order, pagination key
  id: text("id").notNull().unique(),                                // client UUID = dedup key
  senderId: text("sender_id").notNull().references(() => users.id),
  kind: text("kind", { enum: ["text", "media", "voice"] }).notNull(),
  body: text("body"),                                               // text or caption
  replyToSeq: integer("reply_to_seq").references((): AnySQLiteColumn => messages.seq),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  updatedSeq: integer("updated_seq").notNull(),                     // change cursor (CHAT-05)
}, (t) => [index("messages_updated_seq_idx").on(t.updatedSeq)])

export const attachments = sqliteTable("attachments", {
  id: text("id").primaryKey(),                       // 128-bit random base64url (unguessable)
  uploaderId: text("uploader_id").notNull().references(() => users.id),
  messageSeq: integer("message_seq").references(() => messages.seq),   // null until the message is created
  position: integer("position").notNull().default(0),                // 0..9 within the album
  kind: text("kind", { enum: ["image", "video", "audio"] }).notNull(),
  status: text("status", { enum: ["uploading", "processing", "ready", "failed"] }).notNull(),
  declaredSize: integer("declared_size").notNull(),
  width: integer("width"), height: integer("height"), durationMs: integer("duration_ms"),
  waveform: text("waveform"),                        // JSON number[40], 0..100 (voice only)
  error: text("error"),                              // e.g. "transcode_failed", "too_long"
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
}, (t) => [index("attachments_message_seq_idx").on(t.messageSeq)])

export const reactions = sqliteTable("reactions", {
  messageSeq: integer("message_seq").notNull().references(() => messages.seq, { onDelete: "cascade" }),
  userId: text("user_id").notNull().references(() => users.id),
  emoji: text("emoji").notNull(),                    // validated on WRITE only (D-04 reversibility)
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
}, (t) => [primaryKey({ columns: [t.messageSeq, t.userId] })])

export const readState = sqliteTable("read_state", {
  userId: text("user_id").primaryKey().references(() => users.id),
  lastReadSeq: integer("last_read_seq").notNull().default(0),
  readAt: integer("read_at", { mode: "timestamp_ms" }),
})

export const pushSubscriptions = sqliteTable("push_subscriptions", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  sessionId: text("session_id").notNull().references(() => sessions.id, { onDelete: "cascade" }), // logout ⇒ gone
  endpoint: text("endpoint").notNull().unique(),
  p256dh: text("p256dh").notNull(),
  auth: text("auth").notNull(),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  lastOkAt: integer("last_ok_at", { mode: "timestamp_ms" }),
})
```

Key points:
- There is **no conversations table**: there is exactly one conversation, and authorization is "requester is a logged-in user". Both users may read every message and every attachment.
- **`updated_seq` = `max(updated_seq)+1` computed inside the write transaction.** better-sqlite3 is synchronous and there is one process, so a sync `db.transaction(...)` serializes writers. No counters table is needed, and the index makes `max()` cheap. Every change bumps the message's `updated_seq`: insert, reaction, or attachment becoming ready/failed.
- **Files on disk:** `data/media/<attId>/original` (no extension; never served), `display.webp`, `thumb.webp`, `poster.jpg`, `video.mp4`, `audio.m4a`. Temp: `data/media/tmp/<attId>/<index>.part`. `data/media` is already created at boot (`server/src/db/client.ts:25`: `mkdirSync(path.join(dataDir, "media"), { recursive: true })`).

### Protocol (shared/src/chat.ts + ws.ts)

Existing WS contract, quoted from source (`shared/src/ws.ts:10-16`, `:44-48`, `:58`, `:61-68`):
```ts
export const WS_MAX_PAYLOAD = 131072
export const WS_CLOSE_LOGGED_OUT = 4401
export const WS_MAX_FRAMES_PER_SECOND = 100
export const WS_MAX_ROOMS_PER_CONN = 4
export const ClientFrame = z.discriminatedUnion("t", [
  z.strictObject({ t: z.literal("room.join"), room: RoomId }),
  z.strictObject({ t: z.literal("room.leave"), room: RoomId }),
  z.strictObject({ t: z.literal("rtc.signal"), room: RoomId, data: SignalData }),
export const WsErrorCode = z.enum(["bad_frame", "not_in_room", "too_many_rooms"])
export const ServerFrame = z.discriminatedUnion("t", [
  z.object({ t: z.literal("hello"), connId: z.uuid(), userId: z.uuid() }),
  ... room.joined / room.peer-joined / room.peer-left / room.full / rtc.signal / error
```
Additions (new names are proposals `[ASSUMED]`):

| Direction | Frame | Meaning |
|---|---|---|
| C→S | `{t:"ping"}` | App-level liveness check after resume. The server answers `{t:"pong"}` |
| C→S | `{t:"presence", visible: boolean}` | Sent on `hello`, on every `visibilitychange`, on `pagehide`, and every 20 s while visible |
| C→S | `{t:"typing"}` | At most every 3 s while the composer is non-empty (UI-SPEC) |
| S→C | `{t:"pong"}` | Reply to ping |
| S→C | `{t:"msg", message: MessageDto}` | New **or changed** message (insert, reaction, attachment status). The client replaces by `id`/`seq` |
| S→C | `{t:"read", userId, seq, at}` | A read cursor advanced |
| S→C | `{t:"typing", userId}` | Relayed to the *other* user's connections only |

REST (all behind `requireUser`; non-GET also passes the global Origin guard, `server/src/http/guards.ts:4,31`: `const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"])` and `if (!SAFE_METHODS.has(request.method) && request.headers.origin !== config.APP_ORIGIN)`):

| Route | Body / query | Returns |
|---|---|---|
| `GET /api/messages` | `?before=<seq>&limit=50` (limit ≤ 200 for jump-to-quote) | `{messages: MessageDto[] (desc), hasMore, cursor, reads}`. `cursor` = current `max(updated_seq)` |
| `GET /api/sync` | `?since=<cursor>` | `{messages (updated_seq > since, asc, ≤ 500), reads, cursor, hasMore}` |
| `POST /api/messages` | `{id: uuid, body?, replyToSeq?, attachmentIds?: string[1..10]}` | `{message}`. Idempotent on `id` (200 on a replay) |
| `PUT /api/messages/:seq/reaction` | `{emoji: Reaction \| null}` | `{message}` |
| `POST /api/read` | `{seq}` | `{ok}`. `last_read_seq = max(old, seq)` |
| `POST /api/uploads` | `{kind:'image'\|'video'\|'audio', size}` | `{id, chunkSize}` |
| `PUT /api/uploads/:id/chunks/:index` | raw bytes (`application/octet-stream`, ≤ 8 MiB) | 204. Idempotent (overwrite) |
| `POST /api/uploads/:id/complete` | — | `{attachment}` (status `processing`) or 422 `unsupported_media` / `too_long` / `too_large` |
| `GET /media/:id/:variant` | variant ∈ `thumb\|display\|poster\|video\|audio` | file, 200/206/416 |
| `GET /api/push/vapid-public-key` | — | `{key}`, or 503 `push_unconfigured` |
| `POST /api/push/subscriptions` | `{endpoint, keys:{p256dh, auth}}` | `{ok}`. Upsert by endpoint, re-bound to *this* session |
| `POST /api/push/test` | — | `{sent:n}`. Sends only to this session's subscriptions |

`MessageDto = { seq, id, senderId, kind, body, createdAt, updatedSeq, replyTo: {seq, senderId, kind, snippet, attachmentCount, thumb: {id, kind} | null} | null, attachments: AttachmentDto[], reactions: {userId, emoji}[] }`. Embed `replyTo` server-side so a quote renders even when the original isn't loaded (D-02). `AttachmentDto = { id, kind, status, position, width?, height?, durationMs?, waveform? }`. URLs are derived on the client (`/media/${id}/thumb`).

### Pattern 1: Write over HTTP, notify over WS (idempotent send)

**What:** Every durable mutation is a REST call that writes SQLite in one sync transaction, then publishes to both users' connections, then (for new messages) decides whether to push.
**When to use:** For every send, reaction and read. WS carries only ephemeral client→server frames.
```ts
// server/src/chat/service.ts — the select-then-insert-in-tx shape was VERIFIED with drizzle 0.45.4
export function sendMessage(db: Db, senderId: string, input: SendBody) {
  return db.transaction((tx) => {
    const existing = tx.select().from(messages).where(eq(messages.id, input.id)).get()
    if (existing) return { row: existing, created: false }           // retry ⇒ same row, no dupe
    const next = (tx.select({ m: sql<number>`coalesce(max(${messages.updatedSeq}), 0)` }).from(messages).get()!.m) + 1
    const row = tx.insert(messages).values({ id: input.id, senderId, kind: input.kind, body: input.body ?? null,
      replyToSeq: input.replyToSeq ?? null, createdAt: new Date(), updatedSeq: next }).returning().get()
    // attach uploads: only rows with uploaderId === senderId AND messageSeq IS NULL AND status IN (processing, ready)
    return { row, created: true }
  })
}
// route: const { row, created } = sendMessage(...); const dto = toDto(row)
// app.hub.publishToUsers([me.id, peerId], { t: "msg", message: dto })
// if (created && !app.hub.isViewing(peerId)) void app.push.notifyMessage(peerId, dto).catch(log)
```

### Pattern 2: Change cursor + catch-up on every resume

- The client stores `cursor` (from `GET /api/messages` or `/api/sync`).
- On every WS `hello`, every `visibilitychange→visible`, and every `online` event: `GET /api/sync?since=cursor` → apply messages → set the cursor.
- If `hasMore` (more than 500 changes, e.g. after weeks away), drop the cache and reload the latest page.
- Apply rule: a changed message with `seq < oldestLoadedSeq` is **ignored**, because inserting it would create a hole. It arrives fresh when that page is loaded.

### Pattern 3: Client outbox (CHAT-03/04)

- **Text:** `{id: crypto.randomUUID(), body, replyToSeq, createdAt, attempts, state: 'sending'|'failed'}` persisted to `localStorage` key `duet.outbox.v1.<userId>`. Flush **in order, one at a time** when the socket says hello, on `online`, and right after enqueue.
  - A network error/timeout leaves it `sending` and retries with backoff.
  - It becomes `failed` on a 4xx, or after 3 attempts while connected (UI-SPEC).
  - Retry resets `attempts` and reuses the **same `id`**.
  - Clear the key on logout.
- **Merge:** a server echo (POST response *or* WS `msg`, in either order) with the same `id` removes the outbox entry and inserts by `seq`. The UI renders confirmed messages ordered by `seq`, then outbox entries ordered by `createdAt`.
- **Media/voice:** the in-memory queue holds `File`/`Blob` + per-item `attachmentId` + `uploaded` flag. Retry re-uploads only failed items (UI-SPEC). The message POST happens after all items complete. Files are lost if iOS kills the app mid-upload (Assumption A3).

### Pattern 4: Presence-based push suppression (NOTF-03)

- Hub `Conn` gains `visible: boolean` (default false) and `lastSeenAt` (updated on every frame and pong).
- `isViewing(userId) = conns.some(c => c.userId === userId && !c.closing && c.visible && now - c.lastSeenAt < 45_000)`.
- The client sends `presence` on hello, on visibility change and on `pagehide`, plus every 20 s while visible. A frozen iOS app therefore stops suppressing within 45 s even if its "hidden" frame never got out.
- **Never suppress in the SW.** iOS revokes push permission for pushes that show no notification `[CITED: developer.apple.com/documentation/usernotifications/sending-web-push-notifications-in-web-apps-and-browsers]`.

### Pattern 5: Chunked upload through Cloudflare

- Fixed `CHUNK_SIZE = 8 MiB`. The client slices with `Blob.slice` and PUTs sequentially via XHR, so `upload.onprogress` drives the "45%" overlay.
- The server writes `<index>.part.tmp`, then renames to `<index>.part`, so a retried PUT simply overwrites.
- Each chunk's length must equal `CHUNK_SIZE`, except the last (`size - index*CHUNK_SIZE`).
- `complete` checks that every part exists, concatenates with `stream.pipeline` into `original`, deletes tmp, sniffs, sets `processing` and enqueues.
- Caps: image ≤ 50 MB, video ≤ 200 MB, audio ≤ 200 MB (D-11 backstop) `[ASSUMED: image cap]`.
- **Run `requireUser` as the route's `onRequest`,** so an unauthenticated client can't make the server buffer 8 MiB. Verified: with a route-level `onRequest` auth hook, the octet-stream parser did not run on a 401.

### Pattern 6: Media processing (verified commands)

Two in-process serial queues: **image+audio lane** (fast) and **video lane** (slow), so a 3-minute transcode never delays a photo. At boot, re-enqueue every attachment still `processing` (crash recovery) and delete tmp dirs and `uploading` rows older than 24 h. Spawn children with an argument array (no shell), `-nostdin`, a kill timeout (video: 15 min), and `nice -n 10`.

- **Image:** `sharp(original).metadata()`.
  - If `format === 'heif' && compression === 'hevc'` → `heif-convert -q 92 original tmp.jpg`, then work from `tmp.jpg`.
  - Otherwise use sharp directly.
  - Display: `.rotate().resize(2048, 2048, {fit:'inside', withoutEnlargement:true}).webp({quality:82})`.
  - Thumb: `640` / `quality:70`.
  - Record `width`/`height` from the display output info.
  - Output has no EXIF, so no GPS (verified).
  - sharp's default `limitInputPixels` guards against decompression bombs.
- **Video:** `ffprobe -v error -show_entries format=format_name,duration:stream=codec_type,codec_name,width,height,color_transfer -of json original`.
  - Reject unless `format_name` ∈ {`mov,mp4,m4a,3gp,3g2,mj2`, `matroska,webm`}.
  - Reject if `duration > 200` (D-08 "about 3 minutes").
  - Then run:
    ```
    ffmpeg -nostdin -hide_banner -loglevel error -y -f <mov|matroska> -i original -map 0:v:0 -map 0:a:0? \
      -vf "<HDR? tonemap chain,>scale=w='min(1280,iw)':h='min(1280,ih)':force_original_aspect_ratio=decrease:force_divisible_by=2,format=yuv420p" \
      -c:v libx264 -preset veryfast -crf 23 -profile:v high -c:a aac -b:a 128k -ac 2 -movflags +faststart video.mp4
    ```
  - HDR (when `color_transfer` ∈ {`arib-std-b67`, `smpte2084`}): prefix `zscale=t=linear:npl=100,format=gbrpf32le,zscale=p=bt709,tonemap=tonemap=hable:desat=0,zscale=t=bt709:m=bt709:r=tv,`.
  - Verified results:
    - A 1920×1080 HEVC Main10 HLG MOV became 1280×720 H.264 High, `color_transfer=bt709`.
    - A `rotation=90` input became 720×1280 with no rotation side data.
    - The `moov` atom sat at byte 32 (faststart).
    - A 4 s clip took ~2 s wall time on 16 cores.
  - Poster: `ffmpeg -ss <min(0.5, dur/2)> -i video.mp4 -frames:v 1 -vf "scale=640:640:force_original_aspect_ratio=decrease" -q:v 4 poster.jpg`.
  - Probe `video.mp4` again for `width/height/durationMs`.
  - **Delete the video original after success** (Open Question 1).
- **Voice:** same ffprobe allowlist plus {`ogg`, `wav`, `mp3`, `aac`}.
  - `ffmpeg … -i original -vn -c:a aac -b:a 64k -ac 1 -movflags +faststart audio.m4a`.
  - `durationMs` from `ffprobe format=duration` of **the output**. The WebM input reports `N/A`; the output reported 6.008 s for a 6 s source (verified).
  - Peaks: `ffmpeg -i audio.m4a -ac 1 -ar 8000 -f s16le -` piped to Node, cut into 40 buckets of RMS or max, normalized to 0..100, stored as JSON (verified, 48 000 samples for 6 s).

### Pattern 7: Auth-gated media with Range (MDIA-05)

```ts
// VERIFIED against @fastify/static 10.1.5: 401 without auth; 200 + Accept-Ranges; 206 "bytes 0-1/100000";
// 416 "bytes */100000"; custom Cache-Control survives with { cacheControl: false }.
const VARIANTS = { thumb: ["thumb.webp", "image/webp"], display: ["display.webp", "image/webp"],
  poster: ["poster.jpg", "image/jpeg"], video: ["video.mp4", "video/mp4"], audio: ["audio.m4a", "audio/mp4"] } as const
app.get("/media/:id/:variant", { preHandler: requireUser }, async (req, reply) => {
  const { id, variant } = req.params as { id: string; variant: string }
  const v = VARIANTS[variant as keyof typeof VARIANTS]
  if (!/^[A-Za-z0-9_-]{22}$/.test(id) || !v) return reply.code(404).header("Cache-Control", "no-store").send({ error: "not_found" })
  const row = app.db.select().from(attachments).where(eq(attachments.id, id)).get()
  if (!row || row.status !== "ready") return reply.code(404).header("Cache-Control", "no-store").send({ error: "not_found" })
  reply.header("Cache-Control", "private, max-age=31536000, immutable").type(v[1])
  return reply.sendFile(`${id}/${v[0]}`, path.join(app.config.DATA_DIR, "media"), { cacheControl: false })
})
```
`@fastify/static` is already registered for `web/out`, which decorates `reply.sendFile`. Its `setHeaders` (`app.ts`) only touches `.html`/`sw.js`/`.webmanifest`/`/_next/static/` paths, so it doesn't affect media. **URLs have no file extension.** Live checks showed Cloudflare caches by extension (`/sw.js` → `cf-cache-status: EXPIRED`) while extensionless paths are `DYNAMIC`.

### Pattern 8: Service worker (push + click), no fetch listener

```js
// web/public/sw.js — keep the existing install/activate listeners (sw.js:4, :8). Never add "fetch".
self.addEventListener("push", (event) => {
  let d = {}
  try { d = event.data ? event.data.json() : {} } catch { d = {} }
  const title = typeof d.title === "string" && d.title ? d.title : "duet"
  const body = typeof d.body === "string" ? d.body : "New message"
  event.waitUntil((async () => {
    // D-14 collapse. iOS ignores `tag` (MDN BCD: "can be set, but has no effect") and `renotify`,
    // so close what is showing first. getNotifications/close exist on iOS 16.4+.
    try { for (const n of await self.registration.getNotifications()) n.close() } catch {}
    await self.registration.showNotification(title, {        // ALWAYS reached: no early return
      body, tag: d.t === "test" ? "duet-test" : "duet-chat", renotify: true,
      icon: "/icons/icon-192.png", data: { url: "/" },
    })
  })())
})
self.addEventListener("notificationclick", (event) => {
  event.notification.close()
  event.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: "window", includeUncontrolled: true })
    for (const c of wins) { await c.focus(); c.postMessage({ t: "open-chat" }); return }
    await self.clients.openWindow("/")
  })())
})
```
Page side: on `visibilitychange→visible`, call `navigator.serviceWorker.ready.then(r => r.getNotifications()).then(ns => ns.forEach(n => n.close()))` so the tray clears once the chat is read. On a `{t:"open-chat"}` message, scroll to the end.

### Pattern 9: Push sender

```ts
import webpush, { WebPushError } from "web-push"   // CJS default import (works under tsx like better-sqlite3)
// Config: VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT (https: or mailto:; web-push throws otherwise
// and warns on localhost). Default VAPID_SUBJECT to APP_ORIGIN only when it is https.
webpush.setVapidDetails(cfg.VAPID_SUBJECT, cfg.VAPID_PUBLIC_KEY, cfg.VAPID_PRIVATE_KEY)
async function sendOne(sub: Row, payload: object, opts: { topic?: string }) {
  try {
    await webpush.sendNotification({ endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
      JSON.stringify(payload), { TTL: 86_400, urgency: "high", topic: opts.topic, timeout: 10_000 })
    db.update(pushSubscriptions).set({ lastOkAt: new Date() }).where(eq(pushSubscriptions.id, sub.id)).run()
  } catch (err) {
    const code = err instanceof WebPushError ? err.statusCode : 0
    if (code === 404 || code === 410) db.delete(pushSubscriptions).where(eq(pushSubscriptions.id, sub.id)).run()
    log.warn({ evt: "push_failed", code, host: new URL(sub.endpoint).host })   // never log keys/endpoint path
  }
}
// chat payload: { t:"chat", title: count >= 2 ? `${name} · ${count} new messages` : name,
//                 body: truncate(messageLabel(dto), 120) }   topic: "duet-chat"
// count = SELECT count(*) FROM messages WHERE sender_id = sender AND seq > recipient.last_read_seq
```
`topic` must be base64url characters and ≤ 32 long (`web-push` validates `/^[A-Za-z0-9\-_]+$/`). `"duet-chat"` passes. Apple coalesces undelivered pushes with the same Topic, so an offline phone wakes to one notification carrying the newest count. Keep the payload well under Apple's **4 KB** limit `[CITED: Apple docs, PayloadTooLarge]`.

### Pattern 10: Client push subscribe (in the tap handler)

```ts
// Pre-resolve `reg = await navigator.serviceWorker.ready` and the VAPID key on mount, so the tap
// handler does no slow awaits before the permission prompt (iOS needs a direct user gesture).
async function enable() {
  const perm = await Notification.requestPermission()
  if (perm !== "granted") return setState(perm === "denied" ? "blocked" : "off")
  const sub = (await reg.pushManager.getSubscription()) ??
    (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64urlToUint8(vapidKey) }))
  await apiPost("/api/push/subscriptions", sub.toJSON(), OkResponse)
}
// On every app launch while logged in and permission === "granted": getSubscription() → re-POST (upsert).
// iOS loses subscriptions silently and never fires pushsubscriptionchange.
```
Standalone check: `matchMedia('(display-mode: standalone)').matches || (navigator as any).standalone === true`. iOS check: `/iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)`.

### Pattern 11: Voice recording

```ts
const CANDIDATES = ["audio/mp4", "audio/webm;codecs=opus", "audio/webm"]
const mimeType = CANDIDATES.find((t) => MediaRecorder.isTypeSupported(t))
const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } })
const rec = new MediaRecorder(stream, mimeType ? { mimeType } : undefined)
const chunks: Blob[] = []
rec.ondataavailable = (e) => e.data.size && chunks.push(e.data)
rec.onstop = () => { stream.getTracks().forEach((t) => t.stop())            // clears the iOS mic indicator
  const blob = new Blob(chunks, { type: rec.mimeType || mimeType || "application/octet-stream" }) }
rec.start()            // NO timeslice (iOS empty-blob bug with tiny timeslices, Pitfall 9 in research)
```
The pending voice bubble shows flat placeholder bars. The real waveform arrives with the `msg` update once the server finishes.

### Anti-Patterns to Avoid
- **Suppressing a push inside the SW** (an early return when the app is open) gets iOS permission revoked. Suppress on the server.
- **One 200 MB request.** Cloudflare Free rejects anything over 100 MB at the edge, before it reaches duet.
- **Serving `original`.** It may be HEIC with GPS EXIF, or a mislabeled file. If served as `text/html` on the app origin, it becomes stored XSS. Only serve generated variants with fixed MIME types.
- **Relying on `audio.duration` / `video.duration`.** MediaRecorder output reports `Infinity`/NaN. Use the server's `durationMs`.
- **Deriving "viewing" from "socket exists".** A frozen iOS socket looks open for up to ~50 s (25 s ping + missed pong).
- **Writing to the DB from `hub.ts`.** Phase 1 kept the hub DB-free (the session check is injected). Keep it that way. Routes write, then call hub methods.
- **Per-chat SQLite timestamps as cursors.** Use the integer `updated_seq`, never `updated_at` (clock skew, same-ms ties).

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Web Push encryption + VAPID JWT | aes128gcm + ES256 by hand | `web-push` | RFC 8291/8292 details; Apple rejects malformed JWTs with 403 BadJwtToken |
| HEIC decoding | Parsing HEIF grids | `heif-convert` (libheif + libde265) | iPhone HEIC is a tiled HEVC grid. sharp's prebuilt libvips can't decode HEVC (verified) |
| Image resize / EXIF rotate / strip | Canvas on the server, ffmpeg for stills | `sharp` | Autorotate, metadata strip and pixel limits in one call |
| Video/audio normalization | Client-side ffmpeg.wasm, MediaRecorder re-encode | Server `ffmpeg` | Out of scope per REQUIREMENTS. One normalization point |
| HTTP Range / 206 / 416 / ETag | A custom byte-range handler | `@fastify/static` `reply.sendFile` | Verified behaviour. Easy to get wrong for Safari |
| Bottom-anchored list with prepend that keeps position | Scroll-height math | `message-scroller` (`@shadcn/react`) | `preserveScrollOnPrepend` defaults to true |
| Swipe carousel for the viewer | Touch math | `carousel` (Embla) from the registry | Preset component |
| UUIDs | Math.random IDs | `crypto.randomUUID()` (client) / `randomBytes(16).toString('base64url')` (server attachment ids) | Collision-free and unguessable |

**Key insight:** most of this phase's risk sits in cross-device formats (HEIC, HEVC/HDR, MediaRecorder containers) and in iOS push rules. Both are handled by mature native tools on the server plus a strict "always show a notification" SW. The custom code that remains, outbox, cursor sync and presence, is small and pure enough to unit test.

## Common Pitfalls

### Pitfall 1: Cloudflare Free plan's 100 MB request-body cap
**What goes wrong:** A 150 MB clip upload fails at the Cloudflare edge with 413 and never reaches Fastify.
**Why:** Request body limits are tied to the plan: Free 100 MB, Pro 100 MB, Business 200 MB `[CITED: developers.cloudflare.com/workers/platform/limits]`. The `brkn.me` zone plan is "Free Website" `[VERIFIED: Cloudflare API /zones?name=brkn.me, read-only, 2026-10-10]`.
**How to avoid:** Use 8 MiB chunks (Pattern 5). Never set a single-request limit above ~90 MB.
**Warning signs:** HTTP 413 with a Cloudflare-branded body. Nothing in duet's logs.

### Pitfall 2: iOS ignores `tag`/`renotify`, so notifications pile up
**What goes wrong:** D-14's "collapse into one" works on Pixel, but iOS stacks one notification per message.
**Why:** MDN BCD: Safari `Notification.tag` "can be set, but has no effect" (webkit.org/b/258922), and `options_renotify_parameter` is unsupported `[VERIFIED: mdn/browser-compat-data api/Notification.json, api/ServiceWorkerRegistration.json]`.
**How to avoid:** In the push handler, close all open notifications (`getNotifications()` + `close()`, both iOS 16.4+ per BCD) before `showNotification`. Put the running count in the server-computed title. Still set `tag`/`renotify` for Android.
**Warning signs:** Several duet notifications in iOS Notification Center. Behaviour on iOS is `[ASSUMED]` until device UAT.

### Pitfall 3: A silent push gets permission revoked on iOS
**What goes wrong:** Pushes stop on the iPhone after a few days.
**Why:** "Safari doesn't support invisible push notifications… If you don't, Safari revokes the push notification permission" `[CITED: Apple docs]`.
**How to avoid:** `event.waitUntil(showNotification(...))` on every path. Wrap the close loop and JSON parse in try/catch so nothing throws before `showNotification`.

### Pitfall 4: VAPID subject and JWT rules (Apple 403 BadJwtToken)
**What goes wrong:** Android works and iPhone gets nothing. Logs show 403 from `web.push.apple.com`.
**Why:** Apple rejects a JWT whose subject isn't a URL or `mailto:`, or whose exp is more than one day ahead `[CITED: Apple docs]`. web-push defaults to a 12 h exp, so that's fine `[VERIFIED: vapid-helper.js:14 DEFAULT_EXPIRATION_SECONDS = 12 * 60 * 60]`. It throws on a non-https/mailto subject and warns on localhost.
**How to avoid:** `VAPID_SUBJECT=https://duet.brkn.me`. A URL subject avoids putting a personal email in push-service logs. Tests use their own https subject, because the test `APP_ORIGIN` is `http://localhost:3000`. Log push failures per endpoint host with the status code.
**Note:** Apple also says "Don't refresh your JWT more frequently than once per hour". web-push signs a new JWT per send. At two users' volume that is very likely harmless `[ASSUMED]`. If 429/403 ever show up, cache `getVapidHeaders()` per audience and pass them via `headers` with `vapidDetails: null` (the option path was confirmed in the source).

### Pitfall 5: sharp "supports HEIF", but not iPhone HEIC
**What goes wrong:** HEIC uploads fail or render as broken tiles on the Pixel.
**Why:** The prebuilt libvips only ships AV1 HEIF (AVIF). `sharp.format.heif.input.fileSuffix` is `['.avif']`. On a real iPhone HEIC, `metadata()` returned `format heif / compression hevc` and decode threw "bad seek" `[VERIFIED: executed sharp 0.35.5]`.
**How to avoid:** Branch on `metadata().compression === 'hevc'` and use `heif-convert` (Pattern 6). ffmpeg 5.1 isn't a substitute: proper HEIF grid support only arrived in later ffmpeg releases `[ASSUMED]`.

### Pitfall 6: iPhone HDR video looks washed out after transcode
**What goes wrong:** Clips play but look grey or flat.
**Why:** Modern iPhones record 10-bit HEVC HLG (Dolby Vision 8.4). A plain `format=yuv420p` keeps `color_transfer=arib-std-b67` on an 8-bit H.264 stream (verified: the "SDR path" output still had `arib-std-b67`).
**How to avoid:** Use the tone-map chain when `color_transfer` is HLG/PQ. It produced `bt709` (verified).

### Pitfall 7: Unsafe ffmpeg input handling
**What goes wrong:** A crafted "video" that is really an HLS/concat playlist makes ffmpeg read local files or URLs. This is a classic ffmpeg SSRF/LFI.
**How to avoid:** Allowlist `ffprobe` `format_name`, then pass `-f mov|matroska|…` explicitly. Never use a shell, keep `-nostdin`, and set a kill timeout. Both uploaders are authenticated, which lowers the risk without removing it.

### Pitfall 8: A frozen iOS WebSocket looks open
**What goes wrong:** After resume, nothing arrives, the typing indicator sticks, and pushes stay suppressed.
**How to avoid:** On `visibilitychange→visible` and `pageshow(persisted)`, send `{t:"ping"}`. If no `pong` comes within 2 s, close and reconnect. Always run `/api/sync` on visible. Reconnect with backoff 0.5 s → 8 s plus jitter, and immediately on `online`. Close the old socket before opening a new one. 4401 means logged out: go to the login tiles. The 25 s server ping already exists (`server/src/app.ts:80`: `heartbeatMs: deps.heartbeatMs ?? 25_000`).

### Pitfall 9: Push subscription bound to a logged-out device
**What goes wrong:** After logout, or once a session is revoked, a phone keeps getting the other person's message previews on its lock screen.
**How to avoid:** `push_subscriptions.session_id → sessions.id ON DELETE CASCADE`. Logout already deletes the session row (`server/src/auth/routes.ts`), so the subscription goes with it. Re-POST on launch re-binds to the current session.

### Pitfall 10: Media 404s cached as immutable
**What goes wrong:** A tile requested before processing finished stays broken forever.
**How to avoid:** Only `status === 'ready'` responses get `private, max-age=31536000, immutable`. 404s get `no-store`. The client loads a `poster`/`video` URL only after the attachment is `ready`, and re-renders on the `msg` update.

### Pitfall 11: Long-press and swipe fight native gestures
**What goes wrong:**
- On iOS the system callout or text selection appears.
- On Android, Chrome fires `contextmenu` on long-press as well as your 450 ms timer, so the popover toggles twice.
- Horizontal swipe handling kills vertical scrolling.

**How to avoid:**
- Bubbles get `select-none [-webkit-touch-callout:none]` (UI-SPEC).
- Use one open path: `preventDefault()` on `contextmenu` and treat it as "open". Cancel the timer on movement over 8 px.
- Use pointer events with `touch-action: pan-y` on the row, and only capture horizontally after `|dx| > |dy|` and `dx > 8`.
- `navigator.vibrate` doesn't exist on iOS (BCD), so call it as `navigator.vibrate?.(10)`.

### Pitfall 12: The preset `PopoverContent` can't take an `anchor`
**What goes wrong:** You can't anchor one shared popover to an arbitrary bubble. The base-luma `PopoverContent` only forwards `align|alignOffset|side|sideOffset` to the Positioner (`npx shadcn view popover`, this session).
**How to avoid:** Without editing `components/ui/popover.tsx`, make each bubble the `PopoverTrigger` (`render={<div …/>}`, `nativeButton={false}`) with a controlled `open`. In `onOpenChange(open, details)`, ignore `details.reason === 'trigger-press'` so a plain tap doesn't open it (taps mean retry, or nothing). Open from the long-press timer, `contextmenu` and keyboard Enter. Base UI 1.8.0 types include the reasons `'trigger-press'`, `'outside-press'`, `'escape-key'` `[VERIFIED: node_modules/@base-ui/react/popover/root/PopoverRoot.d.ts:84]`. A closed Popover renders nothing heavy, because the portal isn't mounted `[ASSUMED]`.

### Pitfall 13: The iOS keyboard pushes the header off-screen
**What goes wrong:** In a standalone PWA, focusing the composer scrolls the whole page.
**How to avoid:**
- The app container becomes a fixed-height column (`h-dvh overflow-hidden`; Phase 1's `shell.tsx:43` is `min-h-dvh`) with the list as the only scroller.
- Add `interactiveWidget: 'resizes-content'` to `viewport` in `layout.tsx`. The type exists in Next 16.3.8 (`extra-types.d.ts:53`), and it only takes effect in Chrome.
- On iOS, size the container from `window.visualViewport.height` on `resize`/`scroll`.

This is `[ASSUMED]`; confirm on a device.

### Pitfall 14: Read receipts sent while not really viewing
**How to avoid:** Send `POST /api/read` only when `document.visibilityState === 'visible' && document.hasFocus()`, using the max `seq` among `useMessageScrollerVisibility().visibleMessageIds`, debounced 500 ms.

### Pitfall 15: Catch-up deltas for messages outside the loaded window
**How to avoid:** Ignore `msg` updates with `seq < oldestLoadedSeq` (Pattern 2). Otherwise a reaction on a year-old message gets inserted between today's messages.

### Pitfall 16: StrictMode double-mount opens two sockets in `next dev`
**How to avoid:** The realtime connection is a module-level singleton, or the effect cleanup closes it. Two sockets mean double typing frames and double presence.

### Pitfall 17: Dev proxy only covers `/api`
`web/next.config.ts:16` is `return [{ source: "/api/:path*", destination: "http://localhost:3100/api/:path*" }]`. Add `/media/:path*` for `next dev`. WS already connects straight to `:3100` in dev (`web/lib/ws.ts`).

## Code Examples

### Hub additions (keep it DB-free)
```ts
// server/src/ws/hub.ts — extend Conn { visible: boolean; lastSeenAt: number }
publishToUsers(userIds: string[], frame: ServerFrame) {
  for (const c of conns.values()) if (userIds.includes(c.userId)) send(c, frame)
},
isViewing(userId: string, now = Date.now()) {
  for (const c of conns.values())
    if (c.userId === userId && !c.closing && c.visible && now - c.lastSeenAt < 45_000) return true
  return false
},
// onMessage switch: case "ping": send(conn, { t: "pong" }); case "presence": conn.visible = frame.visible;
// case "typing": for (const c of conns.values()) if (c.userId !== conn.userId) send(c, { t: "typing", userId: conn.userId })
// set conn.lastSeenAt = Date.now() at the top of onMessage and in the "pong" listener.
```
Existing frame budget: `WS_MAX_FRAMES_PER_SECOND = 100` (`shared/src/ws.ts:14`). A typing frame every 3 s plus presence every 20 s is far below that.

### Chunk route (verified mechanics)
```ts
export const UPLOAD_CHUNK_SIZE = 8 * 1024 * 1024
app.addContentTypeParser("application/octet-stream", { parseAs: "buffer", bodyLimit: UPLOAD_CHUNK_SIZE },
  (_req, body, done) => done(null, body))
app.put("/api/uploads/:id/chunks/:index", { onRequest: requireUser, bodyLimit: UPLOAD_CHUNK_SIZE }, async (req, reply) => {
  // validate id regex + row (uploaderId === me, status 'uploading'), index < ceil(declaredSize / CHUNK),
  // exact expected length; writeFile(`${dir}/${index}.part.tmp`) then rename → `${index}.part`
  return reply.code(204).send()
})
```
The root error handler (`server/src/app.ts:59-61`) already maps `FST_ERR_CTP_*` to `{error:"invalid_body"}` and keeps a `< 500` status code, so an oversized chunk answers 413.

### Shared pure helpers (testable from server vitest)
```ts
export const REACTIONS = ["💕", "💔", "😋", "😝", "😘", "😭"] as const      // D-04, all single code points
export function messageLabel(m: Pick<MessageDto, "kind" | "body" | "attachments">): string {
  if (m.kind === "text") return m.body ?? ""
  if (m.kind === "voice") return "🎤 Voice note"
  const imgs = m.attachments.filter((a) => a.kind === "image").length, vids = m.attachments.length - imgs
  const label = vids === 0 ? (imgs === 1 ? "📷 Photo" : `📷 ${imgs} photos`)
              : imgs === 0 ? (vids === 1 ? "🎥 Video" : `🎥 ${vids} videos`) : `📷 ${imgs + vids} items`
  return m.body ? `${label} · ${m.body}` : label                         // D-13 + UI-SPEC §7
}
```

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| iOS: no web push | Web Push for Home Screen web apps | iOS 16.4 | Requires install + gesture + standalone (SHEL-03 guide) |
| Safari MediaRecorder: MP4/AAC only | Also WebM/Opus | Safari 18.4 `[CITED: addpipe table, secondary]` | Don't assume the container per platform. Probe `isTypeSupported` and normalize on the server |
| Declarative Web Push | Optional on iOS 18.4+ | 2025 | Not needed. The SW path works everywhere |
| `-metadata rotate=` tag | Display-matrix side data (`-display_rotation` in newer ffmpeg) | ffmpeg 6+ | bookworm's 5.1 has no `-display_rotation` (verified), but autorotate on input works |

**Deprecated/outdated:** `@fastify/static` v10 `setHeaders(reply, …)` takes a Fastify reply first. Phase 1 already handled this.

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | Closing existing notifications before `showNotification` collapses them on iOS | Pitfall 2, Pattern 8 | iOS stacks notifications. A cosmetic D-14 miss; push still works |
| A2 | The visualViewport sizing approach keeps the composer visible on the iOS standalone keyboard | Pitfall 13 | Layout jank on iPhone; fixed during UAT |
| A3 | Media/voice outbox in memory only (lost if iOS kills the app mid-upload). Text outbox persisted | Pattern 3 | A pending photo vanishes after an app kill. The user re-sends. Confirm this is acceptable |
| A4 | Use a plain external store instead of TanStack Query (deviation from the CLAUDE.md stack note) | Standard Stack | None functionally. Planner may override |
| A5 | Use chunked raw PUTs instead of `@fastify/multipart` (deviation from the stack note) | Standard Stack | None. Forced by the 100 MB cap |
| A6 | Image upload cap of 50 MB. Display 2048 px WebP q82, thumb 640 px WebP q70, video max 1280 px CRF 23, voice AAC 64k mono, 40 bars | Pattern 5/6 | Quality and size tuning only (Claude's discretion) |
| A7 | Server video duration cap of 200 s ("about 3 minutes") | Pattern 6 | A 3:10 clip is rejected or accepted unexpectedly |
| A8 | New frame/route names (`msg`, `read`, `presence`, `/api/sync`, …) | Protocol | Naming only |
| A9 | Per-send VAPID JWT is fine for Apple at this volume | Pitfall 4 | Possible 429/403; fix by caching headers |
| A10 | The drizzle 0.45 `index`/`primaryKey`/`AnySQLiteColumn` third-argument array syntax | Data model | A typecheck error the executor fixes quickly |
| A11 | Cloudflare passes `Range` through and doesn't cache extensionless `private` media | Pattern 7 | Seek breaks through the tunnel. Verify with `curl -H 'Range: bytes=0-1'` after deploy |
| A12 | Default `VAPID_SUBJECT` = APP_ORIGIN (https) rather than an email | Pitfall 4 | None if Apple accepts URL subjects, which its docs say it does |

## Open Questions

1. **Keep video/voice originals after a successful transcode?**
   - What we know: D-09 locks "keep photo originals forever". D-08/D-12 say nothing about video or voice originals. The host disk has **26 GB free (73% used)**. A 200 MB original plus its MP4 per clip adds up fast.
   - Recommendation: delete video and voice originals after a successful transcode, and keep them on failure. Confirm with the user. It's a one-line change either way.
2. **Image size cap.** iPhone ProRAW/48 MP HEIC can reach 75 MB+. A 50 MB cap might reject some. Recommendation: 100 MB per image (chunked, so Cloudflare allows it).
3. **Should "Send test notification" target only this device or all of the user's devices?** Recommendation: this session's subscriptions only, since it tests this phone.

## Environment Availability

| Dependency | Required By | Available | Version | Fallback |
|------------|------------|-----------|---------|----------|
| Docker / Compose | Build + deploy | ✓ | 29.6.1 | — |
| `node:24-bookworm-slim` | Runtime image | ✓ (cached) | node 24.21.0, Debian 12.15 | — |
| ffmpeg/ffprobe in the container | MDIA-03/04 | ✓ after apt in the Dockerfile | 5.1.9 | — |
| heif-convert in the container | MDIA-01 HEIC | ✓ after apt in the Dockerfile | 1.15.1 | — |
| ffmpeg on the host (vitest) | Media unit tests | ✓ | 8.0.1 (newer than the container's) | Tests stick to features common to both |
| heif-convert on the host | HEIC unit test | ✗ | — | `it.skipIf(!hasHeifConvert)`. HEIC is proven in a container smoke step (`docker compose exec duet heif-convert …`) and on a device |
| Node on the host | vitest, tsx | ✓ | 22.23.1 (container 24) | sharp needs ≥ 20.9 ✓ |
| Cloudflare zone plan | Upload sizing | Free (100 MB body) | — | Chunking (required) |
| Disk (`./data`) | Media kept forever | 26 GB free | — | Open Question 1 |
| CPU | Transcode | 16 cores, 14 GB RAM | — | Serial video lane + `nice` |
| iPhone + Pixel | Push/HEIC/HEVC/voice UAT | human | — | None. End-of-phase UAT |
| VAPID keypair | NOTF-01 | ✗ (not generated) | — | `npx web-push generate-vapid-keys` once. Write to `.env` via a small script (never printed or committed) |

**Missing with no fallback:** none, apart from real devices for UAT.
**Missing with fallback:** host heif-convert (skip + container smoke), VAPID keys (generate in a plan task).

## Verification Approach

Nyquist validation is disabled (`workflow.nyquist_validation: false`), so this is a brief map, not a formal architecture. The existing server suite passes: **9 files / 145 tests via `npm test` (vitest 5.0.3, `pool: "forks"`)**.

- **Server (vitest + `app.inject` + the existing `openWs` helpers in `server/test/helpers.ts`):**
  - send idempotency (same `id` twice → one row, both responses identical)
  - sync cursor deltas, including reaction bumps
  - read monotonicity
  - reaction replace/remove and allowlist rejection
  - WS fan-out to both users and the sender's second device
  - typing relayed to the peer only
  - `isViewing` gates an injected push sender (add `push?` to `AppDeps`, mirroring the `fetch` injection pattern)
  - 404/410 prunes a subscription
  - logout cascades the subscription
  - chunk upload (exact lengths, idempotent retry, 413 oversize, 401 before body parse)
  - `/media` 401/200/206/416 + `no-store` on not-ready
  - ffmpeg pipeline on lavfi-generated fixtures (rotation, HLG, webm voice duration, peaks length 40)
- **Shared pure logic:** `messageLabel`, `albumCountLabel`, merge/outbox transitions, tested from the server vitest (Phase 1 precedent for `callVerdict`).
- **Container smoke** (after `docker compose up -d --build`): `docker compose exec duet sh -c 'ffmpeg -version | head -1; heif-convert --help | head -1'`, an upload → ready round-trip on the public URL, `curl -H 'Range: bytes=0-1'` → 206 with `cf-cache-status: DYNAMIC`.
- **Device UAT (end of phase):**
  - HEIC from iPhone shows on Pixel
  - iPhone HEVC/HDR clip plays on Pixel
  - voice notes play both ways with a working scrubber
  - push while closed on both phones, tap opens the chat, none while viewing, test push
  - airplane-mode outbox flush with no duplicates
  - resume catch-up

## Security Domain

`security_enforcement: true`, ASVS level 1, block on high.

### Applicable ASVS Categories

| ASVS Category | Applies | Standard Control |
|---------------|---------|-----------------|
| V2 Authentication | yes (reuse) | Existing argon2id + session cookie. Every new route uses `requireUser`; upload chunks use it at `onRequest` |
| V3 Session Management | yes | `/ws` keeps `requireUserNoRenew` + 4401. Push subscriptions cascade with the session |
| V4 Access Control | yes | Two users share one conversation. Attachments can only be attached by their uploader and only once (`message_seq IS NULL`). Reactions and read state are keyed to `request.user.id`, never to a body field |
| V5 Input Validation | yes | zod (strict client frames, REST bodies), `REACTIONS` allowlist on write, id regexes, exact chunk lengths, declared-size caps, ffprobe format allowlist, sharp pixel limit |
| V6 Cryptography | yes | `web-push` (RFC 8291/8292), never hand-rolled. VAPID private key only in `.env`. Attachment ids are 128-bit `randomBytes` |
| V12 Files & Resources | yes | Server-generated paths only (no client filenames on disk), originals never served, fixed MIME per variant, `nosniff` (already global), no shell in child processes |
| V13 API | yes | Global Origin guard on non-GET (CSRF). `SameSite=Lax` blocks cross-site `<img src=/media/…>` hotlinking with cookies |

### Known Threat Patterns for this stack

| Pattern | STRIDE | Standard Mitigation |
|---------|--------|---------------------|
| Crafted media → ffmpeg playlist LFI/SSRF | Information disclosure | ffprobe `format_name` allowlist + explicit `-f`, no shell, timeouts |
| Stored XSS via an uploaded "image" served as HTML | Tampering | Never serve `original`. Variants are regenerated by sharp/ffmpeg with fixed Content-Type. `X-Content-Type-Options: nosniff` |
| Unauthenticated memory pressure through chunk uploads | DoS | `onRequest: requireUser` before parsing, an 8 MiB `bodyLimit`, a per-upload declared-size cap, 24 h tmp cleanup |
| Lock-screen previews after logout | Information disclosure | Subscription → session FK `ON DELETE CASCADE` |
| GPS location kept in shared photos | Information disclosure | Display/thumb variants are metadata-free (verified). The original stays on disk only (D-09) |
| Cross-site WebSocket hijack | Spoofing | Existing `/ws` Origin + cookie check (`server/src/ws/routes.ts:19`) |
| Message text XSS | Tampering | React text rendering only. No `dangerouslySetInnerHTML`. No link previews (out of scope) |
| Edge caching private media | Information disclosure | Extensionless URLs + `Cache-Control: private` |

## Suggested Plan Breakdown (for the planner)

| Plan | Wave | Scope | Requirements |
|---|---|---|---|
| 02-01 | 1 | **All** Phase 2 tables in one migration. `shared/src/chat.ts` + `chat-logic.ts` + ws frames. Chat REST (send/history/sync/react/read). Hub fan-out/typing/presence/ping. Tests | CHAT-01..09 (server) |
| 02-02 | 2 | Chat UI: shadcn adds, store + realtime + outbox, list/markers/status/typing, long-press popover + reactions, swipe reply + quote jump, composer, h-dvh layout | CHAT-01..09 (client) |
| 02-03 | 2 | Push: VAPID config/script, subscription + test routes, sender + suppression + prune, SW handlers, A2HS guide, notifications card/drawer | NOTF-01..03, SHEL-03 |
| 02-04 | 2 | Media server: chunked uploads, processing queues (sharp/heif-convert/ffmpeg), `/media` route, Dockerfile apt, tests | MDIA-01,03,04,05 (server) |
| 02-05 | 3 | Media UI: picker + preview drawer + album grid + viewer, recorder + voice bubble/waveform. Deploy + public smoke + end-of-phase device UAT | MDIA-01..05 (client), all UAT |

Wave-2 plans all touch `server/src/app.ts` registration lines and `web/components/app/shell.tsx`. The planner should either serialize those edits or give each plan its own registration line or route file to avoid merge conflicts.

## Sources

### Primary (HIGH confidence)
- **Executed this session in `node:24-bookworm-slim`:**
  - apt versions: ffmpeg 5.1.9, libheif 1.15.1; size delta ~431 MB
  - sharp 0.35.5 on a real iPhone HEIC (decode fails) and on the heif-convert JPEG (works, EXIF stripped)
  - ffmpeg rotation, HLG tone-map, faststart, poster
  - webm/opus and fragmented-mp4 voice → m4a durations; PCM peaks
- **Executed against the repo's node_modules:**
  - Fastify 5.12.5 octet-stream `parseAs:'buffer'` + route `bodyLimit` → 413; route `onRequest` auth runs before parsing
  - @fastify/static 10.1.5 `sendFile` 200/206/416 with custom Cache-Control
  - drizzle-orm 0.45.4 sync transaction + returning
- **Source read:**
  - `web-push-3.6.7` tarball (`web-push-lib.js`, `vapid-helper.js`, `web-push-error.js`)
  - `@shadcn/react-0.3.1` dist (`message-scroller` types/defaults)
  - `npx shadcn view message-scroller popover` (base-luma)
  - `@base-ui/react` 1.8.0 `PopoverRoot.d.ts`
  - libheif v1.15.1 `examples/encoder_jpeg.cc`
- **MDN browser-compat-data** (raw GitHub): `api/Notification.json`, `api/ServiceWorkerRegistration.json`, `api/Clients.json`, `api/WindowClient.json`, `api/Navigator.json`
- **Apple:** [Sending web push notifications in web apps and browsers](https://developer.apple.com/documentation/usernotifications/sending-web-push-notifications-in-web-apps-and-browsers) (via the JSON doc API): headers, error reasons, the 4 KB payload limit, the no-invisible-push rule
- **Cloudflare API** (read-only): zone `brkn.me` plan = Free Website. Live header checks on `https://duet.brkn.me` (`/sw.js` cached by extension; `/`, `/api/*` DYNAMIC)
- **Repo files read:** `server/src/{app,config,index}.ts`, `server/src/ws/{hub,routes}.ts`, `server/src/auth/{session,routes}.ts`, `server/src/http/guards.ts`, `server/src/db/{schema,client}.ts`, `shared/src/{ws,api,index}.ts`, `web/{public/sw.js,lib/ws.ts,lib/api.ts,app/page.tsx,app/layout.tsx,app/manifest.ts,next.config.ts,components.json}`, `web/components/app/{shell,sw-register}.tsx`, `Dockerfile`, `compose.yaml`, `server/test/helpers.ts`

### Secondary (MEDIUM confidence)
- [Cloudflare Workers platform limits: request body size by plan](https://developers.cloudflare.com/workers/platform/limits/)
- [sharp installation (prebuilt formats, Node requirement)](https://sharp.pixelplumbing.com/install)
- [Fastify ContentTypeParser docs](https://fastify.dev/docs/latest/Reference/ContentTypeParser/)
- [MDN showNotification](https://developer.mozilla.org/en-US/docs/Web/API/ServiceWorkerRegistration/showNotification) (renotify requires tag)
- `.planning/research/PITFALLS.md` (Pitfalls 5, 9–14) and `ARCHITECTURE.md` (Patterns 1–4, data model). The SFU parts are historical

### Tertiary (LOW confidence)
- [Addpipe MediaRecorder demo table](https://addpipe.com/tech-demos/media-recorder-api-demo/) (Safari 18.4 WebM/Opus), [WebKit bug 290223](https://bugs.webkit.org/show_bug.cgi?id=290223), [WebKit bug 290002](https://bugs.webkit.org/show_bug.cgi?id=290002), [frequal: Ogg Opus in Safari 18.4](https://frequal.com/java/OggOpusStillNotWorkingInSafari18_4.html)
- [Braze: Safari mobile web push](https://braze.com/docs/developer_guide/platform_integration_guides/web/push_notifications/safari_mobile_push), [Notificare: Web Push in iOS Safari](https://notificare.com/blog/2023/03/27/web-push-in-ios-safari/) (background only)

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH. Versions come from registries and apt in the actual base image. The key HEIC/HEVC/Range/bodyLimit behaviours were executed.
- Architecture: HIGH for the server, which extends verified Phase 1 code with verified library mechanics. MEDIUM for client gestures and layout on iOS.
- Pitfalls: HIGH for Cloudflare limits, sharp HEIC, ffmpeg HDR/rotation and Range. MEDIUM for iOS notification collapse and keyboard behaviour (BCD/docs, not yet on a device).

**Research date:** 2026-10-10
**Valid until:** 2026-11-09 (30 days; web-push and the Debian packages are stable; iOS behaviour should be rechecked at device UAT)
