import { Writable } from "node:stream"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { eq } from "drizzle-orm"
import { hashToken, SESSION_TTL_MS } from "../src/auth/session"
import { sessions } from "../src/db/schema"
import { loginCookie, makeTestApp, openWs, TEST_ORIGIN, type TestApp, type WsTestClient } from "./helpers"

const HOUR = 60 * 60 * 1000
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

const logLines: string[] = []
const logStream = new Writable({
  write(chunk, _enc, cb) {
    logLines.push(chunk.toString())
    cb()
  },
})

let t: TestApp
let aliceCookie: string
let alice2Cookie: string
let bobCookie: string

beforeAll(async () => {
  t = await makeTestApp({ seed: true, logStream })
  aliceCookie = await loginCookie(t.app, "alice")
  alice2Cookie = await loginCookie(t.app, "alice")
  bobCookie = await loginCookie(t.app, "bob")
})
afterAll(async () => {
  await t.close()
})

function tokenOf(cookie: string): string {
  return cookie.slice("duet_session=".length)
}

function sessionRow(cookie: string) {
  return t.app.db.select().from(sessions).where(eq(sessions.id, hashToken(tokenOf(cookie)))).get()
}

/** Open a socket and consume its hello frame. */
async function connect(cookie: string): Promise<WsTestClient & { connId: string; userId: string }> {
  const c = await openWs(t.app, cookie, TEST_ORIGIN)
  const hello = await c.next()
  expect(hello.t).toBe("hello")
  return Object.assign(c, { connId: hello.connId as string, userId: hello.userId as string })
}

async function joined(c: WsTestClient, room: string) {
  c.send({ t: "room.join", room })
  const f = await c.next()
  expect(f.t).toBe("room.joined")
  expect(f.room).toBe(room)
  return f
}

describe("GET /ws auth and Origin (before the upgrade)", () => {
  it("rejects a connection without a session with 401", async () => {
    await expect(openWs(t.app, null, TEST_ORIGIN)).rejects.toThrow("Unexpected server response: 401")
  })

  it("rejects a valid session with a foreign Origin with 403", async () => {
    await expect(openWs(t.app, aliceCookie, "https://evil.example")).rejects.toThrow(
      "Unexpected server response: 403",
    )
  })

  it("rejects a valid session without an Origin with 403", async () => {
    await expect(openWs(t.app, aliceCookie, null)).rejects.toThrow("Unexpected server response: 403")
  })

  it("rejects an expired session with 401 and deletes the row", async () => {
    const cookie = await loginCookie(t.app, "bob")
    t.app.db
      .update(sessions)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(sessions.id, hashToken(tokenOf(cookie))))
      .run()
    await expect(openWs(t.app, cookie, TEST_ORIGIN)).rejects.toThrow("Unexpected server response: 401")
    expect(sessionRow(cookie)).toBeUndefined()
  })

  it("sends hello { connId, userId } first on a valid session and Origin", async () => {
    const c = await openWs(t.app, aliceCookie, TEST_ORIGIN)
    const hello = await c.next()
    expect(hello.t).toBe("hello")
    expect(hello.connId).toMatch(UUID)
    expect(hello.userId).toBe(sessionRow(aliceCookie)!.userId)
    c.ws.terminate()
  })
})

