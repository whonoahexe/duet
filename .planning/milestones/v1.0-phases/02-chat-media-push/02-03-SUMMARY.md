---
phase: 02-chat-media-push
plan: 03
subsystem: push
tags: [web-push, vapid, service-worker, fastify, zod, react, shadcn, base-ui, playwright]

requires:
  - phase: 02-chat-media-push
    provides: "02-01: app.chatEvents.onMessageCreated, hub.isViewing (45 s presence), messageLabel/truncateGraphemes, OPEN_CHAT_EVENT, push_subscriptions table (session cascade), drawer component, smoke-chat harness with SMOKE_SCRIPT; 02-02: read_state written by POST /api/read (unread count in the push title)"
provides:
  - "deploy/vapid-keys.sh: idempotent VAPID pair create/reuse into the env file (never prints a key)"
  - "VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY (set together) / VAPID_SUBJECT (https: or mailto:, default the https APP_ORIGIN) in config"
  - "shared/src/push.ts: PushSubscriptionBody, VapidKeyResponse, PushTestResponse, PUSH_TOPIC_CHAT, PUSH_TOPIC_TEST, PushPayload"
  - "server/src/push/sender.ts: createPushSender (notifyMessage, sendTest, saveSubscription), isAllowedPushEndpoint, buildPayload"
  - "server/src/push/routes.ts: GET /api/push/vapid-public-key, POST /api/push/subscriptions, POST /api/push/test, chatEvents listener with isViewing suppression"
  - "AppDeps.webPushSend; boot log push_config; log events push_sent, push_suppressed, push_failed, push_subscribed, push_test"
  - "web/public/sw.js push + notificationclick handlers (no fetch listener)"
  - "web/lib/platform.ts (isIos, isStandalone), web/lib/chat/push.ts (getPushState, prepare, enablePush, sendTestPush, syncSubscription, clearNotifications, bridgeServiceWorkerMessages, blockedInstructions)"
  - "A2hsGuide, NotificationsCard, NotificationsDrawer; header menu Notifications item; page a2hs state"
  - "scripts/smoke-onboarding.mjs scenarios a2hs and drawer; smoke-public vapid-key 401"
  - "Owner approval of sharp@0.35.4 for plan 02-04"
affects: [02-04, 02-05, 03]

actuals:
  tokens: 20400
  tasks: 3
  commits: 2
plan_head_before: ae1fc5545145608b32904153060c5b903d413ccb
plan_head_after: f309cbe15b305d2a52944cbe35187ea57045a32e

tech-stack:
  added: ["web-push 3.6.7", "@types/web-push 3.6.4 (dev)"]
  patterns:
    - "Push suppression is decided on the server (hub.isViewing) before sending; the service worker shows a notification on every path"
    - "External push send injected through AppDeps (webPushSend), like the TURN fetch"
    - "Subscriptions upsert by endpoint and bind to the current session, so logout cascades them away"
    - "Service worker tested in node:vm with a fake self"

key-files:
  created:
    - deploy/vapid-keys.sh
    - shared/src/push.ts
    - server/src/push/sender.ts
    - server/src/push/routes.ts
    - server/test/push.test.ts
    - server/test/sw.test.ts
    - web/lib/platform.ts
    - web/lib/chat/push.ts
    - web/components/app/notifications-card.tsx
    - web/components/app/notifications-drawer.tsx
    - web/components/app/a2hs-guide.tsx
    - scripts/smoke-onboarding.mjs
  modified:
    - .env.example
    - server/package.json
    - package-lock.json
    - server/src/config.ts
    - server/src/app.ts
    - shared/src/index.ts
    - server/test/helpers.ts
    - web/public/sw.js
    - web/components/app/shell.tsx
    - web/app/page.tsx
    - scripts/smoke-public.sh
    - README.md

