---
phase: 03-voice-video-calls
plan: 02
subsystem: calls
tags: [web-push, service-worker, websocket, fastify, zod, playwright, vitest]

requires:
  - phase: 03-voice-video-calls
    provides: "03-01 single-call registry (onAttach no-op, recent map), hub CallHooks, callStore, CallProvider, smoke-calls.mjs with pooled logins"
  - phase: 02-chat-media-push
    provides: "push sender (buildPayload, sendOne, no Topic header), close-before-show service worker, clearNotifications, bridgeServiceWorkerMessages"
provides:
  - "PushPayload t call / call-missed with callId and kind"
  - "PushSender.notifyCall (TTL 45) and notifyMissedCall (TTL 86400) with a per-session skip; CALL_PUSH_TTL_SECONDS, callPushBody()"
  - "app.push decoration shared by pushRoutes and the call registry"
  - "hub.isSessionViewing(sessionId)"
  - "registry push hook (notifyCall on a ringing invite, notifyMissed on cancelled/no-answer), ring-on-attach, statusFor"
  - "GET /api/calls/:id (callsRoutes) and the shared CallStatusResponse"
  - "service worker duet-call tag, /?call= and /?missed= links, open-call tap message"
  - "OPEN_CALL_EVENT, callStore.checkCall and the Missed call toast with Call back"
  - "smoke-calls scenarios ring-on-open and stale"
affects: [03-03 video and in-call controls, 03-04 reconnect and device UAT]

actuals:
  tokens: 15700
  tasks: 2
  commits: 3
plan_head_before: f42744afca733b5d8268a6cbb3e3c36b107332a8
plan_head_after: 1741eb72c711e0a12ba76c197de6e508c9cc0309

tech-stack:
  added: []
  patterns:
    - "Ring-on-attach: the server re-sends call.ring to every new callee connection while the call rings; deep links and SW postMessage are hints only"
    - "Push suppression per session (hub.isSessionViewing), not per person, so the other phone still rings"
    - "Registry push adapter in app.ts: fire-and-forget, failures logged as push_call_failed / push_call_missed_failed"

key-files:
  created:
    - server/src/calls/routes.ts
    - server/test/call-push.test.ts
    - .planning/phases/03-voice-video-calls/.tdd/03-02-task2-red.json
  modified:
    - shared/src/push.ts
    - shared/src/call.ts
    - server/src/push/sender.ts
    - server/src/push/routes.ts
    - server/src/app.ts
    - server/src/ws/hub.ts
    - server/src/calls/registry.ts
    - server/test/sw.test.ts
    - web/public/sw.js
    - web/lib/chat/push.ts
    - web/lib/chat/events.ts
    - web/lib/call/store.ts
    - web/components/app/call-provider.tsx
    - scripts/smoke-calls.mjs

key-decisions:
  - "Call pushes skip a session only while it has a visible, fresh /ws connection (research A1, still flagged): the open phone shows the in-app ring, the user's other phone still gets the push"
  - "The missed push goes to the same subscriptions with the same skip rule and the normal 24 h TTL; only a ringing call that ends cancelled or no-answer sends it"
  - "The service worker only ever opens /?call=<uuid>, /?missed=<uuid> or /; the tap URL must equal one of the two links it built itself"
  - "The Missed call toast uses sonner id missed-<callId>, so the deep link, the SW message and a lost Accept race never stack two toasts for one call"

patterns-established:
  - "One PushSender per app (app.push) shared by every push producer"
  - "Party-only status lookups by id answer 404 for malformed, unknown and foreign ids alike"

requirements-completed: [CALL-03, CALL-04]

