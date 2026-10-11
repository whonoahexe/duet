import { createECDH, randomBytes, randomUUID } from "node:crypto"
import { Writable } from "node:stream"
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import { eq, sql } from "drizzle-orm"
import { messages, pushSubscriptions, users } from "../src/db/schema"
import type { WebPushSend } from "../src/push/sender"
import { loginCookie, makeTestApp, openWs, TEST_ORIGIN, vapidTestEnv, type TestApp, type WsTestClient } from "./helpers"

const logLines: string[] = []
const logStream = new Writable({
  write(chunk, _enc, cb) {
    logLines.push(chunk.toString())
    cb()
  },
})

function logged(evt: string): Array<Record<string, unknown>> {
  return logLines
    .map((l) => {
      try {
        return JSON.parse(l) as Record<string, unknown>
      } catch {
        return {}
      }
    })
    .filter((l) => l.evt === evt)
}

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

type SendCall = Parameters<WebPushSend>
let sendImpl: (...args: SendCall) => Promise<unknown> = async () => ({ statusCode: 201 })
const send = vi.fn<WebPushSend>((...args) => sendImpl(...args))

let t: TestApp
let aliceCookie: string
let bobCookie: string
let aliceId: string

beforeAll(async () => {
  t = await makeTestApp({ seed: true, logStream, env: vapidTestEnv(), webPushSend: send })
  aliceCookie = await loginCookie(t.app, "alice")
  bobCookie = await loginCookie(t.app, "bob")
  aliceId = t.app.db.select({ id: users.id }).from(users).where(eq(users.username, "alice")).get()!.id
})
afterAll(async () => {
  await t.close()
})

function post(app: TestApp["app"], url: string, cookie: string | null, payload: unknown, origin: string | null = TEST_ORIGIN) {
  const headers: Record<string, string> = {}
  if (cookie) headers.cookie = cookie
  if (origin) headers.origin = origin
  return app.inject({ method: "POST", url, headers, payload: payload as object })
}

async function subscribe(cookie: string, body = subscription(), app = t.app) {
  const res = await post(app, "/api/push/subscriptions", cookie, body)
  expect(res.statusCode).toBe(200)
  expect(res.json()).toEqual({ ok: true })
  return body
}

async function message(cookie: string, body: string, app = t.app) {
  const res = await post(app, "/api/messages", cookie, { id: randomUUID(), body })
  expect(res.statusCode).toBeLessThan(300)
  return res.json().message as { seq: number }
}

/** Alice has read everything so far, so the unread count starts from zero. */
async function aliceReadsAll() {
  const max = t.app.db.select({ n: sql<number>`coalesce(max(${messages.seq}), 0)` }).from(messages).get()!.n
  if (max > 0) expect((await post(t.app, "/api/read", aliceCookie, { seq: max })).statusCode).toBe(200)
}

function payloadOf(i: number): { t: string; title: string; body: string } {
  return JSON.parse(send.mock.calls[i]![1]) as { t: string; title: string; body: string }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

beforeEach(async () => {
  t.app.db.delete(pushSubscriptions).run()
  send.mockClear()
  sendImpl = async () => ({ statusCode: 201 })
  await aliceReadsAll()
})

describe("push on a new message (NOTF-01, D-13)", () => {
  it("pushes bob's message to alice's saved subscription with the D-13 payload and options", async () => {
    const sub = await subscribe(aliceCookie)
    await message(bobCookie, "hello alice")
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1))
    const [target, , options] = send.mock.calls[0]!
    expect(target).toEqual({ endpoint: sub.endpoint, keys: sub.keys })
    expect(options).toMatchObject({ TTL: 86400, urgency: "high", topic: "duet-chat", timeout: 10000 })
    expect(payloadOf(0)).toEqual({ t: "chat", title: "Bob Test", body: "hello alice" })
    // The sender gets nothing back.
    await message(aliceCookie, "hi bob")
    await sleep(30)
    expect(send).toHaveBeenCalledTimes(1)
  })

  it("titles the push with the unread count from 2 and cuts a long body to 120 graphemes + …", async () => {
    await subscribe(aliceCookie)
    await message(bobCookie, "first")
    await message(bobCookie, "x".repeat(300))
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(2))
    expect(payloadOf(0).title).toBe("Bob Test")
    expect(payloadOf(1).title).toBe("Bob Test · 2 new messages")
    expect(payloadOf(1).body).toBe(`${"x".repeat(120)}…`)
  })

  it("never splits an emoji sequence and keeps the payload under 4 KB", async () => {
    await subscribe(aliceCookie)
    const family = "👨‍👩‍👧‍👦"
    await message(bobCookie, family.repeat(200))
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1))
    const raw = send.mock.calls[0]![1]
    expect(Buffer.byteLength(raw, "utf8")).toBeLessThan(4096)
    const body = payloadOf(0).body
    expect(body.endsWith("…")).toBe(true)
    expect(body.slice(0, -1).split(family).join("")).toBe("")
  })
})

