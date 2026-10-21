import { createECDH, randomBytes, randomUUID } from "node:crypto"
import { afterEach, describe, expect, it, vi } from "vitest"
import { eq } from "drizzle-orm"
import { messages, users } from "../src/db/schema"
import type { WebPushSend } from "../src/push/sender"
import { loginCookie, makeTestApp, openWs, TEST_ORIGIN, vapidTestEnv, type TestApp, type WsFrame, type WsTestClient } from "./helpers"

/**
 * QT-nw9-call-lines / QT-nw9-call-unread: a call end stores one kind "call" message, broadcasts it to
 * both people, and serves it from history and sync. Lines cannot be replied to or reacted to
 * (T-nw9-02) and never trigger a chat push (T-nw9-04).
 */

type Client = WsTestClient & { connId: string; userId: string }

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

let apps: TestApp[] = []
let open: Client[] = []

afterEach(async () => {
  for (const c of open) c.ws.terminate()
  open = []
  for (const a of apps) await a.close()
  apps = []
})

async function app(opts: Parameters<typeof makeTestApp>[0] = {}) {
  const t = await makeTestApp({ seed: true, ...opts })
  apps.push(t)
  const idOf = (username: string) => t.app.db.select({ id: users.id }).from(users).where(eq(users.username, username)).get()!.id
  return {
    t,
    aliceCookie: await loginCookie(t.app, "alice"),
    bobCookie: await loginCookie(t.app, "bob"),
    aliceId: idOf("alice"),
    bobId: idOf("bob"),
  }
}

async function connect(t: TestApp, cookie: string): Promise<Client> {
  const c = await openWs(t.app, cookie, TEST_ORIGIN)
  const hello = await c.next()
  expect(hello.t).toBe("hello")
  const client = Object.assign(c, { connId: hello.connId as string, userId: hello.userId as string })
  open.push(client)
  return client
}

async function nextOf(c: WsTestClient, t: string, timeoutMs = 1000): Promise<WsFrame> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const left = deadline - Date.now()
    if (left <= 0) throw new Error(`no ${t} frame within ${timeoutMs} ms`)
    const f = await c.next(left)
    if (f.t === t) return f
  }
}

function callRows(t: TestApp) {
  return t.app.db.select().from(messages).where(eq(messages.kind, "call")).all()
}

function subscription() {
  const ecdh = createECDH("prime256v1")
  ecdh.generateKeys()
  return {
    endpoint: `https://fcm.googleapis.com/fcm/send/${randomUUID()}`,
    expirationTime: null,
    keys: { p256dh: ecdh.getPublicKey().toString("base64url"), auth: randomBytes(16).toString("base64url") },
  }
}

describe("a call end stores and broadcasts one call line", () => {
  it("decline: both sockets get { t: msg } with kind call, served by history and sync", async () => {
    const { t, aliceCookie, bobCookie, aliceId } = await app()
    const alice = await connect(t, aliceCookie)
    const bob = await connect(t, bobCookie)
    const callId = randomUUID()
    alice.send({ t: "call.invite", callId, kind: "voice" })
    await nextOf(bob, "call.ring")
    bob.send({ t: "call.decline", callId })
    expect(await nextOf(alice, "call.ended")).toEqual({ t: "call.ended", callId, reason: "declined" })
    const fa = await nextOf(alice, "msg")
    const fb = await nextOf(bob, "msg")
    expect(fa).toEqual(fb)
    expect(fa.message).toMatchObject({
      kind: "call",
      senderId: aliceId,
      body: null,
      call: { kind: "voice", outcome: "declined", durationMs: 0 },
      reminder: null,
      replyTo: null,
      attachments: [],
      reactions: [],
    })
    const seq = fa.message.seq as number

    const page = await t.app.inject({ method: "GET", url: "/api/messages", headers: { cookie: bobCookie } })
    expect(page.json().messages).toEqual([fa.message])
    const sync = await t.app.inject({ method: "GET", url: "/api/sync?since=0", headers: { cookie: bobCookie } })
    expect(sync.json().messages).toEqual([fa.message])

    // T-nw9-02: no replies to and no reactions on a line.
    const reply = await t.app.inject({
      method: "POST",
      url: "/api/messages",
      headers: { cookie: bobCookie, origin: TEST_ORIGIN },
      payload: { id: randomUUID(), body: "re", replyToSeq: seq },
    })
    expect(reply.statusCode).toBe(400)
    expect(reply.json()).toEqual({ error: "bad_reply" })
    const react = await t.app.inject({
      method: "PUT",
      url: `/api/messages/${seq}/reaction`,
      headers: { cookie: bobCookie, origin: TEST_ORIGIN },
      payload: { emoji: "💕" },
    })
    expect(react.statusCode).toBe(404)
    expect(react.json()).toEqual({ error: "not_found" })

    // T-nw9-01: a client body cannot carry a kind or call fields.
    const forged = await t.app.inject({
      method: "POST",
      url: "/api/messages",
      headers: { cookie: aliceCookie, origin: TEST_ORIGIN },
      payload: { id: randomUUID(), body: "x", kind: "call", call: { kind: "voice", outcome: "missed", durationMs: 0 } },
    })
    expect(forged.statusCode).toBe(400)
    expect(callRows(t)).toHaveLength(1)
  })

  it("a ring timeout stores outcome missed", async () => {
    const { t, aliceCookie, bobCookie } = await app({ callTimers: { ringTimeoutMs: 100 } })
    const alice = await connect(t, aliceCookie)
    const bob = await connect(t, bobCookie)
    alice.send({ t: "call.invite", callId: randomUUID(), kind: "video" })
    await nextOf(bob, "call.ring")
    const f = await nextOf(bob, "msg")
    expect(f.message.call).toEqual({ kind: "video", outcome: "missed", durationMs: 0 })
    expect(callRows(t)).toHaveLength(1)
  })

  it("glare, then hangup: exactly one call line", async () => {
    const { t, aliceCookie, bobCookie } = await app()
    const alice = await connect(t, aliceCookie)
    const bob = await connect(t, bobCookie)
    const x = randomUUID()
    alice.send({ t: "call.invite", callId: x, kind: "voice" })
    await nextOf(bob, "call.ring")
    bob.send({ t: "call.invite", callId: randomUUID(), kind: "voice" })
    await nextOf(alice, "call.accepted")
    await nextOf(bob, "call.accepted")
    alice.send({ t: "call.end", callId: x })
    await nextOf(bob, "call.ended")
    const f = await nextOf(bob, "msg")
    expect(f.message.call.outcome).toBe("completed")
    await sleep(100)
    expect(callRows(t)).toHaveLength(1)
  })
})