coverage:
  - id: D1
    description: "With the callee's app closed an invite sends 'Incoming voice/video call' (caller's name, TTL 45, urgency high, no Topic) to every callee subscription except visibly viewing sessions; the SW replaces any open notification with tag duet-call and a /?call=<id> link"
    requirement: CALL-03
    verification:
      - kind: integration
        ref: "server/test/call-push.test.ts#incoming-call push (CALL-03, D-09, D-11)"
        status: pass
      - kind: unit
        ref: "server/test/sw.test.ts#service worker call pushes (D-09, D-12)"
        status: pass
    human_judgment: false
  - id: D2
    description: "Ring-on-attach: opening duet while a call rings shows the incoming screen with Accept/Decline; no microphone is captured before Accept"
    requirement: CALL-03
    verification:
      - kind: e2e
        ref: "bash scripts/smoke-calls.sh voice ring-on-open"
        status: pass
      - kind: integration
        ref: "server/test/call-push.test.ts#rings a new callee connection right after hello"
        status: pass
    human_judgment: false
  - id: D3
    description: "A ring that ends cancelled or unanswered sends 'Missed voice/video call', which replaces the incoming notification; decline, answer, busy and glare send none"
    requirement: CALL-04
    verification:
      - kind: integration
        ref: "server/test/call-push.test.ts#missed-call push (D-12)"
        status: pass
    human_judgment: false
  - id: D4
    description: "Tapping a call notification posts open-call or opens /?call= (/?missed=); the app strips the parameter with replaceState and shows 'Missed call from {peer}' with Call back for an ended ring; GET /api/calls/:id is party-only and never cached"
    requirement: CALL-03
    verification:
      - kind: e2e
        ref: "bash scripts/smoke-calls.sh ring-on-open stale"
        status: pass
      - kind: integration
        ref: "server/test/call-push.test.ts#GET /api/calls/:id"
        status: pass
      - kind: unit
        ref: "server/test/sw.test.ts#service worker notificationclick on a call notification (D-09, D-10)"
        status: pass
    human_judgment: false
  - id: D5
    description: "Production at https://duet.brkn.me runs voice calls with push ringing (deploy healthy, smoke-public, live DB check)"
    requirement: CALL-03
    verification:
      - kind: e2e
        ref: "bash scripts/smoke-public.sh && bash scripts/check-live-db.sh --existing ./data"
        status: pass
    human_judgment: false
  - id: D6
    description: "A real incoming-call push on the locked iPhone and Pixel PWAs, the tap landing on the incoming screen (iOS deep-link quirks), and the missed push replacing the ring in the tray"
    requirement: CALL-03
    verification: []
    human_judgment: true
    rationale: "Real push delivery through Apple and FCM, lock-screen presentation and iOS Home Screen tap behaviour cannot be exercised headlessly; covered by the end-of-phase device UAT (03-04)"

duration: 12min
completed: 2026-10-16
status: complete
---

# Phase 3 Plan 02: Push Ringing, Missed Calls and Tap Routing Summary

**Calls now ring a closed app: a 45 s high-urgency "Incoming call" Web Push to every callee phone not already showing the call, server ring-on-attach so opening duet by any route shows the incoming screen, a "Missed call" push that replaces the ring, call-aware service worker tap routing, a party-only GET /api/calls/:id and the "Missed call from {peer}" toast with Call back; deployed to production**

## Performance

- **Duration:** 12 min
- **Started:** 2026-10-15T22:54:38Z
- **Completed:** 2026-10-15T23:07:09Z
- **Tasks:** 2
- **Files modified:** 17 (16 source/test/script files plus 1 RED evidence record)

## Accomplishments

- An accepted invite (not busy, glare or rate-limited) pushes `{t: "call", title: <caller>, body: "📞 Incoming voice call" | "🎥 Incoming video call", callId, kind}` with TTL 45, urgency high and no Topic header to each callee subscription. Sessions that have a visible, fresh /ws connection are skipped (`hub.isSessionViewing`). Logs carry `push_call {callId, subs, skipped, ok}` only.
- Ring-on-attach: while a call rings, every new /ws connection of the callee gets `call.ring` right after hello. The caller's connections and connections opened after the answer get nothing. The client ignores a repeated ring for the call already ringing on that device.
- A ringing call that ends `cancelled` or `no-answer` pushes "Missed voice/video call" (`t: "call-missed"`, 24 h TTL) with the same skip rule. The SW's close-before-show makes it replace the incoming notification. Decline, answer, busy and glare send nothing.
- The service worker tags call pushes `duet-call` and builds `/?call=<id>` or `/?missed=<id>` only from a uuid-shaped call id. A tap on a call notification posts `{t: "open-call", callId}` to an open window, or opens that link when no window exists. Chat taps are unchanged, and the SW still has exactly four listeners.
- The client bridges `open-call` to `OPEN_CALL_EVENT`. CallProvider strips `?call=`/`?missed=` with `history.replaceState`, validates the id with `CallId` and runs `callStore.checkCall`. For a call from the peer that ended cancelled or unanswered, that shows "Missed call from {peer}" with Call back (same kind). duet's notifications are cleared when the incoming screen opens and when a call ends (Pitfall 10).
- `GET /api/calls/:id` needs a session, validates the uuid, answers only the caller or callee (404 otherwise, and for unknown or malformed ids), allows 60/min per IP and sends `Cache-Control: no-store`.
- Deployed: `duet-duet-1` is healthy, smoke-public ok, live-db ok, and the production sw.js carries the call branch.