key-decisions:
  - "The push body is cut further (120, 60, 30... graphemes) until the JSON payload is at most 3072 bytes; the title is capped at 60 graphemes (Apple's 4 KB limit)"
  - "enablePush replaces an existing subscription made with a different VAPID key"
  - "POST /api/push/subscriptions is limited to 30/min per client IP; POST /api/push/test to 10/min"
  - "The notifications card shows only in the installed app when the state is off or blocked; the drawer shows 'Notifications are blocked' plus the platform instructions when blocked"
  - "Owner approved sharp@0.35.4 for plan 02-04 (reply: \"approved\")"

patterns-established:
  - "Push logs carry evt, userId, seq, code and endpoint host only; never an endpoint path, key or message body"
  - "Onboarding state is decided after mount (user agent, display-mode, sessionStorage)"

requirements-completed: [NOTF-01, NOTF-02, NOTF-03, SHEL-03]

coverage:
  - id: D1
    description: "A new message pushes one Web Push per saved subscription of a recipient who is not viewing, with the D-13 title/body, TTL 86400, urgency high, topic duet-chat (NOTF-01)"
    requirement: NOTF-01
    verification:
      - kind: integration
        ref: "server/test/push.test.ts#pushes bob's message to alice's saved subscription with the D-13 payload and options"
        status: pass
      - kind: integration
        ref: "server/test/push.test.ts#titles the push with the unread count from 2 and cuts a long body to 120 graphemes + …"
        status: pass
      - kind: integration
        ref: "server/test/push.test.ts#never splits an emoji sequence and keeps the payload under 4 KB"
        status: pass
    human_judgment: false
  - id: D2
    description: "No push while the recipient is viewing the chat; push resumes once hidden (NOTF-03, D-15)"
    requirement: NOTF-03
    verification:
      - kind: integration
        ref: "server/test/push.test.ts#suppresses while alice's app is visible and pushes again once it is hidden"
        status: pass
    human_judgment: false
  - id: D3
    description: "Service worker always shows a notification (malformed/empty payloads, getNotifications failure), collapses into one, and a tap focuses the window with open-chat or opens / (NOTF-02, D-14)"
    requirement: NOTF-02
    verification:
      - kind: unit
        ref: "server/test/sw.test.ts (10 cases)"
        status: pass
    human_judgment: false
  - id: D4
    description: "Subscriptions: SSRF host allowlist, strict body, 401/403, upsert, logout cascade, 404/410 pruning, push_failed logs code + host only (T-02-14, T-02-15, T-02-16)"
    requirement: NOTF-01
    verification:
      - kind: integration
        ref: "server/test/push.test.ts#POST /api/push/subscriptions validation (T-02-14)"
        status: pass
      - kind: integration
        ref: "server/test/push.test.ts#cascades the subscription away with the session, so later messages push nothing"
        status: pass
      - kind: integration
        ref: "server/test/push.test.ts#deletes the subscription on 410 and keeps it on 500, logging only code and host"
        status: pass
    human_judgment: false
  - id: D5
    description: "Test push to this session only, {sent: 0} without subscriptions, 10/min limit; iOS Add to Home Screen guide before the tiles; Notifications drawer from the header menu (SHEL-03)"
    requirement: SHEL-03
    verification:
      - kind: integration
        ref: "server/test/push.test.ts#POST /api/push/test (SHEL-03)"
        status: pass
      - kind: e2e
        ref: "SMOKE_SCRIPT=scripts/smoke-onboarding.mjs bash scripts/smoke-chat.sh (a2hs, drawer)"
        status: pass
    human_judgment: false
  - id: D6
    description: "Idempotent VAPID key script: created then reused, never prints a key"
    verification:
      - kind: other
        ref: "bash deploy/vapid-keys.sh && bash deploy/vapid-keys.sh | grep -q 'vapid-keys: reused'"
        status: pass
    human_judgment: false
  - id: D7
    description: "Real-device push: notifications arrive on the closed iPhone and Pixel, collapse to one titled '{name} · n new messages', tap opens the chat, none while viewing; the guide steps match Safari; Enable -> Allow -> test push arrives"
    verification: []
    human_judgment: true
    rationale: "Needs plan 02-04's deploy and the two physical phones. iOS collapse via close-before-show, Apple's acceptance of per-send VAPID JWTs and the https subject are assumptions (research A1, A9, A12) only device UAT can confirm"

