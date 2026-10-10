# Phase 2: Chat, Media & Push - Context

**Gathered:** 2026-10-10
**Status:** Ready for planning

<domain>
## Phase Boundary

This phase delivers real-time 1:1 text chat with history kept forever. It covers sending, sent, read and failed states, an offline queue with dedup-safe retry, catch-up on resume, typing indicator, read receipts, reactions and quoted replies. It adds photo and video sharing (including iPhone HEIC and HEVC `.MOV`, transcoded so both phones can play them), recorded voice notes with a scrubber, auth-gated media served with Range support, and web push for new messages, plus first-run onboarding for Add to Home Screen, notifications and a test push.

Requirements: CHAT-01..09, MDIA-01..05, NOTF-01..03, SHEL-03.

Calls are not in this phase (Phase 3). This phase also excludes deleting messages, the unread badge, drafts and search (v2: CHAT-10..13).

</domain>

<decisions>
## Implementation Decisions

### Carried forward (Phase 1, still binding)
- The UI uses only the shadcn preset `b51GFhBEQ` (Base UI + Phosphor, `npx shadcn add` only), always dark, with the rose accent. Do not use lucide, Radix snippets or emoji-picker libraries.
- Phase 2 builds on the chat-shaped shell from Phase 1 D-11: a header with the other person's name and initials Avatar, plus a logout menu.
- One Fastify process serves static `web/out`, `/api`, `/ws` and `/media`. The database is SQLite + Drizzle, and media lives on local disk under `./data`.

### Chat feel & gestures
- **D-01:** You react and reply through **both gestures**. **Swipe right** on a bubble to reply. **Long-press** opens a menu with the reaction row, **Reply** and **Copy**.
- **D-02:** A quoted reply shows a compact quote of the original (author + snippet, or a media label/thumbnail) above the new bubble. Tapping the quote scrolls to the original and highlights it, loading older history if needed.
- **D-03:** Read receipts are **iMessage style**. A small status line ("Sending…", "Sent", "Read 9:41") shows only under **your most recent message**. A failed message shows an inline error/retry affordance on that bubble, and tapping it retries.
- **D-04:** The reactions are a **fixed set of six: 💕 💔 😋 😝 😘 😭**. Each person can have one reaction per message. Choosing a different one replaces it, and tapping your current one removes it. Reactions render as a small chip on the bubble. — **Reversibility:** reversible. The set is a constant in `shared/`. Stored emoji stay valid even if the set changes later.

### Sending photos & videos
- **D-05:** A single **"+" attach button** in the composer opens the native OS picker (`<input type="file" accept="image/*,video/*" multiple>`), which offers Take Photo/Video, Photo Library and Files. There are no separate camera and gallery buttons.
- **D-06:** After you pick, a **preview sheet** shows the selection with an **optional caption** field, Send and Cancel. Nothing sends without an explicit Send.
- **D-07:** Several items go out as **one album message, shown as a grid**: up to **10 items**, **photos and videos mixed**, with **one caption**. Tapping any tile opens a **full-screen viewer you swipe through** that covers the album's items, which satisfies MDIA-02. A single item is just an album of one. — **Reversibility:** costly. The message → attachments (1..10) schema shape and the grid layout are hard to change once history exists, because changing them needs a data migration.
- **D-08:** The video cap is **about 3 minutes / 200 MB per clip**. The server transcodes every clip to **H.264/AAC MP4** with `ffmpeg` (added to the Docker image) and extracts a poster frame. Until the transcode finishes, the bubble shows a processing state.
- **D-09:** Photos keep the **original file forever, HEIC included**. The server generates a **display copy** (JPEG or WebP, at a sensible max dimension) plus a small thumbnail for the grid. Clients display the copy, so HEIC renders on the Pixel.

