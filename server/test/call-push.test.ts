import { createECDH, randomBytes, randomUUID } from "node:crypto"
import { Writable } from "node:stream"
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import { eq } from "drizzle-orm"
import { pushSubscriptions, users } from "../src/db/schema"
import type { WebPushSend } from "../src/push/sender"
import { loginCookie, makeTestApp, openWs, TEST_ORIGIN, vapidTestEnv, type TestApp, type WsFrame, type WsTestClient } from "./helpers"

/**
 * Call pushes (CALL-03, D-09, D-11, D-12): the incoming-call push to phones that are not showing the
 * call, ring-on-attach, the missed-call push and GET /api/calls/:id.
 */

type Client = WsTestClient & { connId: string; userId: string }

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** A subscription body as PushSubscription.toJSON() produces it, with real-shaped keys. */
function subscription(endpoint = `https://fcm.googleapis.com/fcm/send/${randomUUID()}`) {
  const ecdh = createECDH("prime256v1")
  ecdh.generateKeys()
  return {
    endpoint,
    expirationTime: null,
    keys: { p256dh: ecdh.getPublicKey().toString("base64url"), auth: randomBytes(16).toString("base64url") },
  }
}

interface Env {
  t: TestApp
  logLines: string[]
  send: ReturnType<typeof vi.fn<WebPushSend>>
  aliceCookie: string
  /** Bob's phone A (a visible WS in the tests that need one). */
  bobA: string
  /** Bob's phone B (never connected: the app is closed). */
  bobB: string
  aliceId: string
  bobId: string
  open: Client[]
}

async function setup({ vapid = true } = {}): Promise<Env> {
  const logLines: string[] = []
  const logStream = new Writable({
    write(chunk, _enc, cb) {
      logLines.push(chunk.toString())
      cb()
    },
  })
  const send = vi.fn<WebPushSend>(async () => ({ statusCode: 201 }))
  const t = await makeTestApp({
    seed: true,
    logStream,
    env: vapid ? vapidTestEnv() : {},
    webPushSend: send,
    callTimers: { ringTimeoutMs: 500, callerAbsentMs: 50, absentGraceMs: 50 },
  })
  const idOf = (username: string) => t.app.db.select({ id: users.id }).from(users).where(eq(users.username, username)).get()!.id
  return {
    t,
    logLines,
    send,
    aliceCookie: await loginCookie(t.app, "alice"),
    bobA: await loginCookie(t.app, "bob"),
    bobB: await loginCookie(t.app, "bob"),
    aliceId: idOf("alice"),
    bobId: idOf("bob"),
    open: [],
  }
}

function logged(env: Env, evt: string): Array<Record<string, unknown>> {
  return env.logLines
    .map((l) => {
      try {
        return JSON.parse(l) as Record<string, unknown>
      } catch {
        return {}
      }
    })
    .filter((l) => l.evt === evt)
}

async function subscribe(env: Env, cookie: string, body = subscription()) {
  const res = await env.t.app.inject({
    method: "POST",
    url: "/api/push/subscriptions",
    headers: { cookie, origin: TEST_ORIGIN },
    payload: body,
  })
  expect(res.statusCode).toBe(200)
  return body
}

async function connect(env: Env, cookie: string): Promise<Client> {
  const c = await openWs(env.t.app, cookie, TEST_ORIGIN)
  const hello = await c.next()
  expect(hello.t).toBe("hello")
  const client = Object.assign(c, { connId: hello.connId as string, userId: hello.userId as string })
  env.open.push(client)
  return client
}

/** Round-trip a ping so every frame sent before it has been handled by the server. */
async function settle(c: WsTestClient) {
  c.send({ t: "ping" })
  for (;;) {
    const f = await c.next()
    if (f.t === "pong") return
  }
}

/** A connection whose presence says visible (the app is on screen). */
async function visible(env: Env, cookie: string): Promise<Client> {
  const c = await connect(env, cookie)
  c.send({ t: "presence", visible: true })
  await settle(c)
  return c
}

/** The next frame of type `t`, skipping others. */
async function nextOf(c: WsTestClient, t: string, timeoutMs = 1000): Promise<WsFrame> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const left = deadline - Date.now()
    if (left <= 0) throw new Error(`no ${t} frame within ${timeoutMs} ms`)
    const f = await c.next(left)
    if (f.t === t) return f
  }
}

function payloadOf(env: Env, i: number): Record<string, unknown> {
  return JSON.parse(env.send.mock.calls[i]![1]) as Record<string, unknown>
}

async function closeAll(env: Env) {
  for (const c of env.open) c.ws.terminate()
  env.open = []
  // callerAbsentMs / absentGraceMs are 50 ms: let a call left behind end before the next test.
  await sleep(120)
}

