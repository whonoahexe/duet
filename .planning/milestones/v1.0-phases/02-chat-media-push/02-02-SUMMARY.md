---
phase: 02-chat-media-push
plan: 02
subsystem: chat
tags: [fastify, websocket, drizzle, zod, react, base-ui, popover, pointer-events, playwright]

requires:
  - phase: 02-chat-media-push
    provides: "02-01: MessageDto/ReplyPreview contract, toDtos, nextUpdatedSeq, hub.broadcast, chatStore + realtime + outbox, popover component, smoke-chat registry"
provides:
  - "REACTIONS (D-04), Reaction, ReactionBody, ReadBody, ReadResponse, REPLY_SNIPPET_MAX_GRAPHEMES, SendMessageBody.replyToSeq; reactionSummary helper"
  - "PUT /api/messages/:seq/reaction (setReaction) and POST /api/read (markRead), both broadcast over /ws"
  - "Reply validation (400 bad_reply) and server-built ReplyPreview in toDtos (two batched queries, never nested)"
  - "WS frames: client typing; server typing {userId} and read {userId, seq, at}; hub relays typing to the other person only"
  - "web: apiPut; chatStore.react/setReplyTarget/jumpTo/peerTyping/applyRead/markReadUpTo; realtime sendTyping"
  - "web: useLongPress, useSwipeReply, mergeHandlers (gestures.ts); MessageActions, QuoteBlock (+ localReplyPreview), TypingIndicator"
  - "smoke-chat scenarios react, reply, typing-read (seven scenarios in total)"
affects: [02-03, 02-04, 02-05]

actuals:
  tokens: 21957
  tasks: 3
  commits: 5
plan_head_before: 13e096386802cb88932fd720a659afe0e2a49385
plan_head_after: 5215e7e6955fe7d1c2f667254bd45e6088e3908d

tech-stack:
  added: []
  patterns:
    - "Each stored bubble is its own controlled Base UI PopoverTrigger (render=Bubble, nativeButton false, data-slot kept as bubble); onOpenChange ignores trigger-press"
    - "Gesture hooks return plain handler objects merged onto one element with mergeHandlers; latest callbacks live in refs updated in layout effects"
    - "Ephemeral WS frames (typing) never touch the DB; durable reads/reactions go over HTTP, bump updated_seq where they change a message, then broadcast"
    - "Message text renders in span[data-testid=message-text], so quote snippets never collide with the original in e2e lookups"

key-files:
  created:
    - server/test/reactions.test.ts
    - server/test/replies.test.ts
    - server/test/read-typing.test.ts
    - web/lib/chat/gestures.ts
    - web/components/app/message-actions.tsx
    - web/components/app/quote-block.tsx
    - web/components/app/typing-indicator.tsx
  modified:
    - shared/src/chat.ts
    - shared/src/chat-logic.ts
    - shared/src/ws.ts
    - server/src/chat/service.ts
    - server/src/chat/routes.ts
    - server/src/ws/hub.ts
    - server/test/chat-logic.test.ts
    - web/lib/api.ts
    - web/lib/chat/store.ts
    - web/lib/chat/realtime.ts
    - web/lib/chat/outbox.ts
    - web/components/app/message-row.tsx
    - web/components/app/composer.tsx
    - web/components/app/chat-view.tsx
    - scripts/smoke-chat.mjs

key-decisions:
  - "Outbox (unconfirmed) bubbles get no menu and no swipe: reacting or replying needs a server seq"
  - "Typing frames go out only on composer changes (at most one per 3 s), never on a timer while a draft sits untouched, so a left-over draft does not show as typing"
  - "Read tracker: candidate items from useMessageScrollerVisibility, then each peer bubble ([data-slot=bubble][data-seq]) must intersect the list viewport; items are whole sender groups, so the item alone is too coarse"
  - "A quote jump is instant: scrollToMessage brings the sender group into range, then the bubble is re-centred for 6 frames while content-visibility lays out; a smooth scroll outlasted the 1.2 s highlight"
  - "Auto-loading older pages pauses while highlightSeq is set, so a prepend cannot cut a jump short"
  - "The aria-live announcement is written through a ref, not React state (fixes React #185 during message bursts)"
  - "The typing indicator also shows in an empty conversation (below the Empty block)"

