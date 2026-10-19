---
phase: 02-chat-media-push
plan: 06
subsystem: chat-ui, push
tags: [message-scroller, shadcn, web-push, apple-push, vapid, gap-closure]

requires:
  - phase: 02-chat-media-push
    provides: "02-02 chat list (MessageScroller + ScrollFollower), 02-03 push sender + test push, 02-05 deploy sequence"
provides:
  - "SCROLL_TO_LATEST_EVENT + requestScrollToLatest(): every local send (text, reply, album, voice) jumps to the newest message"
  - "Topic-free Web Push to every push service (Apple no longer answers 400 BadWebPushTopic)"
  - "pushFailureReason sanitizer; push_failed logs a capped, redacted reason"
  - "Separate sent-0 test-push toast"
  - "e2e scenario scroll-send"
  - "Production redeploy at https://duet.brkn.me"
affects: [phase-03-calls, verify-work-02]

actuals:
  tokens: 7566
  tasks: 3
  commits: 3
plan_head_before: 0f4997ca43009307b0bb943861145e4b1d906a1a
plan_head_after: 279e5ba5d5595893a6e5c0e24d230b12ef6246bc

tech-stack:
  added: []
  patterns:
    - "Components outside MessageScrollerProvider ask for scrolling through a window event that a follower inside the provider handles"
    - "Third-party error bodies are reduced to a short sanitized reason before logging (identifier codes pass, everything else redacted/flattened/capped)"

key-files:
  created: []
  modified:
    - web/lib/chat/events.ts
    - web/components/app/composer.tsx
    - web/components/app/chat-view.tsx
    - scripts/smoke-chat.mjs
    - server/src/push/sender.ts
    - shared/src/push.ts
    - server/test/push.test.ts
    - web/lib/chat/push.ts
    - .planning/phases/02-chat-media-push/02-UI-SPEC.md

key-decisions:
  - "No Topic header to any push service (not only Apple): collapse stays on-device via the SW close-before-show (D-14); one code path"
  - "Scroll-on-send uses scrollToEnd({behavior: 'auto'}) immediately plus once on the next animation frame; the immediate call re-arms the primitive's following-bottom mode"
  - "push_failed reason: Apple-style identifier reasons pass as-is; other bodies get endpoint path segments (>= 8 chars) -> [redacted], URLs -> [url], control chars -> space, capped at 120 code points"

patterns-established:
  - "Window-event bridge (duet:scroll-to-latest) from Composer to ScrollFollower"

requirements-completed: [CHAT-01, NOTF-01, SHEL-03]

coverage:
  - id: D1
    description: "Sending text/reply/album while scrolled up (or after a non-scrolling wheel at the bottom) lands on the new message; incoming messages while scrolled up only bump the badge"
    requirement: CHAT-01
    verification:
      - kind: e2e
        ref: "bash scripts/smoke-chat.sh scroll-send send reply"
        status: pass
      - kind: e2e
        ref: "bash scripts/smoke-chat.sh (all 12 scenarios)"
        status: pass
    human_judgment: true
    rationale: "UAT test 42 was reported on real phones (touch, keyboard/visualViewport resize, voice note path); headless desktop Chrome does not cover touch overscroll or the voice-note send"
  - id: D2
    description: "No duet push carries a Topic header (FCM and Apple, chat and test); refused pushes log a sanitized reason"
    requirement: NOTF-01
    verification:
      - kind: unit
        ref: "server/test/push.test.ts (no-topic, Apple reason, sanitizer cases)"
        status: pass
    human_judgment: true
    rationale: "Real delivery through web.push.apple.com to the installed iPhone PWA can only be confirmed on the device (UAT test 7)"
  - id: D3
    description: "Send test notification: sent 0 shows 'Couldn't deliver the test to this phone. Reopen duet and try again.'; a failed request keeps the connection copy"
    requirement: SHEL-03
    verification:
      - kind: other
        ref: "grep of both toast strings in web/lib/chat/push.ts; npm run typecheck"
        status: pass
    human_judgment: false
  - id: D4
    description: "Both fixes deployed: container healthy, smoke-public ok, live-db ok, deployed bundle has duet:scroll-to-latest, deployed sender has pushFailureReason and no PUSH_TOPIC"
    verification:
      - kind: integration
        ref: "docker inspect health + scripts/smoke-public.sh + scripts/check-live-db.sh --existing ./data + in-container grep"
        status: pass
    human_judgment: false

duration: 8min
completed: 2026-10-15
status: complete
---

# Phase 2 Plan 06: Gap closure (scroll-on-send, iPhone push) Summary

**Composer sends now dispatch `duet:scroll-to-latest` so ScrollFollower jumps to the newest message, pushes go out without the Topic header that Apple has been rejecting with 400 BadWebPushTopic, refusals log a sanitized reason, and both fixes are live at https://duet.brkn.me**

## Performance

- **Duration:** about 8 min
- **Started:** 2026-10-15T08:56:38Z
- **Completed:** 2026-10-15T09:04:06Z
- **Tasks:** 3 (two code tasks, one deploy-only task)
- **Files modified:** 9

