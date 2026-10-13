---
phase: 02-chat-media-push
reviewed: 2026-10-13T09:37:49Z
depth: standard
files_reviewed: 93
files_reviewed_list:
  - deploy/vapid-keys.sh
  - Dockerfile
  - .env.example
  - README.md
  - scripts/check-live-db.sh
  - scripts/lib/e2e.mjs
  - scripts/smoke-chat.mjs
  - scripts/smoke-chat.sh
  - scripts/smoke-onboarding.mjs
  - scripts/smoke-public.sh
  - server/drizzle/0001_chat_media_push.sql
  - server/drizzle/meta/0001_snapshot.json
  - server/drizzle/meta/_journal.json
  - server/package.json
  - server/scripts/media-selftest.ts
  - server/src/app.ts
  - server/src/chat/events.ts
  - server/src/chat/routes.ts
  - server/src/chat/service.ts
  - server/src/config.ts
  - server/src/db/schema.ts
  - server/src/media/audio.ts
  - server/src/media/exec.ts
  - server/src/media/image.ts
  - server/src/media/probe.ts
  - server/src/media/process.ts
  - server/src/media/routes.ts
  - server/src/media/uploads.ts
  - server/src/media/video.ts
  - server/src/push/routes.ts
  - server/src/push/sender.ts
  - server/src/ws/hub.ts
  - server/test/chat-logic.test.ts
  - server/test/chat.test.ts
  - server/test/helpers.ts
  - server/test/media.test.ts
  - server/test/push.test.ts
  - server/test/reactions.test.ts
  - server/test/read-typing.test.ts
  - server/test/replies.test.ts
  - server/test/sw.test.ts
  - server/test/uploads.test.ts
  - server/test/video.test.ts
  - server/test/voice.test.ts
  - shared/src/chat-logic.ts
  - shared/src/chat.ts
  - shared/src/index.ts
  - shared/src/media.ts
  - shared/src/push.ts
  - shared/src/ws.ts
  - web/app/layout.tsx
  - web/app/page.tsx
  - web/components/app/a2hs-guide.tsx
  - web/components/app/album.tsx
  - web/components/app/chat-view.tsx
  - web/components/app/composer.tsx
  - web/components/app/message-actions.tsx
  - web/components/app/message-row.tsx
  - web/components/app/notifications-card.tsx
  - web/components/app/notifications-drawer.tsx
  - web/components/app/preview-drawer.tsx
  - web/components/app/quote-block.tsx
  - web/components/app/recorder.tsx
  - web/components/app/shell.tsx
  - web/components/app/typing-indicator.tsx
  - web/components/app/viewer.tsx
  - web/components/app/voice-note.tsx
  - web/components/ui/attachment.tsx
  - web/components/ui/bubble.tsx
  - web/components/ui/carousel.tsx
  - web/components/ui/dialog.tsx
  - web/components/ui/drawer.tsx
  - web/components/ui/input-group.tsx
  - web/components/ui/marker.tsx
  - web/components/ui/message-scroller.tsx
  - web/components/ui/message.tsx
  - web/components/ui/popover.tsx
  - web/components/ui/skeleton.tsx
  - web/components/ui/textarea.tsx
  - web/lib/api.ts
  - web/lib/chat/events.ts
  - web/lib/chat/gestures.ts
  - web/lib/chat/outbox.ts
  - web/lib/chat/playback.ts
  - web/lib/chat/push.ts
  - web/lib/chat/realtime.ts
  - web/lib/chat/recorder.ts
  - web/lib/chat/store.ts
  - web/lib/chat/upload.ts
  - web/lib/platform.ts
  - web/next.config.ts
  - web/package.json
  - web/public/sw.js
findings:
  critical: 0
  warning: 6
  info: 7
  total: 13
status: issues_found
---

# Phase 2: Code Review Report

**Reviewed:** 2026-10-13T09:37:49Z
**Depth:** standard
**Files Reviewed:** 93
**Status:** issues_found

## Summary

