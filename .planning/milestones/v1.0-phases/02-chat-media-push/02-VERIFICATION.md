---
phase: 02-chat-media-push
verified: 2026-10-15T14:55:00Z
status: passed
score: 9/11 must-haves verified
covered_files: [".planning/phases/02-chat-media-push/02-01-PLAN.md",".planning/phases/02-chat-media-push/02-01-SUMMARY.md",".planning/phases/02-chat-media-push/02-02-PLAN.md",".planning/phases/02-chat-media-push/02-02-SUMMARY.md",".planning/phases/02-chat-media-push/02-03-PLAN.md",".planning/phases/02-chat-media-push/02-03-SUMMARY.md",".planning/phases/02-chat-media-push/02-04-PLAN.md",".planning/phases/02-chat-media-push/02-04-SUMMARY.md",".planning/phases/02-chat-media-push/02-05-PLAN.md",".planning/phases/02-chat-media-push/02-05-SUMMARY.md",".planning/phases/02-chat-media-push/02-06-PLAN.md",".planning/phases/02-chat-media-push/02-06-SUMMARY.md","Dockerfile","README.md","deploy/vapid-keys.sh","package-lock.json","scripts/check-live-db.sh","scripts/lib/e2e.mjs","scripts/smoke-chat.mjs","scripts/smoke-chat.sh","scripts/smoke-onboarding.mjs","scripts/smoke-public.sh","server/drizzle/0001_chat_media_push.sql","server/drizzle/meta/0001_snapshot.json","server/drizzle/meta/_journal.json","server/package.json","server/scripts/media-selftest.ts","server/src/app.ts","server/src/chat/events.ts","server/src/chat/routes.ts","server/src/chat/service.ts","server/src/config.ts","server/src/db/schema.ts","server/src/media/audio.ts","server/src/media/exec.ts","server/src/media/image.ts","server/src/media/probe.ts","server/src/media/process.ts","server/src/media/routes.ts","server/src/media/uploads.ts","server/src/media/video.ts","server/src/push/routes.ts","server/src/push/sender.ts","server/src/ws/hub.ts","server/test/chat-logic.test.ts","server/test/chat.test.ts","server/test/helpers.ts","server/test/media.test.ts","server/test/push.test.ts","server/test/reactions.test.ts","server/test/read-typing.test.ts","server/test/replies.test.ts","server/test/sw.test.ts","server/test/uploads.test.ts","server/test/video.test.ts","server/test/voice.test.ts","shared/src/chat-logic.ts","shared/src/chat.ts","shared/src/index.ts","shared/src/media.ts","shared/src/push.ts","shared/src/ws.ts","web/app/layout.tsx","web/app/page.tsx","web/components/app/a2hs-guide.tsx","web/components/app/album.tsx","web/components/app/chat-view.tsx","web/components/app/composer.tsx","web/components/app/message-actions.tsx","web/components/app/message-row.tsx","web/components/app/notifications-card.tsx","web/components/app/notifications-drawer.tsx","web/components/app/preview-drawer.tsx","web/components/app/quote-block.tsx","web/components/app/recorder.tsx","web/components/app/shell.tsx","web/components/app/typing-indicator.tsx","web/components/app/viewer.tsx","web/components/app/voice-note.tsx","web/components/ui/attachment.tsx","web/components/ui/bubble.tsx","web/components/ui/carousel.tsx","web/components/ui/dialog.tsx","web/components/ui/drawer.tsx","web/components/ui/input-group.tsx","web/components/ui/marker.tsx","web/components/ui/message-scroller.tsx","web/components/ui/message.tsx","web/components/ui/popover.tsx","web/components/ui/skeleton.tsx","web/components/ui/textarea.tsx","web/lib/api.ts","web/lib/chat/events.ts","web/lib/chat/gestures.ts","web/lib/chat/outbox.ts","web/lib/chat/push.ts","web/lib/chat/realtime.ts","web/lib/chat/recorder.ts","web/lib/chat/store.ts","web/lib/chat/upload.ts","web/lib/platform.ts","web/next.config.ts","web/package.json","web/public/sw.js"]
covered_digest: "v3:sha256:328630ced3a185fed9a97f2e6546fca2a53fb8ffcfb0516262f48c177c3a0a05"
behavior_unverified: 2
overrides_applied: 0
behavior_unverified_items:
  - truth: "SC3 / NOTF-01 on iPhone: with the app closed or backgrounded, a new message raises a push notification on the iPhone (G-02-7 fix: no Topic header)"
    test: "Force-quit and reopen duet on the iPhone so it loads the new bundle. Header menu > Notifications > Send test notification. Then close duet on the iPhone and send 3 quick messages from the Pixel. Then open the chat on the iPhone and send one more from the Pixel."
    expected: "The test notification arrives within a few seconds. One collapsed '{name} · 3 new messages' notification arrives, and tapping it opens the chat. No notification arrives while the chat is open on screen. The Pixel still gets its notifications. `docker logs --since 30m duet-duet-1 | grep push_` shows push_test sent 1 and no push_failed for host web.push.apple.com. If push_failed appears, its reason field names the next suspect (BadJwtToken / 403 points at per-send VAPID JWT, research A9)."
    why_human: "Delivery through web.push.apple.com to an installed iOS PWA can only be observed on the device. The code and unit tests prove that no Topic header is sent, but that Apple's 400 refusal was the only cause has not been proven. No push_* event has been logged since the 09:03Z redeploy, so nobody has retested this yet."
  - truth: "02-06 truth 1 / G-02-42: sending a text, reply, album or voice note scrolls to the newest message even when scrolled up or after a non-scrolling touch at the bottom"
    test: "On both phones: scroll far up in history and send a text; repeat with a photo and with a voice note; touch-overscroll at the bottom and send; then, while scrolled up, have the other phone send a message."
    expected: "Each own send jumps to the new bubble at the bottom. An incoming message while scrolled up only bumps the scroll-to-latest badge and does not move the list."
    why_human: "The executor reports that the headless desktop Chrome e2e (scroll-send) passed, but the verifier did not run it because it starts a server and Chrome. It also cannot cover touch overscroll, the iOS keyboard or visualViewport resize, or the voice-note send path, and those are the conditions UAT test 42 was reported under."