duration: 27min (2026-10-11T08:20Z to 08:47Z, then the owner's sharp approval)
completed: 2026-10-12
status: complete
---

# Phase 2 Plan 03: Push Notifications and Onboarding Summary

**Push for new messages using web-push with VAPID: no push while the recipient is viewing (server-side isViewing), a collapsed "{name} · n new messages" notification, and a tap that opens the chat. Onboarding covers the iOS Add to Home Screen guide, the "Turn on notifications" card with a test push, and a Notifications drawer in the header menu. The owner approved sharp@0.35.4 for plan 02-04.**

## Performance

- **Duration:** about 27 min of execution (2026-10-11T08:20:45Z to 08:47Z). After that the plan waited at the sharp gate until the owner replied.
- **Tasks:** 3. Task 1 was the tracer, Task 2 was auto, Task 3 was the blocking-human gate.
- **Files modified:** 24.

## Accomplishments
- **Server sends pushes.**
  - Every created message is pushed to the other person's saved subscriptions, unless `hub.isViewing` says they are looking at the chat right now (logged as `push_suppressed`).
  - Title: the sender's name, or "{name} · {n} new messages" when 2 or more of their messages are unread (counted from `read_state`).
  - Body: the message label, cut to 120 graphemes plus "…", with the whole payload kept under 3 KB.
  - Send options: TTL 86400, urgency high, topic `duet-chat`, 10 s timeout.
  - A 404 or 410 from the push service deletes that subscription. Other failures log only the status code and the endpoint host.
- **Subscriptions are protected.**
  - They are accepted only for FCM, `*.push.apple.com`, Mozilla and WNS endpoints over https, at most 2048 characters, with a strict body.
  - Each one is upserted by endpoint and bound to the session that saved it, so logging out removes it.
- **Service worker.** It shows a notification for every push. A missing or malformed payload shows "duet" / "New message", and a failure to list open notifications still shows. It closes open duet notifications before showing the new one, because iOS ignores `tag`. A tap focuses the open window and posts `open-chat`, or opens `/`. It still has no fetch listener.
- **Onboarding.**
  - iOS Safari shows the full-screen guide before the login tiles. "Continue in Safari for now" skips it for this browser session.
  - The installed app shows the notifications card while push is off or blocked. It has three states: off (Enable), on (Send test notification and Hide card), and blocked (platform instructions, no button).
  - The header menu has a Notifications drawer that shows the state with the matching action.
  - Every launch re-saves the current subscription, because iOS drops subscriptions silently. The notification tray clears when the chat becomes visible.
- **Test push.** `POST /api/push/test` pushes "duet" / "Test notification. You're all set." to this session's subscriptions only, limited to 10 a minute per IP.

## Task Commits

1. **Task 1: tracer, a new message pushes to the other phone** - `6b6f882` (feat)
2. **Task 2: onboarding, test push and drawer** - `f309cbe` (feat)
3. **Task 3: sharp@0.35.4 legitimacy gate** - no commit (approval only; nothing installed)

**Plan metadata:** the docs commit for this SUMMARY

## Owner Decision (Task 3, package legitimacy gate)

Owner reply, verbatim: "approved"

What was checked before asking (read-only `npm view`):
- sharp@0.35.4 has a single maintainer, `lovell <npm@lovell.info>`, and its repository is github.com/lovell/sharp.
- 0.35.4 was published 2026-08-26 and 0.35.5 on 2026-09-27.
- The prebuilt `@img/sharp-linux-x64@0.35.4` and `@img/sharp-libvips-linux-x64@1.3.3` are also maintained by lovell.
- There are no install, preinstall or postinstall scripts.

Plan 02-04 may now run `npm install -w server sharp@0.35.4 --save-exact`. This plan installed nothing beyond web-push and @types/web-push.

## Files Created/Modified
- `deploy/vapid-keys.sh`, `.env.example`: VAPID pair create/reuse and documentation of the variable names
- `server/src/config.ts`, `server/src/app.ts`: VAPID config, `webPushSend` dep, `push_config` boot log, pushRoutes registration
- `shared/src/push.ts`: push schemas and constants
- `server/src/push/sender.ts`, `server/src/push/routes.ts`: sender, routes and the chatEvents listener
- `server/test/helpers.ts`, `server/test/push.test.ts`, `server/test/sw.test.ts`: `vapidTestEnv()`, 15 push cases, 10 service-worker cases
- `web/public/sw.js`: push and notificationclick handlers
- `web/lib/platform.ts`, `web/lib/chat/push.ts`: platform checks and the push client
- `web/components/app/{notifications-card,notifications-drawer,a2hs-guide,shell}.tsx`, `web/app/page.tsx`: onboarding UI
- `scripts/smoke-onboarding.mjs`, `scripts/smoke-public.sh`, `README.md`: e2e, public 401 check, docs

## Decisions Made
See `key-decisions` in the frontmatter.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 2 - Missing critical] Payload byte cap**
- **Found during:** Task 1
- **Issue:** 120 graphemes of long emoji ZWJ sequences can exceed Apple's 4 KB payload limit, which would get the push rejected.
- **Fix:** `buildPayload` keeps halving the grapheme budget until the JSON is at most 3072 bytes. The title is capped at 60 graphemes.
- **Files modified:** `server/src/push/sender.ts`
- **Verification:** push.test.ts "never splits an emoji sequence and keeps the payload under 4 KB"
- **Committed in:** 6b6f882