I reviewed the Phase 2 chat, media and push stack: the Fastify chat, upload, media, push and WS hub modules, the shared zod contract, the client store, outbox, realtime, upload and recorder modules, the chat UI components, the service worker, and the deploy and smoke scripts. Test files and the preset-generated `web/components/ui/*` got only a light pass, for test reliability and integration.

The server security boundaries hold up:
- Media paths are built from a regex-validated id and a fixed variant map.
- Uploads are owner-checked.
- The ffprobe/ffmpeg gate uses `-protocol_whitelist file`, `-format_whitelist` and an explicit `-f`, with no shell.
- Push endpoints are host-allowlisted (SSRF guard).
- Every non-GET goes through the Origin guard.
- Message text renders only as React text.

I found no injection, path traversal or auth bypass.

The defects are in failure handling and state reconciliation:
- Client entries can get stuck failed forever, with nothing that can clear them.
- An album or voice note is shown twice: once as the WS echo and once as the pending entry.
- Network requests have no timeouts.
- A probe timeout during upload completion becomes a 500 and leaves the upload half-done.
- Orphaned attachments pile up on disk and are never cleaned up.

## Narrative Findings (AI reviewer)

## Warnings

### WR-01: A permanently rejected text message gets stuck in the outbox and can never be removed

**File:** `web/lib/chat/outbox.ts:162-217`, `web/components/app/composer.tsx:64-73`, `web/components/app/chat-view.tsx:497-515`
**Issue:** `nextOutboxState` marks a non-retryable 4xx as `failed`, and the only actions are `retry` (same body, same id) and `clear` (logout).
- **Nothing can remove it:** there is no remove or discard for a single entry. The entry stays in `localStorage` and is rendered after every confirmed message on every launch.
- **Easy to trigger:** the composer never enforces `MESSAGE_BODY_MAX_CODE_POINTS` (4000), and neither does the album caption textarea in `preview-drawer.tsx:200-207`. A pasted long text gets `400 invalid_body`, and every "Tap to retry" fails the same way.
- **Read receipts disappear too:** the stuck entry always sorts last, so `latestMine` in chat-view is always that failed entry. The "Sent" and "Read {time}" line is never shown on any later message until logout.

**Fix:** Block oversize input in the composer and caption, and let failed entries be dropped.
```ts
// shared: export the check
// composer.tsx
const tooLong = codePointLength(text) > MESSAGE_BODY_MAX_CODE_POINTS
const canSend = !isBlankBody(text) && !tooLong
// outbox.ts
discard(id: string): void { if (entries.some((e) => e.id === id)) commit(entries.filter((e) => e.id !== id)) },
```
Also compute `latestMine` from confirmed and non-failed entries, and show the failed row separately.

### WR-02: An album or voice note whose attachment failed before the send can never be sent

**File:** `server/src/chat/service.ts:96-106`, `web/lib/chat/store.ts:162-205`, `web/lib/chat/store.ts:480-489`
**Issue:** `sendMessage` accepts attachments in the `processing` state but rejects `failed` ones with `400 bad_attachment`.
- **The race:** `POST /api/uploads/:id/complete` returns while processing runs. An image sharp cannot decode, or an album where a big video uploads after a photo already failed in the fast lane, can turn `failed` before `runMedia` posts the message.
- **Retry cannot help:** the POST is rejected, and `retryMedia` re-posts the same `attachmentIds` (items with an `attachmentId` are skipped), so it gets the same 400 forever.
- **Good items are lost too:** the whole album, including its good photos, never sends. Entries are memory-only, so a reload drops it silently.
- **Same symptom from a 422:** a video over 200 s whose length the browser could not read at pick time also fails permanently.
- **Inconsistent:** if the failure happens after the send instead, the message goes through with a "Couldn't load" tile.

**Fix:** Pick one behavior. Either accept `failed` attachments in `sendMessage` (the UI already renders failed tiles), or have the client handle `bad_attachment` itself: drop or re-upload items whose attachment failed (or that got a 422 from complete) and resend the rest. Also give failed media entries a discard action.

