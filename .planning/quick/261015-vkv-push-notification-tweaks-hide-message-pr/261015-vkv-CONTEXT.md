# Quick Task 261015-vkv: Push notification tweaks: hide message preview, duet logo badge, custom notification sound - Context

**Gathered:** 2026-10-15
**Status:** Ready for planning

<domain>
## Task Boundary

Push notifications already work on iPhone (Safari PWA) and Pixel (Chrome PWA). Three changes:
1. Notifications must never show the message text.
2. The Pixel status-bar badge must show duet's logo (like WhatsApp's glyph) instead of Chrome's generic icon.
3. Notification sound: user wanted to change it. Web Push can't set a custom sound, so there's no code change (see decisions).

</domain>

<decisions>
## Implementation Decisions

### Notification content (privacy)
- Title is the sender's name, as now. The "{name} · {n} new messages" title (D-13) stays.
- Body shows the message **type only, never text**: e.g. "Message" for text, "Voice note", "Photo", "Video". Mixed attachments get a sensible type label. Captions on media are never included.
- Do this on the server, in `server/src/push/sender.ts` `notifyMessage`. Don't call `messageLabel(message)`, which includes the body. Add a type-only label helper, reusing `mediaLabel` from `shared/src/chat-logic.ts` if it fits. The text must never reach the push payload, so Apple/Google never see it either.
- Keep the existing emoji style of `mediaLabel` ({ emoji: true }) or drop it, whichever reads cleaner. That's Claude's call, as long as it's consistent.
- Update the existing tests that assert the body.

### Badge (Pixel status-bar icon)
- Add a monochrome duet badge glyph: a white silhouette on a transparent background, PNG, 96×96 (Android's recommended badge size). Derive it from the existing duet icon artwork in `web/public/icons/`.
- Pass `badge: "/icons/badge-96.png"` (or similar) in `showNotification` in `web/public/sw.js`.
- **No** iOS home-screen unread count (setAppBadge). The user declined it.
- iOS ignores `badge` and already shows the app icon. No iOS work.

### Sound
- **No code change.** Browsers don't support custom notification sounds, and iOS web push always uses the default tone. The user will change the sound on the Pixel through Android's per-app notification settings. Put those steps in the SUMMARY: long-press a duet notification → Settings, or Settings → Apps → duet → Notifications → pick the category → Sound.

### Claude's Discretion
- Exact type label wording and whether emoji are kept.
- How the badge PNG is produced: an ImageMagick/sharp script from the existing icon, or a hand-drawn SVG rasterized. Commit only the resulting PNG unless a script is trivially useful.
- Whether the service worker needs a cache-busting change so phones pick up the new sw.js. Browsers byte-compare sw.js on navigation, so editing it is enough.

</decisions>

<specifics>
## Specific Ideas

- "like whatsapp does": the WhatsApp phone glyph in the Android status bar is the reference.
- The test-notification path (`sendTest`) can keep its current text.

</specifics>

<canonical_refs>
## Canonical References

- MDN `ServiceWorkerRegistration.showNotification`: the `badge` option (Android only, monochrome mask) and the `silent` option. `sound` is unsupported in all browsers.

</canonical_refs>
