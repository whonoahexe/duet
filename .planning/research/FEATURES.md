> **⚠ 2026-10-09: media plane superseded.** Home is CGNAT, so the user dropped the SFU (see `.planning/phases/01-foundation-auth-media-plane/01-CONTEXT.md` D-16). Calls are now 1:1 peer-to-peer WebRTC with Cloudflare TURN, with TURN credentials minted by the duet server and signaling over duet's WebSocket. Anything below about the self-hosted SFU, coturn, `@sideby-me/rtc`, mediasoup-client, SFU join tokens, router port-forwards or sfu./turn. DNS is historical; ignore it when planning. Everything else stands.

# Feature Research

**Domain:** Private 1:1 messaging + voice/video calling PWA for exactly two people (self-hosted "tiny WhatsApp" for a couple)
**Researched:** 2026-10-08
**Confidence:** MEDIUM overall. The feature landscape (what WhatsApp, Signal, Telegram, and Between do) is HIGH confidence and well established. The iOS PWA platform limits are MEDIUM: they come from WebKit blog posts plus developer reports, and behavior changes between iOS versions, so test them on the real iPhone.

---

## Framing: what "table stakes" means for a 2-user app

The two users have used WhatsApp, iMessage, or Telegram for years, so they'll compare duet to those apps without meaning to. They won't care about the feature count. They'll notice friction. In practice, a feature counts as table stakes here when leaving it out causes one of these:

1. **Silent message loss or doubt** ("did it send?"), which breaks the Core Value of messaging reliably.
2. **A missed call with no trace of it**, which breaks the Core Value of calling reliably.
3. **Daily friction the old app didn't have**: re-logging in, the keyboard covering the composer, notification spam, a photo she can't zoom.

Anything that fails all three tests is a differentiator or an anti-feature, however common it is in the big apps.

The user already committed to these: text, images (kept forever), short video clips, voice notes, read receipts + typing, reactions + replies, voice and video calls, push notifications, and password+TOTP. **This document covers the supporting features those commitments need in order to feel finished.**

---

## Feature Landscape

### Table Stakes (Users Expect These)

#### A. Messaging reliability (the most important gap)

| Feature | Why Expected | Complexity | Notes |
|---------|--------------|------------|-------|
| **Optimistic send with client-generated message ID** | WhatsApp-style: the bubble appears instantly, and the server de-duplicates retries. Without it, slow cellular sends feel broken and retries double-post. | LOW | Client makes a UUID (`clientId`), the server stores it with a UNIQUE constraint, and the insert is idempotent. This is the foundation for everything else in this section. |
| **Persistent outbox + automatic retry** | People send on the subway or in elevators. A message typed offline has to go out when the connection comes back. | MEDIUM | Keep pending messages in IndexedDB (or localStorage for text). Flush on WS reconnect, `online`, or `visibilitychange`. Media uploads retry the same way. |
| **Message status: sending → sent → read, plus failed** | Read receipts are already committed. The *sending* and *failed* states are what's missing, and a stuck "clock" icon with no failed state is the classic chat-app bug. | LOW | Recommendation: **skip a separate "delivered" (double grey tick) state.** Honest delivered status means the service worker has to ack on push. iOS can't do this reliably, and with two people "sent" vs "read" carries the meaning. Failed shows a tap-to-retry affordance. |
| **Reconnect + catch-up sync** | iOS kills the WebSocket whenever the PWA goes to the background. On return the app has to fill the gap with no manual refresh. | MEDIUM | On WS (re)connect and on `visibilitychange → visible`, fetch `messages?after=<lastSeenId>` and also any state changes (reactions, reads, deletes) since the last sync. Treat the WS as a hint and REST as the source of truth. |
| **Connection status banner** | "Connecting…" or "Offline" tells the user why nothing is moving. Telegram and WhatsApp both have it. | LOW | Driven by WS state. Show it only after about 1–2s of disconnect so it doesn't flicker. |
| **Paginated history with infinite scroll up** | History is kept forever. Loading all of it kills the phone, and not being able to scroll back kills the "kept forever" promise. | MEDIUM | Cursor pagination by id. Keep the scroll position when prepending (a well-known pain point; use a reversed list or a virtualizer that supports anchoring). |
| **Unread divider + jump-to-bottom button with unread count** | Standard in every messenger. Without it, you open the app and get lost in the scroll. | LOW | Divider at the first unread message on open. Floating "↓ 3" button when scrolled up. |
| **Read semantics that are actually correct** | A message counts as read only when the recipient actually saw it. Marking it read because the tab is open in the background is a trust problem in a couple app. | LOW | Mark read only when `document.visibilityState === 'visible'` AND the message is in the viewport (IntersectionObserver) or the list is at the bottom. |
| **Day separators, timestamps, sender grouping** | Basic readability. Consecutive bubbles from the same sender are grouped. | LOW | "Today" / "Yesterday" / date chips. Exact time on tap or long-press. |
| **Long-press message menu: React · Reply · Copy · Delete** | The universal mobile interaction for messages. Reactions and replies need an entry point, and on mobile this is it. | LOW–MEDIUM | Use the preset's DropdownMenu, ContextMenu, or Drawer components. Make sure long-press doesn't trigger iOS text selection or the callout (`-webkit-touch-callout: none`, `user-select: none` on bubbles). |
| **Delete own message ("unsend")** | Sending the wrong photo or a typo happens to everyone. WhatsApp, Signal, Telegram, and iMessage all allow it. Since history is kept forever, there has to be a way out. | LOW | Soft delete: blank the content, delete the media file, and render "Message deleted" for both people. No time limit is needed with two users. |
| **Reply UI: quoted preview in bubble + tap to jump to original** | Part of the committed "reply" feature. The quote alone is easy. Tapping to jump is what users expect. | MEDIUM | Jumping to an original that isn't loaded yet means loading around that message id. Acceptable v1 fallback: scroll if it's loaded, otherwise show a toast. |
| **Reactions: fixed quick set, one per user, tap again to remove** | Part of the committed "reactions" feature. WhatsApp and iMessage semantics. | LOW | 6 quick emoji (heart, laugh, wow, sad, pray, thumbs-up) plus "+" using the native emoji keyboard input. **Don't** build a full emoji picker. |
| **Composer that behaves on mobile** | Multiline, Enter inserts a newline on mobile (the send button sends), and it auto-grows. | LOW | Drafts survive app switches (persist to localStorage per conversation). |
| **Keyboard-safe layout on iOS** | On iOS PWAs the soft keyboard covers or pushes the composer and the header scrolls away. This is the most common "this web app feels cheap" moment. | MEDIUM | Use `visualViewport` resize handling, `100dvh`, and `env(safe-area-inset-*)`. Test this on the real iPhone in phase 1 of the UI. Don't leave it for polish. |
| **Linkify URLs in messages** | Pasted links have to be tappable. | LOW | Linkify only, no previews (see Anti-Features). |

