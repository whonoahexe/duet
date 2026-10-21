import { describe, expect, it } from "vitest"
import {
  ReminderBody,
  istParts,
  istToEpoch,
  nextOccurrence,
  reminderPushText,
  type ReminderRule,
} from "@duet/shared"

/** QT-nw9-reminder-store: IST conversion, the next-occurrence rules and body validation (pure). */

const ist = istToEpoch
const MIN = 60_000
const ALL_DAYS = [0, 1, 2, 3, 4, 5, 6]
const USER = "11111111-1111-4111-8111-111111111111"

function recurring(patch: Partial<Extract<ReminderRule, { kind: "recurring" }>> = {}): ReminderRule {
  return { kind: "recurring", everyMinutes: 120, from: "09:00", until: "22:00", days: ALL_DAYS, ...patch }
}

function once(patch: Partial<Extract<ReminderRule, { kind: "once" }>> = {}): ReminderRule {
  return { kind: "once", date: "2026-10-21", time: "16:00", leadMinutes: null, repeat: "none", ...patch }
}

describe("IST conversion", () => {
  it("istToEpoch is UTC+05:30 and istParts reverses it", () => {
    const t = istToEpoch("2026-10-21", "16:00")
    expect(t).toBe(Date.UTC(2026, 9, 21, 10, 30))
    expect(istParts(t)).toEqual({ date: "2026-10-21", time: "16:00", weekday: 3, minuteOfDay: 960 })
  })

  it("handles the IST day boundary (00:15 IST is the previous UTC day)", () => {
    const t = istToEpoch("2026-10-22", "00:15")
    expect(t).toBe(Date.UTC(2026, 9, 21, 18, 45))
    expect(istParts(t)).toMatchObject({ date: "2026-10-22", weekday: 4, minuteOfDay: 15 })
  })
})

describe("nextOccurrence: recurring", () => {
  it("every 2 hours 09:00-22:00: the next slot the same day, then 09:00 the next day", () => {
    expect(nextOccurrence(recurring(), ist("2026-10-21", "10:30"))).toEqual({ at: ist("2026-10-21", "11:00"), leadMinutes: null })
    expect(nextOccurrence(recurring(), ist("2026-10-21", "22:30"))).toEqual({ at: ist("2026-10-22", "09:00"), leadMinutes: null })
    expect(nextOccurrence(recurring(), ist("2026-10-21", "06:00"))).toEqual({ at: ist("2026-10-21", "09:00"), leadMinutes: null })
  })

  it("the window end is inclusive", () => {
    expect(nextOccurrence(recurring({ everyMinutes: 60 }), ist("2026-10-21", "21:30"))).toEqual({
      at: ist("2026-10-21", "22:00"),
      leadMinutes: null,
    })
  })

  it("weekdays only: after Friday 22:30 comes Monday 09:00", () => {
    expect(nextOccurrence(recurring({ days: [1, 2, 3, 4, 5] }), ist("2026-10-23", "22:30"))).toEqual({
      at: ist("2026-10-26", "09:00"),
      leadMinutes: null,
    })
  })

  it("is strictly after: an `after` equal to a slot gives the next slot", () => {
    expect(nextOccurrence(recurring(), ist("2026-10-21", "11:00"))?.at).toBe(ist("2026-10-21", "13:00"))
  })
})

