---
phase: 261021-nw9
plan: 01
subsystem: chat, calls, reminders, push
status: complete
tags: [calls, reminders, system-line, web-push, scheduler, sqlite, pwa]
requires: [261021-5zd]
provides:
  - call lines in chat history (kind "call"), tap to call back, missed calls count as unread
  - reminders (recurring and one-time, IST) with CRUD API, in-process scheduler, push and chat line
  - Menu > Reminders list and form
affects: [server/src/calls/registry.ts, server/src/chat/service.ts, server/src/push/sender.ts, web/public/sw.js, web/components/app/chat-view.tsx]
tech-stack:
  added: []
  patterns:
    - server-written system lines (kinds call/reminder) broadcast without chatEvents (no chat push)
    - fixed UTC+05:30 IST math with no tz library
    - 30 s in-process scheduler with a 5-minute late grace and jump past stale occurrences
key-files:
  created:
    - server/drizzle/0003_calls_reminders.sql
    - server/drizzle/meta/0003_snapshot.json
    - shared/src/system-line.ts
    - shared/src/reminders.ts
    - server/src/reminders/routes.ts
    - server/src/reminders/scheduler.ts
    - web/components/app/system-line.tsx
    - web/components/app/reminders.tsx
    - web/components/app/reminder-form.tsx
    - web/components/ui/toggle.tsx
    - web/components/ui/toggle-group.tsx
    - server/test/system-line.test.ts
    - server/test/call-line.test.ts
    - server/test/reminders-schedule.test.ts
    - server/test/reminders.test.ts
  modified:
    - server/src/db/schema.ts
    - server/drizzle/meta/_journal.json
    - shared/src/chat.ts
    - shared/src/call.ts
    - shared/src/chat-logic.ts
    - shared/src/push.ts
    - shared/src/index.ts
    - server/src/calls/registry.ts
    - server/src/chat/service.ts
    - server/src/app.ts
    - server/src/config.ts
    - server/src/push/sender.ts
    - server/test/helpers.ts
    - server/test/call-registry.test.ts
    - server/test/calls.test.ts
    - server/test/chat.test.ts
    - server/test/chat-logic.test.ts
    - server/test/sw.test.ts
    - web/public/sw.js
    - web/components/app/chat-view.tsx
    - web/components/app/shell.tsx
    - web/lib/api.ts
    - web/lib/chat/store.ts
    - web/lib/chat/realtime.ts
    - scripts/smoke-calls.mjs
    - scripts/smoke-chat.mjs
    - scripts/smoke-chat.sh
decisions:
  - "Commits went to branch gsd/quick-261021-nw9, not master: the executor's protected-branch guard refuses commits on master (git.allow_default_branch_commits is unset). Fast-forward master to finish."
  - "Smoke selectors for the header call buttons are now exact: true, because a call line's aria-label (Call back: Voice call · 3:44) also matches \"Voice call\"."
  - "The reminders GET skips a row whose stored rule no longer parses, and the scheduler switches that row off, so one bad row never breaks the list."
  - "A reminder fire that throws is logged (reminder_fire_failed) and the schedule still advances, so a broken send never repeats every tick."
metrics:
  duration: "about 4 h 50 min wall clock, including a rate-limit pause"
  completed: 2026-10-21
  tasks: 3
  files: 42
actuals:
  tokens: 48621
  tasks: 3
  commits: 4
plan_head_before: b7ce90bb3993ffa8b52eea12ad10d32634fb2cff
plan_head_after: ad938445aa95e3d567ed6f48b74947b2282e7758
---

# Phase 261021-nw9 Plan 01: Calls in chat history and reminders Summary

When a call ends, both chats now show one stored, centred line for it ("Voice call · 3:44", a highlighted "Missed voice call", "Declined", "Call dropped · 1:20", "Couldn't connect"). Tapping the line calls back with the same kind, and a missed call counts as unread. Reminders are new: recurring or one-time, all times in IST, stored in SQLite, fired by a 30 s in-process scheduler. Each firing pushes only to the person or people it is for and shows a system line in both chats; a target who is viewing duet gets a toast instead of the push. They are managed from Menu > Reminders.