describe("rooms and relay", () => {
  it("joins two members and relays rtc.signal only to the other member, unchanged", async () => {
    const a = await connect(aliceCookie)
    const b = await connect(bobCookie)
    const outsider = await connect(bobCookie)

    const aJoin = await joined(a, "r1")
    expect(aJoin.peers).toEqual([])
    const bJoin = await joined(b, "r1")
    expect(bJoin.peers).toEqual([{ connId: a.connId, userId: a.userId }])
    const peerJoined = await a.next()
    expect(peerJoined).toEqual({ t: "room.peer-joined", room: "r1", peer: { connId: b.connId, userId: b.userId } })

    await joined(outsider, "r2")

    const data = {
      description: { type: "offer", sdp: "v=0\r\no=- 1 2 IN IP4 127.0.0.1\r\n" },
      candidate: { candidate: "candidate:1 1 udp 2122260223 192.0.2.1 54400 typ host", sdpMid: "0", sdpMLineIndex: 0 },
    }
    a.send({ t: "rtc.signal", room: "r1", data })
    const relayed = await b.next()
    expect(relayed).toEqual({ t: "rtc.signal", room: "r1", from: a.connId, data })

    expect(await outsider.collect(200)).toEqual([])
    expect(await a.collect(50)).toEqual([])
    for (const c of [a, b, outsider]) c.ws.terminate()
  })

  it("lets two connections of the same user share a room; a third gets room.full", async () => {
    const a1 = await connect(aliceCookie)
    const a2 = await connect(alice2Cookie)
    const a3 = await connect(aliceCookie)
    await joined(a1, "r4")
    const j2 = await joined(a2, "r4")
    expect(j2.peers).toEqual([{ connId: a1.connId, userId: a1.userId }])
    expect((await a1.next()).t).toBe("room.peer-joined")

    a2.send({ t: "rtc.signal", room: "r4", data: { candidate: null } })
    expect(await a1.next()).toEqual({ t: "rtc.signal", room: "r4", from: a2.connId, data: { candidate: null } })

    a3.send({ t: "room.join", room: "r4" })
    expect(await a3.next()).toEqual({ t: "room.full", room: "r4" })

    a3.send({ t: "rtc.signal", room: "r4", data: { candidate: null } })
    expect(await a3.next()).toEqual({ t: "error", code: "not_in_room" })
    expect(await a1.collect(100)).toEqual([])
    expect(await a2.collect(0)).toEqual([])
    for (const c of [a1, a2, a3]) c.ws.terminate()
  })

  it("admits exactly two of three same-tick joins and sends room.full to exactly one", async () => {
    const cs = [await connect(aliceCookie), await connect(bobCookie), await connect(alice2Cookie)]
    for (const c of cs) c.send({ t: "room.join", room: "r3" })
    const frames = await Promise.all(cs.map((c) => c.collect(200)))
    const all = frames.flat()
    expect(all.filter((f) => f.t === "room.joined")).toHaveLength(2)
    expect(all.filter((f) => f.t === "room.full")).toHaveLength(1)
    for (const c of cs) c.ws.terminate()
  })

  it("sends room.peer-left when a member disconnects and frees the slot", async () => {
    const a = await connect(aliceCookie)
    const b = await connect(bobCookie)
    await joined(a, "r5")
    await joined(b, "r5")
    expect((await a.next()).t).toBe("room.peer-joined")

    b.ws.terminate()
    expect(await a.next()).toEqual({ t: "room.peer-left", room: "r5", connId: b.connId })

    const c = await connect(bobCookie)
    const j = await joined(c, "r5")
    expect(j.peers).toEqual([{ connId: a.connId, userId: a.userId }])
    a.ws.terminate()
    c.ws.terminate()
  })

  it("answers not_in_room for a signal to a room the sender has not joined", async () => {
    const a = await connect(aliceCookie)
    a.send({ t: "rtc.signal", room: "nobody-here", data: { candidate: null } })
    expect(await a.next()).toEqual({ t: "error", code: "not_in_room" })
    a.ws.terminate()
  })

  it("answers too_many_rooms on a fifth room for one connection", async () => {
    const a = await connect(aliceCookie)
    for (const room of ["m1", "m2", "m3", "m4"]) await joined(a, room)
    a.send({ t: "room.join", room: "m5" })
    expect(await a.next()).toEqual({ t: "error", code: "too_many_rooms" })
    a.ws.terminate()
  })
})

