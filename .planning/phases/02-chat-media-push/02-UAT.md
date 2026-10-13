---
status: diagnosed
phase: 02-chat-media-push
source: [02-01-SUMMARY.md, 02-02-SUMMARY.md, 02-03-SUMMARY.md, 02-04-SUMMARY.md, 02-05-SUMMARY.md]
started: 2026-10-13T10:26:41Z
updated: 2026-10-13T12:06:08.255Z
---

## Current Test

[testing complete]

## Tests

### 1. Cold Start Smoke Test
expected: Stop the duet container, then start it again with `docker compose up -d`. It boots without errors, migrations run, and https://duet.brkn.me loads and logs in with your chat history intact.
result: pass
note: "Run by Claude: docker compose stop/up -d → clean boot, healthy; smoke-public ok (edge→tunnel→duet→SQLite); check-live-db --existing ok (all migrations applied, 2 users, 3 sessions, 0 messages so history check is trivial)"

### 2. Text chat on both phones
expected: On the installed iPhone and Pixel PWAs (one on cellular), a text sent from one phone appears on the other right away. The typing indicator shows while the other person types. The read state updates once the message is seen. Reactions (💕 💔 😋 😝 😘 😭) from long-press show live on the other phone, and swipe-to-reply sends a reply with a quote.
result: pass

### 3. iPhone keyboard layout
expected: In the installed iPhone PWA, opening the keyboard keeps both the header and the composer on screen. Nothing hides behind the keyboard and the page doesn't jump off-screen. When you're scrolled up and a new message arrives, a scroll-to-latest badge appears and works.
result: pass

### 4. Offline outbox and background catch-up
expected: In airplane mode, a sent message shows as pending. When you turn airplane mode off it sends without retyping. Messages sent while duet was in the background or closed are all there when you reopen it, on both phones.
result: pass

### 5. Gestures and quote jump
expected: On both phones, swipe-to-reply and long-press for reactions don't stop normal scrolling, text selection or the system long-press callout. Tapping a quoted reply that points far back in history scrolls to and highlights the original.
result: pass

### 6. Read receipts respect privacy
expected: If a message arrives while the receiving phone is locked, or while duet is in the background, the sender does NOT see it as read. It only shows as read once the recipient actually has duet open and focused.
result: pass

### 7. Push notifications
expected: The in-app guide steps match Safari's Add to Home Screen flow. Enable → Allow → a test push arrives. With duet closed, new messages raise a notification on both the iPhone and the Pixel. Several messages collapse into a single '{name} · n new messages' notification. Tapping it opens the chat. While you're actively viewing the chat, no notification appears.
result: issue
reported: "notifications are not working on iphone but pass on android"
severity: major

### 8. Photos: HEIC, camera and albums
expected: A HEIC from the iPhone camera roll and a fresh camera photo taken through '+' both appear correctly rotated on the Pixel. A 5-photo album with a caption sent from the Pixel shows on the iPhone as a 2×2 grid with '+1'. The viewer swipes through all 5 and shows the caption.
result: pass

### 9. 10-item mixed album viewer
expected: A 10-item album mixing photos and videos opens in the viewer showing '1 / 10' through '10 / 10' as you swipe. Videos don't autoplay. Closing the viewer returns you to the same scroll position in the chat.
result: pass

### 10. Video clips across phones
expected: An iPhone HEVC HDR portrait .MOV plays on the Pixel upright with normal (not washed-out or blown-out) colours. A clip recorded on the Pixel plays on the iPhone, and seeking works in both directions.
result: pass

### 11. Voice notes
expected: Hold the mic to record and release to send. Slide to cancel. Lock for a hands-free recording and tap to send. The voice note plays on the other phone with a waveform you can tap or drag to seek. After recording on the iPhone, the orange mic indicator turns off.
result: pass

### 12. [02-01] Text message sent in one browser appears in the other in real time and persists across rel
expected: Text message sent in one browser appears in the other in real time and persists across reload (CHAT-01)
result: pass
source: automated
coverage_id: 02-01-D1

### 13. [02-01] Idempotent send on client UUID, 409 id_conflict, strict body, code-point cap, byte-identic
expected: Idempotent send on client UUID, 409 id_conflict, strict body, code-point cap, byte-identical bodies, body never logged (CHAT-04, T-02-01..03)
result: pass
source: automated
coverage_id: 02-01-D2

### 14. [02-01] History pages back to the first message with strict before bound and beginning marker (CHA
expected: History pages back to the first message with strict before bound and beginning marker (CHAT-02)
result: pass
source: automated
coverage_id: 02-01-D3

### 15. [02-01] Offline sends show Sending…, never fail while offline, deliver once in order; Sent only af
expected: Offline sends show Sending…, never fail while offline, deliver once in order; Sent only after a seq (CHAT-03, CHAT-04)
result: pass
source: automated
coverage_id: 02-01-D4