human_verification:
  - test: "iPhone push re-test (UAT test 7). See behavior_unverified_items[0]."
    expected: "Test push and message pushes arrive on the iPhone. They collapse into one notification, a tap opens the chat, nothing arrives while you are viewing the chat, and Android is unchanged."
    why_human: "Real Apple push delivery to the installed PWA cannot be checked from the codebase."
  - test: "Scroll-on-send on both phones (UAT test 42). See behavior_unverified_items[1]."
    expected: "Every own send lands on the newest message, and incoming messages while scrolled up only bump the badge."
    why_human: "Touch, keyboard and visualViewport behaviour on real devices."
  - test: "Decide on the own-media duplicate (prior full-phase review WR-03, still open). Send a photo album and a voice note on cellular, and watch your own chat right after you tap Send."
    expected: "Decide whether a brief second copy of your own album or voice note is acceptable. The copy lasts from the WS echo until the POST response, and if that response is lost it stays as 'Not sent. Tap to retry.' next to the delivered copy. SC2 says 'no message ever appears twice'. If it is not acceptable, the fix is about 3 lines in chatStore.applyMessages: drop state.media entries whose id arrived."
    why_human: "The code shows the window exists: routes.ts broadcasts before it responds, and applyMessages never removes the matching state.media entry. Device UAT tests 8, 9 and 11 passed and did not report it, so whether this is visible and whether it breaks SC2 is a product call."
---

# Phase 2: Chat, Media & Push Verification Report

**Phase Goal:** We can message each other in real time, reliably, with history kept forever, share photos, short video clips and voice notes that display and play correctly on both an iPhone and a Pixel (visible only to the two of us), and get a push notification when the app is not open
**Verified:** 2026-10-15T14:55:00Z
**Status:** human_needed
**Re-verification:** No. This is the initial VERIFICATION.md. It follows device UAT (02-UAT.md, 40/42) and gap-closure plan 02-06.

> **MVP-mode note:** ROADMAP marks Phase 2 `Mode: mvp`, but the goal is not a user story (`user-story.validate` → valid false). Phase 1 did the same: verification here is goal-backward against the roadmap goal and its 5 success criteria. The User Flow Coverage table maps those criteria.

## User Flow Coverage

