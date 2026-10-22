import { createECDH, randomBytes, randomUUID } from "node:crypto"
import { Writable } from "node:stream"
import { afterEach, describe, expect, it, vi } from "vitest"
import { eq } from "drizzle-orm"
import { istToEpoch, type ReminderRule } from "@duet/shared"
import { messages, reminders, users } from "../src/db/schema"
import type { WebPushSend } from "../src/push/sender"
import { loginCookie, makeTestApp, openWs, TEST_ORIGIN, vapidTestEnv, type TestApp, type WsFrame, type WsTestClient } from "./helpers"

/**
 * QT-nw9-reminder-store / QT-nw9-reminder-fire: the reminders API, the scheduler (injected clock,
 * tick() called by hand), pushes only to the target(s), suppression while viewing, the 5-minute late
 * grace, and no title in the logs (T-nw9-03).
 */

const MIN = 60_000
const T0 = istToEpoch("2026-10-21", "12:00")

let apps: TestApp[] = []
let sockets: WsTestClient[] = []

afterEach(async () => {
  for (const c of sockets) c.ws.terminate()
  sockets = []
  for (const a of apps) await a.close()
  apps = []
})

function subscription() {
  const ecdh = createECDH("prime256v1")
  ecdh.generateKeys()
  return {
    endpoint: `https://fcm.googleapis.com/fcm/send/${randomUUID()}`,
    expirationTime: null,
    keys: { p256dh: ecdh.getPublicKey().toString("base64url"), auth: randomBytes(16).toString("base64url") },
  }
}