## Tasks

| # | Task | Commit |
|---|------|--------|
| 1 | Tracer: call lines (migration 0003, registry onEnded, shared line helpers, SystemLine, unread rules, smoke-calls checks) | 22dfe1b |
| 2 | Reminders server: shared contract and IST rules, /api/reminders CRUD, scheduler, push, sw.js tag | 6e773ff |
| 3 | Reminders UI: toggle-group (shadcn CLI), list and form, in-app toast, smoke-chat scenario | 703f42e |
| - | Fix: smoke-calls glare counts lines only after the chat loaded (found by the full smoke-calls run) | ad93844 |

The tracer gate ran after Task 1, before any expansion. It ran every Task 1 `<verify>` command end to end, including `smoke-calls decline glare`, and all passed.

## What was built

- **Migration 0003** (drizzle-kit generated): five `ALTER TABLE messages ADD` columns (`call_kind`, `call_outcome`, `call_duration_ms`, `reminder_for_user_id`, `reminder_lead_min`), plus `CREATE TABLE reminders` and the index `reminders_due_idx (enabled, next_fire_at)`. The messages table is not rebuilt.
- **Calls.**
  - `callOutcome(answered, reason)` maps an end reason to an outcome. Abandoned while ringing (WR-09) or busy gives no line.
  - The registry's `end()` calls `onEnded` once per call, inside a try/catch that logs `call_line_failed`.
  - app.ts stores the line through `insertCallMessage` and broadcasts `{ t: "msg" }` without chatEvents, so there is no duplicate chat push.
  - Replies to lines are refused with 400 bad_reply, and reactions on them with 404 not_found.
  - The push title's unread count includes only text, media and voice messages plus missed calls.
- **Web line.**
  - `SystemLine` is built on Marker and carries data-seq, data-kind and data-missed. A call line is a button.
  - `buildItems` gives each line its own item. Sent/Read never attaches to a line.
  - `ScrollFollower` uses `countsAsUnread`.
  - `ReadTracker` matches `[data-seq]`, so a missed call is marked read once it scrolls into view.
- **Reminders server.**
  - `shared/src/reminders.ts` holds the strict `ReminderBody` (title, from < until and unique days are checked in a superRefine), `ReminderDto`, `istToEpoch`, `istParts`, `nextOccurrence` and `reminderPushText`.
  - The routes require a session. Either person may manage any reminder.
  - Validation errors: invalid_body (also for an unknown forUserId), in_past, and too_many past 100 reminders.
  - Scheduler:
    - Each tick is synchronous and each row has its own try/catch.
    - An occurrence more than 5 minutes overdue is skipped (`reminder_skipped_late`), and the schedule jumps to `nextOccurrence(rule, t - grace)`.
    - A reminder with no further occurrence is switched off (Done).
  - Pushes go out with TTL 300 s. The reminder title never appears in logs; a test checks this.
- **sw.js.**
  - Reminder notifications are tagged `duet-reminder`, link to `/` and close nothing.
  - A chat push no longer closes an open reminder notification.
  - There are still exactly four listeners.
- **UI.**
  - Menu > Reminders opens a full-screen dialog with Skeleton, error and Empty states. Each row shows the schedule, who it is for and its status ("Next …", "Done" or "Off"), plus a Switch.
  - The form uses Field, Input and ToggleGroup only.
  - `chatStore.announceReminder` toasts only for live WS frames, only for the target, and only while the page is visible.

## Verification