describe("nextOccurrence: once", () => {
  it("repeat none, no lead: the time itself, then nothing", () => {
    expect(nextOccurrence(once(), ist("2026-10-21", "12:00"))).toEqual({ at: ist("2026-10-21", "16:00"), leadMinutes: null })
    expect(nextOccurrence(once(), ist("2026-10-21", "16:00"))).toBeNull()
    expect(nextOccurrence(once(), ist("2026-10-22", "16:00"))).toBeNull()
  })

  it("a 15-minute heads-up comes first, then the reminder itself", () => {
    const rule = once({ leadMinutes: 15 })
    expect(nextOccurrence(rule, ist("2026-10-21", "15:40"))).toEqual({ at: ist("2026-10-21", "15:45"), leadMinutes: 15 })
    expect(nextOccurrence(rule, ist("2026-10-21", "15:45"))).toEqual({ at: ist("2026-10-21", "16:00"), leadMinutes: null })
    expect(nextOccurrence(rule, ist("2026-10-21", "16:00"))).toBeNull()
  })

  it("repeat daily and weekly step by a day and a week", () => {
    expect(nextOccurrence(once({ repeat: "daily" }), ist("2026-10-22", "10:00"))).toEqual({
      at: ist("2026-10-22", "16:00"),
      leadMinutes: null,
    })
    expect(nextOccurrence(once({ repeat: "daily" }), ist("2026-10-22", "16:00"))?.at).toBe(ist("2026-10-23", "16:00"))
    expect(nextOccurrence(once({ repeat: "weekly" }), ist("2026-10-21", "16:00"))?.at).toBe(ist("2026-10-28", "16:00"))
    expect(nextOccurrence(once({ repeat: "weekly", leadMinutes: 60 }), ist("2026-10-21", "16:00"))).toEqual({
      at: ist("2026-10-28", "15:00"),
      leadMinutes: 60,
    })
  })

  it("a far-past base with a repeat still finds the next occurrence", () => {
    expect(nextOccurrence(once({ date: "2020-01-01", repeat: "daily" }), ist("2026-10-21", "17:00"))?.at).toBe(
      ist("2026-10-22", "16:00"),
    )
    expect(ist("2026-10-22", "16:00") - ist("2026-10-22", "15:59")).toBe(MIN)
  })
})

describe("ReminderBody validation", () => {
  const ok = { title: "Drink water", forUserId: USER, rule: recurring() }

  it("accepts a recurring and a one-time reminder, and forUserId null (both)", () => {
    expect(ReminderBody.safeParse(ok).success).toBe(true)
    expect(ReminderBody.safeParse({ ...ok, forUserId: null, rule: once({ leadMinutes: 60, repeat: "weekly" }) }).success).toBe(true)
  })

  it.each([
    ["a blank title", { ...ok, title: "   " }],
    ["a 101-code-point title", { ...ok, title: "😀".repeat(101) }],
    ["everyMinutes 4", { ...ok, rule: recurring({ everyMinutes: 4 }) }],
    ["everyMinutes 1441", { ...ok, rule: recurring({ everyMinutes: 1441 }) }],
    ["from equal to until", { ...ok, rule: recurring({ from: "10:00", until: "10:00" }) }],
    ["from after until", { ...ok, rule: recurring({ from: "22:00", until: "09:00" }) }],
    ["no days", { ...ok, rule: recurring({ days: [] }) }],
    ["duplicate days", { ...ok, rule: recurring({ days: [1, 1] }) }],
    ["a day out of range", { ...ok, rule: recurring({ days: [7] }) }],
    ["an invalid date", { ...ok, rule: once({ date: "2026-02-30" }) }],
    ["a bad time", { ...ok, rule: once({ time: "24:00" }) }],
    ["leadMinutes 30", { ...ok, rule: { ...once(), leadMinutes: 30 } }],
    ["an unknown repeat", { ...ok, rule: { ...once(), repeat: "monthly" } }],
    ["an unknown body key", { ...ok, creatorId: USER }],
    ["an unknown rule key", { ...ok, rule: { ...recurring(), extra: 1 } }],
    ["a non-uuid forUserId", { ...ok, forUserId: "bob" }],
  ])("rejects %s", (_name, body) => {
    expect(ReminderBody.safeParse(body).success).toBe(false)
  })

  it("accepts exactly 100 code points", () => {
    expect(ReminderBody.safeParse({ ...ok, title: "😀".repeat(100) }).success).toBe(true)
  })
})

describe("reminderPushText", () => {
  it("titles with the emoji and says who it is from unless it is your own", () => {
    expect(reminderPushText({ title: "Drink water", leadMinutes: null }, { recipientIsCreator: false, creatorName: "Alice Test" })).toEqual({
      title: "⏰ Drink water",
      body: "Reminder · from Alice Test",
    })
    expect(reminderPushText({ title: "Drink water", leadMinutes: null }, { recipientIsCreator: true, creatorName: "Alice Test" })).toEqual({
      title: "⏰ Drink water",
      body: "Reminder",
    })
    expect(reminderPushText({ title: "Meeting", leadMinutes: 15 }, { recipientIsCreator: false, creatorName: "Alice Test" }).body).toBe(
      "In 15 min · from Alice Test",
    )
    expect(reminderPushText({ title: "Meeting", leadMinutes: 60 }, { recipientIsCreator: true, creatorName: "Alice Test" }).body).toBe("In 1 hour")
  })
})
