---
phase: 02-chat-media-push
plan: 01
subsystem: chat
tags: [fastify, websocket, drizzle, sqlite, zod, react, useSyncExternalStore, shadcn, playwright]

requires:
  - phase: 01-foundation-auth-media-plane
    provides: cookie auth (requireUser), global Origin guard, DB-free /ws hub with heartbeat, SignalingClient, Drizzle boot migrations, Docker + Cloudflare Tunnel deploy
provides:
  - "Migration 0001_chat_media_push with every Phase 2 table (messages, attachments, reactions, read_state, push_subscriptions; D-07 shape)"
  - "shared/src/chat.ts contract (MessageDto, SendMessageBody strict, MessagesPage, SyncResponse, limits) and chat-logic.ts pure helpers (codePointLength, isBlankBody, mediaLabel, messageLabel, truncateGraphemes, mergeMessages, nextOutboxState)"
  - "POST/GET /api/messages (idempotent on client UUID, 409 id_conflict) and GET /api/sync change cursor"
  - "hub.broadcast, hub.isViewing (45 s presence freshness), ping/pong and presence frames"
  - "app.chatEvents.onMessageCreated seam (02-03 push subscribes here)"
  - "web chatStore/useChat, singleton reconnecting realtime, persisted text outbox, ChatView/MessageGroupRow/Composer, OPEN_CHAT_EVENT"
  - "scripts/smoke-chat.sh (SMOKE_SCRIPT, SMOKE_TMP, SKIP_BUILD, SMOKE_PORT) with scenarios send/offline/history/catchup; scripts/lib/e2e.mjs"
affects: [02-02, 02-03, 02-04, 02-05]

actuals:
  tokens: 45400
  tasks: 3
  commits: 4
plan_head_before: 3e1732ade80c6cc52deb8a0e14f48e9300f89b38
plan_head_after: 8ffaafbe83dcafcfaae2d14df03b957bd6d16011

tech-stack:
  added: ["@shadcn/react 0.3.1 (via shadcn add message-scroller)"]
  patterns:
    - "Write over HTTP in one sync transaction, then hub.broadcast; hub stays DB-free"
    - "updated_seq = max+1 inside the write transaction as the global change cursor"
    - "Module-level external store + pure merge helpers in shared/ (tested from server vitest)"
    - "Scenario registry e2e driven by a shell harness that seeds fixtures and boots a real server"

key-files:
  created:
    - server/drizzle/0001_chat_media_push.sql
    - shared/src/chat.ts
    - shared/src/chat-logic.ts
    - server/src/chat/service.ts
    - server/src/chat/events.ts
    - server/src/chat/routes.ts
    - server/test/chat.test.ts
    - server/test/chat-logic.test.ts
    - web/lib/chat/store.ts
    - web/lib/chat/realtime.ts
    - web/lib/chat/outbox.ts
    - web/lib/chat/events.ts
    - web/components/app/chat-view.tsx
    - web/components/app/message-row.tsx
    - web/components/app/composer.tsx
    - scripts/smoke-chat.sh
    - scripts/smoke-chat.mjs
    - scripts/lib/e2e.mjs
  modified:
    - server/src/db/schema.ts
    - server/src/ws/hub.ts
    - server/src/app.ts
    - shared/src/ws.ts
    - shared/src/index.ts
    - web/components/app/shell.tsx
    - web/app/layout.tsx
    - scripts/check-live-db.sh
    - scripts/smoke-public.sh

key-decisions:
  - "No @tanstack/react-query: one useSyncExternalStore store with mergeMessages (planner deviation A4, as planned)"
  - "GET /api/sync cursor = last returned updatedSeq when hasMore, else the server's current max (a stale client cursor resets down)"
  - "mergeMessages never lets a lower updatedSeq replace a higher one, so out-of-order WS/sync/POST echoes cannot regress a message"
  - "Any 401 from a chat request or a 4401 close resets the store and outbox and returns to login; logout stops realtime before POST /api/logout"
  - "Bad query strings on GET /api/messages and /api/sync answer 400 invalid_query (bodies keep invalid_body)"
  - "Text bubbles use overflow-wrap anywhere and the BubbleGroup is full width, so the preset max-w-[80%] measures against the row (otherwise bubbles shrink-wrapped to a narrow column)"