### 16. [02-01] Catch-up after a dropped socket through /api/sync, ping/pong and presence-based isViewing 
expected: Catch-up after a dropped socket through /api/sync, ping/pong and presence-based isViewing (CHAT-05, D-15)
result: pass
source: automated
coverage_id: 02-01-D5

### 17. [02-01] All Phase 2 tables live in the deployed database through one migration; public 401s for /a
expected: All Phase 2 tables live in the deployed database through one migration; public 401s for /api/messages and /api/sync
result: pass
source: automated
coverage_id: 02-01-D6

### 18. [02-02] React with 💕 💔 😋 😝 😘 😭 from the long-press / right-click / Enter menu; one per person, rep
expected: React with 💕 💔 😋 😝 😘 😭 from the long-press / right-click / Enter menu; one per person, replace and remove; allowlist by exact string; chip live on the other phone; updated_seq bump reaches offline phones through /api/sync (CHAT-08, D-04)
result: pass
source: automated
coverage_id: 02-02-D1

### 19. [02-02] Swipe right (or menu Reply) starts a reply with the 'Replying to' chip; replies carry a se
expected: Swipe right (or menu Reply) starts a reply with the 'Replying to' chip; replies carry a server-built, grapheme-safe quote (direct parent only, media label and thumb for media parents); 400 bad_reply for a missing parent; tapping a quote pages back ('Finding message…'), centres and rings the original (CHAT-09, D-01, D-02)
result: pass
source: automated
coverage_id: 02-02-D2

### 20. [02-02] Typing indicator: frames at most every 3 s while typing, relayed only to the other person'
expected: Typing indicator: frames at most every 3 s while typing, relayed only to the other person's sockets; three-dot muted bubble with a 5 s TTL that also clears when their message arrives (CHAT-06)
result: pass
source: automated
coverage_id: 02-02-D3

### 21. [02-02] Read receipts: POST /api/read moves forward only, clamps to the newest seq, broadcasts eac
expected: Read receipts: POST /api/read moves forward only, clamps to the newest seq, broadcasts each advance; reads come back from /api/messages and /api/sync; the status line under your latest message reads 'Read {time}' (CHAT-07, D-03)
result: pass
source: automated
coverage_id: 02-02-D4

### 22. [02-03] A new message pushes one Web Push per saved subscription of a recipient who is not viewing
expected: A new message pushes one Web Push per saved subscription of a recipient who is not viewing, with the D-13 title/body, TTL 86400, urgency high, topic duet-chat (NOTF-01)
result: pass
source: automated
coverage_id: 02-03-D1

### 23. [02-03] No push while the recipient is viewing the chat; push resumes once hidden (NOTF-03, D-15)
expected: No push while the recipient is viewing the chat; push resumes once hidden (NOTF-03, D-15)
result: pass
source: automated
coverage_id: 02-03-D2

### 24. [02-03] Service worker always shows a notification (malformed/empty payloads, getNotifications fai
expected: Service worker always shows a notification (malformed/empty payloads, getNotifications failure), collapses into one, and a tap focuses the window with open-chat or opens / (NOTF-02, D-14)
result: pass
source: automated
coverage_id: 02-03-D3

### 25. [02-03] Subscriptions: SSRF host allowlist, strict body, 401/403, upsert, logout cascade, 404/410 
expected: Subscriptions: SSRF host allowlist, strict body, 401/403, upsert, logout cascade, 404/410 pruning, push_failed logs code + host only (T-02-14, T-02-15, T-02-16)
result: pass
source: automated
coverage_id: 02-03-D4

### 26. [02-03] Test push to this session only, {sent: 0} without subscriptions, 10/min limit; iOS Add to 
expected: Test push to this session only, {sent: 0} without subscriptions, 10/min limit; iOS Add to Home Screen guide before the tiles; Notifications drawer from the header menu (SHEL-03)
result: pass
source: automated
coverage_id: 02-03-D5

### 27. [02-03] Idempotent VAPID key script: created then reused, never prints a key
expected: Idempotent VAPID key script: created then reused, never prints a key
result: pass
source: automated
coverage_id: 02-03-D6

### 28. [02-04] Chunked uploads through Cloudflare's 100 MB cap: create (22-char id, 8 MiB chunks), exact-
expected: Chunked uploads through Cloudflare's 100 MB cap: create (22-char id, 8 MiB chunks), exact-length chunk PUTs with onRequest auth (401 before the body is read), 413 oversize chunk, 400 bad_chunk, 404 for another person's upload, 409 incomplete, 413 too_large, 422 for kinds without a lane (MDIA-05)
result: pass
source: automated
coverage_id: 02-04-D1