## Task Commits

1. **Task 1: Incoming-call push and ring-on-attach (tracer)**: `98433dd` (feat)
2. **Task 2: Missed-call push, tap routing, stale toast, deploy**
   - RED: `39e1261` (test)
   - GREEN: `1741eb7` (feat)

**Plan metadata:** the docs(03-02) commit that adds this file.

## TDD Gate Compliance

- **Task 2 RED:** the target `test/call-push.test.ts > missed-call push only for cancelled or unanswered rings (D-12) > sends one missed push when the caller cancels while ringing` failed with `expected "vi.fn()" to be called 2 times, but got 1 times` (no missed-call hook existed yet). Classifier: `RED_EVIDENCE_OK (target_test_failed)`. Semantic assessment: the target executed and failed on the planned assertion. In the full-file run, the no-answer missed push, GET /api/calls/:id (401 expected, route missing) and the SW open-call cases also failed on assertions. There were no load, syntax or fixture faults. Record: `.planning/phases/03-voice-video-calls/.tdd/03-02-task2-red.json`.
- **GREEN:** `1741eb7` comes after the `test(03-02)` commit `39e1261`. No REFACTOR commit was needed.
- Task 1 is `type="tracer"` (not TDD), so its tests were written with the implementation. The tracer gate re-ran its full `<verify>` before expansion (call-push/sw/push tests, `smoke-calls.sh voice ring-on-open`, server suite, typecheck, preset), and it was green.

## Files Created/Modified

- `shared/src/push.ts`: PushPayload `call` / `call-missed`, optional `callId`, `kind`
- `shared/src/call.ts`: `CallStatusResponse`
- `server/src/push/sender.ts`: `CALL_PUSH_TTL_SECONDS`, `callPushBody`, `buildPayload(..., extra)`, per-send TTL, `notifyCall`, `notifyMissedCall`
- `server/src/push/routes.ts`: uses `app.push` (no own sender, no `send` option)
- `server/src/app.ts`: `app.push` decoration, the registry push adapter (caller display name, session skip), `callsRoutes` registration
- `server/src/ws/hub.ts`: `isSessionViewing(sessionId)` (onAttach after hello already existed from 03-01)
- `server/src/calls/registry.ts`: `push` option, invite -> `notifyCall`, cancelled/no-answer while ringing -> `notifyMissed`, ring-on-attach, `statusFor`
- `server/src/calls/routes.ts`: `GET /api/calls/:id`
- `web/public/sw.js`: call push branch and call-aware notificationclick
- `web/lib/chat/events.ts`, `web/lib/chat/push.ts`: `OPEN_CALL_EVENT` and its bridge
- `web/lib/call/store.ts`: repeated-ring guard, `clearNotifications` on incoming and on end, `checkCall`, toast id per call
- `web/components/app/call-provider.tsx`: `?call=` / `?missed=` handling and the `OPEN_CALL_EVENT` listener
- `server/test/call-push.test.ts` (new), `server/test/sw.test.ts`: every behavior case
- `scripts/smoke-calls.mjs`: `loggedInContext` / `newAppPage` helpers, scenarios `ring-on-open` and `stale`

## Decisions Made