**2. [Rule 2 - Missing critical] Rate limit on POST /api/push/subscriptions**
- **Found during:** Task 1
- **Issue:** The plan rate-limited only the test endpoint.
- **Fix:** Subscriptions are now limited to 30 a minute per client IP, the same as the rtc routes.
- **Files modified:** `server/src/push/routes.ts`
- **Committed in:** 6b6f882

**3. [Rule 2 - Missing critical] Subscription made with a different VAPID key**
- **Found during:** Task 1
- **Issue:** `getSubscription()` can return a subscription made with an older applicationServerKey. That subscription can never receive this server's pushes.
- **Fix:** `enablePush` compares the keys and, when they differ, unsubscribes and subscribes again.
- **Files modified:** `web/lib/chat/push.ts`
- **Committed in:** 6b6f882

**4. [Process] Tracer feedback gate**
- **Found during:** Task 1
- **Issue:** The gate's precedence chain stops when a tracer carries a `<human-check>`. This tracer's human-check runs "after plan 02-04 deploys", so it cannot be done mid-plan.
- **Fix:** Re-ran the automated verify (all green) and continued. The device check moves to end-of-phase UAT (coverage D7).

---

**Total deviations:** 3 auto-fixed (missing critical), plus 1 process note.
**Impact on plan:** All three fixes protect delivery or abuse resistance. No contract changed.

## Issues Encountered
- Execution paused once on a rate-limit cut-off during Task 1. The work in progress was re-verified before the first commit.
- Out of scope, not fixed: existing react-hooks lint errors in `shell.tsx` (ConnectionSubline), `page.tsx` (the existing `void load()` effect pattern), `chat-view.tsx` and `call-test.tsx`.
- A read-only `git stash list` was run once by mistake. It changed nothing.

## User Setup Required
None now. The env file already has the VAPID pair (`bash deploy/vapid-keys.sh` reported created, then reused). The keys go live with plan 02-04's deploy. Run `bash scripts/smoke-public.sh` after that deploy: it now expects the vapid-key route to answer 401, and the live server does not have that route yet.

## Next Phase Readiness
- Plan 02-04 can install sharp@0.35.4 (approved) and deploy. The deploy carries the VAPID keys and this plan's push code.
- End-of-phase device UAT on the iPhone and the Pixel (coverage D7):
  - Push arrives while the app is closed.
  - Several messages collapse into one notification.
  - A tap opens the chat.
  - No push arrives while viewing the chat.
  - The guide steps match Safari.
  - The test push arrives.

---
*Phase: 02-chat-media-push*
*Completed: 2026-10-12*

## Self-Check: PASSED