patterns-established:
  - "New WS client frames are strictObject; new server frames are tolerant z.object"
  - "Chat logs carry evt/userId/seq/created only; a log-stream test proves bodies never appear"
  - "Smoke harness: SMOKE_SCRIPT swaps the scenario file against the same seeded server"

requirements-completed: [CHAT-01, CHAT-02, CHAT-03, CHAT-04, CHAT-05]

coverage:
  - id: D1
    description: "Text message sent in one browser appears in the other in real time and persists across reload (CHAT-01)"
    requirement: CHAT-01
    verification:
      - kind: e2e
        ref: "bash scripts/smoke-chat.sh send"
        status: pass
      - kind: integration
        ref: "server/test/chat.test.ts#delivers a created message to every socket of both people; a replay delivers nothing"
        status: pass
    human_judgment: false
  - id: D2
    description: "Idempotent send on client UUID, 409 id_conflict, strict body, code-point cap, byte-identical bodies, body never logged (CHAT-04, T-02-01..03)"
    requirement: CHAT-04
    verification:
      - kind: integration
        ref: "server/test/chat.test.ts#POST /api/messages (CHAT-01, CHAT-04)"
        status: pass
      - kind: integration
        ref: "server/test/chat.test.ts#never writes a message body to the log"
        status: pass
    human_judgment: false
  - id: D3
    description: "History pages back to the first message with strict before bound and beginning marker (CHAT-02)"
    requirement: CHAT-02
    verification:
      - kind: integration
        ref: "server/test/chat.test.ts#pages 120 messages by seq: 50 + 50 + 20, disjoint, ascending, covering all, hasMore true/true/false"
        status: pass
      - kind: e2e
        ref: "bash scripts/smoke-chat.sh history"
        status: pass
    human_judgment: false
  - id: D4
    description: "Offline sends show Sending…, never fail while offline, deliver once in order; Sent only after a seq (CHAT-03, CHAT-04)"
    requirement: CHAT-03
    verification:
      - kind: e2e
        ref: "bash scripts/smoke-chat.sh offline"
        status: pass
      - kind: unit
        ref: "server/test/chat-logic.test.ts#nextOutboxState (CHAT-03, CHAT-04)"
        status: pass
    human_judgment: false
  - id: D5
    description: "Catch-up after a dropped socket through /api/sync, ping/pong and presence-based isViewing (CHAT-05, D-15)"
    requirement: CHAT-05
    verification:
      - kind: e2e
        ref: "bash scripts/smoke-chat.sh catchup"
        status: pass
      - kind: integration
        ref: "server/test/chat.test.ts#GET /api/sync (CHAT-05 change cursor)"
        status: pass
      - kind: integration
        ref: "server/test/chat.test.ts#/ws ping and presence (D-15, Pitfall 8)"
        status: pass
    human_judgment: false
  - id: D6
    description: "All Phase 2 tables live in the deployed database through one migration; public 401s for /api/messages and /api/sync"
    verification:
      - kind: other
        ref: "bash scripts/check-live-db.sh && bash scripts/check-live-db.sh --existing ./data"
        status: pass
      - kind: other
        ref: "bash scripts/smoke-public.sh"
        status: pass
    human_judgment: false
  - id: D7
    description: "Real-device behaviour: iOS standalone keyboard keeps header and composer visible; airplane-mode outbox and background catch-up on both phones; scroll-to-latest badge feel"
    verification: []
    human_judgment: true
    rationale: "visualViewport sizing (Pitfall 13, assumption A2) and iOS socket freezing can only be confirmed on the iPhone and Pixel at end-of-phase UAT"

duration: 50min active (wall clock 14h 30m including a rate-limit pause)
completed: 2026-10-11
status: complete
---

# Phase 2 Plan 01: Real-time Text Chat Summary

**Idempotent, cursor-synced text chat: one migration with every Phase 2 table, POST/GET /api/messages + /api/sync, hub broadcast and presence, a persisted localStorage outbox, and a grouped messenger screen, deployed at https://duet.brkn.me**

## Performance

- **Duration:** about 50 min of active work. Wall clock was 14h 30m because a rate-limit cut-off paused execution between Task 2 and the Task 3 commit.
- **Started:** 2026-10-10T17:30Z
- **Completed:** 2026-10-11T07:46Z
- **Tasks:** 3 (Task 1 tracer, Task 2 TDD, Task 3 auto + deploy)
- **Files modified:** 40

