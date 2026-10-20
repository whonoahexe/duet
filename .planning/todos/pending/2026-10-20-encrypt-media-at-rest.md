---
created: 2026-10-20T12:09:13.550Z
title: Encrypt media at rest on the server
area: media
severity: major
order: 3
files:
  - server/src/media/process.ts
  - server/src/media/routes.ts
  - server/src/media/uploads.ts
notes:
  - .planning/notes/2026-10-20-encrypt-media-at-rest.md
---

## Problem

The box is a shared studio machine and others use the owner's desktop login; anyone can open ~/codebases/duet/data/media and see our photos/videos in plain form. The root disk is not LUKS-encrypted. Web access is already login-gated.

## Solution

Level 1 (decided; E2EE not needed): the server encrypts every stored file (originals, thumbnails, posters, video/audio variants) with AES-256-GCM, key in a plain file under ~/.config/duet (mode 600) — the goal is only that casual browsing shows unreadable files. Decrypt on serve; encrypt video in fixed-size chunks so Range requests / iOS streaming keep working. One-time migration of existing files. Consider the same for message text in data/duet.sqlite. Land before the gallery/profile-photo todo.