patterns-established:
  - "New ServerFrame variants stay z.object (tolerant); new ClientFrame variants stay strictObject"
  - "Store 'latest value' refs are written in useLayoutEffect, never during render (react-hooks/refs)"
  - "Smoke status waits accept DELIVERED (Sent or Read {time}) wherever D-03 allows either"

requirements-completed: [CHAT-06, CHAT-07, CHAT-08, CHAT-09]

coverage:
  - id: D1
    description: "React with 💕 💔 😋 😝 😘 😭 from the long-press / right-click / Enter menu; one per person, replace and remove; allowlist by exact string; chip live on the other phone; updated_seq bump reaches offline phones through /api/sync (CHAT-08, D-04)"
    requirement: CHAT-08
    verification:
      - kind: integration
        ref: "server/test/reactions.test.ts#PUT /api/messages/:seq/reaction (CHAT-08, D-04)"
        status: pass
      - kind: unit
        ref: "server/test/chat-logic.test.ts#reactionSummary (D-04)"
        status: pass
      - kind: e2e
        ref: "bash scripts/smoke-chat.sh react"
        status: pass
    human_judgment: false
  - id: D2
    description: "Swipe right (or menu Reply) starts a reply with the 'Replying to' chip; replies carry a server-built, grapheme-safe quote (direct parent only, media label and thumb for media parents); 400 bad_reply for a missing parent; tapping a quote pages back ('Finding message…'), centres and rings the original (CHAT-09, D-01, D-02)"
    requirement: CHAT-09
    verification:
      - kind: integration
        ref: "server/test/replies.test.ts#replies (CHAT-09, D-02)"
        status: pass
      - kind: e2e
        ref: "bash scripts/smoke-chat.sh reply"
        status: pass
    human_judgment: false
  - id: D3
    description: "Typing indicator: frames at most every 3 s while typing, relayed only to the other person's sockets; three-dot muted bubble with a 5 s TTL that also clears when their message arrives (CHAT-06)"
    requirement: CHAT-06
    verification:
      - kind: integration
        ref: "server/test/read-typing.test.ts#typing relay (CHAT-06)"
        status: pass
      - kind: e2e
        ref: "bash scripts/smoke-chat.sh typing-read"
        status: pass
    human_judgment: false
  - id: D4
    description: "Read receipts: POST /api/read moves forward only, clamps to the newest seq, broadcasts each advance; reads come back from /api/messages and /api/sync; the status line under your latest message reads 'Read {time}' (CHAT-07, D-03)"
    requirement: CHAT-07
    verification:
      - kind: integration
        ref: "server/test/read-typing.test.ts#POST /api/read (CHAT-07, D-03)"
        status: pass
      - kind: e2e
        ref: "bash scripts/smoke-chat.sh typing-read"
        status: pass
    human_judgment: false
  - id: D5
    description: "Real-device gestures and privacy: swipe and long-press coexist with native scrolling, text selection and the system callout on iPhone and Pixel; no receipt while the phone is locked or duet is in the background; quote jump far back in history on a phone"
    verification: []
    human_judgment: true
    rationale: "Pitfall 11 (native gesture conflicts) and the visible+focused receipt rule (T-02-11) depend on iOS/Android touch and focus behaviour; headless Chrome emulates focus for every page, so only device UAT can confirm them (plan human-check items for Tasks 2 and 3)"

duration: 28min
completed: 2026-10-11
status: complete
---

# Phase 2 Plan 02: Reactions, Replies, Typing and Read Receipts Summary

**Long-press reactions from the couple's six emoji, swipe-to-reply quotes that jump back through history, a three-dot typing indicator and "Read 9:41" receipts, all end to end: shared contract, REST/WS server, store, gestures and seven passing two-browser scenarios.**

## Performance

- **Duration:** 28 min
- **Started:** 2026-10-11T07:48:49Z
- **Completed:** 2026-10-11T08:16:43Z
- **Tasks:** 3 (Task 1 tracer, Tasks 2 and 3 TDD)
- **Files modified:** 22 (7 created, 15 modified)

