import { createECDH, randomBytes, randomUUID } from "node:crypto"
import sharp from "sharp"
import { Writable } from "node:stream"
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import { eq, sql } from "drizzle-orm"
import { messages, pushSubscriptions, users } from "../src/db/schema"
import { buildPayload, PUSH_REASON_MAX_CHARS, pushFailureReason, type WebPushSend } from "../src/push/sender"
import {
  loginCookie,
  makeTestApp,
  openWs,
  TEST_ORIGIN,
  uploadBytes,
  vapidTestEnv,
  type TestApp,
  type WsTestClient,
} from "./helpers"

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

/** A Safari/iOS endpoint: web.push.apple.com plus a 128-char base64url token. */
function appleEndpoint() {
  return `https://web.push.apple.com/${randomBytes(96).toString("base64url")}`
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
    expect(options).toMatchObject({ TTL: 86400, urgency: "high", timeout: 10000 })
    // G-02-7: no Topic header to any push service (Apple answers any Topic with 400 BadWebPushTopic).
    expect(options).not.toHaveProperty("topic")
    // Privacy: the body is the type only. The text never reaches Apple's or Google's push service.
    expect(payloadOf(0)).toEqual({ t: "chat", title: "Bob Test", body: "Message" })
    expect(send.mock.calls[0]![1]).not.toContain("hello alice")
    // The sender gets nothing back.
    await message(aliceCookie, "hi bob")
    await sleep(30)
    expect(send).toHaveBeenCalledTimes(1)
  })

  it("pushes to an Apple subscription with the same options and no topic (G-02-7)", async () => {
    const sub = await subscribe(aliceCookie, subscription(appleEndpoint()))
    await message(bobCookie, "hello iphone")
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1))
    const [target, , options] = send.mock.calls[0]!
    expect(target.endpoint).toBe(sub.endpoint)
    expect(options).toMatchObject({ TTL: 86400, urgency: "high", timeout: 10000 })
    expect(options).not.toHaveProperty("topic")
  })

  it("titles the push with the unread count from 2 and never carries the text", async () => {
    await subscribe(aliceCookie)
    await message(bobCookie, "first")
    await message(bobCookie, "x".repeat(300))
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(2))
    expect(payloadOf(0).title).toBe("Bob Test")
    expect(payloadOf(1).title).toBe("Bob Test · 2 new messages")
    expect(payloadOf(1).body).toBe("Message")
    expect(send.mock.calls[1]![1]).not.toContain("x".repeat(300))
    expect(send.mock.calls[0]![1]).not.toContain("first")
  })

  it("pushes 'Message' for an emoji-only text message", async () => {
    await subscribe(aliceCookie)
    const family = "👨‍👩‍👧‍👦"
    await message(bobCookie, family.repeat(200))
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1))
    expect(payloadOf(0).body).toBe("Message")
    expect(send.mock.calls[0]![1]).not.toContain(family)
  })

  it("never puts a photo caption in the push", async () => {
    await subscribe(aliceCookie)
    const bytes = await sharp({ create: { width: 64, height: 48, channels: 3, background: { r: 180, g: 40, b: 70 } } })
      .jpeg({ quality: 80 })
      .toBuffer()
    const { id } = await uploadBytes(t.app, bobCookie, bytes)
    await t.app.media.idle()
    const res = await post(t.app, "/api/messages", bobCookie, { id: randomUUID(), body: "secret caption", attachmentIds: [id] })
    expect(res.statusCode).toBeLessThan(300)
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1))
    expect(payloadOf(0)).toEqual({ t: "chat", title: "Bob Test", body: "Photo" })
    expect(send.mock.calls[0]![1]).not.toContain("secret caption")
  })
})

describe("buildPayload (D-13 truncation, 4 KB cap)", () => {
  it("cuts a long body to 120 graphemes + …", () => {
    const p = JSON.parse(buildPayload("chat", "T", "x".repeat(300))) as { body: string }
    expect(p.body).toBe(`${"x".repeat(120)}…`)
  })

  it("never splits an emoji sequence and keeps the payload under 4 KB", () => {
    const family = "👨‍👩‍👧‍👦"
    const raw = buildPayload("chat", "T", family.repeat(200))
    expect(Buffer.byteLength(raw, "utf8")).toBeLessThan(4096)
    const body = (JSON.parse(raw) as { body: string }).body
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
    // No body on the error: no reason key.
    expect(line).not.toHaveProperty("reason")
    const path = new URL(kept.endpoint).pathname
    expect(logLines.some((l) => l.includes(path))).toBe(false)
    expect(logLines.some((l) => l.includes(kept.keys.p256dh) || l.includes(kept.keys.auth))).toBe(false)
  })
})

