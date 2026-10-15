---
phase: quick-261015-vkv
plan: 01
subsystem: push
tags: [push, privacy, notifications, pwa, android]
status: complete
requires: []
provides:
  - "messageTypeLabel: type-only push body helper (shared)"
  - "Android notification badge web/public/icons/badge-96.png"
affects: [server/src/push/sender.ts, web/public/sw.js]
tech-stack:
  added: []
  patterns:
    - "The push body helper's parameter type (Pick<MessageDto, 'kind' | 'attachments'>) omits body, so the type system blocks text leaks"
key-files:
  created:
    - web/public/icons/badge-96.png
  modified:
    - shared/src/chat-logic.ts
    - server/src/push/sender.ts
    - web/public/sw.js
    - server/test/chat-logic.test.ts
    - server/test/push.test.ts
    - server/test/sw.test.ts
    - server/test/static.test.ts
decisions:
  - "Push body labels have no emoji: Message, Voice note, Photo, N photos, Video, N videos, N items (media with no attachments falls back to Message)"
  - "Badge made with a one-off ImageMagick command from icon-512.png. Only the PNG is committed."
  - "No sw.js cache-busting: sw.js is served no-cache and browsers byte-compare it on navigation"
requirements: [NOTF-01]
metrics:
  duration: 2min
  completed: 2026-10-15
actuals:
  tokens: 3200
  tasks: 2
  commits: 3
commits: 3
plan_head_before: 43c6ca29a281d71fd58f9217b85d6236f5cdab51
plan_head_after: 971434a8f53561425031f16f23762c8823c5ba1c
---

# Quick 261015-vkv: Push notification tweaks Summary

Push notifications now carry only a type label as the body ("Message", "Photo", "Voice note", and so on). The server decides the label, so message text and captions never reach Apple's or Google's push services. The Pixel status bar shows a white duet heart badge instead of Chrome's generic icon.

## What changed

- **Privacy (Task 1, tracer):** `messageTypeLabel(m: Pick<MessageDto, "kind" | "attachments">)` is in `shared/src/chat-logic.ts`. `notifyMessage` builds the payload with `buildPayload("chat", title, messageTypeLabel(message))`. The title logic is unchanged (sender name, or "{name} · {n} new messages" from 2 unread), and so is the `sendTest` text. `messageLabel` stays as it was and is documented as being only for the in-app aria-live announcement.
- **Badge (Task 2):** `web/public/icons/badge-96.png` is 96x96 RGBA: every pixel's RGB is white and the heart's shape is in the alpha channel (opaque center, transparent corners). `sw.js` passes `badge: "/icons/badge-96.png"` on every `showNotification`.

**Label wording (no emoji):** text → `Message`, voice → `Voice note`, media → `Photo` / `N photos` / `Video` / `N videos` / `N items` (mixed). Media with no attachments → `Message`. Captions are never included.

**Badge generation command** (ImageMagick 7, run once, script not committed):

```
magick web/public/icons/icon-512.png -colorspace Gray -level 40%,90% -alpha copy -trim +repage -resize 80x80 -gravity center -background none -extent 96x96 -channel RGB -evaluate set 100% +channel PNG32:web/public/icons/badge-96.png
```

I flattened it on a dark background and checked by eye: a clean, centered heart.

## Sound (no code, per CONTEXT "Sound")

Browsers can't set a custom sound for a web-push notification, and iOS web push always plays the default tone. To change the tone on the Pixel, use either path:

- Long-press a duet notification → tap the Settings gear → pick the notification category → **Sound** → choose a tone.
- Or: **Settings → Apps → duet → Notifications** → pick the notification category → **Sound** → choose a tone.

## Deploy note

**The duet container needs a rebuild and redeploy.** The phones only see these changes once the duet container is rebuilt and restarted from `compose.yaml`. After that, the server sends the type-only body, and `web/out` ships the new `sw.js` and `badge-96.png`. The service worker updates itself the next time the app is opened, because `sw.js` is served no-cache. I did not rebuild or redeploy.

## Verification

- `npm run test -w server -- chat-logic.test push.test sw.test`: pass.
- `npm run build && npm test`: 20 files, 296 passed, 1 skipped. The skip was already there and is unrelated. This includes static.test serving `/icons/badge-96.png` as image/png from the rebuilt `web/out`.
- `npm run typecheck`: clean.
- `! grep -q messageLabel server/src/push/sender.ts`: pass.
- Badge checks: `96 96 False`, RGB minima `1 1 1`, alpha center/corner `1 0`.
- Still to do by hand after redeploy (human-check): on the Pixel, the status bar shows the heart and the body is type-only; on the iPhone, the body is type-only.

## TDD Gate Compliance

- RED: `2b5752c` test(261015-vkv). 8 failures, including the photo-caption test, whose payload was `"📷 Photo · secret caption"`.
- GREEN: `03b38d5` feat(261015-vkv). 51/51 pass.
- REFACTOR: not needed.

## Commits

- `2b5752c` test(261015-vkv): push body must be type-only, never text or captions
- `03b38d5` feat(261015-vkv): type-only push body, message text never leaves the box
- `971434a` feat(261015-vkv): duet heart badge for the Android status bar

## Deviations from Plan

None. The plan was executed as written. One optional extra was added: the emoji-only integration test now asserts body "Message".

## Known Stubs

None.

## Self-Check: PASSED

- FOUND: web/public/icons/badge-96.png, shared/src/chat-logic.ts, server/src/push/sender.ts, web/public/sw.js
- FOUND commits: 2b5752c, 03b38d5, 971434a (ancestors of HEAD)