| Step (from goal / SC) | Expected | Evidence in codebase | Status |
|---|---|---|---|
| Send text in real time | Peer sees it within 2 s, no reload | `routes.ts` POST /api/messages → `hub.broadcast({t:"msg"})`; chat.test "delivers a created message to every socket of both people"; device UAT 2 | ✓ |
| History kept forever, paged back | 50/page to the first message | `latestPage` strict `before`; chat.test 120-message paging; device UAT 5 | ✓ |
| Reliable: offline queue, retry, no duplicates, catch-up | Outbox, idempotent id, /api/sync on hello/visible/online | `sendMessage` tx + 409 id_conflict; `/api/sync`; chat.test idempotency + sync; device UAT 4 | ✓ (warning: own-media transient duplicate, WR-03) |
| Photos incl. HEIC, full screen | Display on both phones, viewer | `image.ts` sharp + heif-convert; container has heif-convert; media.test EXIF/rotate; device UAT 8, 9 | ✓ |
| Video clips incl. HEVC .MOV | H.264 MP4 plays on both | `video.ts`, `probe.ts`; video.test; device UAT 10 | ✓ |
| Voice notes with scrubber | Plays both phones, seek works | `audio.ts`, `voice-note.tsx` slider; voice.test; device UAT 11 | ✓ |
| Visible only to the two of us | 401 without session, private cache | `media/routes.ts` requireUser; live `curl` /media → 401 | ✓ |
| Push when app not open | Notification on iPhone and Pixel | Pixel: device UAT 7 (Android pass). iPhone: fix deployed but not retested | ⚠️ human |

## Goal Achievement

### Observable Truths

Scored set: the 5 roadmap success criteria plus the 6 must-haves of gap-closure plan 02-06. The ~93 truths of plans 02-01..02-05 are covered under these criteria. Device UAT tests 2-11 and automated UAT tests 12-41 verified them, and the verifier spot-checked the code (see "Plan 01-05 truths" below).

