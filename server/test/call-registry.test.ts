import { randomUUID } from "node:crypto"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { ServerFrame } from "@duet/shared"
import { createCallRegistry, RECENT_CALL_MAX, type CallRegistryOptions, type CallTransport } from "../src/calls/registry"
import { ConfigError, loadConfig } from "../src/config"

const ALICE = "0b6f4a8e-1d2c-4b3a-9f8e-7d6c5b4a3921"
const BOB = "1c7a5b9f-2e3d-4c4b-8a9f-8e7d6c5b4a32"

type Sent = { conn: string; frame: ServerFrame }

/** The registry against a fake hub: connections are connId -> userId, every frame sent is recorded. */
function harness(opts: Partial<CallRegistryOptions> = {}) {
  const conns = new Map<string, string>()
  /** A connection's session when given at attach (a reconnect of the same device); else its own. */
  const sessions = new Map<string, string>()
  const sent: Sent[] = []
  const rooms = new Map<string, Set<string>>()
  const transport: CallTransport = {
    sendToConn(conn, frame) {
      if (conns.has(conn)) sent.push({ conn, frame })
    },
    sendToUser(userId, frame, exceptConnId) {
      for (const [conn, u] of conns) if (u === userId && conn !== exceptConnId) sent.push({ conn, frame })
    },
    serverJoin(conn, room) {
      if (!conns.has(conn)) return
      const members = rooms.get(room) ?? new Set<string>()
      members.add(conn)
      rooms.set(room, members)
    },
    serverLeave(conn, room) {
      rooms.get(room)?.delete(conn)
    },
    sessionOf(conn) {
      return conns.has(conn) ? (sessions.get(conn) ?? `session-${conn}`) : undefined
    },
  }
  const registry = createCallRegistry({
    log: { info() {} },
    transport,
    otherUser: (u) => (u === ALICE ? BOB : u === BOB ? ALICE : undefined),
    ...opts,
  })
  return {
    registry,
    sent,
    rooms,
    attach(userId: string, session?: string): string {
      const conn = randomUUID()
      conns.set(conn, userId)
      if (session !== undefined) sessions.set(conn, session)
      registry.onAttach(conn, userId)
      return conn
    },
    close(conn: string): void {
      const userId = conns.get(conn)
      conns.delete(conn)
      if (userId) registry.onClose(conn, userId)
    },
    /** Frames one connection received, optionally only of type t. */
    to(conn: string, t?: string): ServerFrame[] {
      return sent.filter((s) => s.conn === conn && (!t || s.frame.t === t)).map((s) => s.frame)
    },
    ofType(t: string): Sent[] {
      return sent.filter((s) => s.frame.t === t)
    },
    invite(conn: string, kind: "voice" | "video" = "voice"): string {
      const callId = randomUUID()
      registry.onFrame(conn, conns.get(conn)!, { t: "call.invite", callId, kind })
      return callId
    },
    frame(conn: string, frame: Parameters<typeof registry.onFrame>[2]): void {
      registry.onFrame(conn, conns.get(conn)!, frame)
    },
  }
}

beforeEach(() => {
  vi.useFakeTimers()
})
afterEach(() => {
  vi.useRealTimers()
})

describe("ring timeout (D-07)", () => {
  it("ends an unanswered call as no-answer at 45 s on every connection of both people, not before", () => {
    const h = harness()
    const a = h.attach(ALICE)
    const a2 = h.attach(ALICE)
    const b1 = h.attach(BOB)
    const b2 = h.attach(BOB)
    const callId = h.invite(a)
    vi.advanceTimersByTime(44_999)
    expect(h.ofType("call.ended")).toEqual([])
    vi.advanceTimersByTime(1)
    for (const conn of [a, a2, b1, b2]) {
      expect(h.to(conn, "call.ended")).toHaveLength(1)
      expect(h.to(conn, "call.ended")).toEqual([{ t: "call.ended", callId, reason: "no-answer" }])
    }
    const next = h.invite(a)
    expect(h.to(b1, "call.ring").at(-1)).toEqual({ t: "call.ring", callId: next, kind: "voice", from: ALICE })
    h.registry.close()
  })

  it("rings the full time with no callee device at all and then ends as no-answer (D-16)", () => {
    const h = harness()
    const a = h.attach(ALICE)
    const callId = h.invite(a)
    expect(h.ofType("call.ring")).toEqual([])
    vi.advanceTimersByTime(44_999)
    expect(h.ofType("call.ended")).toEqual([])
    vi.advanceTimersByTime(1)
    expect(h.to(a, "call.ended")).toEqual([{ t: "call.ended", callId, reason: "no-answer" }])
    h.registry.close()
  })

  it("uses the injected ring timeout", () => {
    const h = harness({ ringTimeoutMs: 3000 })
    const a = h.attach(ALICE)
    const callId = h.invite(a)
    vi.advanceTimersByTime(3000)
    expect(h.to(a, "call.ended")).toEqual([{ t: "call.ended", callId, reason: "no-answer" }])
    h.registry.close()
  })
})