describe("no push while viewing (NOTF-03, D-15)", () => {
  async function settle(c: WsTestClient) {
    c.send({ t: "ping" })
    for (;;) {
      const f = await c.next()
      if (f.t === "pong") return
    }
  }

  it("suppresses while alice's app is visible and pushes again once it is hidden", async () => {
    await subscribe(aliceCookie)
    const c = await openWs(t.app, aliceCookie, TEST_ORIGIN)
    expect((await c.next()).t).toBe("hello")
    c.send({ t: "presence", visible: true })
    await settle(c)

    const before = logged("push_suppressed").length
    const m = await message(bobCookie, "while viewing")
    await sleep(30)
    expect(send).toHaveBeenCalledTimes(0)
    const suppressed = logged("push_suppressed")
    expect(suppressed.length).toBe(before + 1)
    expect(suppressed.at(-1)).toMatchObject({ userId: aliceId, seq: m.seq })

    c.send({ t: "presence", visible: false })
    await settle(c)
    await message(bobCookie, "while hidden")
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1))
    c.ws.terminate()
  })
})

describe("failures and pruning", () => {
  it("deletes the subscription on 410 and keeps it on 500, logging only code and host", async () => {
    const gone = await subscribe(aliceCookie)
    sendImpl = async () => {
      throw Object.assign(new Error("Received unexpected response code"), { statusCode: 410 })
    }
    await message(bobCookie, "to a dead subscription")
    await vi.waitFor(() => {
      const row = t.app.db.select().from(pushSubscriptions).where(eq(pushSubscriptions.endpoint, gone.endpoint)).get()
      expect(row).toBeUndefined()
    })

    const kept = await subscribe(aliceCookie)
    sendImpl = async () => {
      throw Object.assign(new Error("Received unexpected response code"), { statusCode: 500 })
    }
    const before = logged("push_failed").length
    await message(bobCookie, "to a flaky push service")
    await vi.waitFor(() => expect(logged("push_failed").length).toBe(before + 1))
    const row = t.app.db.select().from(pushSubscriptions).where(eq(pushSubscriptions.endpoint, kept.endpoint)).get()
    expect(row).toBeDefined()
    const line = logged("push_failed").at(-1)!
    expect(line).toMatchObject({ code: 500, host: "fcm.googleapis.com" })
    const path = new URL(kept.endpoint).pathname
    expect(logLines.some((l) => l.includes(path))).toBe(false)
    expect(logLines.some((l) => l.includes(kept.keys.p256dh) || l.includes(kept.keys.auth))).toBe(false)
  })
})

describe("POST /api/push/subscriptions validation (T-02-14)", () => {
  it("rejects endpoints outside the push services, oversize endpoints and malformed keys with 400", async () => {
    for (const endpoint of ["http://127.0.0.1/x", "https://evil.example/x", `https://fcm.googleapis.com/${"a".repeat(3000)}`]) {
      const res = await post(t.app, "/api/push/subscriptions", aliceCookie, subscription(endpoint))
      expect(res.statusCode).toBe(400)
      expect(res.json()).toEqual({ error: "invalid_body" })
    }
    const bad = { ...subscription(), keys: { p256dh: "short", auth: "x" } }
    expect((await post(t.app, "/api/push/subscriptions", aliceCookie, bad)).statusCode).toBe(400)
    const extra = { ...subscription(), extra: 1 }
    expect((await post(t.app, "/api/push/subscriptions", aliceCookie, extra)).statusCode).toBe(400)
    expect(t.app.db.select().from(pushSubscriptions).all()).toHaveLength(0)
  })

  it("accepts Apple endpoints and upserts by endpoint", async () => {
    const sub = subscription(`https://web.push.apple.com/${randomUUID()}`)
    await subscribe(aliceCookie, sub)
    await subscribe(aliceCookie, sub)
    expect(t.app.db.select().from(pushSubscriptions).all()).toHaveLength(1)
  })

  it("answers 401 without a session and 403 without an Origin", async () => {
    expect((await post(t.app, "/api/push/subscriptions", null, subscription())).statusCode).toBe(401)
    expect((await post(t.app, "/api/push/subscriptions", aliceCookie, subscription(), null)).statusCode).toBe(403)
    expect((await t.app.inject({ method: "GET", url: "/api/push/vapid-public-key" })).statusCode).toBe(401)
  })

  it("serves the VAPID public key to a logged-in user, never cached", async () => {
    const res = await t.app.inject({ method: "GET", url: "/api/push/vapid-public-key", headers: { cookie: aliceCookie } })
    expect(res.statusCode).toBe(200)
    expect(res.headers["cache-control"]).toBe("no-store")
    expect(res.json().key).toBe(t.app.config.VAPID_PUBLIC_KEY)
  })
})

