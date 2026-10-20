---
date: "2026-10-20 03:12"
promoted: false
---

Shared media gallery like WhatsApp: tap the other person's name/avatar in the chat header → a page showing all photos and videos we've shared in a grid (newest first, video tiles show duration), tap a tile → full-screen viewer with swipe between items, plus "jump to message in chat". Maybe tabs for Media / Voice notes later. Feasibility: the attachments table already has kind/status/size/duration per file and thumbnails are already generated, so this is mostly a paginated "list ready image+video attachments" endpoint + a grid page using the existing thumbnails and viewer. Must keep working once media is encrypted at rest (see encrypt-media-at-rest note).