describe("absence grace (Pitfall 3)", () => {
  it("cancels a ringing call 10 s after the caller's connection closed", () => {
    const h = harness()
    const a = h.attach(ALICE)
    const b = h.attach(BOB)
    const callId = h.invite(a)
    h.close(a)
    vi.advanceTimersByTime(9_999)
    expect(h.ofType("call.ended")).toEqual([])
    vi.advanceTimersByTime(1)
    expect(h.to(b, "call.ended")).toEqual([{ t: "call.ended", callId, reason: "cancelled" }])
    h.registry.close()
  })

  it("keeps ringing when one ringing callee device closes", () => {
    const h = harness()
    const a = h.attach(ALICE)
    const b1 = h.attach(BOB)
    const b2 = h.attach(BOB)
    const callId = h.invite(a)
    h.close(b1)
    vi.advanceTimersByTime(20_000)
    expect(h.ofType("call.ended")).toEqual([])
    h.frame(b2, { t: "call.accept", callId })
    expect(h.to(a, "call.accepted")).toEqual([{ t: "call.accepted", callId }])
    h.registry.close()
  })

  it("ends an active call as dropped 35 s after a bound party's connection closed, not before", () => {
    const h = harness()
    const a = h.attach(ALICE)
    const b = h.attach(BOB)
    const callId = h.invite(a)
    h.frame(b, { t: "call.accept", callId })
    h.close(b)
    vi.advanceTimersByTime(34_999)
    expect(h.ofType("call.ended")).toEqual([])
    vi.advanceTimersByTime(1)
    expect(h.to(a, "call.ended")).toEqual([{ t: "call.ended", callId, reason: "dropped" }])
    h.registry.close()
  })

  it("CR-01: an accept while the caller is away replaces the 10 s cancel with the 35 s active grace", () => {
    const h = harness()
    const a = h.attach(ALICE)
    const b = h.attach(BOB)
    const callId = h.invite(a)
    h.close(a)
    vi.advanceTimersByTime(5_000)
    h.frame(b, { t: "call.accept", callId })
    expect(h.to(b, "call.accepted")).toEqual([{ t: "call.accepted", callId }])
    // The ringing-phase timer would have cancelled the call 5 s from here.
    vi.advanceTimersByTime(34_999)
    expect(h.ofType("call.ended")).toEqual([])
    vi.advanceTimersByTime(1)
    expect(h.to(b, "call.ended")).toEqual([{ t: "call.ended", callId, reason: "dropped" }])
    h.registry.close()
  })

  it("CR-01: a caller that rejoins after an accept made while it was away keeps the call active", () => {
    const h = harness()
    const a = h.attach(ALICE, "session-alice")
    const b = h.attach(BOB)
    const callId = h.invite(a)
    h.close(a)
    h.frame(b, { t: "call.accept", callId })
    vi.advanceTimersByTime(8_000)
    const a2 = h.attach(ALICE, "session-alice")
    h.frame(a2, { t: "call.rejoin", callId })
    expect(h.to(a2, "call.state")).toEqual([{ t: "call.state", callId, status: "active", peerCamera: false }])
    expect([...(h.rooms.get(`call-${callId}`) ?? [])].sort()).toEqual([a2, b].sort())
    vi.advanceTimersByTime(60_000)
    expect(h.ofType("call.ended")).toEqual([])
    h.frame(b, { t: "call.end", callId })
    expect(h.to(a2, "call.ended")).toEqual([{ t: "call.ended", callId, reason: "hangup" }])
    h.registry.close()
  })

  it("does not end an active call when the ring timeout would have fired", () => {
    const h = harness()
    const a = h.attach(ALICE)
    const b = h.attach(BOB)
    const callId = h.invite(a)
    vi.advanceTimersByTime(30_000)
    h.frame(b, { t: "call.accept", callId })
    vi.advanceTimersByTime(60_000)
    expect(h.ofType("call.ended")).toEqual([])
    h.registry.close()
  })
})

