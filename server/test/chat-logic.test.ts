import { describe, expect, it } from "vitest"
import {
  mediaLabel,
  mergeMessages,
  messageLabel,
  nextOutboxState,
  truncateGraphemes,
  type AttachmentDto,
  type AttachmentKind,
  type MessageDto,
} from "@duet/shared"

const ALICE = "11111111-1111-4111-8111-111111111111"

function att(kind: AttachmentKind, position: number): AttachmentDto {
  return {
    id: `att${position}`.padEnd(22, "x"),
    kind,
    status: "ready",
    position,
    width: null,
    height: null,
    durationMs: null,
    waveform: null,
    error: null,
  }
}

function msg(seq: number, patch: Partial<MessageDto> = {}): MessageDto {
  return {
    seq,
    id: `00000000-0000-4000-8000-${String(seq).padStart(12, "0")}`,
    senderId: ALICE,
    kind: "text",
    body: `m${seq}`,
    createdAt: 1_700_000_000_000 + seq,
    updatedSeq: seq,
    replyTo: null,
    attachments: [],
    reactions: [],
    ...patch,
  }
}

function media(kinds: AttachmentKind[], body: string | null = null) {
  return { kind: "media" as const, body, attachments: kinds.map((k, i) => att(k, i)) }
}

describe("messageLabel / mediaLabel (D-13)", () => {
  it("labels text, voice, photos, videos and mixed albums", () => {
    expect(messageLabel({ kind: "text", body: "are you home yet?", attachments: [] })).toBe("are you home yet?")
    expect(messageLabel({ kind: "voice", body: null, attachments: [att("audio", 0)] })).toBe("🎤 Voice note")
    expect(messageLabel(media(["image"]))).toBe("📷 Photo")
    expect(messageLabel(media(["image", "image", "image"]))).toBe("📷 3 photos")
    expect(messageLabel(media(["video"]))).toBe("🎥 Video")
    expect(messageLabel(media(["video", "video"]))).toBe("🎥 2 videos")
    expect(messageLabel(media(["image", "video", "image", "video"]))).toBe("📷 4 items")
  })

  it("puts a caption after the media label with ' · '", () => {
    expect(messageLabel(media(["image"], "hi"))).toBe("📷 Photo · hi")
  })

  it("gives the same labels without emoji", () => {
    expect(mediaLabel(["image"], { emoji: false })).toBe("Photo")
    expect(mediaLabel(["image", "image", "image"], { emoji: false })).toBe("3 photos")
    expect(mediaLabel(["video"], { emoji: false })).toBe("Video")
    expect(mediaLabel(["video", "video"], { emoji: false })).toBe("2 videos")
    expect(mediaLabel(["image", "video", "image", "video"], { emoji: false })).toBe("4 items")
    expect(mediaLabel(["audio"], { emoji: false })).toBe("Voice note")
    expect(mediaLabel(["image"], { emoji: true })).toBe("📷 Photo")
  })
})

describe("truncateGraphemes", () => {
  it("cuts to max graphemes and appends an ellipsis", () => {
    const out = truncateGraphemes("a".repeat(121), 120)
    expect(out).toBe(`${"a".repeat(120)}…`)
  })

  it("never splits a ZWJ emoji sequence", () => {
    const family = "👨‍👩‍👧‍👦"
    const out = truncateGraphemes(family.repeat(130), 120)
    expect(out).toBe(`${family.repeat(120)}…`)
  })

  it("returns strings at or under the limit unchanged", () => {
    expect(truncateGraphemes("a".repeat(120), 120)).toBe("a".repeat(120))
    expect(truncateGraphemes("short", 120)).toBe("short")
    expect(truncateGraphemes("", 120)).toBe("")
  })
})

describe("mergeMessages", () => {
  it("keeps ascending seq order when merging out-of-order input", () => {
    const out = mergeMessages([msg(2), msg(5)], [msg(7), msg(3), msg(6)], 2)
    expect(out.map((m) => m.seq)).toEqual([2, 3, 5, 6, 7])
  })

  it("replaces an existing message by seq", () => {
    const changed = msg(5, { updatedSeq: 9, reactions: [{ userId: ALICE, emoji: "💕" }] })
    const out = mergeMessages([msg(4), msg(5)], [changed], 4)
    expect(out).toHaveLength(2)
    expect(out[1]).toEqual(changed)
  })

  it("never lets an older version replace a newer one", () => {
    const newer = msg(5, { updatedSeq: 9, body: "newer" })
    const out = mergeMessages([msg(4), newer], [msg(5, { updatedSeq: 5, body: "older" })], 4)
    expect(out[1]).toEqual(newer)
  })

  it("drops incoming messages older than the loaded window", () => {
    const out = mergeMessages([msg(10), msg(11)], [msg(3), msg(12)], 10)
    expect(out.map((m) => m.seq)).toEqual([10, 11, 12])
  })

  it("is idempotent when the same DTO is merged twice", () => {
    const once = mergeMessages([msg(1)], [msg(2)], 1)
    const twice = mergeMessages(once, [msg(2)], 1)
    expect(twice).toEqual(once)
  })

  it("accepts anything into an empty, unanchored window", () => {
    const out = mergeMessages([], [msg(8), msg(4)], null)
    expect(out.map((m) => m.seq)).toEqual([4, 8])
  })
})

describe("nextOutboxState (CHAT-03, CHAT-04)", () => {
  const fresh = { attempts: 0, state: "sending" as const }

  it("removes the entry once the server confirmed it", () => {
    expect(nextOutboxState(fresh, { kind: "ok" })).toBeNull()
  })

  it("keeps a network failure sending and counts the attempt", () => {
    expect(nextOutboxState(fresh, { kind: "network", connected: true })).toEqual({ attempts: 1, state: "sending" })
  })

  it("fails the third failure while connected", () => {
    const two = { attempts: 2, state: "sending" as const }
    expect(nextOutboxState(two, { kind: "network", connected: true })).toEqual({ attempts: 3, state: "failed" })
    expect(nextOutboxState(two, { kind: "http", status: 503, connected: true })).toEqual({ attempts: 3, state: "failed" })
  })

  it("fails a 4xx rejection at once, except 401, 408 and 429", () => {
    expect(nextOutboxState(fresh, { kind: "http", status: 400, connected: true })).toMatchObject({ state: "failed" })
    expect(nextOutboxState(fresh, { kind: "http", status: 409, connected: true })).toMatchObject({ state: "failed" })
    for (const status of [401, 408, 429]) {
      expect(nextOutboxState(fresh, { kind: "http", status, connected: true })).toMatchObject({ state: "sending" })
    }
  })

  it("never fails while offline", () => {
    let entry: { attempts: number; state: "sending" | "failed" } = { attempts: 2, state: "sending" }
    for (let i = 0; i < 10; i++) {
      entry = nextOutboxState(entry, { kind: "network", connected: false })!
      expect(entry.state).toBe("sending")
    }
  })

  it("keeps the other fields of the entry", () => {
    const entry = { id: "x", body: "hi", createdAt: 1, attempts: 0, state: "sending" as const }
    expect(nextOutboxState(entry, { kind: "network", connected: true })).toEqual({ ...entry, attempts: 1 })
  })
})