- Per-session suppression for the call push (research A1, still flagged): a phone that shows the in-app ring gets no heads-up, and the other phone still gets one. Switching to push-all is a one-line change in the app.ts adapter's skip predicate.
- The missed push uses the same session skip, because the phone that is open already saw the ring end.
- The SW tap URL must equal one of the two links the push handler built. Everything else opens `/`.
- Missed-call toasts are deduplicated per call id.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] The stale scenario cancelled before the invite reached the server**
- **Found during:** Task 2 (first `smoke-calls.sh ring-on-open stale` run)
- **Issue:** the caller's "Ringing…" appears before the invite is sent, because the ICE servers are fetched first. Cancelling right away meant the server never knew the call, so Bob's `GET /api/calls/:id` answered 404 and no toast showed.
- **Fix:** before cancelling, the scenario polls `GET /api/calls/<id>` from Ada's page until it answers 200. This is a test-only race; the app behaves correctly, since an unknown call shows nothing.
- **Files modified:** scripts/smoke-calls.mjs
- **Verification:** `smoke-calls.sh ring-on-open stale` and the full eleven-scenario run all pass.
- **Committed in:** 1741eb7

**2. [Test detail] Ring timeouts in call-push.test.ts**
- The no-answer missed-push case uses `ringTimeoutMs: 300` as planned. The other describes use 500 ms or 5 s, so cancel, decline, accept, busy and glare cases cannot turn into a no-answer under suite load. Each describe gets its own app, which also keeps Alice under the 10-invite flood limit.

**3. [Process] Commits on master**
- The orchestrator dispatched this plan sequentially on `master` and asked for normal commits, the same as 03-01. No ref rewriting was done.

---

**Total deviations:** 3 (1 test-race bug, 1 test detail, 1 process note)
**Impact on plan:** none. Every planned behavior, test, scenario and the deploy are in place.

## Issues Encountered

None beyond the deviations above.

## Known Stubs

None.

## Threat Flags

None. The new surface (call push payloads, the SW deep link, `GET /api/calls/:id`) is the one in the plan's threat model, and each mitigation is in place:
- T-03-08: the payload carries only the name, fixed copy, id and kind; the exact payload is asserted in tests.
- T-03-09: requireUser, uuid validation, party-only `statusFor`, 404 for everything else, no-store, 60/min per IP.
- T-03-10: the SW builds links only from a uuid id, the tap URL must match exactly, and the client re-validates with `CallId` and uses replaceState.
- T-03-11: a push is sent only for a ringing invite; busy, glare and rate-limited invites send none.
- T-03-12: stored endpoints are reused; logs carry only counts and the call id, and tests assert that no endpoint path or key appears.
- T-03-SC: no package was installed.

## User Setup Required

None. No external service configuration is required.

## Next Phase Readiness

- 03-03 (video and in-call controls) can reuse `callPushBody("video", ...)`, which is already wired. Video invites already push "🎥 Incoming video call".
- 03-04 device UAT should check on the real iPhone and Pixel (coverage D6): the lock-screen incoming push, a tap from a killed app reaching the incoming screen through ring-on-attach, the missed push replacing the ring, and the tray clearing when duet opens.
- The flagged items stay open: A1 (push-all vs. skip viewing sessions), and a phone that rang by push while another device answered keeps its "Incoming call" notification until duet opens there.

## Self-Check: PASSED

- Created files exist on disk: server/src/calls/routes.ts, server/test/call-push.test.ts and .planning/phases/03-voice-video-calls/.tdd/03-02-task2-red.json.
- Commits 98433dd, 39e1261 and 1741eb7 are ancestors of HEAD (3 commits since plan_head_before).
- Plan verification was re-run after the last code commit. Server suite: 356 passed / 1 skipped. `npm run typecheck` is clean and `check-preset.sh` prints "preset ok". `smoke-calls.sh ring-on-open stale` passes, as do all 11 scenarios. `smoke-chat.sh send` is ok. After the deploy, the container is healthy, smoke-public is ok and live-db is ok.
- Acceptance greps: CALL_PUSH_TTL_SECONDS in sender.ts 3, duet-call in sw.js 1, addEventListener in sw.js 4, open-call in sw.js 2, OPEN_CALL_EVENT across the three client files >= 3, no-store in calls/routes.ts 1.

---
*Phase: 03-voice-video-calls*
*Completed: 2026-10-16*