describe("frames about calls that are not current", () => {
  it("answers decline, end and accept of an ended call with its stored reason", () => {
    const h = harness()
    const a = h.attach(ALICE)
    const b = h.attach(BOB)
    const callId = h.invite(a)
    h.frame(b, { t: "call.decline", callId })
    h.sent.length = 0
    h.frame(b, { t: "call.decline", callId })
    h.frame(a, { t: "call.end", callId })
    h.frame(b, { t: "call.accept", callId })
    expect(h.to(b)).toEqual([
      { t: "call.ended", callId, reason: "declined" },
      { t: "call.ended", callId, reason: "declined" },
    ])
    expect(h.to(a)).toEqual([{ t: "call.ended", callId, reason: "declined" }])
    h.registry.close()
  })

  it("answers an unknown call id with failed", () => {
    const h = harness()
    const b = h.attach(BOB)
    const callId = randomUUID()
    h.frame(b, { t: "call.accept", callId })
    expect(h.to(b)).toEqual([{ t: "call.ended", callId, reason: "failed" }])
    h.registry.close()
  })

  it(`remembers at most ${RECENT_CALL_MAX} ended calls`, () => {
    const h = harness()
    const a = h.attach(ALICE)
    const b = h.attach(BOB)
    const ids: string[] = []
    for (let i = 0; i < RECENT_CALL_MAX + 1; i++) {
      const callId = h.invite(a)
      ids.push(callId)
      h.frame(a, { t: "call.end", callId })
      vi.advanceTimersByTime(7_000) // stay under the invite rate limit
    }
    h.sent.length = 0
    h.frame(b, { t: "call.accept", callId: ids[0]! })
    h.frame(b, { t: "call.accept", callId: ids[1]! })
    expect(h.to(b)).toEqual([
      { t: "call.ended", callId: ids[0], reason: "failed" },
      { t: "call.ended", callId: ids[1], reason: "cancelled" },
    ])
    h.registry.close()
  })
})

describe("close()", () => {
  it("clears every timer: nothing ends after close", () => {
    const h = harness()
    const a = h.attach(ALICE)
    const b = h.attach(BOB)
    h.invite(a)
    h.close(a)
    h.registry.close()
    vi.advanceTimersByTime(60_000)
    expect(h.to(b, "call.ended")).toEqual([])
  })
})

describe("every device rings, the first answer wins (D-11)", () => {
  it("binds the accepting device and stops the others; a later accept from another device only stops it", () => {
    const h = harness()
    const a = h.attach(ALICE)
    const b1 = h.attach(BOB)
    const b2 = h.attach(BOB)
    const callId = h.invite(a)
    expect(h.to(b1, "call.ring")).toHaveLength(1)
    expect(h.to(b2, "call.ring")).toHaveLength(1)
    h.frame(b2, { t: "call.accept", callId })
    expect(h.to(b1, "call.stop-ringing")).toHaveLength(1)
    expect(h.to(b1, "call.stop-ringing")).toEqual([{ t: "call.stop-ringing", callId, reason: "answered-elsewhere" }])
    expect(h.to(b2, "call.accepted")).toEqual([{ t: "call.accepted", callId }])
    h.sent.length = 0
    h.frame(b1, { t: "call.accept", callId })
    expect(h.to(b1)).toEqual([{ t: "call.stop-ringing", callId, reason: "answered-elsewhere" }])
    expect([...(h.rooms.get(`call-${callId}`) ?? [])].sort()).toEqual([a, b2].sort())
    h.frame(b2, { t: "call.end", callId })
    expect(h.to(a, "call.ended")).toEqual([{ t: "call.ended", callId, reason: "hangup" }])
    h.registry.close()
  })

  it("ends the call on a decline from one device, for every connection of both people", () => {
    const h = harness()
    const a = h.attach(ALICE)
    const a2 = h.attach(ALICE)
    const b1 = h.attach(BOB)
    const b2 = h.attach(BOB)
    const callId = h.invite(a)
    h.frame(b1, { t: "call.decline", callId })
    for (const conn of [a, a2, b1, b2]) {
      expect(h.to(conn, "call.ended")).toEqual([{ t: "call.ended", callId, reason: "declined" }])
    }
    h.registry.close()
  })
})

describe("glare (D-14)", () => {
  it("merges the callee's own invite into the ringing call as an accept", () => {
    const h = harness()
    const a = h.attach(ALICE)
    const b = h.attach(BOB)
    const x = h.invite(a, "voice")
    const y = h.invite(b, "video")
    expect(h.to(b, "call.accepted")).toHaveLength(1)
    expect(h.to(b, "call.accepted")).toEqual([{ t: "call.accepted", callId: x, replaces: y }])
    expect(h.to(a, "call.accepted")).toEqual([{ t: "call.accepted", callId: x }])
    expect([...(h.rooms.get(`call-${x}`) ?? [])].sort()).toEqual([a, b].sort())
    expect(h.to(a, "call.ring")).toEqual([])
    expect(h.ofType("call.ended")).toEqual([])
    vi.advanceTimersByTime(60_000)
    expect(h.ofType("call.ended")).toEqual([])
    h.registry.close()
  })
})

