---
date: "2026-10-20 03:32"
promoted: false
---

Bug: on the Pixel, pressing Android back while a photo/video is open in the viewer closes the whole app instead of the viewer. Cause: duet never touches browser history (no pushState/popstate anywhere in web/), so back has nothing inside the app to go to. Same likely for every overlay: viewer, send preview drawer, message actions, notifications drawer, permission drawer (and the future media gallery). Fix: one shared hook — on open, push a history entry; on popstate, close the overlay; when closed any other way (X, swipe, Escape), pop the entry it pushed so entries don't pile up. Use it in every overlay. Verify on the Pixel home-screen app.
