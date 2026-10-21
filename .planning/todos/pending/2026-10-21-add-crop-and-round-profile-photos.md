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