## Accomplishments
- G-02-42: every local send (text, reply, photo/video album, voice note) jumps the chat to the newest message, including when you were scrolled up and after a wheel or touch at the bottom that did not scroll. Incoming messages while scrolled up still only bump the badge and leave the list where it is.
- G-02-7: no Topic header goes to any push service. `push_failed` now carries a `reason` (for example `BadWebPushTopic`) that is capped at 120 code points, with endpoint path segments replaced by `[redacted]`, URLs by `[url]` and control characters by spaces. The error object, endpoint and keys are never logged.
- D-16 / SHEL-03: the test-push toast no longer blames the connection when the server answered `sent: 0`.
- Redeployed: the container is healthy, smoke-public and live-db pass, and the in-container checks confirm the deployed bundle and server code.

## Task Commits

1. **Task 1: scroll-on-send tracer (G-02-42)**: `b42f536` (fix)
2. **Task 2: topic-free push + reason logging + sent-0 toast (G-02-7)**: `f9289c9` (test, RED), then `279e5ba` (fix, GREEN)
3. **Task 3: redeploy**: no commit. This task only builds, deploys and verifies, and it changes no files.

## Files Created/Modified
- `web/lib/chat/events.ts`: adds `SCROLL_TO_LATEST_EVENT` and `requestScrollToLatest()`.
- `web/components/app/composer.tsx`: calls `requestScrollToLatest()` after `sendText`, `sendMedia` and `sendVoice` (3 call sites).
- `web/components/app/chat-view.tsx`: ScrollFollower listens for the event, clears the badge, then calls `scrollToEnd({behavior: "auto"})` immediately and again on the next frame. A pending frame is cancelled on cleanup.
- `scripts/smoke-chat.mjs`: new `scroll-send` scenario.
- `server/src/push/sender.ts`: no `topic` option. Adds `pushFailureReason` and `PUSH_REASON_MAX_CHARS`, and `push_failed` includes `reason` when one is available.
- `shared/src/push.ts`: removes `PUSH_TOPIC_CHAT` and `PUSH_TOPIC_TEST`.
- `server/test/push.test.ts`: tests for no topic (FCM chat, Apple chat, test push), Apple 400 reason logging, the capped and redacted long body, and `pushFailureReason` unit cases.
- `web/lib/chat/push.ts`: `sendTestPush` uses separate copy for sent 0 and for a failed request.
- `.planning/phases/02-chat-media-push/02-UI-SPEC.md`: adds the scroll-on-send sentence and the sent-0 copy row.

## Gates Run
- RED proof for the tracer: with the three composer calls temporarily removed, `scroll-send` failed with "a send while scrolled up did not jump to the latest message". It passed after they were restored.
- RED proof for Task 2: 10 of 23 push tests failed before the implementation, and 23 of 23 passed after.
- Pre-deploy: server suite 288 passed, 1 skipped (the existing environment-conditional `skipIf` for HEIF/HDR tools). `npm run typecheck` is clean and `check-preset` reports "preset ok".
- Full e2e: all 12 scenarios passed (send, offline, history, catchup, react, reply, typing-read, photo, album, video, voice, scroll-send), ending in "smoke-chat ok". The onboarding e2e passed (a2hs, drawer) and ended in "smoke-chat ok".
- Post-deploy: `duet-duet-1` was healthy about 15 s after recreate. smoke-public and live-db both passed, and the in-container grep exited 0.
- No push was sent to the real phones from a script or the container.

## Decisions Made
- The Topic header is dropped for every push service, not just Apple. This keeps one code path, and collapsing already happens on the device through the service worker (D-14).
- `scrollToEnd` uses behavior "auto", not "smooth", so the keyboard or visualViewport resize on phones cannot cut the scroll short.

## Deviations from Plan

None. The plan was executed as written. One small addition inside the planned sanitizer: a URL-decoded copy of each endpoint path segment is also redacted, which is the same capability in another encoding (defense in depth for T-02-36). Task 3 has no commit because it changes no files.

## Issues Encountered
None.

## Pending Human Verification (UAT tests 7 and 42, route to /gsd-verify-work 2)
Force-quit and reopen duet on both phones first so the PWA loads the new bundle.
1. **iPhone:** header menu -> Notifications -> "Send test notification". A notification should arrive within a few seconds. Then close duet on the iPhone and send 3 quick messages from the Pixel. One notification "{name} · 3 new messages" should arrive, and tapping it should open the chat. No notification should arrive while the chat is open and on screen. The Pixel should still get its notifications.
2. **Server confirmation:**
   `docker compose logs --since 30m duet | grep -E '"evt":"push_(failed|test|sent)"'`
   Expect push_test with sent 1 and no push_failed for host web.push.apple.com. If a push_failed still appears, its `reason` field names the next suspect. A 403 BadJwtToken, a 429 or any JWT-related reason points at the per-send VAPID JWT refresh (research A9; fix by caching the VAPID headers). Route that to /gsd-debug rather than patching blind.
3. **Both phones:** scroll far up in history and send a text. The view should jump to it at the bottom. Repeat with a photo and with a voice note. While scrolled up, a message from the other phone should show the badge and not move the list.

## User Setup Required
None.

## Next Phase Readiness
- Both Phase 2 UAT gaps are fixed in code and deployed. Phase 2 can close once the user confirms UAT tests 7 and 42 on the devices.

---
*Phase: 02-chat-media-push*
*Completed: 2026-10-15*

## Self-Check: PASSED

All 9 listed files exist; commits b42f536, f9289c9, 279e5ba are ancestors of HEAD.
