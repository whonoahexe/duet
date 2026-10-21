---
date: "2026-10-21 15:58"
promoted: true
---

Round profile photos everywhere, including the notification icon. Today the push notification (Pixel) shows the new profile photo, which is good, but as a square: web/public/sw.js uses /media/<id>/avatar-sm, a square 192x192 webp from server/src/media/image.ts, and Android shows web-push icons as-is. Want: server also makes an "avatar-round" variant — same photo masked to a circle with transparent corners, saved as PNG so the alpha survives — encrypted like the other avatar files and added to the /media route table; the SW uses it as the notification icon. Existing photos have no round variant: generate it lazily on first request (or just re-set both photos). Decided 2026-10-21: round everywhere — chat header, incoming-call + in-call screens, top of the media gallery, profile photo drawer. The preset Avatar is already rounded-full, so check each place that renders the photo without it (e.g. the large call-screen image) and make it a circle. iPhone notifications always show the app icon, so this is Pixel-only there. Batch with the crop note — the profile-photo crop frame is a circle too.