#### B. Media (images, video, voice notes)

| Feature | Why Expected | Complexity | Notes |
|---------|--------------|------------|-------|
| **Pick from library or take a photo/video with the native camera** | Both are standard. | LOW | `<input type="file" accept="image/*,video/*" multiple>`. iOS shows "Take Photo / Photo Library / Choose File" by itself. **Don't** build a custom in-app camera. |
| **Multi-select images in one send** | WhatsApp and iMessage allow it. Sending 6 vacation photos one at a time is painful. | LOW–MEDIUM | `multiple` attribute. Each image becomes its own message (simplest). Album grid grouping is a differentiator. |
| **Client-side image downscale before upload** | Over cellular, 12MP originals (4–8MB) make sending slow. WhatsApp compresses too. | LOW | Canvas resize to a ~2560px long edge, JPEG q≈0.85. iOS Safari generally hands the page JPEG, not HEIC, for `accept="image/*"` (verify on device). The server should still sniff the type and reject or convert HEIC with sharp or libvips if it arrives. |
| **Upload progress + cancel; placeholder bubble during upload** | Users need to see a 40MB video clip is still going. | MEDIUM | XHR or `fetch` with upload progress (XHR is simpler for progress). Ties into the outbox and retry. |
| **Stable layout: stored dimensions + blur/thumb placeholder** | Without dimensions, the chat jumps while images load and scroll-to-bottom breaks. | LOW | Store width, height, and a tiny thumbnail (or blurhash) at upload time. Render the aspect-ratio box immediately. |
| **Full-screen media viewer: pinch-zoom, swipe between media, close by swipe-down** | Every messenger has one. A photo that can't be zoomed feels broken. | MEDIUM | Use a small lightbox library rather than writing your own (PhotoSwipe or yet-another-react-lightbox). Style it with the preset tokens only. |
| **Save / share media to the phone** | "Send me that photo" means she wants it in her Photos app. | LOW | `navigator.share({ files })` (works on iOS and Android) as a share-sheet button. Long-press on `<img>` also gives iOS "Save to Photos". |
| **Video: server-side transcode to H.264/AAC MP4 (faststart) + poster frame** | iPhone records HEVC in a `.mov` container. Chrome on Android plays HEVC-in-MOV unreliably, and large originals stall on cellular. | MEDIUM | One `ffmpeg` job on upload: `-c:v libx264 -pix_fmt yuv420p -vf scale=-2:'min(1080,ih)' -c:a aac -movflags +faststart`, plus one JPEG poster frame. Enforce limits (e.g. ≤ 3 min, ≤ 200MB upload). The bubble shows "Processing…" until the job is done. |
| **Inline video playback** | Tap to play inside the bubble or the viewer, with no forced fullscreen. | LOW | `playsinline`, poster attribute, `preload="metadata"`. |
| **Voice notes: tap-to-record with timer, cancel, send** | Part of the committed feature. Hold-to-record with slide-to-cancel is WhatsApp's pattern, but **tap-to-start / tap-to-stop with a visible timer and a trash button** is far easier to get right on mobile web, with no touch-event edge cases. | MEDIUM | MediaRecorder output differs: Chrome gives `audio/webm;codecs=opus`, Safari has historically given `audio/mp4` (AAC), and reports on recent iOS conflict. **Normalize server-side with the same ffmpeg pipeline to AAC `.m4a`**, which plays everywhere. Record `recorder.mimeType` and never assume it. Cap length at around 5–10 min. |
| **Voice note playback: play/pause, scrubber, duration, played/unplayed dot** | Standard. Duration has to show *before* playback. | LOW–MEDIUM | Get the duration from ffprobe at transcode time, since WebM from MediaRecorder often has no duration header. Allow only one note playing at a time. |
| **Playback speed (1× / 1.5× / 2×) for voice notes** | WhatsApp made this expected. It's trivial to add. | LOW | `audio.playbackRate`. |

