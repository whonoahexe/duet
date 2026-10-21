import { and, eq, lte } from "drizzle-orm"
import { REMINDER_LATE_GRACE_MS, ReminderRule, nextOccurrence, type ReminderEvent } from "@duet/shared"
import type { Db } from "../db/client"
import { reminders } from "../db/schema"

export type ReminderRow = typeof reminders.$inferSelect

export interface ReminderScheduler {
  /** Boot catch-up tick, then one tick every tickMs (unref'd). */
  start(): void
  /** One synchronous pass over every due reminder. */
  tick(): void
  close(): void
}

export interface ReminderSchedulerOptions {
  db: Db
  log: { info: (obj: object) => void; warn: (obj: object) => void }
  /** Clock, injectable for tests. */
  now?: () => number
  tickMs?: number
  lateGraceMs?: number
  /** Deliver one firing (insert the line, broadcast, push). Errors are logged and never stop the tick. */
  fire: (row: ReminderRow, event: ReminderEvent) => void
}

/** Parse a stored rule; null when the JSON or the shape is bad. */
function parseRule(raw: string): ReminderRule | null {
  try {
    const r = ReminderRule.safeParse(JSON.parse(raw))
    return r.success ? r.data : null
  } catch {
    return null
  }
}

/**
 * The in-process reminder scheduler (QT-nw9-reminder-fire). Every tick fires the enabled reminders
 * whose next_fire_at is due. An occurrence more than lateGraceMs overdue (the server was down) is
 * skipped, and the schedule jumps to the first occurrence that is still inside the grace window or in
 * the future, so a long downtime never replays a backlog (T-nw9-05). A reminder with no further
 * occurrence is switched off (a one-time reminder shows as Done). Each row is handled in its own
 * try/catch and a bad stored rule disables only that row (T-nw9-08). Logs carry ids only, never the
 * title (T-nw9-03).
 */
export function createReminderScheduler({
  db,
  log,
  now = Date.now,
  tickMs = 30_000,
  lateGraceMs = REMINDER_LATE_GRACE_MS,
  fire,
}: ReminderSchedulerOptions): ReminderScheduler {
  let interval: ReturnType<typeof setInterval> | undefined

  function tick(): void {
    const t = now()
    const due = db
      .select()
      .from(reminders)
      .where(and(eq(reminders.enabled, true), lte(reminders.nextFireAt, t)))
      .all()
    for (const row of due) {
      try {
        const rule = parseRule(row.rule)
        if (!rule) {
          db.update(reminders)
            .set({ enabled: false, nextFireAt: null, nextLeadMin: null, updatedAt: new Date(t) })
            .where(eq(reminders.id, row.id))
            .run()
          log.warn({ evt: "reminder_rule_invalid", id: row.id })
          continue
        }
        let event: ReminderEvent | null = row.nextFireAt !== null ? { at: row.nextFireAt, leadMinutes: row.nextLeadMin } : null
        while (event !== null && event.at <= t) {
          const lateMs = t - event.at
          if (lateMs > lateGraceMs) {
            log.info({ evt: "reminder_skipped_late", id: row.id, lateMs })
            event = nextOccurrence(rule, t - lateGraceMs)
            continue
          }
          try {
            fire(row, event)
          } catch {
            log.warn({ evt: "reminder_fire_failed", id: row.id })
          }
          event = nextOccurrence(rule, event.at)
        }
        db.update(reminders)
          .set({
            enabled: event !== null,
            nextFireAt: event?.at ?? null,
            nextLeadMin: event?.leadMinutes ?? null,
            updatedAt: new Date(t),
          })
          .where(eq(reminders.id, row.id))
          .run()
      } catch {
        log.warn({ evt: "reminder_tick_failed", id: row.id })
      }
    }
  }

  return {
    start() {
      tick()
      if (interval === undefined) {
        interval = setInterval(() => {
          try {
            tick()
          } catch {
            log.warn({ evt: "reminder_tick_failed" })
          }
        }, tickMs)
        interval.unref?.()
      }
    },
    tick,
    close() {
      if (interval !== undefined) clearInterval(interval)
      interval = undefined
    },
  }
}
