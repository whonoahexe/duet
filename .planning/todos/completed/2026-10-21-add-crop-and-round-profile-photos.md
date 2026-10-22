---
created: 2026-10-21T10:31:14.064Z
title: Add crop and round profile photos
area: media
severity: minor
order: 7
priority: low
files:
  - server/src/media/image.ts
  - server/src/media/avatar.ts
  - server/src/media/routes.ts
  - web/public/sw.js
  - web/components/app/composer.tsx
notes:
  - .planning/notes/2026-10-21-crop-images-and-profile-photos.md
  - .planning/notes/2026-10-21-round-profile-photos.md
---

## Problem

Images can't be cropped before sending, profile photos are always centre-cropped automatically, and the Pixel notification shows the profile photo as a square.

## Solution

One quick task, low priority. Crop (images only, no rotate): one hand-written cropper (pointer-event drag/pinch, preset tokens, no react-easy-crop). Profile photo uses a fixed circle frame, replacing the server's centre crop; the send preview gets a Crop button per image with Free / Square. The phone sends the original plus a normalised crop rect; the server applies it with sharp (rotate() then extract) before variants, so the stored original is the cropped image. Round everywhere: the server adds an encrypted PNG "avatar-round" variant (circle, transparent corners; made the first time it's requested for existing photos) that the SW uses as the notification icon, and every in-app photo (header, call screens, gallery top, profile drawer) is a circle.

## Resolution

Done in quick task 261022-m25 (2026-10-22). What shipped:

- A hand-written cropper (`web/components/app/cropper.tsx`): pointer-event drag, corner handles and pinch, preset components only, no crop library.
- Profile photos: a picked or taken photo is framed in a fixed circle before upload; Cancel uploads nothing.
- Send preview: a Crop button on every photo the browser can show (single view and each strip tile), with Free / Square; each photo of an album is cropped on its own and the drawer stays open.
- Server crop at complete: the phone sends the untouched original plus a normalised crop rect; the server validates it (strict zod) and applies it with sharp (rotate() then extract) before any variant, so the encrypted stored original is the cropped image.
- An encrypted 192 px `avatar-round` PNG (circle, transparent corners) written with the other avatar crops and made on first request for older photos; the service worker uses it as the notification icon.
- The call PiP tile's peer photo is now round, like every other in-app profile photo.