#### C. Calls

| Feature | Why Expected | Complexity | Notes |
|---------|--------------|------------|-------|
| **Call buttons in chat header (voice / video)** | The entry point. | LOW | |
| **Outgoing call screen: "Calling…", ringback tone, cancel, timeout → missed** | Without ringback and a timeout, the caller doesn't know if it's working. | LOW–MEDIUM | Server-side call state machine: `ringing → accepted / declined / missed / cancelled / ended`. Ring timeout about 45s. |
| **Incoming call screen when the app is open (full-screen sheet, ringtone, Accept / Decline)** | Push only covers the backgrounded case. When the app is open, it needs a real in-app ring. | MEDIUM | Delivered over WS. **iOS autoplay rule:** the ringtone `<audio>` only plays if the page has had a user gesture. Unlock an audio element on the first tap after app open. `navigator.vibrate` is unavailable on iOS. |
| **Incoming call while backgrounded: push → tap → app opens straight into the incoming-call UI** | Committed ("push-to-answer"). | MEDIUM | **Don't rely on the notification's deep-link URL.** On iOS, `clients.openWindow` / URL routing from `notificationclick` is unreliable: it often reopens the last page or the root. Instead, **on app open and on every `visibilitychange → visible`, ask the server "is there a ringing call for me?"** and show the incoming sheet if there is. This works whatever URL iOS opens. |
| **Mute mic / camera on-off / flip camera / end call** | The universal in-call control set. | LOW–MEDIUM | Mute = `producer.pause()` + signal to peer (show "muted" icon on the other side). Flip = new `getUserMedia({ facingMode })` + `producer.replaceTrack()`; stop the old track first, because iOS can't open both cameras at once. |
| **Remote "muted" / "camera off" indicators** | Without them, a muted partner looks like a broken call. | LOW | Small signaling message or producer pause/resume events. |
| **Self-view PiP (draggable corner) + tap to swap** | Standard video-call layout. | LOW–MEDIUM | Draggable is nice. A fixed corner is acceptable for v1. |
| **Call timer + "Reconnecting…" state** | Over cellular, ICE restarts happen. Users need to see the call is recovering, not frozen. | MEDIUM | Watch transport `connectionstatechange` and attempt ICE restart. End the call on the other side after about 20–30s of no recovery. |
| **Call history entries in the chat timeline** | WhatsApp and Signal put "Missed voice call", "Video call · 12:04" in the thread. A missed call that leaves no trace is a Core Value failure. | LOW | System messages written by the server when the call state machine reaches a terminal state. Tap the entry to call back. |
| **Missed-call push notification** | If she didn't see the ringing push, she needs a follow-up "Missed call from X". | LOW | Sent on the `missed` transition. Use the same notification tag as the ringing one so it replaces it. |
| **Glare / busy handling** | Both people tapping "call" at the same moment is *likely* in a couple app ("call me" → both call). | LOW–MEDIUM | Server rule: if A calls B while B→A is ringing, auto-merge into one accepted call. If someone is already in a call, return "busy". |
| **Screen stays awake during video call** | The phone auto-locking mid-call ends the call on iOS. | LOW | Screen Wake Lock API works in iOS Home Screen apps from **iOS 18.4**. Re-acquire on `visibilitychange`. |
| **Hang-up propagation + stale call cleanup** | If one side closes the app or loses battery, the other must not sit in a dead call forever. | LOW–MEDIUM | Heartbeat or SFU peer-left event → server ends the call → both clients get `ended`. |

#### D. Notifications, badge, PWA shell