## Accomplishments
- **Reactions (D-04, CHAT-08).** `PUT /api/messages/:seq/reaction` accepts only the six `REACTIONS` by exact string, so `💕` plus U+FE0F, `❤️` and anything else get 400.
  - Each person has one reaction per message, and setting `null` removes it.
  - The write bumps `updated_seq` and is broadcast as a changed `msg`.
  - Every stored bubble is its own controlled popover, opened by long-press (450 ms), right-click/contextmenu or Enter, never by a tap. It holds the reaction row, a separator, Reply and Copy.
  - The chip sits on the bubble's inner corner and opens the same menu.
- **Replies (D-01, D-02, CHAT-09).** You can reply by swiping right (8/56/72 px, vertical scroll still works) or by choosing Reply in the menu.
  - The composer shows "Replying to {name}" with the quote and a Cancel reply button, and the outbox keeps `replyToSeq`.
  - The server checks the parent inside the send transaction (400 `bad_reply`) and builds the quote: at most 120 graphemes, media label and thumb for media, direct parent only.
  - Tapping a quote pages back 200 at a time behind "Finding message…", then centres the original and rings it for 1.2 s.
- **Typing (CHAT-06).** The client sends a `typing` frame on composer changes, at most every 3 s.
  - The hub relays it only to the other person's sockets.
  - The indicator is a muted three-dot bubble that disappears after 5 s or as soon as their message arrives. It is static under reduced motion.
- **Read receipts (CHAT-07, D-03).** `POST /api/read` moves your read position forward only, clamps it to the newest message, and broadcasts each advance.
  - The web client sends it only while the page is visible and focused, for peer bubbles actually inside the list viewport, debounced 500 ms.
  - The status line goes Sending… → Sent → Read {time}.
- **Bug fix in 02-01 code:** a burst of incoming messages crashed the chat with React error #185. This is fixed (see Deviations).

## Task Commits

1. **Task 1: reaction tracer, end to end** - `34b0b18` (feat)
2. **Task 2: swipe/menu reply with quote jump** - `84397e5` (test, RED) and `0488950` (feat, GREEN)
3. **Task 3: typing indicator and read receipts** - `a93c444` (test, RED) and `5215e7e` (feat, GREEN)

**Plan metadata:** the docs commit for this SUMMARY.

## TDD Gate Compliance

**Task 2:**
- **RED** `84397e5`: all 6 tests in `replies.test.ts` failed on assertions.
  - Evidence: `.planning/phases/02-chat-media-push/.red-02-02.json` (raw TAP in `.red-02-02-raw.txt`). Target: `test/replies.test.ts > replies (CHAT-09, D-02) > builds a ReplyPreview for a text parent`, which failed with `expected 400 to be 200`. The classifier returned `RED_EVIDENCE_OK target_test_failed`.
  - Semantic assessment: the target ran and failed on its planned status assertion, because the strict send body had no `replyToSeq` yet. There was no load, syntax or fixture fault.
- **GREEN** `0488950`: 6/6 pass; the full suite passes 203/203.

**Task 3:**
- **RED** `a93c444`: 4 of 5 tests in `read-typing.test.ts` failed on behaviour.
  - Evidence: `.red-02-02-t3.json` (raw in `.red-02-02-t3-raw.txt`). Target: `POST /api/read (CHAT-07, D-03) > advances bob's read cursor forward only…`, which failed with `expected 404 to be 200`. The classifier returned `RED_EVIDENCE_OK target_test_failed`.
  - The extra-key `bad_frame` guard already passed, because `typing` was unknown to `ClientFrame`. It stays as a regression guard.
- **GREEN** `5215e7e`: 5/5 pass; the full suite passes 208/208.

**REFACTOR:** not needed for either task.

**Tracer gate (Task 1):** interactive run, `end-of-phase` mode, automated-only verify. The verify re-ran green (`send react`, 197 tests, typecheck, preset) before expanding.