describe("push_failed reason (G-02-7, T-02-16, T-02-36, T-02-37)", () => {
  it("logs Apple's BadWebPushTopic reason for a 400 and keeps the subscription", async () => {
    const sub = await subscribe(aliceCookie, subscription(appleEndpoint()))
    sendImpl = async () => {
      throw Object.assign(new Error("Received unexpected response code"), {
        statusCode: 400,
        body: '{"reason":"BadWebPushTopic"}',
      })
    }
    const before = logged("push_failed").length
    await message(bobCookie, "to apple")
    await vi.waitFor(() => expect(logged("push_failed").length).toBe(before + 1))
    expect(logged("push_failed").at(-1)).toMatchObject({
      code: 400,
      host: "web.push.apple.com",
      pruned: false,
      reason: "BadWebPushTopic",
    })
    const row = t.app.db.select().from(pushSubscriptions).where(eq(pushSubscriptions.endpoint, sub.endpoint)).get()
    expect(row).toBeDefined()
  })

  it("caps and sanitizes a long text body: no newline, no endpoint path or token, no keys", async () => {
    const sub = await subscribe(aliceCookie, subscription(appleEndpoint()))
    const path = new URL(sub.endpoint).pathname
    const token = path.slice(1)
    const body = `Rejected ${sub.endpoint}\nfor subscription ${path} (token ${token})\n${"detail ".repeat(100)}`.slice(0, 600)
    expect(body.length).toBe(600)
    sendImpl = async () => {
      throw Object.assign(new Error("Received unexpected response code"), { statusCode: 500, body })
    }
    const before = logged("push_failed").length
    await message(bobCookie, "to a chatty push service")
    await vi.waitFor(() => expect(logged("push_failed").length).toBe(before + 1))
    const line = logged("push_failed").at(-1)!
    expect(line).toMatchObject({ code: 500, host: "web.push.apple.com", pruned: false })
    const reason = line.reason as string
    expect(typeof reason).toBe("string")
    expect([...reason].length).toBeLessThanOrEqual(PUSH_REASON_MAX_CHARS)
    expect(reason).not.toMatch(/[\n\r]/)
    expect(reason).not.toContain(path)
    expect(reason).not.toContain(token)
    expect(logLines.some((l) => l.includes(path) || l.includes(token))).toBe(false)
    expect(logLines.some((l) => l.includes(sub.keys.p256dh) || l.includes(sub.keys.auth))).toBe(false)
  })
})

describe("pushFailureReason", () => {
  const endpoint = `https://fcm.googleapis.com/fcm/send/${randomUUID()}`

  it("gives undefined for missing, blank and non-string bodies", () => {
    for (const body of [undefined, null, "", "   \n\t ", 42, {}, Buffer.from("x")]) {
      expect(pushFailureReason(body, endpoint)).toBeUndefined()
    }
  })

  it("passes an identifier-shaped JSON reason through as-is", () => {
    expect(pushFailureReason('{"reason":"BadWebPushTopic"}', endpoint)).toBe("BadWebPushTopic")
  })

  it("trims an FCM-style text body", () => {
    expect(pushFailureReason("push subscription has unsubscribed or expired.\n", endpoint)).toBe(
      "push subscription has unsubscribed or expired.",
    )
  })

  it("takes the message of a Mozilla-style JSON body", () => {
    const body = JSON.stringify({ code: 410, errno: 106, message: "Request did not validate No such subscription" })
    expect(pushFailureReason(body, endpoint)).toBe("Request did not validate No such subscription")
  })

  it("redacts endpoint path segments and URLs, flattens control characters and caps the length", () => {
    const id = new URL(endpoint).pathname.split("/").at(-1)!
    const out = pushFailureReason(`bad ${id}\r\n\u0000at ${endpoint} and https://example.com/x?y=1 ${"z".repeat(300)}`, endpoint)!
    expect(out.startsWith("bad [redacted] at [url] and [url] z")).toBe(true)
    expect(out).not.toContain(id)
    expect([...out].length).toBe(PUSH_REASON_MAX_CHARS)
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
    expect(send.mock.calls[0]![2]).toMatchObject({ TTL: 86400, urgency: "high" })
    expect(send.mock.calls[0]![2]).not.toHaveProperty("topic")
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