| Feature | Why Expected | Complexity | Notes |
|---------|--------------|------------|-------|
| **Install + notification onboarding flow** | On iOS, push **only works after Add to Home Screen**, and permission has to be requested from a user gesture *inside the installed app*. Without guidance, she'll use it in a Safari tab and never get notifications. | LOW–MEDIUM | First-run screen: detect `display-mode: standalone`. If it isn't standalone on iOS, show "Share → Add to Home Screen" instructions. Once installed, show an "Enable notifications" button. Log in inside the installed app, because iOS keeps PWA storage separate from Safari. |
| **Message push with sender + preview** | Committed. Preview text ("Photo", "Voice message 0:12", or the text snippet). | LOW | |
| **No push while the recipient is actively looking at the chat** | Getting a banner for a message you're already reading is annoying. **But iOS requires every push to show a notification**: after about 3 silent pushes Safari revokes the subscription. So the suppression has to happen on the **server**, not in the service worker. | LOW–MEDIUM | Server tracks "recipient has a foreground WS + chat visible" via client-reported visibility and skips sending the push. The SW must always call `showNotification` for anything it does receive. |
| **Notification collapsing (tag) + clear on open** | Ten messages in a row shouldn't make ten banners stack up. Opening the chat should clear them from Notification Center. | LOW | `tag: 'chat'` (renotify where supported). On chat open: `registration.getNotifications()` → `close()`. |
| **App icon badge = unread count** | iOS users expect the red badge. | LOW | `navigator.setAppBadge(n)` from the SW on push and in the page on read. iOS 16.4+, installed apps only, requires notification permission. **Android Chrome doesn't support the Badging API**; Android shows a launcher notification dot instead, which is fine. |
| **Push subscription self-healing + "send test notification" button** | Subscriptions silently expire or get revoked (iOS revocation, reinstall, cleared storage). Without a health check, "notifications stopped working" turns into a debugging session. | LOW | Re-register the subscription on every app open (upsert by endpoint). The server deletes subscriptions that return 404/410. The settings screen shows status plus a test button. |
| **Long-lived login sessions** | Logging in with password + TOTP every day would make her give up on the app. WhatsApp never asks. | LOW | Rolling session cookie (e.g. 90 days, refreshed on use), httpOnly, Secure, SameSite=Lax. TOTP only at login. |
| **App shell loads offline + shows recent cached messages** | Opening the app in a dead zone should show the last conversation, not a white screen or a browser error. | MEDIUM | SW caches the app shell. Last ~100–200 messages cached in IndexedDB (read-only view). **Not** full offline-first sync; see Anti-Features. |
| **SW update prompt ("New version — reload")** | You'll iterate quickly. Without it, the installed PWAs keep running stale code with a mismatched API for days. | LOW | Detect `waiting` SW → toast with a Reload action → `skipWaiting` + reload. |
| **Safe areas, standalone styling, dark mode following system** | The notch and home indicator have to be handled. Dark mode at night is expected. | LOW | `viewport-fit=cover`, `env(safe-area-inset-*)`. Use the preset's dark tokens; no custom theming. |

#### E. Account & settings (minimal)

| Feature | Why Expected | Complexity | Notes |
|---------|--------------|------------|-------|
| **Login (password + TOTP), logout, change password** | Committed, plus the bare minimum account hygiene. | LOW | Rate-limit login attempts. |
| **TOTP enrollment for the two seeded accounts** | Each person needs to scan a QR once. | LOW | Do it on first login (show QR + confirm a code) or with a CLI seed script that prints an otpauth URI. Recovery is a server-side CLI reset, since the owner has shell access. |
| **Display name + avatar** | Shown in the chat header, notifications, and the incoming-call screen. | LOW | Upload an avatar once. That's the whole "profile". |

---

### Differentiators (Competitive Advantage)

Since there are only two users, "competitive advantage" means **things that make this feel like *their* app rather than a downgraded WhatsApp**. Pick at most 2–3 for v1.x. None of these are required for launch.

| Feature | Value Proposition | Complexity | Notes |
|---------|-------------------|------------|-------|
| **Shared media gallery ("Our photos")** | Between's core "Moments" idea. Images are kept forever, so a grid of every photo and video ever sent is a memory album for free. Probably the best value per hour of work on this list. | LOW–MEDIUM | One query (`messages WHERE type IN (image, video) ORDER BY id DESC`), a grid, and reuse of the media viewer. |
| **Days-together counter / anniversary chip in the header** | The signature couple-app feature (Between, and every couple app in the stores). Charming and almost free. | LOW | One date setting + "Day 1,234". Optional anniversary push via cron. |
| **"Thinking of you" nudge (tap the heart → partner gets a gentle push + a small animation in chat)** | A one-tap, low-effort way to connect, and something WhatsApp can't do. | LOW | Effectively a special message type. Reuses push. |
| **Message search** | History is kept forever, and "what was that restaurant you sent?" comes up sooner or later. WhatsApp has it, so after a few months this becomes table stakes. | LOW–MEDIUM | SQLite FTS5 or Postgres `tsvector`, depending on the DB choice. Results jump to the message (shares the "jump to message" mechanism with replies). |
| **Swipe-to-reply gesture** | Faster than long-press → Reply. Feels native. | LOW–MEDIUM | Horizontal pan on the bubble with a threshold. Watch for conflict with iOS edge-swipe-back. |
| **Online / last-seen presence** | Cheap because the WS already exists. "Online" in the header tells you whether calling now makes sense. | LOW | Can be derived from the WS + visibility state that push suppression already needs. Signal deliberately doesn't have it, so it's a real choice, but for a couple it's usually welcome. |
| **Album grouping for multi-image sends** | 6 photos shown as one 2×3 grid bubble instead of 6 bubbles. | MEDIUM | Needs a `groupId` on messages. Rendering complexity. |
| **"Recording a voice message…" indicator** | WhatsApp-level polish on top of typing. | LOW | Reuses the typing channel with a different state. |
| **Edit message (with "edited" label)** | WhatsApp, Telegram, and iMessage have it now. Delete covers most needs. | LOW–MEDIUM | Needs edit propagation through sync and reply quotes that update. |
| **Voice → video upgrade mid-call** | Start in voice, turn on the camera without hanging up. | MEDIUM | The SFU makes this fairly natural (produce a new video track), but it needs UI state and permission prompt handling mid-call. |
| **Pinned messages / shared notes** | Couple apps keep addresses, wifi passwords, gift ideas. | LOW–MEDIUM | Pin flag + pinned bar. |

