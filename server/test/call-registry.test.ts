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
      return conns.has(conn) ? `session-${conn}` : undefined
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
    attach(userId: string): string {
      const conn = randomUUID()
      conns.set(conn, userId)
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
