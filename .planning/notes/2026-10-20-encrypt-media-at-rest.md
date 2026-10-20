---
date: "2026-10-20 02:58"
promoted: false
---

Encrypt media at rest on the server (level 1, decided — E2EE not needed). Observed: the box is a shared studio machine; anyone at it can open ~/codebases/duet/data/media and see our photos/videos in plain form (61 MB, root disk not LUKS). Over the web /media is already login-gated and data/ is git-ignored. Want: server encrypts every stored file (originals, thumbnails, video posters/variants) with AES-256-GCM, key kept outside data/ (e.g. ~/.config/duet, mode 600), decrypt on serve; videos encrypted in fixed-size chunks so Range requests / iOS streaming keep working; migrate the existing files once. Consider doing the same for message text in data/duet.sqlite. Caveat: stops people casually browsing the folder or copying it; does not stop someone who can read the key file (same user account) or root. Decided 2026-10-20: others use the owner's desktop login, but the goal is only to stop casual browsing (scrambled files are enough), so a plain key file in ~/.config/duet is fine — no root-owned key / Docker secret needed.