---

### Anti-Features (Commonly Requested, Often Problematic)

| Feature | Why Requested | Why Problematic | Alternative |
|---------|---------------|-----------------|-------------|
| **"Delivered" double-grey-tick state** | WhatsApp has three ticks. | Real delivery acks need the SW to make network calls on push, which is fragile on iOS. Fake "delivered" (= "sent to push service") is misleading. | Sending / Sent / Read / Failed. |
| **Speakerphone / earpiece toggle** | Every phone dialer has one. | iOS Safari can't reliably route WebRTC audio: `setSinkId` doesn't exist before Safari 18.4, is unreliable after, and output routing is controlled by getUserMedia/AVAudioSession mode. You'd spend hours on something the platform won't do. | Don't show the button. Rely on system routing; AirPods and Bluetooth work through Control Center. Write this down as a known limitation. |
| **Notification action buttons (Answer / Decline / Reply from notification)** | Feels native. | Not supported for web push on iOS. Only the default tap action exists. | Tap opens the app, and the app checks for a ringing call (see Calls). |
| **Native ringing / CallKit / ringing on lock screen** | Real phone experience. | Already out of scope. Impossible from a PWA. | Push notification + missed-call entry + missed-call push. |
| **Link previews (unfurling)** | WhatsApp and iMessage do it. | The server fetching arbitrary URLs is an SSRF surface, plus scraping edge cases (OG tags, redirects, paywalls). Hours of work for low value between two people. | Linkify only. |
| **GIF / sticker search (Giphy, Tenor)** | Fun. Between sells stickers. | A third-party API key and data leaving the box conflict with "self-hosted, no third parties". | Native emoji keyboard, plus sending images and short videos. |
| **Custom emoji picker for the composer** | Looks complete. | The phone keyboard already has a better one. Bundle bloat. | Native keyboard. Fixed 6-emoji quick reactions + "+" that opens the keyboard. |
| **Full offline-first local database with sync / conflict resolution** | "Works offline like WhatsApp." | Multi-day project (IndexedDB schema, sync protocol, conflict handling). Not needed at 2 users. | Outbox for *sending* + read-only cache of recent messages + catch-up sync on reconnect. |
| **Client-side video compression (ffmpeg.wasm)** | Smaller uploads. | ffmpeg.wasm is ~30MB, slow, and memory-hungry on iOS (tab crashes). | Server-side ffmpeg on the same box. |
| **Custom in-app camera UI** | Snapchat-style capture. | getUserMedia preview + capture + recording UI is a whole sub-project. | Native picker with camera option via `<input type="file">`. |
| **Message forwarding, groups, broadcast, stories/status, polls, bots, scheduling** | Big-app parity. | Only one chat with one other person exists. Forwarding goes nowhere. | Nothing. |
| **Screen sharing / call recording / call effects / background blur** | Video-call parity. | iOS Safari doesn't support `getDisplayMedia`. Recording raises consent questions. Blur means ML models on the phone. | Nothing. |
| **Live location sharing** | Couple apps advertise it. | Background geolocation is impossible in a PWA. A foreground-only version is useless. | Send a maps link. |
| **Admin panel / user management UI** | "Proper app". | Two fixed accounts forever. | CLI scripts: seed users, reset TOTP, reset password. |
| **Themes / chat wallpapers / custom bubble colors** | Between monetizes them. | Conflicts with the locked shadcn preset (no UI deviation allowed). | Preset light/dark only. |
| **Read-receipt / typing privacy toggles** | Signal and WhatsApp have them. | Both users chose these features, and toggles add state, settings UI, and logic branches. | Always on. |
| **Notification preview privacy toggle, mute/DND schedules** | Big-app settings. | iOS Focus modes and per-app notification settings already handle this at the OS level. | OS settings. Revisit only if asked. |
| **Multi-device "ring every device, first to answer wins" with device management** | Using it on a laptop too. | Call ownership across devices, "answered elsewhere" UX, per-device sessions UI. | Push goes to all subscriptions (that comes free). If a second device answers, so be it. Don't build device-management UI. |
| **Self-service password / TOTP recovery flows (email, SMS)** | Standard SaaS. | No email infrastructure, and the owner has shell access. | CLI reset script. |

---

## Feature Dependencies

