# Requirements: duet

**Defined:** 2026-10-08
**Core Value:** The two of us can reliably message and call each other — on both phones, including over cellular — on infrastructure we fully control.

## v1 Requirements

### Infrastructure

- [ ] **INFR-01**: duet is reachable at an HTTPS URL on the new domain via a Cloudflare Tunnel to this machine
- [ ] **INFR-02**: App, database (SQLite) and media files run self-hosted in Docker on this machine with data on a persistent volume
- [ ] **INFR-03**: SFU + coturn run on this machine and are reachable from the public internet (new domain DNS, router UDP/TCP port-forwards, verified non-CGNAT public IPv4)
- [ ] **INFR-04**: A smoke test proves media flows through the SFU (`bytesReceived > 0`) from a phone on cellular, both direct and forced-relay via TURN

### Auth

- [ ] **AUTH-01**: Exactly two accounts exist, created by a server seed script; there is no sign-up UI
- [ ] **AUTH-02**: User can log in by tapping their name and entering their password (password-only; TOTP dropped 2026-10-08)
- [ ] **AUTH-03**: User stays logged in across app restarts for a long rolling period (no frequent re-login)
- [ ] **AUTH-04**: User can log out

### App Shell

- [ ] **SHEL-01**: UI is built exclusively from shadcn preset `b51GFhBEQ` (scaffolded via `shadcn init -p b51GFhBEQ`, components only via `shadcn add`)
- [ ] **SHEL-02**: User can install the app to the home screen on iPhone (Safari) and Pixel (Chrome) and it launches standalone
- [ ] **SHEL-03**: First-run onboarding guides iPhone users to Add to Home Screen and to enable notifications, with a test-push button

### Chat

- [ ] **CHAT-01**: User can send and receive text messages in real time
- [ ] **CHAT-02**: Full message history persists forever and loads with pagination when scrolling up
- [ ] **CHAT-03**: Sent messages appear instantly and show status: sending / sent / read / failed
- [ ] **CHAT-04**: Messages composed while offline are queued and sent automatically on reconnect; failed messages can be retried; retries never duplicate
- [ ] **CHAT-05**: After the app resumes from background or reconnects, it catches up on everything missed
- [ ] **CHAT-06**: User sees a typing indicator when the other person is typing
- [ ] **CHAT-07**: User sees when the other person has read their messages (read receipts)
- [ ] **CHAT-08**: User can react to a message with an emoji
- [ ] **CHAT-09**: User can reply to a specific message, shown as a quoted reply

### Media

- [ ] **MDIA-01**: User can send images from the camera or photo library; iPhone HEIC photos display correctly on both phones
- [ ] **MDIA-02**: User can tap an image to view it full screen
- [ ] **MDIA-03**: User can send short video clips that play on both phones (server transcodes to H.264 MP4)
- [ ] **MDIA-04**: User can record and send voice notes that play on both phones, with a playback scrubber
- [ ] **MDIA-05**: Media is only accessible to the two logged-in users (auth-gated, supports range requests for playback)

### Notifications

- [ ] **NOTF-01**: User receives a push notification for new messages when the app is not in the foreground
- [ ] **NOTF-02**: Tapping a message notification opens the app into the chat
- [ ] **NOTF-03**: No push is sent while the recipient is actively viewing the chat

### Calls

- [ ] **CALL-01**: User can start a 1:1 voice call
- [ ] **CALL-02**: User can start a 1:1 video call
- [ ] **CALL-03**: Recipient gets an "incoming call" push; tapping it (or opening the app) shows the incoming-call screen to accept or decline
- [ ] **CALL-04**: Unanswered calls stop ringing after a timeout; caller can cancel while ringing
- [ ] **CALL-05**: During a call, user can mute/unmute, turn camera on/off, and hang up
- [ ] **CALL-06**: During a video call, user can switch between front and back camera
- [ ] **CALL-07**: A call survives brief network blips, showing a "Reconnecting…" state, and rejoins automatically
- [ ] **CALL-08**: Screen stays awake during a call
- [ ] **CALL-09**: Calls connect over cellular (TURN relay) as well as Wi-Fi

## v2 Requirements

### Chat