describe("logout removes the device's subscriptions (T-02-15)", () => {
  it("cascades the subscription away with the session, so later messages push nothing", async () => {
    const second = await loginCookie(t.app, "alice")
    const sub = await subscribe(second)
    expect((await post(t.app, "/api/logout", second, {})).statusCode).toBe(200)
    const row = t.app.db.select().from(pushSubscriptions).where(eq(pushSubscriptions.endpoint, sub.endpoint)).get()
    expect(row).toBeUndefined()
    await message(bobCookie, "after logout")
    await sleep(30)
    expect(send).toHaveBeenCalledTimes(0)
  })
})

describe("POST /api/push/test (SHEL-03)", () => {
  function test(cookie: string, ip: string) {
    return t.app.inject({
      method: "POST",
      url: "/api/push/test",
      headers: { cookie, origin: TEST_ORIGIN, "cf-connecting-ip": ip },
      payload: {},
    })
  }

  it("pushes only to this session's subscriptions", async () => {
    const other = await loginCookie(t.app, "alice")
    const mine = await subscribe(aliceCookie)
    await subscribe(other)
    const res = await test(aliceCookie, "10.20.0.1")
    expect(res.statusCode).toBe(200)
    expect(res.headers["cache-control"]).toBe("no-store")
    expect(res.json()).toEqual({ sent: 1 })
    expect(send).toHaveBeenCalledTimes(1)
    expect(send.mock.calls[0]![0].endpoint).toBe(mine.endpoint)
    expect(payloadOf(0)).toEqual({ t: "test", title: "duet", body: "Test notification. You're all set." })
    expect(send.mock.calls[0]![2]).toMatchObject({ topic: "duet-test", TTL: 86400, urgency: "high" })
  })

  it("answers {sent: 0} without subscriptions or when the push service fails", async () => {
    expect((await test(aliceCookie, "10.20.0.2")).json()).toEqual({ sent: 0 })
    await subscribe(aliceCookie)
    sendImpl = async () => {
      throw Object.assign(new Error("boom"), { statusCode: 500 })
    }
    expect((await test(aliceCookie, "10.20.0.2")).json()).toEqual({ sent: 0 })
  })

  it("limits each client IP to 10 a minute", async () => {
    for (let i = 0; i < 10; i += 1) expect((await test(aliceCookie, "10.20.0.3")).statusCode).toBe(200)
    const limited = await test(aliceCookie, "10.20.0.3")
    expect(limited.statusCode).toBe(429)
    expect(limited.json().error).toBe("rate_limited")
  })

  it("answers 401 without a session and 403 without an Origin", async () => {
    expect((await post(t.app, "/api/push/test", null, {})).statusCode).toBe(401)
    expect((await post(t.app, "/api/push/test", aliceCookie, {}, null)).statusCode).toBe(403)
  })
})

describe("without VAPID configuration", () => {
  let bare: TestApp
  const bareSend = vi.fn<WebPushSend>(async () => ({}))

  beforeAll(async () => {
    bare = await makeTestApp({ seed: true, webPushSend: bareSend })
  })
  afterAll(async () => {
    await bare.close()
  })

  it("answers 503 push_unconfigured and still sends messages", async () => {
    const alice = await loginCookie(bare.app, "alice")
    const bob = await loginCookie(bare.app, "bob")
    const key = await bare.app.inject({ method: "GET", url: "/api/push/vapid-public-key", headers: { cookie: alice } })
    expect(key.statusCode).toBe(503)
    expect(key.json()).toEqual({ error: "push_unconfigured" })
    const sub = await post(bare.app, "/api/push/subscriptions", alice, subscription())
    expect(sub.statusCode).toBe(503)
    expect((await post(bare.app, "/api/push/test", alice, {})).statusCode).toBe(503)
    await message(bob, "still delivered", bare.app)
    await sleep(30)
    expect(bareSend).not.toHaveBeenCalled()
  })
})