```
Auth (password+TOTP, long-lived session)
    └──required by──> everything below

PWA shell (manifest, SW, standalone, safe areas, update prompt)
    └──required by──> Install+notification onboarding
                          └──required by──> Web push (messages)
                                                ├──required by──> Push-to-answer calls
                                                ├──required by──> Missed-call push
                                                └──enhanced by──> App badge (needs notif permission on iOS)

Realtime channel (WS) + REST history API
    ├──required by──> Optimistic send (clientId idempotency)
    │                     └──required by──> Outbox + retry ──> Failed state / tap-to-retry
    ├──required by──> Reconnect + catch-up sync
    ├──required by──> Typing indicator, read receipts, reactions live updates
    ├──required by──> In-app incoming call sheet
    └──required by──> Presence/visibility ──> Server-side push suppression
                                         └──enhances──> Online/last-seen (differentiator)

Message model (types: text | image | video | voice | system(call) ; replyToId ; deletedAt)
    ├──required by──> Reply (quote + jump-to-message)
    │                     └──shares mechanism with──> Message search jump (differentiator)
    ├──required by──> Reactions
    ├──required by──> Delete/unsend
    └──required by──> Call history entries (system messages)

Upload endpoint + ffmpeg/sharp processing pipeline
    ├──required by──> Images (dimensions + thumb)
    ├──required by──> Video clips (H.264 transcode + poster)
    ├──required by──> Voice notes (AAC normalization + duration)
    └──required by──> Media viewer ──enhances──> Shared gallery (differentiator)

SFU integration (room provisioning + join tokens + mediasoup-client)
    └──required by──> Call state machine (ringing/accepted/declined/missed/ended)
                          ├──required by──> Outgoing/incoming call UI, glare/busy handling
                          ├──required by──> Call history entries + missed-call push
                          └──required by──> In-call controls (mute/flip/camera/end, reconnecting)

Server-side push suppression ──conflicts with──> SW-side "skip notification if focused"
    (iOS revokes subscription after ~3 silent pushes; suppression MUST be server-side)

Notification deep-link routing ──conflicts with──> iOS reality
    (use "check server for ringing call on open/visible" instead of URL routing)
```

### Dependency Notes

- **Push depends on install onboarding, and calls depend on push:** on iOS none of the "incoming call while backgrounded" flow works until the app is installed and has notification permission. Build and test onboarding + push **before** calls, and test it on the real iPhone early.
- **Outbox depends on clientId idempotency:** retries without server-side dedupe produce duplicate messages. Put the `clientId UNIQUE` column in the first message schema.
- **One ffmpeg pipeline covers video and voice:** once ffmpeg is in the container for video, normalizing voice notes to AAC `.m4a` costs nothing extra and removes the whole Safari-vs-Chrome MediaRecorder format problem. Build the pipeline once, generically (job: input file → output file(s) + metadata).
- **Call history entries depend on a server-owned call state machine:** if call state lives only in the clients, missed calls get lost whenever the callee's app isn't open, which is exactly the case that matters. The server must own `ringing → terminal` transitions and the ring timeout.
- **Read semantics and push suppression share one signal:** the client reporting "I'm visible and viewing the chat" drives both "mark as read" and "don't push me". Build it once.
- **Reply jump-to-message and search jump share the "load history around message X" API.** Build it for replies, and search reuses it later.

---

## MVP Definition

### Launch With (v1)

Everything the user committed to, plus the supporting table stakes that keep it from feeling broken:

- [ ] **Auth:** password + TOTP, two seeded accounts, rolling 90-day sessions, logout. *Gate for everything.*
- [ ] **PWA shell:** manifest, icons, SW with app-shell cache, safe areas, dark mode, SW update prompt. *Required for install and push.*
- [ ] **Install + notification onboarding** (iOS Add-to-Home-Screen guidance, permission button, subscription upsert, test-push button). *Without it, push silently never works on iOS.*
- [ ] **Text chat:** optimistic send + clientId idempotency, outbox + retry, sending/sent/read/failed, reconnect + catch-up sync, connection banner, paginated history, unread divider + jump-to-bottom, day separators, linkify, keyboard-safe composer with persisted drafts. *The Core Value: reliable messaging.*
- [ ] **Typing + read receipts** with correct visibility-based read semantics. *Committed.*
- [ ] **Long-press menu: react / reply / copy / delete.** Fixed quick reactions, quoted replies (jump if loaded), soft-delete. *Committed, plus "unsend".*
- [ ] **Images:** multi-select, client downscale, upload progress, dimension placeholders, full-screen viewer with zoom/swipe, share/save. *Committed, kept forever.*
- [ ] **Video clips:** server transcode to H.264 MP4 + poster, size/duration caps, inline playback. *Committed; transcode is what makes iPhone→Pixel work.*
- [ ] **Voice notes:** tap-to-record with timer/cancel, AAC normalization, duration, scrubber, 1×/1.5×/2×. *Committed.*
- [ ] **Push:** message push with preview, server-side suppression when viewing, tag-collapsing, clear-on-open, app badge on iOS. *Committed.*
- [ ] **Calls:** voice + video via SFU, server call state machine, outgoing ringback + timeout, in-app incoming sheet + ringtone, push-to-answer via "check for ringing call on open", mute / camera / flip / end, remote mute indicators, reconnecting state, wake lock, glare/busy handling, hang-up propagation. *Committed; Core Value.*
- [ ] **Call history entries + missed-call push.** *A missed call must leave a trace.*
- [ ] **Settings (minimal):** display name, avatar, change password, notification status/test. *Bare minimum.*

### Add After Validation (v1.x)

