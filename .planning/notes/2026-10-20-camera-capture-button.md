---
date: "2026-10-20 03:25"
promoted: true
---

Capture photos and videos directly from the composer (high priority). Today the + icon only opens the gallery (web/components/app/composer.tsx: file input accept="image/*,video/*" multiple), so we have to shoot in the camera app first and then pick the file. Decided: Option A — a camera button next to +, backed by a second hidden file input with the `capture` attribute, which opens the phone's own camera app; the result goes into the existing preview/caption/send flow. Native quality (zoom, flash, HDR, front/back, stabilisation). Check on the Pixel whether one input with accept image+video + capture offers both photo and video modes; if not, the button opens a small Photo / Video menu (accept="image/*" vs accept="video/*"). Not doing: an in-app getUserMedia/MediaRecorder camera (Option B) — days of work, worse quality, Pixel webm not playable on iPhone. Apple Live Photos arrive as stills, same as the gallery path.