## Files Created/Modified
- `shared/src/chat.ts`, `shared/src/chat-logic.ts`, `shared/src/ws.ts`: the reaction/read/reply contract, `reactionSummary`, and the typing/read frames.
- `server/src/chat/service.ts`: `setReaction`, `markRead`, `bad_reply` validation, and `replyPreviews` used by `toDtos`.
- `server/src/chat/routes.ts`: `PUT /api/messages/:seq/reaction`, `POST /api/read`.
- `server/src/ws/hub.ts`: typing relay. The hub still has no DB access.
- `web/lib/chat/gestures.ts`: `useLongPress`, `useSwipeReply`, `mergeHandlers`, `haptic`.
- `web/components/app/message-actions.tsx`, `quote-block.tsx`, `typing-indicator.tsx`: new UI pieces built from preset components only.
- `web/components/app/message-row.tsx`, `composer.tsx`, `chat-view.tsx`: the popover trigger bubble, swipe, quote, chip, reply chip, typing indicator, read tracker, jump follower and "Read {time}".
- `web/lib/chat/store.ts`, `realtime.ts`, `outbox.ts`, `web/lib/api.ts`: store state and methods, frame routing, `replyToSeq` persistence, `apiPut`.
- `server/test/{reactions,replies,read-typing}.test.ts`, `server/test/chat-logic.test.ts`, `scripts/smoke-chat.mjs`.

## Decisions Made
See `key-decisions` in the frontmatter. The plan's assumptions were confirmed in the browser:
- The Pitfall 12 popover-per-bubble approach works.
- A closed popover mounts no portal: the status footer stays the bubble's direct sibling.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] The popover trigger replaced the bubble's `data-slot`**
- **Found during:** Task 1 (smoke `send`)
- **Issue:** The preset `PopoverTrigger` wrapper sets `data-slot="popover-trigger"`, and that overrode the Bubble's own `data-slot="bubble"`. Bubble lookups failed, and the slot styling hooks lost their name.
- **Fix:** Pass `data-slot="bubble"` explicitly on the trigger. The focusable bubble shows the preset focus ring on its content (`focus-visible:*:data-[slot=bubble-content]:ring-3 ring-ring/30`) instead of dropping the outline.
- **Files modified:** `web/components/app/message-row.tsx`
- **Verification:** a DOM probe, then `smoke-chat send react`.
- **Committed in:** `34b0b18`

