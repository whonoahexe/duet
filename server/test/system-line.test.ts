import { describe, expect, it } from "vitest"
import {
  callLineText,
  callOutcome,
  countsAsUnread,
  leadLabel,
  messageLabel,
  messageTypeLabel,
  reminderLineText,
  reminderWho,
  type CallEndReason,
  type MessageDto,
} from "@duet/shared"

/** QT-nw9-call-lines / QT-nw9-call-unread / QT-nw9-reminder-fire: the shared system-line helpers. */

const ALICE = "11111111-1111-4111-8111-111111111111"
const BOB = "22222222-2222-4222-8222-222222222222"
const NAMES = { [ALICE]: "Alice Test", [BOB]: "Bob Test" }

function msg(patch: Partial<MessageDto>): MessageDto {
  return {
    seq: 1,
    id: "00000000-0000-4000-8000-000000000001",
    senderId: ALICE,
    kind: "text",
    body: "hi",
    createdAt: 1_700_000_000_000,
    updatedSeq: 1,
    replyTo: null,
    attachments: [],
    reactions: [],
    call: null,
    reminder: null,
    ...patch,
  }
}

describe("callOutcome", () => {
  it("an answered call is completed after a hangup and dropped after anything else", () => {
    expect(callOutcome(true, "hangup")).toBe("completed")
    for (const r of ["dropped", "failed", "declined", "cancelled", "no-answer", "busy"] as CallEndReason[]) {
      expect(callOutcome(true, r)).toBe("dropped")
    }
  })

  it("a ring is missed (cancelled, no-answer), declined, failed (WR-08), or leaves no line (dropped WR-09, busy)", () => {
    expect(callOutcome(false, "cancelled")).toBe("missed")
    expect(callOutcome(false, "no-answer")).toBe("missed")
    expect(callOutcome(false, "declined")).toBe("declined")
    expect(callOutcome(false, "failed")).toBe("failed")
    expect(callOutcome(false, "dropped")).toBeNull()
    expect(callOutcome(false, "busy")).toBeNull()
  })
})

describe("callLineText", () => {
  it("answered calls show the kind and duration", () => {
    expect(callLineText({ kind: "voice", outcome: "completed", durationMs: 224_000 }, ALICE, BOB)).toEqual({
      text: "Voice call · 3:44",
      missed: false,
    })
    expect(callLineText({ kind: "video", outcome: "completed", durationMs: 725_000 }, ALICE, ALICE)).toEqual({
      text: "Video call · 12:05",
      missed: false,
    })
  })

  it("a missed call is 'No answer' for the caller and a highlighted 'Missed … call' for the callee", () => {
    expect(callLineText({ kind: "voice", outcome: "missed", durationMs: 0 }, ALICE, ALICE)).toEqual({ text: "No answer", missed: false })
    expect(callLineText({ kind: "voice", outcome: "missed", durationMs: 0 }, ALICE, BOB)).toEqual({
      text: "Missed voice call",
      missed: true,
    })
    expect(callLineText({ kind: "video", outcome: "missed", durationMs: 0 }, ALICE, BOB)).toEqual({
      text: "Missed video call",
      missed: true,
    })
  })

  it("declined, dropped and failed", () => {
    expect(callLineText({ kind: "voice", outcome: "declined", durationMs: 0 }, ALICE, BOB).text).toBe("Declined")
    expect(callLineText({ kind: "voice", outcome: "declined", durationMs: 0 }, ALICE, ALICE).text).toBe("Declined")
    expect(callLineText({ kind: "voice", outcome: "dropped", durationMs: 80_000 }, ALICE, BOB).text).toBe("Call dropped · 1:20")
    expect(callLineText({ kind: "video", outcome: "failed", durationMs: 0 }, ALICE, BOB).text).toBe("Couldn't connect")
  })
})

