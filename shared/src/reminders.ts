import { z } from "zod"
import { codePointLength, isBlankBody } from "./chat-logic"
import { leadLabel } from "./system-line"

/**
 * Reminders contract (QT-nw9-reminder-store, QT-nw9-reminder-fire). Reminders are shared: both
 * people see every reminder and either may manage it; the creator stays the "from" person. Every time
 * is India time. Request bodies are strict, DTOs plain z.object (like chat.ts).
 */

/** India has no DST, so IST is a fixed UTC+05:30 and no tz library is needed. */
export const IST_OFFSET_MS = 330 * 60 * 1000
/** For client-side formatting (Intl.DateTimeFormat timeZone). */
export const IST_TIME_ZONE = "Asia/Kolkata"
/** Longest title, in code points. */
export const REMINDER_TITLE_MAX = 100
/** T-nw9-05: a recurring reminder fires at most every 5 minutes... */
export const REMINDER_MIN_EVERY_MINUTES = 5
/** ...and at least once a day. */
export const REMINDER_MAX_EVERY_MINUTES = 1440
/** The heads-up choices of a one-time reminder, in minutes. */
export const REMINDER_LEADS = [15, 60] as const
/** T-nw9-05: at most this many reminders in total. */
export const REMINDER_MAX_COUNT = 100
/** After downtime an occurrence still fires when it is at most this late; older ones are skipped. */
export const REMINDER_LATE_GRACE_MS = 5 * 60 * 1000
/** A reminder push is worthless hours later: the push service drops it after 5 minutes. */
export const REMINDER_PUSH_TTL_SECONDS = 300

const DAY_MS = 24 * 60 * 60 * 1000

/** "HH:MM", 00:00 to 23:59. */
export const HhMm = z.string().regex(/^([01][0-9]|2[0-3]):[0-5][0-9]$/)

/** "YYYY-MM-DD", a real calendar date (2026-02-30 is not). */
export const IsoDate = z
  .string()
  .regex(/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/)
  .refine((v) => {
    const [y, m, d] = v.split("-").map(Number)
    const t = new Date(Date.UTC(y, m - 1, d))
    return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d
  }, "invalid date")

/** Day of the week in IST, Sunday = 0. */
export const Weekday = z.number().int().min(0).max(6)

const recurringShape = {
  kind: z.literal("recurring"),
  everyMinutes: z.number().int().min(REMINDER_MIN_EVERY_MINUTES).max(REMINDER_MAX_EVERY_MINUTES),
  /** Active window start, inclusive. */
  from: HhMm,
  /** Active window end, inclusive (a slot exactly at `until` fires). */
  until: HhMm,
  /** Allowed weekdays (IST, Sunday = 0). */
  days: z.array(Weekday).max(7),
}

const onceShape = {
  kind: z.literal("once"),
  date: IsoDate,
  time: HhMm,
  /** Heads-up before the reminder itself: 15 min, 1 hour, or none. */
  leadMinutes: z.union([z.literal(15), z.literal(60)]).nullable(),
  repeat: z.enum(["none", "daily", "weekly"]),
}

/** A stored rule (DTO side, tolerant of fields a newer server adds). */
export const ReminderRule = z.discriminatedUnion("kind", [z.object(recurringShape), z.object(onceShape)])
export type ReminderRule = z.infer<typeof ReminderRule>
export type RecurringRule = Extract<ReminderRule, { kind: "recurring" }>
export type OnceRule = Extract<ReminderRule, { kind: "once" }>

const StrictReminderRule = z.discriminatedUnion("kind", [z.strictObject(recurringShape), z.strictObject(onceShape)])

function minutesOf(hhmm: string): number {
  const [h, m] = hhmm.split(":").map(Number)
  return h * 60 + m
}

/**
 * POST /api/reminders and PUT /api/reminders/:id body. The creator always comes from the session.
 * forUserId null means both people (the server checks a non-null id is a real user, T-nw9-07).
 */
export const ReminderBody = z
  .strictObject({
    title: z.string().max(REMINDER_TITLE_MAX * 8),
    forUserId: z.uuid().nullable(),
    rule: StrictReminderRule,
  })
  .superRefine((b, ctx) => {
    if (isBlankBody(b.title)) ctx.addIssue({ code: "custom", path: ["title"], message: "blank" })
    else if (codePointLength(b.title.trim()) > REMINDER_TITLE_MAX) {
      ctx.addIssue({ code: "custom", path: ["title"], message: "too_long" })
    }
    if (b.rule.kind === "recurring") {
      if (minutesOf(b.rule.from) >= minutesOf(b.rule.until)) {
        ctx.addIssue({ code: "custom", path: ["rule", "until"], message: "until_not_after_from" })
      }
      if (b.rule.days.length === 0) ctx.addIssue({ code: "custom", path: ["rule", "days"], message: "no_days" })
      else if (new Set(b.rule.days).size !== b.rule.days.length) {
        ctx.addIssue({ code: "custom", path: ["rule", "days"], message: "duplicate" })
      }
    }
  })