**2. [Rule 1 - Bug] React error #185 during a burst of incoming messages (02-01 code)**
- **Found during:** Task 3 (full smoke: `history` then `reply`; Bob's page crashed while Ada posted 150 messages)
- **Issue:** `ScrollFollower` called `setAnnouncement` from an effect on every incoming message. Under a burst this cascaded into nested sync updates, past React's limit. It reproduced with 150 messages and not with 40. Development React confirmed the cause, and disabling `ScrollFollower` removed it, while removing the popover and gestures did not.
- **Fix:** Write the aria-live text through a ref instead of React state.
- **Files modified:** `web/components/app/chat-view.tsx`
- **Verification:** the dev-build probe shows no errors on 150-message bursts, and the full smoke passes.
- **Committed in:** `5215e7e`

**3. [Rule 1 - Bug] The quote jump missed the bubble when its sender group is tall**
- **Found during:** Task 3 (full smoke: `history` + `reply`)
- **Issue:** `scrollToMessage` can only target a scroller item, which is a whole sender group (121 messages here). Centring the group and then loading another older page with its scroll restore cut the smooth jump short.
- **Fix:** `scrollToMessage(group, start)`, then re-centre the bubble itself for 6 frames, instantly. Auto-loading older pages waits while `highlightSeq` is set.
- **Files modified:** `web/components/app/chat-view.tsx`
- **Verification:** `smoke-chat history reply`, `reply` alone, and the full seven-scenario run.
- **Committed in:** `5215e7e`

**4. [Rule 3 - Blocking] The reply scenario used 60 fillers, which never forced a page back**
- **Found during:** Task 2
- **Issue:** The first screen already loads two pages of 50, and the plan's order (original → reply → fillers) leaves the reply unloaded too. The jump path was never exercised.
- **Fix:**
  - Post 150 fillers.
  - Then post a second reply to the original from Bob through `context.request`.
  - Assert the original is not loaded before tapping that reply's quote.
  - Require the target to be both ringed and inside the list viewport.
- **Files modified:** `scripts/smoke-chat.mjs`
- **Committed in:** `0488950`

**5. [Rule 1 - Bug] The 02-01 scenarios expected "Sent" forever**
- **Found during:** Task 3
- **Issue:** Once receipts exist, Bob's open page moves Ada's status from Sent to Read {time}, as D-03 intends. The `send`, `offline` and `catchup` waits for exactly "Sent" became racy.
- **Fix:** Use a `DELIVERED` matcher (Sent or `Read …`). The "status line directly under the latest bubble" check accepts either text.
- **Files modified:** `scripts/smoke-chat.mjs`
- **Committed in:** `5215e7e`

**6. [Rule 2 - Missing critical] No typing indicator in an empty conversation**
- **Found during:** Task 3 (`typing-read` alone on a fresh database)
- **Issue:** The indicator lived only inside the message list, which does not exist before the first message.
- **Fix:** Render it under the Empty block as well.
- **Files modified:** `web/components/app/chat-view.tsx`
- **Committed in:** `5215e7e`

**7. [Rule 1 - Bug] Refs written during render**
- **Found during:** Task 3 (eslint `react-hooks/refs` on the changed files)
- **Fix:** The latest-callback and latest-value refs in `gestures.ts` and the new `chat-view.tsx` followers are written in `useLayoutEffect`. Two older findings in `chat-view.tsx` from 02-01 (`awayRef.current =` and `Date.now()` in render) are left as they were, because they are out of scope.
- **Committed in:** `5215e7e`

---

**Total deviations:** 7 auto-fixed (5 bugs, 1 missing critical, 1 blocking).
**Impact on plan:** All were needed for correct behaviour or for a meaningful e2e check. No contract was renamed, no package was installed, no `shadcn add` was run, and no file owned by plan 02-03 was touched.

## Issues Encountered
- `git.base-branch` reports `master` as protected. As dispatched (and as in 02-01 and Phase 1), the commits land on `master` in this sequential run.
- Debugging needed a `next dev` instance plus a throwaway server on 127.0.0.1:3100. Both were stopped afterwards. The production duet container was left alone.

## Known Stubs
- `web/components/app/quote-block.tsx` (`thumbUrl`): quote thumbnails point at `/media/{id}/thumb` and `/media/{id}/poster`, which plan 02-04 serves. No media message can be created until 02-04, so no thumbnail is requested yet. This is intentional, per the plan's action step 5.

## User Setup Required
None. No external service configuration is needed.

## Next Phase Readiness
- Plan 02-03 (push) is unaffected. This plan did not touch `server/src/app.ts`, `server/test/helpers.ts`, `shared/src/index.ts`, `shell.tsx`, `page.tsx`, `sw.js` or any manifest.
- Plans 02-04/02-05 can reuse the following:
  - `QuoteBlock` and `localReplyPreview`, with media labels and thumbs already handled.
  - `MessageText`.
  - `GroupItem`, which now carries `replyTo`, `reactions` and `readAt`.
- Not deployed by this plan: 02-01 deployed, and this plan's verification is local. The live site picks the new routes up on the next deploy.
- End-of-phase device UAT still needs both phones:
  - Swipe and long-press next to native scroll, selection and the callout (Pitfall 11).
  - No receipt while the phone is locked.
  - Typing dots timing.
  - Quote jump far back in history.

---
*Phase: 02-chat-media-push*
*Completed: 2026-10-11*

## Self-Check: PASSED
- Created files present: reactions/replies/read-typing tests, gestures.ts, message-actions.tsx, quote-block.tsx, typing-indicator.tsx, RED evidence records.
- Commits on this branch: 34b0b18, 84397e5, 0488950, a93c444, 5215e7e (evaluation-scope resolved, plan-subjects).
- Plan verification: `npm --prefix server run test` 208/208, `npm run typecheck` 0, `bash scripts/check-preset.sh` preset ok, `bash scripts/smoke-chat.sh` printed all seven scenario lines and "smoke-chat ok".