- [ ] **Shared media gallery**: as soon as v1 is stable. Highest delight per hour.
- [ ] **Message search**: once history is a few months deep, or the first time someone asks "where did you send that…".
- [ ] **Days-together counter + "thinking of you" nudge**: cheap couple-app charm. Add when there's an evening free.
- [ ] **Online / last-seen presence**: if "is she around to call?" turns out to matter.
- [ ] **Swipe-to-reply**: if long-press → Reply feels slow in daily use.
- [ ] **Edit message**: if delete-and-resend becomes a frequent complaint.

### Future Consideration (v2+)

- [ ] **Voice → video upgrade mid-call**: nice, but hanging up and calling back with video takes 3 seconds.
- [ ] **Album grouping for multi-image sends**: pure visual polish.
- [ ] **Pinned messages / shared notes**: only if they start using the chat as a shared notebook.
- [ ] **Recording-voice indicator**: polish.

---

## Feature Prioritization Matrix

| Feature | User Value | Implementation Cost | Priority |
|---------|------------|---------------------|----------|
| Optimistic send + clientId + outbox/retry + failed state | HIGH | MEDIUM | P1 |
| Reconnect + catch-up sync | HIGH | MEDIUM | P1 |
| Install + notification onboarding | HIGH | LOW | P1 |
| Server-side push suppression + tag collapse + clear on open | HIGH | LOW | P1 |
| Keyboard-safe iOS layout | HIGH | MEDIUM | P1 |
| Long-lived sessions | HIGH | LOW | P1 |
| Paginated history + unread divider + jump-to-bottom | HIGH | MEDIUM | P1 |
| Media viewer (zoom/swipe/share) | HIGH | MEDIUM | P1 |
| ffmpeg pipeline (video H.264 + voice AAC) | HIGH | MEDIUM | P1 |
| Server call state machine + call history entries + missed-call push | HIGH | MEDIUM | P1 |
| "Check for ringing call on open" (push-to-answer) | HIGH | LOW | P1 |
| In-call controls (mute/camera/flip/end) + remote indicators | HIGH | LOW–MEDIUM | P1 |
| Reconnecting state + hang-up propagation | HIGH | MEDIUM | P1 |
| Glare/busy handling | MEDIUM | LOW | P1 |
| Delete/unsend | MEDIUM | LOW | P1 |
| App badge (iOS) | MEDIUM | LOW | P1 |
| Wake lock during calls | MEDIUM | LOW | P1 |
| SW update prompt | MEDIUM (dev velocity) | LOW | P1 |
| Voice note playback speed | LOW–MEDIUM | LOW | P1 (trivial) |
| Shared media gallery | HIGH | LOW–MEDIUM | P2 |
| Message search | MEDIUM (grows over time) | LOW–MEDIUM | P2 |
| Days-together counter / nudge | MEDIUM | LOW | P2 |
| Online / last seen | MEDIUM | LOW | P2 |
| Swipe-to-reply | LOW–MEDIUM | LOW–MEDIUM | P2 |
| Edit message | LOW–MEDIUM | LOW–MEDIUM | P2 |
| Voice→video upgrade | LOW | MEDIUM | P3 |
| Album grouping | LOW | MEDIUM | P3 |
| Speaker/earpiece toggle | MEDIUM | HIGH / infeasible on iOS | Won't build |
| Link previews | LOW | MEDIUM + security | Won't build |
| Full offline-first sync | LOW at this scale | HIGH | Won't build |

**Priority key:**
- P1: Must have for launch
- P2: Should have, add when possible
- P3: Nice to have, future consideration

---

## Competitor Feature Analysis

| Feature | WhatsApp | Signal | Telegram | Between (couple app) | duet approach |
|---------|----------|--------|----------|----------------------|---------------|
| Message status | Clock / ✓ sent / ✓✓ delivered / blue ✓✓ read | Same as WhatsApp, read optional | ✓ sent / ✓✓ read | Read indicator | Sending / Sent / Read / Failed (no "delivered") |
| Offline send | Queued, auto-retry | Queued, auto-retry | Queued, auto-retry | Queued | Outbox + retry on reconnect |
| Reactions | Any emoji, 1 per user | Any emoji, 1 per user | Multiple | Stickers | 6 quick + "+" via native keyboard, 1 per user |
| Reply | Swipe or long-press, quote, tap to jump | Same | Same | Basic | Long-press, quote, jump if loaded (swipe in v1.x) |
| Delete | For everyone (time-limited) | For everyone (time-limited) | Anytime, both sides | Yes | Anytime, soft-delete, both sides |
| Edit | Yes (15 min) | Yes (24h) | Yes | No | v1.x maybe |
| Voice notes | Hold/lock, waveform, speed, transcription | Hold/lock, speed | Hold/lock, speed | Yes (length capped on free tier) | Tap-to-record, timer, scrubber, speed |
| Media viewer | Zoom, swipe, save, media gallery | Same | Same | "Moments" album | Lightbox + share; gallery in v1.x |
| Video handling | Server and client compression | Client compression | Server transcode | Length-capped | Server ffmpeg → H.264 MP4 |
| Call controls | Mute, camera, flip, speaker, PiP, upgrade to video | Same | Same | Basic | Mute, camera, flip, end (**no speaker toggle**: platform limit) |
| Missed calls | In-chat entry + calls tab + notification | In-chat entry + notification | Calls list + notification | Notification | In-chat entry + missed-call push (no separate calls tab) |
| Incoming call | Native full-screen ring (CallKit) | Native ring | Native ring | Native ring | Push → tap → in-app ring screen (no native ringing) |
| Presence | Online / last seen | None | Online / last seen | Partial | v1.x optional |
| Search | Yes | Yes | Yes | Limited | v1.x |
| Couple extras | None | None | None | Day counter, calendar, anniversaries, album, passcode | Day counter + nudge + gallery in v1.x; skip calendar |

