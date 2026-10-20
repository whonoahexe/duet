---
created: 2026-10-20T12:09:13.550Z
title: Show calls in chat history and add reminders
area: chat
severity: minor
order: 5
files:
  - server/src/db/schema.ts
  - server/src/calls/registry.ts
  - server/src/push/sender.ts
  - web/components/app/message-row.tsx
notes:
  - .planning/notes/2026-10-20-calls-in-chat-history.md
  - .planning/notes/2026-10-20-reminders.md
---

## Problem

Calls leave no trace in the chat (only server logs), and there is no way to set reminders for ourselves or each other.

## Solution

Both use a new centred system line in the chat (shared design, one migration for new message kinds). Calls: on call end the server inserts a "call" message — "Voice call · 3:44", "No answer" / "Missed voice call" (highlighted, counts as unread), "Declined", "Call dropped · 1:20"; tap to call back; glare-merged calls give one line. Reminders: recurring (every N min/h inside an active window, optional weekdays, pausable) and one-off (date/time, optional heads-up, optional daily/weekly repeat); target me, the other person, or both; shown in chat when they involve the other person, own ones notification-only; reminders table + in-process scheduler (~30 s tick) sending through the existing web-push sender, late only within a few minutes after downtime; in-app display when push is suppressed; IST; managed from a "Reminders" ⋮ menu item. No notification action buttons.