export type ReminderBody = z.infer<typeof ReminderBody>

/** PATCH /api/reminders/:id body: pause or re-arm. */
export const ReminderEnabledBody = z.strictObject({ enabled: z.boolean() })
export type ReminderEnabledBody = z.infer<typeof ReminderEnabledBody>

export const ReminderDto = z.object({
  id: z.uuid(),
  creatorId: z.uuid(),
  /** null means both people. */
  forUserId: z.uuid().nullable(),
  title: z.string(),
  rule: ReminderRule,
  /** Off = paused, or a finished one-time reminder (shown as Done). */
  enabled: z.boolean(),
  /** Epoch ms of the next firing, null when nothing is scheduled. */
  nextAt: z.number().int().nullable(),
  /** Heads-up minutes of the next firing, null when it is the reminder itself. */
  nextLeadMinutes: z.number().int().nullable(),
  /** Epoch ms. */
  createdAt: z.number().int(),
})
export type ReminderDto = z.infer<typeof ReminderDto>

export const RemindersResponse = z.object({ reminders: z.array(ReminderDto) })
export type RemindersResponse = z.infer<typeof RemindersResponse>

export const ReminderResponse = z.object({ reminder: ReminderDto })
export type ReminderResponse = z.infer<typeof ReminderResponse>

/** Epoch ms of an IST date and time ("2026-10-21", "16:00" -> 10:30 UTC). */
export function istToEpoch(date: string, time: string): number {
  const [y, mo, d] = date.split("-").map(Number)
  const [h, mi] = time.split(":").map(Number)
  return Date.UTC(y, mo - 1, d, h, mi) - IST_OFFSET_MS
}

/** The IST calendar date, "HH:MM" time, weekday (Sunday = 0) and minute of the day of `ms`. */
export function istParts(ms: number): { date: string; time: string; weekday: number; minuteOfDay: number } {
  const d = new Date(ms + IST_OFFSET_MS)
  const pad = (n: number) => String(n).padStart(2, "0")
  const h = d.getUTCHours()
  const m = d.getUTCMinutes()
  return {
    date: `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`,
    time: `${pad(h)}:${pad(m)}`,
    weekday: d.getUTCDay(),
    minuteOfDay: h * 60 + m,
  }
}

/** One firing: when, and the heads-up minutes (null for the reminder itself). */
export interface ReminderEvent {
  at: number
  leadMinutes: number | null
}

/**
 * The earliest firing strictly after `after`, or null when the rule never fires again.
 * Recurring: on allowed IST weekdays, from, from + every, ... up to until inclusive (8 days are
 * searched, which always covers a week). Once: the occurrence base + k * step (a day for daily, a week
 * for weekly, only k = 0 for none), each preceded by its heads-up when one is set.
 */
export function nextOccurrence(rule: ReminderRule, after: number): ReminderEvent | null {
  if (rule.kind === "recurring") {
    const p = istParts(after)
    const dayStart = istToEpoch(p.date, "00:00")
    const from = minutesOf(rule.from)
    const until = minutesOf(rule.until)
    for (let i = 0; i < 8; i++) {
      if (!rule.days.includes((p.weekday + i) % 7)) continue
      const start = dayStart + i * DAY_MS
      for (let m = from; m <= until; m += rule.everyMinutes) {
        const at = start + m * 60_000
        if (at > after) return { at, leadMinutes: null }
      }
    }
    return null
  }
  const base = istToEpoch(rule.date, rule.time)
  const step = rule.repeat === "daily" ? DAY_MS : rule.repeat === "weekly" ? 7 * DAY_MS : 0
  const first = step === 0 ? 0 : Math.max(0, Math.floor((after - base) / step))
  const last = step === 0 ? 0 : first + 2
  let best: ReminderEvent | null = null
  for (let k = first; k <= last; k++) {
    const occ = base + k * step
    const candidates: ReminderEvent[] = []
    if (rule.leadMinutes !== null) candidates.push({ at: occ - rule.leadMinutes * 60_000, leadMinutes: rule.leadMinutes })
    candidates.push({ at: occ, leadMinutes: null })
    for (const c of candidates) if (c.at > after && (best === null || c.at < best.at)) best = c
  }
  return best
}

/**
 * The reminder push (text-only, so it uses the emoji): title "⏰ Drink water", body "Reminder" or
 * "In 15 min", plus " · from Alice" when the recipient is not the creator. The title is the
 * reminder's point and Web Push payloads are encrypted to the device (T-nw9-04).
 */
export function reminderPushText(
  r: { title: string; leadMinutes: number | null },
  who: { recipientIsCreator: boolean; creatorName: string },
): { title: string; body: string } {
  const head = r.leadMinutes !== null ? `In ${leadLabel(r.leadMinutes)}` : "Reminder"
  return { title: `⏰ ${r.title}`, body: who.recipientIsCreator ? head : `${head} · from ${who.creatorName}` }
}