describe("incoming-call push (CALL-03, D-09, D-11)", () => {
  let env: Env
  beforeAll(async () => {
    env = await setup()
  })
  afterAll(async () => {
    await env.t.close()
  })
  beforeEach(() => {
    env.t.app.db.delete(pushSubscriptions).run()
    env.send.mockClear()
  })
  afterEach(async () => {
    await closeAll(env)
  })

  it("pushes to Bob's closed phone only, with the caller's name, the call id, TTL 45, urgency high and no topic", async () => {
    await subscribe(env, env.bobA)
    const subB = await subscribe(env, env.bobB)
    const bobA = await visible(env, env.bobA)
    const alice = await connect(env, env.aliceCookie)
    const callId = randomUUID()
    alice.send({ t: "call.invite", callId, kind: "voice" })
    expect(await nextOf(bobA, "call.ring")).toEqual({ t: "call.ring", callId, kind: "voice", from: env.aliceId })
    await vi.waitFor(() => expect(env.send).toHaveBeenCalledTimes(1))
    await sleep(30)
    expect(env.send).toHaveBeenCalledTimes(1)
    const [target, , options] = env.send.mock.calls[0]!
    expect(target.endpoint).toBe(subB.endpoint)
    expect(payloadOf(env, 0)).toEqual({ t: "call", title: "Alice Test", body: "📞 Incoming voice call", callId, kind: "voice" })
    expect(options).toMatchObject({ TTL: 45, urgency: "high" })
    expect(options).not.toHaveProperty("topic")

    // Logs: call id and counts only, never an endpoint path or a key (T-03-12).
    const line = logged(env, "push_call").at(-1)
    expect(line).toMatchObject({ callId, subs: 1, skipped: 1, ok: 1 })
    const raw = env.logLines.filter((l) => l.includes('"push_call"')).join("\n")
    expect(raw).not.toContain(new URL(subB.endpoint).pathname)
    expect(raw).not.toContain(subB.keys.p256dh)
    expect(raw).not.toContain(subB.keys.auth)
    alice.send({ t: "call.end", callId })
    await nextOf(bobA, "call.ended")
  })

  it("uses the video body for a video invite", async () => {
    await subscribe(env, env.bobB)
    const alice = await connect(env, env.aliceCookie)
    const callId = randomUUID()
    alice.send({ t: "call.invite", callId, kind: "video" })
    await vi.waitFor(() => expect(env.send).toHaveBeenCalledTimes(1))
    expect(payloadOf(env, 0)).toEqual({ t: "call", title: "Alice Test", body: "🎥 Incoming video call", callId, kind: "video" })
    alice.send({ t: "call.end", callId })
    await nextOf(alice, "call.ended")
  })

  it("rings a new callee connection right after hello while the call rings (ring-on-attach), and never the caller or after the answer", async () => {
    const alice = await connect(env, env.aliceCookie)
    const callId = randomUUID()
    alice.send({ t: "call.invite", callId, kind: "voice" })
    await settle(alice)

    const late = await openWs(env.t.app, env.bobB, TEST_ORIGIN)
    env.open.push(Object.assign(late, { connId: "", userId: "" }))
    expect((await late.next()).t).toBe("hello")
    expect(await late.next()).toEqual({ t: "call.ring", callId, kind: "voice", from: env.aliceId })

    const alice2 = await connect(env, env.aliceCookie)
    expect(await alice2.collect(80)).toEqual([])

    late.send({ t: "call.accept", callId })
    await nextOf(late, "call.accepted")
    const afterAnswer = await connect(env, env.bobA)
    expect((await afterAnswer.collect(80)).filter((f) => f.t === "call.ring")).toEqual([])
    alice.send({ t: "call.end", callId })
    await nextOf(late, "call.ended")
  })
})

describe("incoming-call push without VAPID", () => {
  let env: Env
  beforeAll(async () => {
    env = await setup({ vapid: false })
  })
  afterAll(async () => {
    await closeAll(env)
    await env.t.close()
  })

  it("attempts no push and still rings over /ws", async () => {
    const bob = await connect(env, env.bobA)
    const alice = await connect(env, env.aliceCookie)
    const callId = randomUUID()
    alice.send({ t: "call.invite", callId, kind: "voice" })
    expect(await nextOf(bob, "call.ring")).toEqual({ t: "call.ring", callId, kind: "voice", from: env.aliceId })
    await sleep(50)
    expect(env.send).not.toHaveBeenCalled()
    alice.send({ t: "call.end", callId })
    await nextOf(bob, "call.ended")
  })
})