### Voice notes
- **D-10:** Recording supports **both modes**. **Hold the mic** to record and release to send, with **slide to cancel**. You can also **lock** a recording (slide up, or tap) for hands-free long notes, which shows a timer and Cancel/Send. While the text field is empty, the mic button takes the Send button's place.
- **D-11:** Voice notes have **no length limit**. The server's per-upload size cap (the same order as the 200 MB media cap) is the only backstop.
- **D-12:** Playback is a **play button plus a waveform scrubber**. The waveform is computed (client-side at record time, or server-side) and drawn as bars, and you drag on it to seek. The duration shows. The voice note must play on both phones, so recordings from iOS (`audio/mp4`/AAC) and Chrome (`audio/webm`/Opus) need a common playable format. The server may transcode them to AAC/M4A.

### Push & onboarding
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

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Scope & requirements
- `.planning/ROADMAP.md` §"Phase 2: Chat, Media & Push": goal and the 5 success criteria
- `.planning/REQUIREMENTS.md`: CHAT-01..09, MDIA-01..05, NOTF-01..03, SHEL-03 (and v2 CHAT-10..13, which are explicitly out)
- `.planning/PROJECT.md`: constraints (locked preset, self-hosted, speed first)

### Prior decisions & stack
- `.planning/phases/01-foundation-auth-media-plane/01-CONTEXT.md`: D-04..D-11 (login, session, dark theme, chat shell), D-16 (P2P + WS hub)
- `.claude/CLAUDE.md` / stack notes: Fastify plugins (`@fastify/multipart`, `@fastify/static` Range), `web-push` VAPID rules (`userVisibleOnly`, TTL/urgency/topic, delete on 404/410), TanStack Query patching from WS, the hand-written `public/sw.js`, and no Serwist
- `.planning/research/` (ARCHITECTURE.md, PITFALLS.md if present): iOS push and PWA pitfalls, media pitfalls

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- `web/components/ui/`: avatar, badge, button, card, dropdown-menu, empty, field, input, item, label, separator, sonner, spinner, switch. Phase 2 will need more through `npx shadcn add` (e.g. textarea/input-group, popover, drawer/sheet, dialog, slider, skeleton, and the chat primitives message/bubble/message-scroller/attachment/marker, if available in the registry).
- `web/public/sw.js`: an installability-only SW. Phase 2 adds `push` and `notificationclick` handlers. It must stay non-intercepting for `/media` (auth + Range).
- `server/src/ws/hub.ts`: an in-memory, DB-free hub keyed by connection, with heartbeat, a session liveness re-check, and per-connection rate limits. Chat frames (message events, typing, read, reaction) extend this hub or sit beside it.
- `shared/src/ws.ts`: a zod-typed frame protocol discriminated by `t`, with strict client frames and tolerant server frames. Add chat frames here.
- `server/src/auth/session`, `server/src/http/guards.ts`: session auth and the Origin check, to reuse for `/api/messages`, uploads and the `/media` auth hook.

### Established Patterns
- Shared zod schemas in `@duet/shared` for every REST body and WS frame.
- Drizzle schema in `server/src/db/schema.ts` (users, sessions), with migrations run at boot.
- The Dockerfile uses a build/runtime split on `node:24-bookworm-slim`. ffmpeg (and any HEIC decoder) must be added to the runtime stage.

### Integration Points
- The chat shell page (`web/app/page.tsx`) gets the message list and composer.
- `compose.yaml` mounts the `./data` volume, and media goes under `/data/media`.
- VAPID keys go in the env file, alongside the existing TURN env.

</code_context>

<specifics>
## Specific Ideas

- The reaction set is personal to the couple: 💕 💔 😋 😝 😘 😭 (not the generic ❤️😂😮😢👍🔥).
- Gestures should feel like iMessage or WhatsApp: swipe to reply, long-press for reactions.
- Albums should look like a real chat app's photo grid, with a swipeable full-screen viewer.
- Voice notes should look like a real chat app's, with a waveform rather than a plain slider.

</specifics>

<deferred>
## Deferred Ideas

- Voice note extras (playback speed, auto-playing consecutive notes, a "played" indicator) were offered and not pursued. Revisit if wanted.
- Already in v2: delete message (CHAT-10), unread icon badge (CHAT-11), drafts (CHAT-12), search (CHAT-13).

</deferred>

---

*Phase: 02-chat-media-push*
*Context gathered: 2026-10-10*