describe("reminderWho", () => {
  it("your own reminder: for you, for the other, for both", () => {
    expect(reminderWho(ALICE, ALICE, ALICE, NAMES)).toBe("for you")
    expect(reminderWho(ALICE, BOB, ALICE, NAMES)).toBe("for Bob Test")
    expect(reminderWho(ALICE, null, ALICE, NAMES)).toBe("for both of you")
  })

  it("the other person's reminder: from them, from them for both, for themselves", () => {
    expect(reminderWho(ALICE, BOB, BOB, NAMES)).toBe("from Alice Test")
    expect(reminderWho(ALICE, null, BOB, NAMES)).toBe("from Alice Test · for both of you")
    expect(reminderWho(ALICE, ALICE, BOB, NAMES)).toBe("for Alice Test")
  })

  it("falls back to Someone for an unknown name", () => {
    expect(reminderWho(ALICE, BOB, BOB, {})).toBe("from Someone")
  })
})

describe("leadLabel and reminderLineText", () => {
  it("labels heads-up leads", () => {
    expect(leadLabel(15)).toBe("15 min")
    expect(leadLabel(60)).toBe("1 hour")
    expect(leadLabel(120)).toBe("2 hours")
  })

  it("builds the reminder line", () => {
    const water = msg({ kind: "reminder", body: "Drink water", reminder: { forUserId: BOB, leadMinutes: null } })
    expect(reminderLineText(water, BOB, NAMES)).toBe("Drink water · from Alice Test")
    expect(reminderLineText(water, ALICE, NAMES)).toBe("Drink water · for Bob Test")
    const meeting = msg({ kind: "reminder", body: "Meeting", reminder: { forUserId: ALICE, leadMinutes: 15 } })
    expect(reminderLineText(meeting, ALICE, NAMES)).toBe("Meeting · in 15 min · for you")
    const hour = msg({ kind: "reminder", body: "Meeting", reminder: { forUserId: null, leadMinutes: 60 } })
    expect(reminderLineText(hour, BOB, NAMES)).toBe("Meeting · in 1 hour · from Alice Test · for both of you")
  })
})

describe("countsAsUnread (QT-nw9-call-unread)", () => {
  it("never counts your own messages", () => {
    expect(countsAsUnread(msg({}), ALICE)).toBe(false)
    expect(countsAsUnread(msg({ kind: "call", body: null, call: { kind: "voice", outcome: "missed", durationMs: 0 } }), ALICE)).toBe(false)
  })

  it("counts the peer's text, media, voice and missed calls", () => {
    expect(countsAsUnread(msg({}), BOB)).toBe(true)
    expect(countsAsUnread(msg({ kind: "media" }), BOB)).toBe(true)
    expect(countsAsUnread(msg({ kind: "voice" }), BOB)).toBe(true)
    expect(countsAsUnread(msg({ kind: "call", body: null, call: { kind: "voice", outcome: "missed", durationMs: 0 } }), BOB)).toBe(true)
  })

  it("never counts the peer's other call lines or any reminder line", () => {
    for (const outcome of ["completed", "declined", "dropped", "failed"] as const) {
      expect(countsAsUnread(msg({ kind: "call", body: null, call: { kind: "voice", outcome, durationMs: 0 } }), BOB)).toBe(false)
    }
    expect(countsAsUnread(msg({ kind: "reminder", body: "x", reminder: { forUserId: BOB, leadMinutes: null } }), BOB)).toBe(false)
  })
})

describe("labels for the new kinds", () => {
  it("messageTypeLabel and messageLabel say Call and Reminder, never empty", () => {
    expect(messageTypeLabel({ kind: "call", attachments: [] })).toBe("Call")
    expect(messageTypeLabel({ kind: "reminder", attachments: [] })).toBe("Reminder")
    expect(messageLabel({ kind: "call", body: null, attachments: [] })).toBe("Call")
    expect(messageLabel({ kind: "reminder", body: "Drink water", attachments: [] })).toBe("Reminder")
  })
})