### 29. [02-04] Photo processing: autorotated display (long edge 2048, q82) and thumb (640, q70) WebPs wit
expected: Photo processing: autorotated display (long edge 2048, q82) and thumb (640, q70) WebPs with no EXIF/GPS, original byte-identical, never enlarged, junk bytes fail with unsupported_media; HEVC HEIC through heif-convert (MDIA-01, D-09)
result: pass
source: automated
coverage_id: 02-04-D2

### 30. [02-04] GET /media/:id/:variant: session only, both people, image/webp private immutable with Acce
expected: GET /media/:id/:variant: session only, both people, image/webp private immutable with Accept-Ranges, 206 at both ends, 416 past the end, original/unknown/malformed/not-ready all 404 no-store; unauthenticated public request 401 with cf-cache-status DYNAMIC (MDIA-05)
result: pass
source: automated
coverage_id: 02-04-D3

### 31. [02-04] Albums: attachmentIds order kept as positions in send, /api/messages and /api/sync; bad_at
expected: Albums: attachmentIds order kept as positions in send, /api/messages and /api/sync; bad_attachment for attached, foreign, unfinished and failed uploads; 11 or duplicated ids invalid_body; a late-finishing photo re-broadcasts its message to both people (D-07, T-02-28)
result: pass
source: automated
coverage_id: 02-04-D4

### 32. [02-04] Upload concurrency and boot recovery: doubled/concurrent complete returns one attachment, 
expected: Upload concurrency and boot recovery: doubled/concurrent complete returns one attachment, a re-sent chunk keeps the last bytes, processing rows re-queued at boot, 25 h uploads and temp dirs deleted, 1 h kept
result: pass
source: automated
coverage_id: 02-04-D5

### 33. [02-04] Composer '+' opens the native picker; preview drawer with count title, caption and 'Send p
expected: Composer '+' opens the native picker; preview drawer with count title, caption and 'Send photo'/'Send n photos', removable items; album bubble on the other browser loads the processed thumbnail from /media/; full-screen viewer opens at the tapped tile, '2 / 2', ArrowLeft to '1 / 2', Escape closes (D-05, D-06, D-07, MDIA-02)
result: pass
source: automated
coverage_id: 02-04-D6

### 34. [02-04] Production runs everything from 02-01..02-04 with ffmpeg and heif-convert in the image: co
expected: Production runs everything from 02-01..02-04 with ffmpeg and heif-convert in the image: container healthy, live DB has both migrations, push_config configured true, Range forwarded by Cloudflare (206)
result: pass
source: automated
coverage_id: 02-04-D7

### 35. [02-05] ffprobe gate (T-02-30): HLS and ffconcat files named like videos are refused by probeMedia
expected: ffprobe gate (T-02-30): HLS and ffconcat files named like videos are refused by probeMedia; complete answers 422 unsupported_media without processing and deletes the bytes; a 210 s clip answers 422 too_long; FLAC and JPEG sent as voice answer 422 unsupported_media; video and audio accepted up to 200 MB, 413 above
result: pass
source: automated
coverage_id: 02-05-D1

### 36. [02-05] Video transcode: a 1920x1080 clip with a 90-degree display matrix becomes a 720x1280 H.264
expected: Video transcode: a 1920x1080 clip with a 90-degree display matrix becomes a 720x1280 H.264 High / AAC stereo MP4 with no rotation side data, moov before mdat, a <=640 px portrait poster, durationMs within 100 ms; 10-bit HLG HEVC comes out bt709; zeroed media data fails with transcode_failed; original byte-identical; /media video Range 206 and poster served
result: pass
source: automated
coverage_id: 02-05-D2

### 37. [02-05] Voice normalization: WebM/Opus without container duration and fragmented MP4/AAC become mo
expected: Voice normalization: WebM/Opus without container duration and fragmented MP4/AAC become mono AAC .m4a with durationMs within 150 ms and 40 integer peaks 0..100; audio/mp4 with Accept-Ranges and 206
result: pass
source: automated
coverage_id: 02-05-D3

### 38. [02-05] Message kinds: image+video mix as kind media in order; one audio without body is kind voic
expected: Message kinds: image+video mix as kind media in order; one audio without body is kind voice; audio with an image, two audio notes, or audio with a caption are 400 bad_attachment
result: pass
source: automated
coverage_id: 02-05-D4