## Accomplishments
- The D-07 schema now exists in the live database: `messages` (seq PK, client-UUID `id` UNIQUE, indexed `updated_seq`), `attachments` (nullable `message_seq` + `position`), `reactions` (PK seq+user), `read_state` and `push_subscriptions` (cascades with the session). The live `__drizzle_migrations` table holds 2 rows.
- The chat API never loses or doubles a message. A replayed id returns the same message and broadcasts nothing; an id owned by the other person gets 409. Bodies are capped at 4000 code points and stored byte-identical. `/api/sync` returns at most 500 changes and sets `hasMore` when there are more.
- The hub now has `broadcast`, `isViewing` (visible presence heard from within 45 s), and ping/pong. It still imports no database code. `app.chatEvents.onMessageCreated` is ready for plan 02-03's push.
- Client side:
  - A single reconnecting socket backs off from 0.5 s to 8 s.
  - On resume it checks the socket with a ping and reconnects if no pong arrives within 2 s.
  - It sends presence on hello, on every visibility change, on pagehide and every 20 s.
  - It calls `/api/sync` and flushes the outbox on every hello, resume and online event.
  - The text outbox persists in `duet.outbox.v1.<userId>` and retries with the same id.
- The chat screen follows UI-SPEC:
  - Bubbles from one sender group together when under 2 minutes apart.
  - Day markers and 15-minute time markers separate the list.
  - The first load shows skeleton bubbles; an empty chat and an unreachable server each have their own state.
  - History markers show loading, error and the beginning of the conversation.
  - Only your latest message carries a status line: Sending… or Sent. Failed messages show "Not sent. Tap to retry."
  - The scroll-to-latest button shows a count badge, incoming messages are announced through aria-live, and the header shows a Connecting…/Offline subline.
  - The composer grows from 1 to 6 lines. The app sizes itself to the visual viewport for the iOS keyboard.

## Task Commits

1. **Task 1: tracer, end-to-end real-time text** - `757bf1d` (feat)
2. **Task 2: never lost or doubled** - `83f26ea` (test, RED) and `6f025ca` (feat, GREEN)
3. **Task 3: messenger screen, live schema proof, deploy** - `8ffaafb` (feat)

**Plan metadata:** the docs commit for this SUMMARY

## TDD Gate Compliance (Task 2)

- **RED** `83f26ea`: 21 behavior tests failed on assertions against signature-only stubs (42 run).
  - The RED evidence record is `.planning/phases/02-chat-media-push/.red-02-01.json` (raw TAP in `.red-02-01-raw.txt`).
  - Target: `test/chat.test.ts > GET /api/sync (CHAT-05 change cursor) > returns the messages changed after the cursor, ascending by updatedSeq`. It failed with `expected 404 to be 200`. The classifier returned `RED_EVIDENCE_OK target_test_failed`.
  - Semantic assessment: the target executed and failed on its planned status assertion because the route did not exist. There was no load, syntax or fixture fault.
- **GREEN** `6f025ca`: 42/42 in the two files; full suite 187/187.
- **REFACTOR:** not needed.

## Files Created/Modified
- `server/src/db/schema.ts`, `server/drizzle/0001_chat_media_push.sql` (+ meta): all Phase 2 tables
- `shared/src/chat.ts`, `shared/src/chat-logic.ts`, `shared/src/ws.ts`: contract, pure helpers, and the `msg`/`pong`/`ping`/`presence` frames
- `server/src/chat/{service,events,routes}.ts`: send transaction, DTO building, paging, sync, event seam
- `server/src/ws/hub.ts`, `server/src/app.ts`: broadcast, presence, isViewing; chatEvents and chatRoutes wiring
- `web/lib/chat/{store,realtime,outbox,events}.ts`: client state, socket manager, persisted outbox, OPEN_CHAT_EVENT
- `web/components/app/{chat-view,message-row,composer,shell}.tsx`, `web/app/layout.tsx`: chat screen
- `web/components/ui/{message,bubble,message-scroller,marker,input-group,textarea,skeleton,popover,drawer}.tsx`: added through the shadcn CLI only
- `scripts/smoke-chat.{sh,mjs}`, `scripts/lib/e2e.mjs`, `scripts/check-live-db.sh`, `scripts/smoke-public.sh`: e2e and live checks
- `server/test/chat.test.ts`, `server/test/chat-logic.test.ts`