### WR-03: Your own album or voice note is shown twice, and can show "Not sent" after it was delivered

**File:** `web/lib/chat/store.ts:354-368`, `server/src/chat/routes.ts:55-58`, `web/components/app/chat-view.tsx:406-494`
**Issue:** `POST /api/messages` broadcasts the `msg` frame before it sends the HTTP response, so the WS echo usually wins. `applyMessages` confirms text outbox entries by id (`outbox.confirm`) but never removes the matching `state.media` entry.
- **Duplicate in the list:** the album or voice note shows twice, as the confirmed copy and the pending copy.
- **Duplicate React keys:** both copies usually land in the same sender group, so `<Fragment key={item.id}>` in `message-row.tsx:368` gets a duplicate key.
- **Delivered but marked failed:** if the POST response is then lost (network drop after the commit), the pending copy becomes "Not sent. Tap to retry." next to the delivered message.

**Fix:**
```ts
applyMessages(incoming) {
  ...
  const ids = new Set(incoming.map((m) => m.id))
  if (state.media.some((e) => ids.has(e.id))) set({ media: state.media.filter((e) => !ids.has(e.id)) })
  ...
}
```
In `runMedia`, also stop treating the entry as failed once it is gone from `state.media`.

### WR-04: No request timeouts, so one stalled request blocks every text send or wedges an album

**File:** `web/lib/api.ts:14-23`, `web/lib/chat/upload.ts:16-43`, `web/lib/chat/outbox.ts:106-156`, `web/lib/chat/store.ts:162-205`
**Issue:** `fetch` has no `AbortSignal` and the XHR has no `timeout`.
- **Text sends:** `outbox.flush` awaits `deps.send` with `flushing = true`. While a POST hangs on a stalled cellular or tunnel connection, every later text, every "online" event and every hello only sets `again = true`, so nothing goes out.
- **Albums:** while a chunk PUT hangs, the entry stays `sending` with its id in `mediaRunning`, so "Tap to retry" is never offered.
- **How long:** recovery depends on the network stack or the Cloudflare 100 s proxy timeout.

**Fix:** Add `signal: AbortSignal.timeout(15_000)` (longer for `/complete`) in `request()` and map an abort to `ApiError(0, "timeout")`. Set `xhr.timeout` per chunk (for example 120 s). Also abort an in-flight flush from `Realtime.onOnline` and `onResume`.

### WR-05: A probe timeout or missing ffprobe during upload completion returns 500 and leaves the upload stuck

**File:** `server/src/media/uploads.ts:46-60`, `server/src/media/uploads.ts:175-183`, `server/src/media/exec.ts:48-51`
**Issue:** `gate()` maps only `MediaError("unsupported_media")` to a rejection. `runTool` always rejects a kill-timeout with code `"timeout"` (it ignores `failCode`), and a missing binary with `"tool_missing"`. Both are rethrown, and `complete` throws after it has already deleted the chunk dir (line 175). The result:
- the request gets a 500 (the default handler can echo an fs/stack message);
- the row stays `uploading`;
- `original` sits in `media/<id>/` until the next boot's `cleanupStale`;
- every later `/complete` answers `409 incomplete`.

A file built to stall ffprobe can do this on demand.

**Fix:** Treat every gate failure as a rejection, and mark the row failed before you throw:
```ts
} catch (err) {
  if (err instanceof MediaError) return "unsupported_media"
  throw err
}
```
Also wrap the code from assembly through gate in a try that sets `status: "failed"` and removes `outDir` on any error.

### WR-06: Orphaned attachments and media files are never cleaned up

**File:** `server/src/media/process.ts:170-196`, `server/src/media/process.ts:208-217`
**Issue:** `cleanupStale` deletes only rows still `uploading`, and it runs only at boot (`onReady`). These are never removed:
- completed uploads that never got attached to a message (`message_seq IS NULL` in `processing`, `ready` or `failed`), from a reload mid-album, a WR-02 dead end, or an app kill between `complete` and `POST /api/messages`;
- rejected uploads (row `failed`, files deleted, but the row stays).

