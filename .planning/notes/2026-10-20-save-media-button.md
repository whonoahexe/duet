---
date: "2026-10-20 03:32"
promoted: false
---

Save/download button in the media viewer (web/components/app/viewer.tsx top bar, next to close). Saves the full-quality original, not the thumbnail. A web app can't write straight to the photo library, so per platform: iPhone — navigator.share({ files }) opens the share sheet, user taps "Save Image"/"Save Video" → Photos; Pixel — plain download (<a download> from a fetched blob) → Downloads folder, shows in Google Photos under "On this device". Use web/lib/platform.ts isIos() to pick. Must keep working once media is encrypted at rest (server decrypts on serve, so it should). Batch with the back-button fix — same viewer code.