## Decisions Made
See `key-decisions` in the frontmatter. `replyTo` is always null for now; plan 02-02 builds ReplyPreview inside `toDtos`.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Bubbles shrink-wrapped to a narrow column**
- **Found during:** Task 3 (visual check with mobile screenshots)
- **Issue:** The preset `BubbleGroup` sizes to its content, so the bubble's `max-w-[80%]` measured against a narrow parent. Multi-line messages wrapped at about 150px, and long URLs overflowed the left edge.
- **Fix:** Added `w-full` to the `BubbleGroup` and `wrap-anywhere` to the text bubble content. Both are utility classes on preset components, and no file under `web/components/ui` was edited.
- **Files modified:** `web/components/app/message-row.tsx`
- **Verification:** measured widths in headless Chrome; re-shot screenshots; smoke-chat passes.
- **Committed in:** `8ffaafb`

**2. [Rule 1 - Bug] WS messages lost while the first page loads**
- **Found during:** Task 2
- **Issue:** `loadLatest` replaced the whole list, which dropped any WS message that arrived while the request was in flight.
- **Fix:** Messages newer than the page are merged back in. The cursor stays at the page value, so the next sync replays anything in between without duplicates.
- **Files modified:** `web/lib/chat/store.ts`
- **Committed in:** `6f025ca`

**3. [Rule 2 - Missing critical] Session loss handling**
- **Found during:** Task 2
- **Issue:** The plan only handled 4401 closes. A 401 from send, sync or paging would have left a dead chat on screen.
- **Fix:** Any chat 401 resets the store, clears the outbox, stops the socket and returns to login. Logout stops the socket before its POST, so the server's 4401 is not mistaken for a remote logout.
- **Files modified:** `web/lib/chat/store.ts`, `web/lib/chat/outbox.ts`, `web/components/app/shell.tsx`
- **Committed in:** `6f025ca`

**4. [Rule 3 - Blocking] TDD RED evidence format**
- **Found during:** Task 2 RED
- **Issue:** Vitest's TAP output for the two-file run prints unindented multi-line diffs. The classifier rejected it as `invalid_record` ("Malformed TAP").
- **Fix:** Per tdd.md, re-ran just the planned target with the same runner and reporter. The classifier accepted it with `RED_EVIDENCE_OK`. The full 21-failure run is recorded in the semantic assessment.
- **Committed in:** `83f26ea` (the evidence files go in the docs commit)

---

**Total deviations:** 4 auto-fixed (2 bugs, 1 missing critical, 1 blocking).
**Impact on plan:** all four were needed for correctness. No contract was renamed and nothing was added beyond the plan's scope.

## Issues Encountered
- A rate-limit cut-off interrupted execution after Task 2. The coordinator resumed it. Task 3's uncommitted work was re-verified from scratch (typecheck, 187 tests, preset, live-db, all four e2e scenarios on a fresh build) before it was committed and deployed.
- The scratchpad root-pin script disappeared during the pause. The coordinator's replacement toplevel check was used for the remaining writes and commits.

## Known Stubs
- `server/src/chat/service.ts` `toDtos` sets `replyTo: null` on purpose. Reply previews are plan 02-02's scope (`bad_reply`, ReplyPreview), and no reply can be created until then.
- ChatView renders text bodies only. Media and voice bubbles are plans 02-04 and 02-05; no media message can be created yet.

## User Setup Required
None. No external service configuration was needed.

## Next Phase Readiness
- Plans 02-02 and 02-03 (wave 2) can start. The contracts they read are in place: MessageDto, `hub.broadcast`/`isViewing`, `chatEvents`, the store methods, OPEN_CHAT_EVENT, the popover and drawer components, and the smoke-chat registry with SMOKE_SCRIPT.
- End-of-phase device UAT items still need the phones:
  - iOS keyboard layout.
  - Airplane-mode outbox.
  - Background catch-up.
  - The badge on a real touch scroll.

---
*Phase: 02-chat-media-push*
*Completed: 2026-10-11*

## Self-Check: PASSED