---

## Platform Constraints That Shape Features (iOS PWA)

These are listed here because they directly decide whether a feature is buildable. PITFALLS.md should go deeper on each.

| Constraint | Feature impact | Confidence |
|------------|----------------|------------|
| Push only after Add to Home Screen; permission needs a user gesture in the installed app | Onboarding flow is table stakes | HIGH (WebKit) |
| Every push must show a notification; ~3 silent pushes → subscription revoked | Push suppression must be server-side | MEDIUM (WebKit commit + Discourse incident) |
| No notification action buttons on iOS web push | No Answer/Decline in notification | MEDIUM |
| `notificationclick` deep-link URL often ignored (opens last page or root) | App must reconcile "ringing call?" on open/visible | MEDIUM (multiple dev reports) |
| WS dies when backgrounded | Catch-up sync on visible is mandatory | HIGH |
| Badging API: iOS 16.4+ installed apps with notif permission; **not** on Android Chrome | Badge iOS-only; Android uses launcher dot | MEDIUM (MDN + WebKit) |
| Screen Wake Lock works in Home Screen apps from iOS 18.4 | Wake lock during calls OK on current iOS | MEDIUM |
| No reliable audio output routing (setSinkId) on iOS | No speaker toggle | MEDIUM |
| MediaRecorder formats differ (webm/opus vs mp4/aac) | Normalize voice notes server-side | MEDIUM |
| iPhone video is HEVC/MOV; Chrome Android playback unreliable | Server transcode to H.264 MP4 | MEDIUM |
| Only one camera can be open at a time on iOS | Flip camera = stop old track, then open new | MEDIUM (well-known; verify on device) |
| Backgrounding the PWA mid-call suspends camera (and possibly mic) | Show "video paused" state; document "keep app open during calls" | MEDIUM (verify on device) |
| No `navigator.vibrate` on iOS | Ringtone audio only; needs prior audio unlock gesture | HIGH |

---

## Sources

- WebKit — Badging for Home Screen Web Apps: https://webkit.org/blog/14112/badging-for-home-screen-web-apps/
- MDN — Display a badge on the app icon: https://developer.mozilla.org/en-US/docs/Web/Progressive_web_apps/How_to/Display_badge_on_app_icon
- WebKit — Meet Web Push (userVisibleOnly requirement): https://webkit.org/?p=12945
- WebKit commit — Enforce silent push quota: https://webkit.googlesource.com/WebKit/+/108ccb442e40e9705d212e74c1f213e3b5a0ea05
- Discourse Meta — iOS notifications can lose permission to push if the user is currently active: https://meta.discourse.org/t/ios-notifications-can-lose-permission-to-push-if-the-user-is-currently-active/290225
- Apple Developer Forums — Web push notification actions on iOS 16.4: https://developer.apple.com/forums/thread/726793
- Apple Developer Forums — PWA push unable to redirect to specified URL on iOS: https://developer.apple.com/forums/thread/733604
- OneSignal — Action buttons compatibility: https://documentation.onesignal.com/docs/en/action-buttons.md
- WebKit — MediaRecorder API: https://webkit.org/blog/11353/mediarecorder-api/
- MDN — MediaRecorder.isTypeSupported(): https://developer.mozilla.org/en-US/docs/Web/API/MediaRecorder/isTypeSupported
- Build with Matija — iPhone Safari MediaRecorder audio (conflicting format report): https://www.buildwithmatija.com/de/blog/iphone-safari-mediarecorder-audio-recording-transcription
- Jellyfin forum — HEVC playback in Chrome (MP4 vs MOV container): https://forum.jellyfin.org/t-hevc-not-working-in-chrome?pid=18623
- Daily.co — setOutputDeviceAsync (Safari <18.4 no setSinkId; unreliable after): https://docs.daily.co/reference/daily-js/instance-methods/set-output-device-async.md
- VideoSDK — Change audio output device (iOS notes): https://docs.videosdk.live/javascript/guide/video-and-audio-calling-api-sdk/handling-media/change-audio-ouptut-device
- WebKit Bugzilla 254545 — Wake Lock in Home Screen web apps: https://bugs.webkit.org/show_bug.cgi?id=254545
- firt.dev — iOS PWA compatibility notes: https://firt.dev/notes/pwa-ios/
- Between feature comparison: https://connectedcouples.app/compare/connected-vs-between ; DesignRush listing: https://www.designrush.com/best-designs/apps/between
- WhatsApp / Signal / Telegram feature behavior: first-hand product knowledge (HIGH confidence for the feature list; exact time limits on edit/delete may have changed)

---
*Feature research for: private 2-person messaging + calling PWA (duet)*
*Researched: 2026-10-08*