describe("call lines and pushes (T-nw9-04, QT-nw9-call-unread)", () => {
  async function pushApp(ringTimeoutMs = 100) {
    const send = vi.fn<WebPushSend>(async () => ({ statusCode: 201 }))
    const env = await app({ env: vapidTestEnv(), webPushSend: send, callTimers: { ringTimeoutMs } })
    const res = await env.t.app.inject({
      method: "POST",
      url: "/api/push/subscriptions",
      headers: { cookie: env.bobCookie, origin: TEST_ORIGIN },
      payload: subscription(),
    })
    expect(res.statusCode).toBe(200)
    const payloads = () => send.mock.calls.map((c) => JSON.parse(c[1]) as Record<string, unknown>)
    return { ...env, send, payloads }
  }

  async function text(t: TestApp, cookie: string) {
    const res = await t.app.inject({
      method: "POST",
      url: "/api/messages",
      headers: { cookie, origin: TEST_ORIGIN },
      payload: { id: randomUUID(), body: "hello" },
    })
    expect(res.statusCode).toBe(200)
  }

  it("a missed ring sends only the call-missed push; a following text counts the missed call as unread", async () => {
    const { t, aliceCookie, send, payloads } = await pushApp()
    const alice = await connect(t, aliceCookie)
    alice.send({ t: "call.invite", callId: randomUUID(), kind: "voice" })
    await nextOf(alice, "msg")
    await vi.waitFor(() => expect(payloads().map((p) => p.t)).toEqual(["call", "call-missed"]))
    await sleep(50)
    expect(payloads().map((p) => p.t)).toEqual(["call", "call-missed"])
    send.mockClear()
    await text(t, aliceCookie)
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1))
    expect(payloads()[0]).toMatchObject({ t: "chat", title: "Alice Test · 2 new messages", body: "Message" })
  })

  it("a completed call does not count: one text after it is titled with the name only", async () => {
    const { t, aliceCookie, bobCookie, send, payloads } = await pushApp(45_000)
    const alice = await connect(t, aliceCookie)
    const bob = await connect(t, bobCookie)
    const callId = randomUUID()
    alice.send({ t: "call.invite", callId, kind: "voice" })
    await nextOf(bob, "call.ring")
    bob.send({ t: "call.accept", callId })
    await nextOf(alice, "call.accepted")
    alice.send({ t: "call.end", callId })
    await nextOf(alice, "msg")
    // Bob's socket must not count as viewing for the chat push below.
    bob.ws.terminate()
    await sleep(50)
    send.mockClear()
    await text(t, aliceCookie)
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1))
    expect(payloads()[0]).toMatchObject({ t: "chat", title: "Alice Test" })
  })
})