### 39. [02-05] Video in the browser: picker accepts image/*,video/*; '1 video' / 'Send video'; the other 
expected: Video in the browser: picker accepts image/*,video/*; '1 video' / 'Send video'; the other browser sees 'Processing…' or the poster, then the poster from /media/ with its duration chip; the viewer's native video (controls, playsInline, paused, no autoplay) loads metadata from /media/
result: pass
source: automated
coverage_id: 02-05-D5

### 40. [02-05] Voice in the browser: holding 'Record voice note' 2.5 s sends a note whose 'Seek voice not
expected: Voice in the browser: holding 'Record voice note' 2.5 s sends a note whose 'Seek voice note' slider carries a 1..4 s server duration and plays; slide-left cancel, too-short hold (toast), tap-to-lock discard and tap-to-lock send all work; every getUserMedia track has ended after each path (T-02-32)
result: pass
source: automated
coverage_id: 02-05-D6

### 41. [02-05] Production at https://duet.brkn.me runs every Phase 2 feature: rebuilt and healthy, contai
expected: Production at https://duet.brkn.me runs every Phase 2 feature: rebuilt and healthy, container self-test heic/video/voice/media-selftest ok, smoke-public ok, live-db ok, all 13 e2e scenarios (send..voice, a2hs, drawer) ok, server suite 280 passed / 1 skipped, typecheck, preset ok, no raw HTML rendering
result: pass
source: automated
coverage_id: 02-05-D7

### 42. Auto-scroll to latest on send
expected: Sending a message scrolls the chat down to show the new message at the bottom, even when you were scrolled up in history.
result: issue
reported: "pass - also, it should auto scroll down when a msg is sent"
severity: major

## Summary

total: 42
passed: 40
issues: 2
pending: 0
skipped: 0
blocked: 0

## Gaps

- gap_id: G-02-42
  truth: "Sending a message scrolls the chat down to show the new message at the bottom, even when you were scrolled up in history."
  status: failed
  reason: "User reported: pass - also, it should auto scroll down when a msg is sent"
  severity: major
  test: 42
  root_cause: "No code path scrolls to the end on a local send. Composer send handlers (text/album/voice) only add optimistic store entries; the only scrollToEnd call is ScrollFollower's OPEN_CHAT_EVENT handler; Composer renders outside MessageScrollerProvider. Own messages rely on the primitive's following-bottom mode, which is off when scrolled up and is also switched off by a non-scrolling touch/wheel at the bottom (overscroll, swipe-to-reply, long-press jitter)."
  artifacts:
    - path: "web/components/app/composer.tsx"
      issue: "send(), sendPicked(), recorder onSend never request scroll-to-end"
    - path: "web/components/app/chat-view.tsx"
      issue: "Composer outside MessageScrollerProvider; ScrollFollower only scrolls on OPEN_CHAT_EVENT"
    - path: "web/lib/chat/store.ts"
      issue: "sendText/sendMedia/sendVoice carry no own-send signal"
  missing:
    - "Unconditionally scrollToEnd (behavior auto) on every local send — text, reply, album, voice — e.g. a window event ScrollFollower listens for"
    - "Keep the incoming-message scroll-to-latest badge behaviour unchanged"
    - "Regression scenario in scripts/smoke-chat.mjs: send while scrolled up 1200px, and after a non-scrolling wheel at bottom → new bubble visible"
  debug_session: .planning/debug/no-autoscroll-on-send.md

- gap_id: G-02-7
  truth: "The in-app guide steps match Safari's Add to Home Screen flow. Enable → Allow → a test push arrives. With duet closed, new messages raise a notification on both the iPhone and the Pixel. Several messages collapse into a single '{name} · n new messages' notification. Tapping it opens the chat. While you're actively viewing the chat, no notification appears."
  status: failed
  reason: "User reported: notifications are not working on iphone but pass on android"
  severity: major
  test: 7
  root_cause: "web.push.apple.com rejects every duet push with HTTP 400 (logs: ~25 consecutive 400s, Apple sub last_ok_at NULL; FCM all OK). server/src/push/sender.ts sendOne always sets web-push topic (duet-chat / duet-test), and since ~mid-Sep 2026 Apple answers any Topic header with 400 BadWebPushTopic (3 independent projects report and fixed it by dropping Topic). Apple's reason string not directly observed because push_failed logs drop err.body."
  artifacts:
    - path: "server/src/push/sender.ts"
      issue: "sendOne always passes topic; catch logs only statusCode, drops WebPushError.body"
    - path: "shared/src/push.ts"
      issue: "PUSH_TOPIC_CHAT / PUSH_TOPIC_TEST assume Apple coalesces by topic"
    - path: "server/test/push.test.ts"
      issue: "lines ~105 and ~266 assert a topic is sent (lock in failing behaviour)"
    - path: "web/lib/chat/push.ts"
      issue: "sendTestPush shows 'Check your connection' on sent: 0 (misleading)"
  missing:
    - "Stop sending the Topic header (at least for *.push.apple.com); SW close-before-show already collapses on device"
    - "Log a capped, sanitized err.body reason in push_failed"
    - "Update push tests to assert no topic"
    - "Reword the sent:0 test-push toast"
    - "After deploy: user re-taps Enable + Send test notification on the installed iPhone; if a different Apple 400/403 appears, next suspect is per-send VAPID JWT refresh (research A9)"
  debug_session: .planning/debug/iphone-push-not-arriving.md
