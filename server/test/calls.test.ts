import { randomUUID } from "node:crypto"
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest"
import { loginCookie, makeTestApp, openWs, TEST_ORIGIN, type TestApp, type WsFrame, type WsTestClient } from "./helpers"

type Client = WsTestClient & { connId: string; userId: string }

let t: TestApp
let aliceCookie: string
let alice2Cookie: string
let bobCookie: string
let open: Client[] = []

beforeAll(async () => {
  t = await makeTestApp({ seed: true })
  aliceCookie = await loginCookie(t.app, "alice")
  alice2Cookie = await loginCookie(t.app, "alice")
  bobCookie = await loginCookie(t.app, "bob")
})
afterAll(async () => {
  await t.close()
})
afterEach(async () => {
  // A hangup from a test that failed half-way must not leave the single current call behind.
  for (const c of open) c.ws.terminate()
  open = []
  await new Promise((r) => setTimeout(r, 20))
})

async function connect(cookie: string): Promise<Client> {
  const c = await openWs(t.app, cookie, TEST_ORIGIN)
  const hello = await c.next()
  expect(hello.t).toBe("hello")
  const client = Object.assign(c, { connId: hello.connId as string, userId: hello.userId as string })
  open.push(client)
  return client
}

/** The next frame of type `t`, skipping others (room.peer-left and the like). */
async function nextOf(c: WsTestClient, t: string, timeoutMs = 1000): Promise<WsFrame> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const left = deadline - Date.now()
    if (left <= 0) throw new Error(`no ${t} frame within ${timeoutMs} ms`)
    const f = await c.next(left)
    if (f.t === t) return f
  }
}

/** Alice invites, Bob's socket rings. */
async function ring(alice: Client, bob: Client, kind: "voice" | "video" = "voice"): Promise<string> {
  const callId = randomUUID()
  alice.send({ t: "call.invite", callId, kind })
  const f = await bob.next()
  expect(f).toEqual({ t: "call.ring", callId, kind, from: alice.userId })
  return callId
}

/** Ring, accept, and consume the join + accepted frames on both sides. */
async function activeCall(alice: Client, bob: Client): Promise<string> {
  const callId = await ring(alice, bob)
  bob.send({ t: "call.accept", callId })
  await nextOf(alice, "call.accepted")
  await nextOf(bob, "call.accepted")
  return callId
}

describe("call.invite", () => {
  it("rings every connection of the other person, never the caller's own socket", async () => {
    const alice = await connect(aliceCookie)
    const bob = await connect(bobCookie)
    const callId = await ring(alice, bob)
    expect(await alice.collect(100)).toEqual([])
    alice.send({ t: "call.end", callId })
    expect(await nextOf(bob, "call.ended")).toEqual({ t: "call.ended", callId, reason: "cancelled" })
  })
})

describe("call.accept", () => {
  it("joins both connections to call-<id> and tells both", async () => {
    const alice = await connect(aliceCookie)
    const bob = await connect(bobCookie)
    const callId = await ring(alice, bob)
    const room = `call-${callId}`
    bob.send({ t: "call.accept", callId })

    expect(await alice.next()).toEqual({ t: "room.joined", room, peers: [] })
    expect(await alice.next()).toEqual({
      t: "room.peer-joined",
      room,
      peer: { connId: bob.connId, userId: bob.userId },
    })
    expect(await alice.next()).toEqual({ t: "call.accepted", callId })

    expect(await bob.next()).toEqual({
      t: "room.joined",
      room,
      peers: [{ connId: alice.connId, userId: alice.userId }],
    })
    expect(await bob.next()).toEqual({ t: "call.accepted", callId })

    alice.send({ t: "call.end", callId })
    await nextOf(bob, "call.ended")
  })

  it("relays rtc.signal between the two parties in the call room", async () => {
    const alice = await connect(aliceCookie)
    const bob = await connect(bobCookie)
    const callId = await activeCall(alice, bob)
    const room = `call-${callId}`
    const data = { description: { type: "offer", sdp: "v=0\r\n" } }
    alice.send({ t: "rtc.signal", room, data })
    expect(await nextOf(bob, "rtc.signal")).toEqual({ t: "rtc.signal", room, from: alice.connId, data })
    alice.send({ t: "call.end", callId })
    await nextOf(bob, "call.ended")
  })

  it("refuses an accept from the caller with not_allowed", async () => {
    const alice = await connect(aliceCookie)
    const bob = await connect(bobCookie)
    const callId = await ring(alice, bob)
    alice.send({ t: "call.accept", callId })
    expect(await alice.next()).toEqual({ t: "error", code: "not_allowed" })
    alice.send({ t: "call.end", callId })
    await nextOf(bob, "call.ended")
  })
})