- `npm test`: 32 files, 539 passed, 1 skipped (baseline was 28 files, 468 passed).
- Both typechecks are clean.
- Lint is clean on every new and touched lint-clean file. chat-view.tsx still has 2 errors and shell.tsx 1, the same as at HEAD.
- `check-preset.sh` prints "preset ok". `package-lock.json` and `web/package.json` are unchanged against 6ab3df4.
- `check-live-db.sh` prints "live-db ok", so migration 0003 applies on the real boot path.
- `smoke-calls.sh decline glare` passes, and so does `smoke-chat.sh send reply reminders`. Both ran with a throwaway MEDIA_KEY_FILE.
- Regression check: the full `smoke-calls.sh` run (all 19 scenarios) passes after fix ad93844.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Commits made on a feature branch instead of master**
- **Found during:** the Task 1 commit.
- **Issue:** the executor's pre-commit guard reports master as a protected branch (`git.base-branch --is-protected master` returns true) and refuses to commit there.
- **Fix:** before the first commit, created `gsd/quick-261021-nw9` from master (b7ce90b). All three task commits are on it, and HEAD is left there.
- **To finish:** `git checkout master && git merge --ff-only gsd/quick-261021-nw9` (or set `git.allow_default_branch_commits: true` for future quick tasks).

**2. [Rule 1 - Bug] Smoke selectors broke once call lines existed**
- **Found during:** Task 1 smoke (glare).
- **Issue:** `getByRole("button", { name: "Voice call" })` also matched the line button "Call back: Missed voice call", which is a strict-mode violation.
- **Fix:** every header call-button selector in smoke-calls.mjs now uses `exact: true`.
- **Commit:** 22dfe1b

**3. [Rule 1 - Bug] calls.test.ts ring() read the new msg frame**
- **Issue:** after a call ended, the next `ring()` got the queued `{ t: "msg" }` call line instead of `call.ring`.
- **Fix:** added a `nextCallFrame` helper that skips only `msg` frames. No assertion about call.* frames was weakened.
- **Commit:** 22dfe1b

**4. [Rule 2 - Robustness] Scheduler and list hardening**
- A `fire()` that throws is logged as `reminder_fire_failed` and the schedule still advances, so it never refires every tick.
- The interval callback is wrapped in a try/catch.
- `GET /api/reminders` skips a row whose rule does not parse.
- **Commits:** 6e773ff

**5. [Rule 1 - Bug] The glare smoke counted lines before the chat had loaded**
- **Found during:** the full smoke-calls regression run after Task 3.
- **Issue:** the composer shows while the first page is still loading, so the baseline system-line count could read 0, and the +1 check failed.
- **Fix:** the scenario now waits for the message list or the empty state, plus a 500 ms settle, before counting. The failure message now includes both pages' counts.
- **Commit:** ad93844

**6. Minor shape choice:** `ReminderForm` has no `onCancel` prop. The form view's own Back button and `useBackClose` in `Reminders` return to the list.

## Rollout notes (not deployed, per constraints)

1. Fast-forward master to `gsd/quick-261021-nw9`. Then rebuild and restart the container the usual way (for example `docker compose build duet && docker compose up -d duet`). Confirm that the boot log shows no migrate error and that migration 0003 applied (`server/drizzle/0003_calls_reminders.sql`).
2. **Both phones must fully close and reopen duet once.** An older installed PWA parses MessageDto kinds strictly and cannot read the new `call` / `reminder` messages until it loads the new build. The new sw.js (the duet-reminder tag) also takes effect then.
3. `REMINDER_TICK_MS` is optional (default 30000). Production needs no new env var.
4. Accepted choice (T-nw9-04): **reminder push notifications carry the reminder's title** ("⏰ <title>"). Web Push payloads are encrypted to the device (RFC 8291). Chat pushes stay type-only as before.

## Known Stubs

None.

## Threat Flags

None beyond the plan's threat model. The new endpoints `/api/reminders*` are covered by T-nw9-03, T-nw9-05, T-nw9-06 and T-nw9-07.

## Self-Check: PASSED

All four commits (22dfe1b, 6e773ff, 703f42e, ad93844) are ancestors of HEAD, and every created key file exists.