describe("frame validation (bad_frame keeps the socket open)", () => {
  const badFrames: Array<[string, string]> = [
    ["malformed JSON", "{not json"],
    ["an unknown t", JSON.stringify({ t: "room.dance", room: "x" })],
    ["room 'Bad Room'", JSON.stringify({ t: "room.join", room: "Bad Room" })],
    ["a 65-char room id", JSON.stringify({ t: "room.join", room: "a".repeat(65) })],
  ]
  for (const [name, raw] of badFrames) {
    it(`answers bad_frame for ${name} and stays usable`, async () => {
      const a = await connect(aliceCookie)
      a.send(raw)
      expect(await a.next()).toEqual({ t: "error", code: "bad_frame" })
      await joined(a, `still-open-${name.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}`)
      a.ws.terminate()
    })
  }

  it("accepts a 64-char room id", async () => {
    const a = await connect(aliceCookie)
    await joined(a, "b".repeat(64))
    a.ws.terminate()
  })
})

describe("signal size limits", () => {
  async function pair(room: string) {
    const a = await connect(aliceCookie)
    const b = await connect(bobCookie)
    await joined(a, room)
    await joined(b, room)
    expect((await a.next()).t).toBe("room.peer-joined")
    return { a, b }
  }

  it("relays an SDP of 65536 chars and rejects 65537 with bad_frame", async () => {
    const { a, b } = await pair("sdp-limit")
    const ok = { description: { type: "offer", sdp: "x".repeat(65536) } }
    a.send({ t: "rtc.signal", room: "sdp-limit", data: ok })
    const relayed = await b.next()
    expect(relayed.t).toBe("rtc.signal")
    expect(relayed.data.description.sdp).toHaveLength(65536)

    a.send({ t: "rtc.signal", room: "sdp-limit", data: { description: { type: "offer", sdp: "x".repeat(65537) } } })
    expect(await a.next()).toEqual({ t: "error", code: "bad_frame" })
    expect(await b.collect(100)).toEqual([])
    a.ws.terminate()
    b.ws.terminate()
  })

  it("relays a candidate of 2048 chars and rejects 2049 with bad_frame", async () => {
    const { a, b } = await pair("cand-limit")
    a.send({ t: "rtc.signal", room: "cand-limit", data: { candidate: { candidate: "c".repeat(2048) } } })
    const relayed = await b.next()
    expect(relayed.data.candidate.candidate).toHaveLength(2048)

    a.send({ t: "rtc.signal", room: "cand-limit", data: { candidate: { candidate: "c".repeat(2049) } } })
    expect(await a.next()).toEqual({ t: "error", code: "bad_frame" })
    expect(await b.collect(100)).toEqual([])
    a.ws.terminate()
    b.ws.terminate()
  })
})

describe("rate and payload limits", () => {
  it("closes with 1008 after more than 100 frames within one second", async () => {
    const a = await connect(aliceCookie)
    for (let i = 0; i < 101; i++) a.send({ t: "room.leave", room: "not-joined" })
    expect(await a.closed).toEqual({ code: 1008 })
  })

  it("closes with 1009 on a message above 131072 bytes", async () => {
    const a = await connect(aliceCookie)
    a.send("y".repeat(131073))
    expect(await a.closed).toEqual({ code: 1009 })
  })
})

describe("logout and session renewal", () => {
  it("POST /api/logout closes that session's sockets with 4401 and leaves others open", async () => {
    const cookie = await loginCookie(t.app, "alice")
    const a = await connect(cookie)
    const b = await connect(bobCookie)

    const res = await t.app.inject({
      method: "POST",
      url: "/api/logout",
      headers: { origin: TEST_ORIGIN, cookie },
      payload: {},
    })
    expect(res.statusCode).toBe(200)
    expect(await a.closed).toEqual({ code: 4401 })

    await joined(b, "after-logout")
    expect(b.ws.readyState).toBe(b.ws.OPEN)
    b.ws.terminate()
  })

  it("does not renew the session on connect; GET /api/me still renews it", async () => {
    const cookie = await loginCookie(t.app, "bob")
    const old = new Date(Date.now() - 25 * HOUR)
    const oldExpiry = new Date(old.getTime() + SESSION_TTL_MS)
    t.app.db
      .update(sessions)
      .set({ lastSeenAt: old, expiresAt: oldExpiry })
      .where(eq(sessions.id, hashToken(tokenOf(cookie))))
      .run()

    const c = await connect(cookie)
    const row = sessionRow(cookie)!
    expect(row.lastSeenAt.getTime()).toBe(old.getTime())
    expect(row.expiresAt.getTime()).toBe(oldExpiry.getTime())
    c.ws.terminate()

    const me = await t.app.inject({ method: "GET", url: "/api/me", headers: { cookie } })
    expect(me.statusCode).toBe(200)
    expect(String(me.headers["set-cookie"] ?? "")).toContain(`${cookie};`)
  })
})

