---
created: 2026-10-20T12:09:13.550Z
title: Add shared media gallery and profile photos
area: media
severity: minor
order: 4
files:
  - web/components/app/shell.tsx
  - web/components/app/viewer.tsx
  - server/src/db/schema.ts
notes:
  - .planning/notes/2026-10-20-shared-media-grid-gallery.md
  - .planning/notes/2026-10-20-profile-pictures.md
---

## Problem

Old photos/videos can only be found by scrolling the chat, and the header shows only initials — no profile photos anywhere.

## Solution

Gallery: tap the peer's name/avatar in the header → full-screen grid (3 columns, newest first, grouped by month, video duration on tiles), infinite scroll via a paginated GET /api/media?before= over ready image/video attachments using existing thumb/poster variants; tap → existing viewer extended to swipe across the whole gallery. No voice-notes tab and no "jump to message" in v1. Profile photos: shared — one photo per person, either of us can change it, both see the same one. Set from a "Profile photo" item in the ⋮ menu (choose / camera / remove, pick whose photo). Server centre-crops a square in small + large sizes via the existing upload pipeline; shown in header, incoming/in-call screens, Pixel push icon, top of the gallery; updates live over WS. Build after media encryption.