async function setup() {
  let clock = T0
  const logLines: string[] = []
  const logStream = new Writable({
    write(chunk, _enc, cb) {
      logLines.push(chunk.toString())
      cb()
    },
  })
  const send = vi.fn<WebPushSend>(async () => ({ statusCode: 201 }))
  const t = await makeTestApp({ seed: true, env: vapidTestEnv(), webPushSend: send, logStream, now: () => clock })
  apps.push(t)
  const idOf = (username: string) => t.app.db.select({ id: users.id }).from(users).where(eq(users.username, username)).get()!.id
  const aliceCookie = await loginCookie(t.app, "alice")
  const bobCookie = await loginCookie(t.app, "bob")
  const subs: Record<string, string> = {}
  for (const [who, cookie] of [
    ["alice", aliceCookie],
    ["bob", bobCookie],
  ] as const) {
    const body = subscription()
    const res = await t.app.inject({ method: "POST", url: "/api/push/subscriptions", headers: { cookie, origin: TEST_ORIGIN }, payload: body })
    expect(res.statusCode).toBe(200)
    subs[who] = body.endpoint
  }
  const api = (cookie: string | null, method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE", url: string, payload?: unknown) =>
    t.app.inject({
      method,
      url,
      headers: cookie ? { cookie, origin: TEST_ORIGIN } : { origin: TEST_ORIGIN },
      ...(payload !== undefined ? { payload: payload as Record<string, unknown> } : {}),
    })
  /** Push payloads sent so far, with the endpoint they went to. */
  const pushes = () =>
    send.mock.calls.map((c): { endpoint: string; ttl: number | undefined } & Record<string, unknown> => ({
      endpoint: c[0].endpoint,
      ttl: c[2].TTL,
      ...(JSON.parse(c[1]) as Record<string, unknown>),
    }))
  return {
    t,
    logLines,
    send,
    pushes,
    subs,
    api,
    aliceCookie,
    bobCookie,
    aliceId: idOf("alice"),
    bobId: idOf("bob"),
    setClock: (ms: number) => {
      clock = ms
    },
  }
}

async function connect(t: TestApp, cookie: string, visible = false): Promise<WsTestClient> {
  const c = await openWs(t.app, cookie, TEST_ORIGIN)
  sockets.push(c)
  expect((await c.next()).t).toBe("hello")
  if (visible) {
    c.send({ t: "presence", visible: true })
    c.send({ t: "ping" })
    for (;;) if ((await c.next()).t === "pong") break
  }
  return c
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

function onceAt(ms: number, patch: Partial<Extract<ReminderRule, { kind: "once" }>> = {}): ReminderRule {
  const d = new Date(ms + 330 * MIN)
  const pad = (n: number) => String(n).padStart(2, "0")
  return {
    kind: "once",
    date: `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`,
    time: `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`,
    leadMinutes: null,
    repeat: "none",
    ...patch,
  }
}

function reminderLines(t: TestApp) {
  return t.app.db.select().from(messages).where(eq(messages.kind, "reminder")).all()
}

describe("/api/reminders", () => {
  it("requires a session", async () => {
    const e = await setup()
    for (const [method, url] of [
      ["GET", "/api/reminders"],
      ["POST", "/api/reminders"],
      ["PUT", `/api/reminders/${randomUUID()}`],
      ["PATCH", `/api/reminders/${randomUUID()}`],
      ["DELETE", `/api/reminders/${randomUUID()}`],
    ] as const) {
      const res = await e.api(null, method, url, method === "GET" || method === "DELETE" ? undefined : {})
      expect(res.statusCode).toBe(401)
    }
  })

  it("creates, lists for both, replaces, toggles and deletes; either person may manage any reminder", async () => {
    const e = await setup()
    const created = await e.api(e.aliceCookie, "POST", "/api/reminders", {
      title: "  Call mum  ",
      forUserId: e.bobId,
      rule: onceAt(T0 + 10 * MIN),
    })
    expect(created.statusCode).toBe(200)
    const r = created.json().reminder
    expect(r).toEqual({
      id: expect.any(String),
      creatorId: e.aliceId,
      forUserId: e.bobId,
      title: "Call mum",
      rule: onceAt(T0 + 10 * MIN),
      enabled: true,
      nextAt: T0 + 10 * MIN,
      nextLeadMinutes: null,
      createdAt: T0,
    })
    const list = await e.api(e.bobCookie, "GET", "/api/reminders")
    expect(list.statusCode).toBe(200)
    expect(list.headers["cache-control"]).toBe("no-store")
    expect(list.json()).toEqual({ reminders: [r] })

    const replaced = await e.api(e.bobCookie, "PUT", `/api/reminders/${r.id}`, {
      title: "Water",
      forUserId: null,
      rule: { kind: "recurring", everyMinutes: 60, from: "09:00", until: "22:00", days: [0, 1, 2, 3, 4, 5, 6] },
    })
    expect(replaced.statusCode).toBe(200)
    expect(replaced.json().reminder).toMatchObject({
      id: r.id,
      creatorId: e.aliceId,
      forUserId: null,
      title: "Water",
      enabled: true,
      nextAt: istToEpoch("2026-10-21", "13:00"),
    })

    const off = await e.api(e.bobCookie, "PATCH", `/api/reminders/${r.id}`, { enabled: false })
    expect(off.json().reminder).toMatchObject({ enabled: false, nextAt: null, nextLeadMinutes: null })
    const on = await e.api(e.aliceCookie, "PATCH", `/api/reminders/${r.id}`, { enabled: true })
    expect(on.json().reminder).toMatchObject({ enabled: true, nextAt: istToEpoch("2026-10-21", "13:00") })
    expect((await e.api(e.aliceCookie, "PATCH", `/api/reminders/${r.id}`, { enabled: "yes" })).statusCode).toBe(400)

    const del = await e.api(e.bobCookie, "DELETE", `/api/reminders/${r.id}`)
    expect(del.statusCode).toBe(200)
    expect(del.json()).toEqual({ ok: true })
    expect((await e.api(e.bobCookie, "DELETE", `/api/reminders/${r.id}`)).statusCode).toBe(404)
    expect((await e.api(e.bobCookie, "PATCH", `/api/reminders/${r.id}`, { enabled: true })).statusCode).toBe(404)
    expect((await e.api(e.bobCookie, "PUT", "/api/reminders/not-a-uuid", { enabled: true })).statusCode).toBe(404)
  })

  it("validates bodies: invalid_body, unknown forUserId, in_past, and too_many past 100", async () => {
    const e = await setup()
    const bad = await e.api(e.aliceCookie, "POST", "/api/reminders", { title: "", forUserId: null, rule: onceAt(T0 + MIN) })
    expect(bad.statusCode).toBe(400)
    expect(bad.json()).toEqual({ error: "invalid_body" })
    const stranger = await e.api(e.aliceCookie, "POST", "/api/reminders", {
      title: "x",
      forUserId: randomUUID(),
      rule: onceAt(T0 + MIN),
    })
    expect(stranger.json()).toEqual({ error: "invalid_body" })
    const past = await e.api(e.aliceCookie, "POST", "/api/reminders", { title: "x", forUserId: null, rule: onceAt(T0 - MIN) })
    expect(past.statusCode).toBe(400)
    expect(past.json()).toEqual({ error: "in_past" })

    const rule = { kind: "recurring", everyMinutes: 60, from: "09:00", until: "22:00", days: [1] }
    for (let i = 0; i < 100; i++) {
      const res = await e.api(e.aliceCookie, "POST", "/api/reminders", { title: `r${i}`, forUserId: null, rule })
      expect(res.statusCode).toBe(200)
    }
    const over = await e.api(e.aliceCookie, "POST", "/api/reminders", { title: "r100", forUserId: null, rule })
    expect(over.statusCode).toBe(409)
    expect(over.json()).toEqual({ error: "too_many" })
  })

  it("re-enabling a finished one-time reminder is in_past", async () => {
    const e = await setup()
    const r = (await e.api(e.aliceCookie, "POST", "/api/reminders", { title: "x", forUserId: null, rule: onceAt(T0 + MIN) })).json()
      .reminder
    e.setClock(T0 + 2 * MIN)
    const res = await e.api(e.aliceCookie, "PATCH", `/api/reminders/${r.id}`, { enabled: true })
    expect(res.statusCode).toBe(400)
    expect(res.json()).toEqual({ error: "in_past" })
  })
})

describe("the reminder scheduler", () => {
  it("fires on time: a line for both, a push only to the target, then Done; never the title in logs", async () => {
    const e = await setup()
    const title = `Secret plan ${randomUUID()}`
    const r = (await e.api(e.aliceCookie, "POST", "/api/reminders", { title, forUserId: e.bobId, rule: onceAt(T0 + 10 * MIN) })).json()
      .reminder
    const alice = await connect(e.t, e.aliceCookie)
    const bob = await connect(e.t, e.bobCookie)

    e.setClock(T0 + 5 * MIN)
    e.t.app.reminders.tick()
    expect(await bob.collect(50)).toEqual([])
    expect(e.send).not.toHaveBeenCalled()

    e.setClock(T0 + 10 * MIN + 10_000)
    e.t.app.reminders.tick()
    const fa = await nextOf(alice, "msg")
    const fb = await nextOf(bob, "msg")
    expect(fa).toEqual(fb)
    expect(fb.message).toMatchObject({
      kind: "reminder",
      senderId: e.aliceId,
      body: title,
      reminder: { forUserId: e.bobId, leadMinutes: null },
      call: null,
    })
    await vi.waitFor(() => expect(e.send).toHaveBeenCalledTimes(1))
    expect(e.pushes()).toEqual([{ endpoint: e.subs.bob, ttl: 300, t: "reminder", title: `⏰ ${title}`, body: "Reminder · from Alice Test" }])

    const after = (await e.api(e.bobCookie, "GET", "/api/reminders")).json().reminders[0]
    expect(after).toMatchObject({ id: r.id, enabled: false, nextAt: null })

    // A second tick fires nothing again.
    e.t.app.reminders.tick()
    expect(reminderLines(e.t)).toHaveLength(1)

    // A reminder line takes no replies or reactions (T-nw9-02).
    const seq = fb.message.seq as number
    const reply = await e.api(e.bobCookie, "POST", "/api/messages", { id: randomUUID(), body: "ok", replyToSeq: seq })
    expect(reply.json()).toEqual({ error: "bad_reply" })
    expect((await e.api(e.bobCookie, "PUT", `/api/messages/${seq}/reaction`, { emoji: "💕" })).statusCode).toBe(404)

    await new Promise((r) => setTimeout(r, 30))
    const raw = e.logLines.join("\n")
    expect(raw).toContain('"reminder_fired"')
    expect(raw).toContain('"push_reminder"')
    expect(raw).not.toContain(title)
  })

  it("a target viewing duet gets the line but no push", async () => {
    const e = await setup()
    await e.api(e.aliceCookie, "POST", "/api/reminders", { title: "Hi", forUserId: e.bobId, rule: onceAt(T0 + MIN) })
    const bob = await connect(e.t, e.bobCookie, true)
    e.setClock(T0 + MIN)
    e.t.app.reminders.tick()
    expect((await nextOf(bob, "msg")).message.kind).toBe("reminder")
    await new Promise((r) => setTimeout(r, 50))
    expect(e.send).not.toHaveBeenCalled()
    expect(e.logLines.some((l) => l.includes('"push_suppressed"'))).toBe(true)
  })

  it("a reminder for yourself pushes only to you (body Reminder) and both sockets get the line", async () => {
    const e = await setup()
    await e.api(e.aliceCookie, "POST", "/api/reminders", { title: "Stretch", forUserId: e.aliceId, rule: onceAt(T0 + MIN) })
    const alice = await connect(e.t, e.aliceCookie)
    const bob = await connect(e.t, e.bobCookie)
    e.setClock(T0 + MIN)
    e.t.app.reminders.tick()
    await nextOf(alice, "msg")
    expect((await nextOf(bob, "msg")).message.reminder).toEqual({ forUserId: e.aliceId, leadMinutes: null })
    await vi.waitFor(() => expect(e.send).toHaveBeenCalledTimes(1))
    expect(e.pushes()).toEqual([{ endpoint: e.subs.alice, ttl: 300, t: "reminder", title: "⏰ Stretch", body: "Reminder" }])
  })

  it("a reminder for both pushes to both", async () => {
    const e = await setup()
    await e.api(e.bobCookie, "POST", "/api/reminders", { title: "Dinner", forUserId: null, rule: onceAt(T0 + MIN) })
    e.setClock(T0 + MIN)
    e.t.app.reminders.tick()
    await vi.waitFor(() => expect(e.send).toHaveBeenCalledTimes(2))
    const byEndpoint = Object.fromEntries(e.pushes().map((p) => [p.endpoint, p.body]))
    expect(byEndpoint).toEqual({ [e.subs.alice]: "Reminder · from Bob Test", [e.subs.bob]: "Reminder" })
    expect(reminderLines(e.t)).toHaveLength(1)
  })

  it("late grace: 4 minutes late still fires, 6 minutes late is skipped and logged", async () => {
    const e = await setup()
    await e.api(e.aliceCookie, "POST", "/api/reminders", { title: "a", forUserId: null, rule: onceAt(T0 + MIN) })
    await e.api(e.aliceCookie, "POST", "/api/reminders", { title: "b", forUserId: null, rule: onceAt(T0 + 3 * MIN) })
    e.setClock(T0 + 7 * MIN)
    e.t.app.reminders.tick()
    expect(reminderLines(e.t).map((m) => m.body)).toEqual(["b"])
    const skipped = e.logLines.map((l) => JSON.parse(l) as Record<string, unknown>).filter((l) => l.evt === "reminder_skipped_late")
    expect(skipped).toHaveLength(1)
    expect(skipped[0]).toMatchObject({ lateMs: 6 * MIN })
    const rows = e.t.app.db.select().from(reminders).all()
    expect(rows.every((row) => !row.enabled && row.nextFireAt === null)).toBe(true)
  })

  it("a long downtime fires at most once and moves to the next future slot; a repeating one leaves no line", async () => {
    const e = await setup()
    await e.api(e.aliceCookie, "POST", "/api/reminders", {
      title: "Water",
      forUserId: null,
      rule: { kind: "recurring", everyMinutes: 60, from: "09:00", until: "22:00", days: [0, 1, 2, 3, 4, 5, 6] },
    })
    const bob = await connect(e.t, e.bobCookie)
    // Next is 13:00; the server comes back at 16:02, two minutes after the 16:00 slot.
    e.setClock(istToEpoch("2026-10-21", "16:02"))
    e.t.app.reminders.tick()
    // QT-fast-recurring-quiet: a live-only frame for the toast, no stored chat line.
    expect(await nextOf(bob, "reminder")).toMatchObject({ senderId: e.aliceId, title: "Water", forUserId: null, leadMinutes: null })
    expect(reminderLines(e.t)).toHaveLength(0)
    // Bob is connected but not viewing, so both people get the push: one fire.
    await vi.waitFor(() => expect(e.send).toHaveBeenCalledTimes(2))
    const row = e.t.app.db.select().from(reminders).get()!
    expect(row.nextFireAt).toBe(istToEpoch("2026-10-21", "17:00"))
    expect(row.enabled).toBe(true)
    // Three hours with no slot inside the grace: nothing fires.
    e.setClock(istToEpoch("2026-10-21", "20:30"))
    e.t.app.reminders.tick()
    expect(await bob.collect(50)).toEqual([])
    expect(e.send).toHaveBeenCalledTimes(2)
    expect(e.t.app.db.select().from(reminders).get()!.nextFireAt).toBe(istToEpoch("2026-10-21", "21:00"))
  })

  it("a heads-up fires twice: first with the lead, then the reminder itself", async () => {
    const e = await setup()
    await e.api(e.aliceCookie, "POST", "/api/reminders", {
      title: "Meeting",
      forUserId: e.bobId,
      rule: onceAt(T0 + 30 * MIN, { leadMinutes: 15 }),
    })
    e.setClock(T0 + 15 * MIN)
    e.t.app.reminders.tick()
    e.setClock(T0 + 30 * MIN)
    e.t.app.reminders.tick()
    expect(reminderLines(e.t).map((m) => m.reminderLeadMin)).toEqual([15, null])
    await vi.waitFor(() => expect(e.send).toHaveBeenCalledTimes(2))
    expect(e.pushes().map((p) => p.body)).toEqual(["In 15 min · from Alice Test", "Reminder · from Alice Test"])
    expect(e.t.app.db.select().from(reminders).get()!.enabled).toBe(false)
  })

  it("a stored rule that no longer parses disables only that reminder", async () => {
    const e = await setup()
    await e.api(e.aliceCookie, "POST", "/api/reminders", { title: "good", forUserId: null, rule: onceAt(T0 + MIN) })
    const bad = (await e.api(e.aliceCookie, "POST", "/api/reminders", { title: "bad", forUserId: null, rule: onceAt(T0 + MIN) })).json()
      .reminder
    e.t.app.db.update(reminders).set({ rule: "{nope" }).where(eq(reminders.id, bad.id)).run()
    e.setClock(T0 + MIN)
    e.t.app.reminders.tick()
    expect(reminderLines(e.t).map((m) => m.body)).toEqual(["good"])
    expect(e.t.app.db.select().from(reminders).where(eq(reminders.id, bad.id)).get()!.enabled).toBe(false)
  })
})