Each orphan keeps its original (up to 100 to 200 MB) plus variants under `/data/media` for good. On a long-running container, `uploading` leftovers also pile up until a restart.

**Fix:** Run a periodic sweep (for example hourly, plus at boot). It deletes rows with `message_seq IS NULL AND created_at < now - 24h` in any status, together with `media/<id>` and `media/tmp/<id>`, skipping ids that are queued or running in the processor.

## Info

### IN-01: The video duration cap is applied only after a full transcode when the container has no duration

**File:** `server/src/media/uploads.ts:52`, `server/src/media/video.ts:54-101`
**Issue:** For a WebM or other stream whose ffprobe `durationMs` is null, the gate passes. ffmpeg then transcodes everything, for up to `VIDEO_TIMEOUT_MS` (15 min), before `too_long` is detected, and that blocks the single slow lane.
**Fix:** Pass `-t String(VIDEO_MAX_DURATION_MS / 1000 + 1)` to the transcode, and treat an output at that cap as `too_long`.

### IN-02: Shutdown waits for a running transcode instead of stopping it

**File:** `server/src/media/process.ts:231-238`, `server/src/app.ts:123-125`
**Issue:** `close()` awaits the running jobs (up to 15 min). `docker stop` sends SIGKILL after 10 s, so every restart during a transcode ends with a hard kill. The job is re-queued at boot, so nothing is lost.
**Fix:** Keep the child handles (or pass an `AbortSignal` into `runTool`) and kill them in `close()`. The rows stay `processing` and are re-queued on start.

### IN-03: A failed voice note's retry button can never succeed

**File:** `web/components/app/voice-note.tsx:94-100`
**Issue:** With `failed` true (server transcode failure), `toggle()` bumps `attempt`, but `src` stays undefined because `playable` is false. "Couldn't load" acts as a retry button that does nothing.
**Fix:** Disable the button when `failed` is true and only offer retry for `error` (load failures).

### IN-04: Quote thumbnails have no load-error fallback

**File:** `web/components/app/quote-block.tsx:65-68`
**Issue:** A quoted photo or video whose attachment is still `processing`, or has `failed`, gets a `404` from `/media/<id>/thumb|poster`, and the browser's broken-image icon shows inside the quote.
**Fix:** Add `onError` to hide the `<img>`, or only render it when the parent attachment is known to be ready.

### IN-05: Duplicated helpers

**File:** `web/lib/chat/store.ts:208-210`, `web/components/app/preview-drawer.tsx:19-21`, `server/src/media/video.ts:23`, `server/src/media/audio.ts:12`
**Issue:** `kindOf` is defined twice, and so is the ffmpeg `BASE_ARGS` array. If they drift, the picker check and the upload `kind` can disagree.
**Fix:** Export one `kindOf` (from preview-drawer or a small `lib/chat/media.ts`) and one `FFMPEG_BASE_ARGS` from `exec.ts`.

### IN-06: Unused `Geist` import

**File:** `web/app/layout.tsx:2`
**Issue:** `Geist` is imported but never used; only `Geist_Mono` and `Space_Grotesk` are.
**Fix:** Remove `Geist` from the import.

### IN-07: The media self-test leaks its temp dir on failure

**File:** `server/scripts/media-selftest.ts:28-31`, `server/scripts/media-selftest.ts:131-163`
**Issue:** `fail()` calls `process.exit(1)` inside the `try`, so the `finally` that removes `root` never runs, and every failed self-test leaves `/tmp/duet-media-selftest-*` behind (inside the container too).
**Fix:** Throw from `fail()` and call `process.exit(1)` after the `finally`, or set `process.exitCode = 1` and return.

---

_Reviewed: 2026-10-13T09:37:49Z_
_Reviewer: Claude (gsd-code-reviewer)_
_Depth: standard_