describe("busy", () => {
  it("refuses an invite from a second device while a call is active, without ringing", () => {
    const h = harness()
    const a = h.attach(ALICE)
    const a2 = h.attach(ALICE)
    const b = h.attach(BOB)
    const x = h.invite(a)
    h.frame(b, { t: "call.accept", callId: x })
    h.sent.length = 0
    const z = h.invite(a2)
    expect(h.to(a2)).toEqual([{ t: "call.ended", callId: z, reason: "busy" }])
    expect(h.to(b, "call.ring")).toEqual([])
    expect(h.to(a, "call.ended")).toEqual([])
    h.frame(a, { t: "call.end", callId: x })
    expect(h.to(b, "call.ended")).toEqual([{ t: "call.ended", callId: x, reason: "hangup" }])
    h.registry.close()
  })

  it("refuses an invite from the caller's second device while the first still rings", () => {
    const h = harness()
    const a = h.attach(ALICE)
    const a2 = h.attach(ALICE)
    const b = h.attach(BOB)
    h.invite(a)
    h.sent.length = 0
    const z = h.invite(a2)
    expect(h.to(a2)).toEqual([{ t: "call.ended", callId: z, reason: "busy" }])
    expect(h.to(b)).toEqual([])
    h.registry.close()
  })

  it("ignores a repeated invite with the current id from the caller's connection", () => {
    const h = harness()
    const a = h.attach(ALICE)
    const b = h.attach(BOB)
    const x = h.invite(a)
    h.sent.length = 0
    h.frame(a, { t: "call.invite", callId: x, kind: "voice" })
    expect(h.sent).toEqual([])
    h.frame(b, { t: "call.accept", callId: x })
    expect(h.to(a, "call.accepted")).toEqual([{ t: "call.accepted", callId: x }])
    h.registry.close()
  })
})

describe("invite flood guard (T-03-03)", () => {
  it("refuses the 11th invite within 60 s without ringing, and rings again after 60 s", () => {
    const h = harness()
    const a = h.attach(ALICE)
    const b = h.attach(BOB)
    for (let i = 0; i < 10; i++) {
      const id = h.invite(a)
      h.frame(a, { t: "call.end", callId: id })
      vi.advanceTimersByTime(1_000)
    }
    expect(h.to(b, "call.ring")).toHaveLength(10)
    h.sent.length = 0
    const refused = h.invite(a)
    expect(h.to(a)).toEqual([{ t: "call.ended", callId: refused, reason: "failed" }])
    expect(h.to(b)).toEqual([])
    vi.advanceTimersByTime(60_000)
    const later = h.invite(a)
    expect(h.to(b, "call.ring")).toEqual([{ t: "call.ring", callId: later, kind: "voice", from: ALICE }])
    h.registry.close()
  })
})

describe("CALL_RING_TIMEOUT_MS config", () => {
  const base = { NODE_ENV: "test", APP_ORIGIN: "http://localhost:3000" }
  it("defaults to 45000", () => {
    expect(loadConfig(base).CALL_RING_TIMEOUT_MS).toBe(45_000)
  })
  it("accepts 3000..120000", () => {
    expect(loadConfig({ ...base, CALL_RING_TIMEOUT_MS: "3000" }).CALL_RING_TIMEOUT_MS).toBe(3000)
    expect(loadConfig({ ...base, CALL_RING_TIMEOUT_MS: "120000" }).CALL_RING_TIMEOUT_MS).toBe(120_000)
  })
  it("rejects 2999", () => {
    expect(() => loadConfig({ ...base, CALL_RING_TIMEOUT_MS: "2999" })).toThrow(ConfigError)
  })
})

describe("CALL_INVITE_LIMIT config (T-03-03)", () => {
  const base = { NODE_ENV: "test", APP_ORIGIN: "http://localhost:3000" }
  it("is unset by default, so the registry keeps INVITE_LIMIT", () => {
    expect(loadConfig(base).CALL_INVITE_LIMIT).toBeUndefined()
  })
  it("accepts 1..1000 and rejects 0", () => {
    expect(loadConfig({ ...base, CALL_INVITE_LIMIT: "100" }).CALL_INVITE_LIMIT).toBe(100)
    expect(() => loadConfig({ ...base, CALL_INVITE_LIMIT: "0" })).toThrow(ConfigError)
  })
})