describe("call rooms are server-managed (T-03-02)", () => {
  it("answers room_reserved to a client join of any call- room and joins nothing", async () => {
    const alice = await connect(aliceCookie)
    for (const room of [`call-${randomUUID()}`, "call-x"]) {
      alice.send({ t: "room.join", room })
      expect(await alice.next()).toEqual({ t: "error", code: "room_reserved" })
      alice.send({ t: "rtc.signal", room, data: { candidate: null } })
      expect(await alice.next()).toEqual({ t: "error", code: "not_in_room" })
    }
  })

  it("still lets clients join other rooms (the /debug/call harness)", async () => {
    const alice = await connect(aliceCookie)
    alice.send({ t: "room.join", room: "smoke-n-1" })
    expect(await alice.next()).toEqual({ t: "room.joined", room: "smoke-n-1", peers: [] })
  })
})

describe("call.end", () => {
  it("hangs up an active call on both sockets and closes the room", async () => {
    const alice = await connect(aliceCookie)
    const bob = await connect(bobCookie)
    const callId = await activeCall(alice, bob)
    alice.send({ t: "call.end", callId })
    expect(await nextOf(alice, "call.ended")).toEqual({ t: "call.ended", callId, reason: "hangup" })
    expect(await nextOf(bob, "call.ended")).toEqual({ t: "call.ended", callId, reason: "hangup" })
    alice.send({ t: "rtc.signal", room: `call-${callId}`, data: { candidate: null } })
    expect(await nextOf(alice, "error")).toEqual({ t: "error", code: "not_in_room" })
  })

  it("cancels a ringing call and clears it, so a new invite rings again", async () => {
    const alice = await connect(aliceCookie)
    const bob = await connect(bobCookie)
    const callId = await ring(alice, bob)
    alice.send({ t: "call.end", callId })
    expect(await nextOf(bob, "call.ended")).toEqual({ t: "call.ended", callId, reason: "cancelled" })
    await nextOf(alice, "call.ended")
    const next = await ring(alice, bob)
    alice.send({ t: "call.end", callId: next })
    await nextOf(bob, "call.ended")
  })

  it("refuses an end from an unbound connection of a party and keeps the call active", async () => {
    const alice = await connect(aliceCookie)
    const alice2 = await connect(alice2Cookie)
    const bob = await connect(bobCookie)
    const callId = await activeCall(alice, bob)
    alice2.send({ t: "call.end", callId })
    expect(await nextOf(alice2, "error")).toEqual({ t: "error", code: "not_allowed" })
    // Still active: the relay works and the bound connection can hang up.
    const room = `call-${callId}`
    alice.send({ t: "rtc.signal", room, data: { candidate: null } })
    expect((await nextOf(bob, "rtc.signal")).from).toBe(alice.connId)
    alice.send({ t: "call.end", callId })
    expect(await nextOf(bob, "call.ended")).toEqual({ t: "call.ended", callId, reason: "hangup" })
  })
})

describe("call.decline", () => {
  it("ends the ringing call as declined for the caller", async () => {
    const alice = await connect(aliceCookie)
    const bob = await connect(bobCookie)
    const callId = await ring(alice, bob)
    bob.send({ t: "call.decline", callId })
    expect(await nextOf(alice, "call.ended")).toEqual({ t: "call.ended", callId, reason: "declined" })
  })
})
