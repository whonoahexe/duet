---
date: "2026-10-20 03:40"
promoted: false
---

Profile pictures. Today the header shows only initials (web/components/app/shell.tsx AvatarFallback); users table has no photo column. Decided: both of us can set each other's photo, not just our own. Confirmed 2026-10-20: shared — one photo per person, either of us can change it, both see the same photo (not contact-style). Shows in: chat header, incoming-call + in-call screens, push notification icon (Pixel only — iOS web push always shows the app icon), top of the future media gallery. Set via a "Profile photo" item in the ⋮ menu → drawer with current photo, Choose photo (gallery, + camera once the camera-button note lands), Remove; with a way to pick whose photo you're changing. Server centre-crops to a square and makes a small (header) and large (call screen) size, reusing the existing upload/processing pipeline; auth-gated like other media and included in encrypt-at-rest. Change pushes over WS so the other phone updates live. No drag-to-crop editor at first.