describe("heartbeat", () => {
  it("keeps a healthy socket (auto-pong) open across several heartbeats", async () => {
    const hb = await makeTestApp({ seed: true, heartbeatMs: 50 })
    try {
      const cookie = await loginCookie(hb.app, "alice")
      const c = await openWs(hb.app, cookie, TEST_ORIGIN)
      expect((await c.next()).t).toBe("hello")
      await new Promise((r) => setTimeout(r, 300))
      expect(c.ws.readyState).toBe(c.ws.OPEN)
      c.ws.terminate()
    } finally {
      await hb.close()
    }
  })

  // WR-02: a session revoked out of process (seed CLI password reset deletes the rows) or past its
  // expiry must not keep its socket. The heartbeat re-checks the session and closes with 4401.
  it("closes a socket with 4401 once its session row is deleted, and leaves other sessions open", async () => {
    const hb = await makeTestApp({ seed: true, heartbeatMs: 50 })
    try {
      const aliceC = await loginCookie(hb.app, "alice")
      const bobC = await loginCookie(hb.app, "bob")
      const a = await openWs(hb.app, aliceC, TEST_ORIGIN)
      const b = await openWs(hb.app, bobC, TEST_ORIGIN)
      expect((await a.next()).t).toBe("hello")
      expect((await b.next()).t).toBe("hello")

      hb.app.db.delete(sessions).where(eq(sessions.id, hashToken(tokenOf(aliceC)))).run()
      expect(await a.closed).toEqual({ code: 4401 })

      await new Promise((r) => setTimeout(r, 150))
      expect(b.ws.readyState).toBe(b.ws.OPEN)
      b.ws.terminate()
    } finally {
      await hb.close()
    }
  })

  it("closes a socket with 4401 once its session has expired", async () => {
    const hb = await makeTestApp({ seed: true, heartbeatMs: 50 })
    try {
      const cookie = await loginCookie(hb.app, "alice")
      const c = await openWs(hb.app, cookie, TEST_ORIGIN)
      expect((await c.next()).t).toBe("hello")

      hb.app.db
        .update(sessions)
        .set({ expiresAt: new Date(Date.now() - 1000) })
        .where(eq(sessions.id, hashToken(tokenOf(cookie))))
        .run()
      expect(await c.closed).toEqual({ code: 4401 })
    } finally {
      await hb.close()
    }
  })
})

describe("logging", () => {
  it("logs ws_open and ws_close but never signaling contents", async () => {
    const a = await connect(aliceCookie)
    const b = await connect(bobCookie)
    await joined(a, "log-room")
    await joined(b, "log-room")
    expect((await a.next()).t).toBe("room.peer-joined")
    const sdpMarker = "sdp-marker-7f3a9c"
    const candMarker = "cand-marker-2b8e41"
    a.send({ t: "rtc.signal", room: "log-room", data: { description: { type: "offer", sdp: sdpMarker } } })
    a.send({ t: "rtc.signal", room: "log-room", data: { candidate: { candidate: candMarker } } })
    expect((await b.next()).t).toBe("rtc.signal")
    expect((await b.next()).t).toBe("rtc.signal")
    a.ws.terminate()
    await a.closed
    await new Promise((r) => setTimeout(r, 50))

    const logs = logLines.join("")
    expect(logs).toContain('"evt":"ws_open"')
    expect(logs).toContain('"evt":"ws_close"')
    expect(logs).not.toContain(sdpMarker)
    expect(logs).not.toContain(candMarker)
    b.ws.terminate()
  })
})