- **CHAT-10**: Delete own message (soft delete, "message deleted" placeholder)
- **CHAT-11**: Unread badge on the home-screen app icon
- **CHAT-12**: Drafts survive app close
- **CHAT-13**: Message search

### Calls

- **CALL-10**: Missed-call / call-log entries in the chat timeline and missed-call push

### Account

- **AUTH-05**: ~~Recovery codes for lost authenticator~~ (moot: TOTP dropped)
- **AUTH-06**: CLI script to reset a user's password

### Ops

- **OPS-01**: Nightly backup of database + media
- **OPS-02**: Disk-space alert

### Extras

- **XTRA-01**: Shared media gallery
- **XTRA-02**: Days-together counter / "thinking of you" nudge
- **XTRA-03**: Online presence

## Out of Scope

| Feature | Reason |
|---------|--------|
| End-to-end encryption | User chose "private & self-hosted"; TLS + self-hosting is the bar |
| View-once / disappearing / screenshot blocking | Images are normal, kept forever |
| Native apps / CallKit full-screen ringing | Push-to-answer accepted; native adds days |
| Groups, >2 users, sign-up | Exactly two users forever |
| Third-party data hosting (Vercel, managed DB/Blob) | Everything self-hosted on this machine |
| Any deviation from the shadcn preset (themes, lucide, Radix snippets) | Preset is locked |
| "Delivered" tick | iOS can't report it honestly |
| Speaker/earpiece toggle | iOS PWAs can't control audio routing |
| Notification action buttons (Answer/Decline in the notification) | Unsupported on iOS |
| Link previews | SSRF risk, low value |
| GIF/sticker search | Third-party dependency |
| Offline-first sync DB, client-side video compression (ffmpeg.wasm) | Days of work, unnecessary at this scale |
| Admin UI | Two users; scripts suffice |

## Traceability

Which phases cover which requirements. Updated during roadmap creation.

| Requirement | Phase | Status |
|-------------|-------|--------|
| INFR-01 | Phase 1 | Pending |
| INFR-02 | Phase 1 | Pending |
| INFR-03 | Phase 1 | Pending |
| INFR-04 | Phase 1 | Pending |
| AUTH-01 | Phase 1 | Pending |
| AUTH-02 | Phase 1 | Pending |
| AUTH-03 | Phase 1 | Pending |
| AUTH-04 | Phase 1 | Pending |
| SHEL-01 | Phase 1 | Pending |
| SHEL-02 | Phase 1 | Pending |
| SHEL-03 | Phase 2 | Pending |
| CHAT-01 | Phase 2 | Pending |
| CHAT-02 | Phase 2 | Pending |
| CHAT-03 | Phase 2 | Pending |
| CHAT-04 | Phase 2 | Pending |
| CHAT-05 | Phase 2 | Pending |
| CHAT-06 | Phase 2 | Pending |
| CHAT-07 | Phase 2 | Pending |
| CHAT-08 | Phase 2 | Pending |
| CHAT-09 | Phase 2 | Pending |
| MDIA-01 | Phase 2 | Pending |
| MDIA-02 | Phase 2 | Pending |
| MDIA-03 | Phase 2 | Pending |
| MDIA-04 | Phase 2 | Pending |
| MDIA-05 | Phase 2 | Pending |
| NOTF-01 | Phase 2 | Pending |
| NOTF-02 | Phase 2 | Pending |
| NOTF-03 | Phase 2 | Pending |
| CALL-01 | Phase 3 | Pending |
| CALL-02 | Phase 3 | Pending |
| CALL-03 | Phase 3 | Pending |
| CALL-04 | Phase 3 | Pending |
| CALL-05 | Phase 3 | Pending |
| CALL-06 | Phase 3 | Pending |
| CALL-07 | Phase 3 | Pending |
| CALL-08 | Phase 3 | Pending |
| CALL-09 | Phase 3 | Pending |

**Coverage:**
- v1 requirements: 37 total
- Mapped to phases: 37
- Unmapped: 0 ✓

---
*Requirements defined: 2026-10-08*
*Last updated: 2026-10-08 after roadmap revision (3 phases; MDIA moved to Phase 2, CALL to Phase 3)*