| # | Truth | Status | Evidence |
|---|---|---|---|
| SC1 | Real-time delivery; sending/sent/read/failed states; typing; reactions; quoted replies; history back to the first message | ✓ VERIFIED | Server: `chat/routes.ts` (send, reaction, read), `hub.ts` typing relay, `service.ts` paging. Tests: chat.test (paging 50/50/20, WS fan-out), reactions/replies/read-typing tests, all passing in the verifier's run (288 passed / 1 skipped). Client: status logic in `chat-view.tsx` `toItem` ("sending" without seq, "read" only when the peer cursor ≥ seq). Device UAT 2, 5, 6 passed |
| SC2 | Offline queue auto-sends, failed retry with a tap, no message twice, background catch-up | ✓ VERIFIED (with warning) | `sendMessage` single sync tx: replay returns the same row, the other person's id gets 409. `/api/sync` change cursor. Realtime syncs on hello/visible/online. Tests: idempotency, sync cap 500. Device UAT 4. **Warning:** two edge cases are open from the prior review. WR-03: your own album or voice note renders twice between the WS echo and the POST response, because `applyMessages` never prunes `state.media`. WR-01: a text over 4000 code points gets stuck "Not sent" forever, because the composer has no length guard and the outbox has no discard. Both are routed to a human decision |
| SC3 | Push when closed/backgrounded on iPhone and Pixel; tap opens chat; none while viewing; iPhone A2HS guide + test push that delivers | ⚠️ PRESENT_BEHAVIOR_UNVERIFIED | Code present and wired: `push/routes.ts` `onMessageCreated` → `isViewing` suppression → `notifyMessage`; `sw.js` always shows, close-before-show, `notificationclick` posts open-chat; `a2hs-guide.tsx` has "Continue in Safari for now". The G-02-7 fix is in place: `sender.ts` sends `{TTL, urgency, timeout}` with no topic (push.test "pushes to an Apple subscription … no topic"), and the deployed `sender.ts` hash matches HEAD. Pixel passed device UAT 7. **The iPhone has not been retested:** no push_* event has been logged since the 09:03Z redeploy |
| SC4 | Photo from camera/library (HEIC on Pixel, full-screen viewer); video clip incl. HEVC .MOV plays on both | ✓ VERIFIED | `image.ts` (sharp + heif-convert), `video.ts` (H.264/AAC, HDR tone-map, faststart), `viewer.tsx`. The container has ffmpeg, ffprobe and heif-convert (verifier `docker exec … command -v`). media.test and video.test pass. Device UAT 8, 9, 10 passed |
| SC5 | Voice note with a working scrubber; seeking in video/voice (Range); media 401 without session | ✓ VERIFIED | `audio.ts` (m4a + 40 peaks), `voice-note.tsx` role=slider, `media/routes.ts` requireUser + `reply.sendFile` Range. media.test "206 at both ends and 416 past the end". Live check by the verifier: `https://duet.brkn.me/media/<id>/thumb` → 401 JSON. Device UAT 10, 11 passed |
| 06-1 | Own send (text/reply/album/voice) scrolls to the newest message, even when scrolled up or after a non-scrolling touch/wheel | ⚠️ PRESENT_BEHAVIOR_UNVERIFIED | `composer.tsx` calls `requestScrollToLatest()` after `sendText` (l.69), `sendMedia` (l.118) and `sendVoice` (l.46). `ScrollFollower` (inside `MessageScrollerProvider autoScroll`, chat-view l.599/648) listens and calls `scrollToEnd({behavior:"auto"})` now and on the next frame. The deployed bundle contains `duet:scroll-to-latest`. The headless e2e was reported by the executor and not run by the verifier. Not retested on devices |
| 06-2 | Incoming message while scrolled up leaves the list and bumps the badge | ✓ VERIFIED | `ScrollFollower` effect: `bumpNewWhileAway` only when `awayRef` is set, and nothing in it scrolls. This is unchanged from the version device UAT 3 passed |
| 06-3 | No Web Push carries a Topic header (Apple or FCM) | ✓ VERIFIED | `sender.ts` `sendOne` options are `{TTL, urgency:"high", timeout}`. `PUSH_TOPIC_*` is removed from `shared/src/push.ts`. push.test asserts no topic (FCM chat, Apple chat, test push). The deployed file is identical (sha256 match) |
| 06-4 | push_failed logs code, host, pruned and a sanitized capped reason, never the endpoint path or keys | ✓ VERIFIED | `pushFailureReason` + `log.warn({evt, code, host, pruned, reason})`. push.test "logs Apple's BadWebPushTopic reason" and "caps and sanitizes a long text body". Advisory: 06/WR-01, the WNS query-string token and the fast-path redaction gap (see Anti-Patterns) |
| 06-5 | sent 0 → "Couldn't deliver the test to this phone. Reopen duet and try again."; failed request keeps the connection copy | ✓ VERIFIED | `web/lib/chat/push.ts` `sendTestPush` has both strings. Advisory: 06/WR-02 (503/429/401 get the connection copy) and 06/WR-03 (the "Reopen" advice can't fix a pruned subscription) |
| 06-6 | Both fixes run in production | ✓ VERIFIED | Verifier checks: `duet-duet-1` healthy; deployed `server/src/{push/sender,chat/routes,chat/service,media/routes,ws/hub}.ts` and `sw.js` sha256 equal HEAD; bundle chunk contains `duet:scroll-to-latest`; public `/api/messages` and `/api/sync` → 401 JSON |

**Score:** 9/11 truths verified (2 present, behavior-unverified)

**Superseded plan truth (not a failure):** 02-03's truth 1 specifies "topic duet-chat". Gap-closure plan 02-06 removed the topic on purpose (Apple answers 400 BadWebPushTopic), and collapsing is now done only on the device (D-14 close-before-show). The current code follows 02-06.

### Plan 01-05 truths (grouped)

| Plan | Truths | Verifier evidence | Status |
|---|---|---|---|
| 02-01 (CHAT-01..05) | 22 | Artifacts 13/13, key links 5/5 (gsd-tools). chat.test covers idempotency, 409, strict body, code points, byte-identical round trip, paging, WS fan-out, body never logged, sync cap, ping/pong, 45 s presence. Migration 0001 is present. Device UAT 2-6 | ✓ |
| 02-02 (CHAT-06..09) | 16 | Artifacts 8/8, links 4/4. reactions/replies/read-typing tests. Read sent only when `visibilityState==="visible" && document.hasFocus()` (chat-view l.321). Device UAT 2, 5, 6 | ✓ |
| 02-03 (NOTF-01..03, SHEL-03) | 16 (+1 backstop) | Artifacts 9/9, links 5/5. push.test (suppression while viewing, logout cascade, 410 prune, session-only test push, 10/min limit) and sw.test (always shows, collapse, open-chat, no fetch listener). The topic truth is superseded. iPhone delivery is pending (SC3) | ✓ / ⚠️ iPhone |
| 02-04 (MDIA-01, 02, 05) | 20 | Artifacts 11/11, links 5/5. media.test and uploads.test: EXIF strip, original byte-identical, Range 206/416, 404 no-store, attachment order, concurrency, boot recovery. Container tools present. Device UAT 8, 9 | ✓ |
| 02-05 (MDIA-03, 04) | 19 (+2 backstop) | Artifacts 6/6, links 4/4. video.test and voice.test: HLS/concat refused, too_long, rotation, HLG→bt709, m4a + 40 peaks. Device UAT 9, 10, 11 cover the 10-item viewer backstop | ✓ |

Backstop truths: the 02-03 push-body truncation and the 02-05 1-hour voice duration are present in code (`truncateGraphemes` in `buildPayload`, tabular-nums timer). The 02-05 10-item viewer was observed in device UAT 9. Nobody has confirmed the 120-char truncated push body on the iPhone, so it goes into the iPhone push re-test.

### Prohibitions

| Prohibition | Tier | Enforcement evidence | Disposition |
|---|---|---|---|
| CHAT-01 never log message bodies | test | chat.test "never writes a message body to the log" (passes) | ✓ resolved |
| CHAT-03 no "Sent" without seq, no "Delivered" | test | `toItem`: `!m.confirmed` → "sending"; message-row has no "Delivered"; e2e offline scenario (executor) | ✓ resolved |
| CHAT-07 read receipt only when visible and focused | judgment | chat-view l.321 guard; device UAT 6 passed (human-resolved) | ✓ resolved |
| NOTF-01 logout stops previews (cascade) | test | push.test "cascades the subscription away with the session" | ✓ resolved |
| NOTF-01 every push shows a notification | test | sw.test (malformed payload, getNotifications throws) | ✓ resolved |
| SHEL-03 never trap the user in onboarding | judgment | a2hs-guide l.71 "Continue in Safari for now"; onboarding e2e (executor); device UAT 7 guide portion | ✓ resolved |
| MDIA-01 no EXIF/original served | test | media.test l.72 + "never serves the original" | ✓ resolved |
| MDIA-05 no shared-cacheable media | test | media.test private/immutable + 404 no-store; extensionless URLs | ✓ resolved |
| MDIA-01 never delete/overwrite photo original | test | media.test "leaves the original byte-identical" | ✓ resolved |
| MDIA-04 mic closed after every path | test | smoke-chat.mjs l.534 asserts every track `ended` (executor-run); device UAT 11 (orange mic indicator off) | ✓ resolved |

### Required Artifacts

`gsd-tools verify.artifacts` on every plan: 02-01 13/13, 02-02 8/8, 02-03 9/9, 02-04 11/11, 02-05 6/6, 02-06 7/7. All exist and are substantive. The verifier manually read the core paths for wiring: chat routes/service, push routes/sender, sw.js, media routes, composer → events → ScrollFollower, and the store media reconciliation.

### Key Link Verification

`gsd-tools verify.key-links`: 02-01 5/5, 02-02 4/4, 02-03 5/5, 02-04 5/5, 02-05 4/4, 02-06 4/4. All are WIRED. The verifier confirmed these by hand:
- `composer.tsx` → `requestScrollToLatest()` (3 sites) → `SCROLL_TO_LATEST_EVENT` → `ScrollFollower.scrollToEnd`, mounted inside `MessageScrollerProvider autoScroll`.
- `chatEvents.onMessageCreated` → `hub.isViewing` → `sender.notifyMessage` → `sendNotification` without topic.
- `sw.js` `postMessage({t:"open-chat"})` → `push.ts` l.183 → `OPEN_CHAT_EVENT` → `ScrollFollower`.
- `shell.tsx` l.99 `syncSubscription()` on launch, l.107 `clearNotifications()` on visible.

### Data-Flow Trace (Level 4)

| Artifact | Data | Source | Real data | Status |
|---|---|---|---|---|
| chat-view message list | `chat.messages` | `GET /api/messages` / WS `msg` / `/api/sync` → `latestPage`/`syncSince` SQL | yes | ✓ FLOWING |
| push notification payload | title/body | `notifyMessage`: users + read_state + messages count query → `buildPayload` | yes | ✓ FLOWING |
| album / viewer / voice | `/media/:id/:variant` | attachments row status=ready + file on disk | yes | ✓ FLOWING |

### Behavioral Spot-Checks

| Behavior | Command | Result | Status |
|---|---|---|---|
| Server suite (run once) | `npm --prefix server run test` | 20 files, 288 passed / 1 skipped (HEIF `skipIf`, host lacks heif-convert) | ✓ PASS |
| Container media toolchain | `docker exec duet-duet-1 sh -c 'command -v ffmpeg/ffprobe/heif-convert'` | all three present | ✓ PASS |
| Deployed code = HEAD | sha256 of 5 server files + sw.js, local vs container | all equal | ✓ PASS |
| Deployed bundle has scroll-on-send | grep `duet:scroll-to-latest` in `/app/web/out/_next/static` | 1 chunk | ✓ PASS |
| Public auth gate | `curl https://duet.brkn.me/{api/messages, api/sync?since=0, media/<id>/thumb}` | 401 JSON ×3 | ✓ PASS |
| iPhone push after the fix | container logs `push_*` since 09:03Z | only `push_config configured true`; no sends yet | ? SKIP → human |
| Headless e2e (smoke-chat scroll-send etc.) | not run (starts a server and Chrome) | executor-reported pass | ? SKIP |

### Probe Execution

There are no `scripts/*/tests/probe-*.sh` files, and the plans declare no probes. Step 7c: not applicable.

### Requirements Coverage

| Requirement | Source Plan | Description | Status | Evidence |
|---|---|---|---|---|
| CHAT-01 | 02-01, 02-06 | Real-time text send/receive | ✓ SATISFIED | SC1; chat.test fan-out; UAT 2 |
| CHAT-02 | 02-01 | History forever, paged | ✓ SATISFIED | paging test; UAT 5 |
| CHAT-03 | 02-01 | sending/sent/read/failed | ✓ SATISFIED | toItem status logic; UAT 2, 4 (WR-01 edge noted) |
| CHAT-04 | 02-01 | Offline queue, retry, no dup | ✓ SATISFIED | idempotent tx + outbox; UAT 4 (WR-03 display edge → human decision) |
| CHAT-05 | 02-01 | Catch-up after resume | ✓ SATISFIED | /api/sync + realtime triggers; UAT 4 |
| CHAT-06 | 02-02 | Typing indicator | ✓ SATISFIED | read-typing.test relay; UAT 2 |
| CHAT-07 | 02-02 | Read receipts | ✓ SATISFIED | markRead forward-only; UAT 6 |
| CHAT-08 | 02-02 | Emoji reactions | ✓ SATISFIED | reactions.test; UAT 2 |
| CHAT-09 | 02-02 | Quoted replies | ✓ SATISFIED | replies.test; UAT 5 |
| NOTF-01 | 02-03, 02-06 | Push when not foreground | ? NEEDS HUMAN | Pixel pass; iPhone fix deployed, not retested |
| NOTF-02 | 02-03 | Tap opens chat | ✓ SATISFIED (Pixel) / ? iPhone | sw.test; UAT 7 Android |
| NOTF-03 | 02-03 | No push while viewing | ✓ SATISFIED | push.test suppression; UAT 7 Android |
| SHEL-03 | 02-03, 02-06 | iPhone A2HS + enable + test push | ? NEEDS HUMAN | Guide and card are present. The test push "delivers a real notification" on the iPhone is still unproven |
| MDIA-01 | 02-04 | Photos incl. HEIC | ✓ SATISFIED | media.test; UAT 8 |
| MDIA-02 | 02-04 | Full-screen viewer | ✓ SATISFIED | UAT 8, 9 |
| MDIA-03 | 02-05 | Video clips H.264 | ✓ SATISFIED | video.test; UAT 10 |
| MDIA-04 | 02-05 | Voice notes + scrubber | ✓ SATISFIED | voice.test; UAT 11 |
| MDIA-05 | 02-04 | Auth-gated media with Range | ✓ SATISFIED | media.test Range; live 401 |

All 18 phase requirement IDs appear in plan frontmatter, and REQUIREMENTS.md maps no extra ID to Phase 2. There are no orphaned requirements. Note: REQUIREMENTS.md already marks NOTF-01 and SHEL-03 `[x] Complete`, even though iPhone delivery is still pending human confirmation.

### Anti-Patterns Found

| File | Line | Pattern | Severity | Impact |
|---|---|---|---|---|
| (phase files) | — | TBD/FIXME/XXX/TODO/placeholder scan | — | none found; no lucide/radix/dangerouslySetInnerHTML |
| web/lib/chat/store.ts / server/src/chat/routes.ts | store 354-368, routes 55-58 | Prior review WR-03 (open): the WS echo is applied while `state.media` keeps the pending copy, so your own album or voice note shows twice until the POST response, and stays as "Not sent" if the response is lost. `message-row.tsx` l.368 also gets a duplicate `Fragment key` | ⚠️ Warning | Conflicts with the literal SC2 text "no message ever appears twice" on the sender's own screen. Not reported in device UAT. Routed to a human decision |
| web/components/app/composer.tsx | 35 | Prior review WR-01 (open): `canSend` has no 4000-code-point guard, and the outbox has no discard, so an oversize paste is stuck "Not sent" forever and hides the status line of later messages | ⚠️ Warning | An edge case of "failed ones can be retried": the retry can never succeed |
| server/src/push/sender.ts | 55, 62-75 | 06/WR-01: the reason sanitizer misses the WNS query token and skips redaction on the fast path | ⚠️ Warning | Log hygiene only. Neither phone uses WNS |
| web/lib/chat/push.ts | 126-142 | 06/WR-02, 06/WR-03: the test-push toast copy is misleading for 503/429/401 and for a pruned subscription | ⚠️ Warning | Diagnostic UX. Does not block delivery |
| (others) | — | Prior WR-02, WR-04..06 and IN-*, 06/IN-01..04 | ℹ️ Info/Warning | Tracked as open in 02-REVIEW-DISPOSITION.md. Failure-path robustness, not core-goal failures |

### Human Verification Required

#### 1. iPhone push after the Topic fix (UAT test 7)

**Test:** Force-quit and reopen duet on the iPhone. Go to Notifications and tap "Send test notification". Close duet and send 3 quick messages from the Pixel. Tap the notification. Then send one more message while the chat is open on the iPhone. Optionally send a message longer than 120 characters to check truncation.
**Expected:** The test notification arrives. One "{name} · 3 new messages" notification arrives, and a tap opens the chat. Nothing arrives while you are viewing the chat. The long body ends with "…". In the server logs, `push_test sent 1` appears and there is no `push_failed` for web.push.apple.com.
**Why human:** Only the device can show Apple push delivery to an installed PWA. No push has been sent since the redeploy.

#### 2. Scroll-on-send on both phones (UAT test 42)

**Test:** Scroll far up and send a text, then a photo, then a voice note. Touch-overscroll at the bottom and send. While scrolled up, have the other phone send a message.
**Expected:** Every own send jumps to the new bubble. An incoming message only bumps the badge.
**Why human:** Touch, keyboard and visualViewport behaviour, plus the voice path, which headless desktop Chrome does not cover.

#### 3. Decide on the own-media duplicate (prior WR-03)

**Test:** On cellular, send an album and a voice note, and watch your own chat right after you tap Send.
**Expected:** Decide whether a transient second copy is acceptable under SC2 ("no message ever appears twice"). If it isn't, the fix is a few lines in `chatStore.applyMessages`: drop `state.media` entries whose id arrived.
**Why human:** The code shows the defect window. Whether it is visible enough to count as a goal failure is a product call. Device UAT passed media without reporting it.

### Gaps Summary

No must-have FAILED. All artifacts and key links pass, the server suite is green, and the deployed code matches HEAD. Two truths are present and wired but not behaviorally proven where it matters: iPhone push delivery after dropping the Topic header (SC3 / NOTF-01 / SHEL-03), and scroll-on-send on real devices (G-02-42). Both fixes are deployed, and neither has been retested on the iPhone or Pixel. One display defect from the earlier full-phase review is still open in code: a transient duplicate of your own album or voice note (WR-03). It is surfaced as a human decision because SC2 literally says "no message ever appears twice". The phase can close once the user confirms items 1 and 2 on the devices and accepts or schedules item 3.

---

_Verified: 2026-10-15T14:55:00Z_
_Verifier: Claude (gsd-verifier)_
