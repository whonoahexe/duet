import { randomUUID } from "node:crypto"
import { Writable } from "node:stream"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { eq, sql } from "drizzle-orm"
import { messages, users } from "../src/db/schema"
import { loginCookie, makeTestApp, openWs, TEST_ORIGIN, type TestApp, type WsTestClient } from "./helpers"

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
let aliceId: string
let bobId: string

function userId(username: string): string {
  const row = t.app.db.select({ id: users.id }).from(users).where(eq(users.username, username)).get()
  if (!row) throw new Error(`no user ${username}`)
  return row.id
}

function send(cookie: string | null, payload: unknown, origin: string | null = TEST_ORIGIN, app = t.app) {
  const headers: Record<string, string> = {}
  if (cookie !== null) headers.cookie = cookie
  if (origin !== null) headers.origin = origin
  return app.inject({ method: "POST", url: "/api/messages", headers, payload: payload as object })
}

function count(app = t.app): number {
  return app.db.select({ n: sql<number>`count(*)` }).from(messages).get()!.n
}

/** Open a socket and consume its hello frame. */
async function connect(cookie: string): Promise<WsTestClient> {
  const c = await openWs(t.app, cookie, TEST_ORIGIN)
  const hello = await c.next()
  expect(hello.t).toBe("hello")
  return c
}

beforeAll(async () => {
  t = await makeTestApp({ seed: true, logStream })
  aliceCookie = await loginCookie(t.app, "alice")
  alice2Cookie = await loginCookie(t.app, "alice")
  bobCookie = await loginCookie(t.app, "bob")
  aliceId = userId("alice")
  bobId = userId("bob")
})
afterAll(async () => {
  await t.close()
})

describe("POST /api/messages (CHAT-01, CHAT-04)", () => {
  const firstId = randomUUID()

  it("stores a text message and returns its DTO with seq 1", async () => {
    const res = await send(aliceCookie, { id: firstId, body: "hi" })
    expect(res.statusCode).toBe(200)
    const { message } = res.json()
    expect(message).toEqual({
      seq: 1,
      id: firstId,
      senderId: aliceId,
      kind: "text",
      body: "hi",
      createdAt: expect.any(Number),
      updatedSeq: 1,
      replyTo: null,
      attachments: [],
      reactions: [],
    })
  })

  it("is idempotent on the client id: a replay returns the identical message and stores one row", async () => {
    const before = count()
    const first = (await send(aliceCookie, { id: firstId, body: "hi" })).json()
    const again = await send(aliceCookie, { id: firstId, body: "hi" })
    expect(again.statusCode).toBe(200)
    expect(again.json()).toEqual(first)
    expect(again.json().message.seq).toBe(1)
    expect(count()).toBe(before)
    expect(t.app.db.select().from(messages).where(eq(messages.id, firstId)).all()).toHaveLength(1)
  })

  it("rejects the other person's id with 409 id_conflict and leaves their row unchanged", async () => {
    const before = t.app.db.select().from(messages).where(eq(messages.id, firstId)).get()
    const res = await send(bobCookie, { id: firstId, body: "hijack" })
    expect(res.statusCode).toBe(409)
    expect(res.json()).toEqual({ error: "id_conflict" })
    const after = t.app.db.select().from(messages).where(eq(messages.id, firstId)).get()
    expect(after).toEqual(before)
    expect(after?.senderId).toBe(aliceId)
    expect(after?.body).toBe("hi")
  })

  it("rejects an empty or whitespace-only body with 400 invalid_body", async () => {
    for (const body of ["", "   \n ", "\t\n"]) {
      const res = await send(aliceCookie, { id: randomUUID(), body })
      expect(res.statusCode).toBe(400)
      expect(res.json()).toEqual({ error: "invalid_body" })
    }
  })

  it("rejects an extra key (senderId) with 400 invalid_body: the sender comes from the session only", async () => {
    const res = await send(aliceCookie, { id: randomUUID(), body: "spoof", senderId: bobId })
    expect(res.statusCode).toBe(400)
    expect(res.json()).toEqual({ error: "invalid_body" })
  })

  it("rejects a missing body, a non-uuid id and a non-string body with 400 invalid_body", async () => {
    for (const payload of [{ id: randomUUID() }, { id: "not-a-uuid", body: "x" }, { id: randomUUID(), body: 42 }]) {
      const res = await send(aliceCookie, payload)
      expect(res.statusCode).toBe(400)
      expect(res.json()).toEqual({ error: "invalid_body" })
    }
  })

  it("counts length in code points: 4000 astral emoji are accepted, 4001 are rejected", async () => {
    const ok = await send(aliceCookie, { id: randomUUID(), body: "😘".repeat(4000) })
    expect(ok.statusCode).toBe(200)
    expect([...ok.json().message.body]).toHaveLength(4000)
    const tooLong = await send(aliceCookie, { id: randomUUID(), body: "😘".repeat(4001) })
    expect(tooLong.statusCode).toBe(400)
    expect(tooLong.json()).toEqual({ error: "invalid_body" })
    const tooLongAscii = await send(aliceCookie, { id: randomUUID(), body: "a".repeat(4001) })
    expect(tooLongAscii.statusCode).toBe(400)
  })

  it("round-trips the body byte-identically (combining marks, ZWJ emoji, newlines, edge spaces)", async () => {
    const body = "  á é 👨‍👩‍👧‍👦\n\nline two  "
    const id = randomUUID()
    const res = await send(aliceCookie, { id, body })
    expect(res.statusCode).toBe(200)
    expect(Buffer.from(res.json().message.body, "utf8").equals(Buffer.from(body, "utf8"))).toBe(true)

    const page = await t.app.inject({ method: "GET", url: "/api/messages", headers: { cookie: bobCookie } })
    const found = page.json().messages.find((m: { id: string }) => m.id === id)
    expect(Buffer.from(found.body, "utf8").equals(Buffer.from(body, "utf8"))).toBe(true)
    const row = t.app.db.select().from(messages).where(eq(messages.id, id)).get()
    expect(row?.body).toBe(body)
  })

  it("answers 401 without a session and 403 without an Origin", async () => {
    const noCookie = await send(null, { id: randomUUID(), body: "x" })
    expect(noCookie.statusCode).toBe(401)
    const noOrigin = await send(aliceCookie, { id: randomUUID(), body: "x" }, null)
    expect(noOrigin.statusCode).toBe(403)
  })
})

describe("GET /api/messages (CHAT-02)", () => {
  let fresh: TestApp
  let cookie: string

  beforeAll(async () => {
    fresh = await makeTestApp({ seed: true })
    cookie = await loginCookie(fresh.app, "alice")
  })
  afterAll(async () => {
    await fresh.close()
  })

  it("returns an empty page with cursor 0 and no reads on an empty conversation", async () => {
    const res = await fresh.app.inject({ method: "GET", url: "/api/messages", headers: { cookie } })
    expect(res.statusCode).toBe(200)
    expect(res.headers["cache-control"]).toBe("no-store")
    expect(res.json()).toEqual({ messages: [], hasMore: false, cursor: 0, reads: [] })
  })

  it("answers 401 without a session and 400 on a bad query", async () => {
    const res = await fresh.app.inject({ method: "GET", url: "/api/messages" })
    expect(res.statusCode).toBe(401)
    for (const q of ["limit=0", "limit=201", "before=0", "before=abc"]) {
      const bad = await fresh.app.inject({ method: "GET", url: `/api/messages?${q}`, headers: { cookie } })
      expect(bad.statusCode).toBe(400)
    }
  })

  it("pages 120 messages by seq: 50 + 50 + 20, disjoint, ascending, covering all, hasMore true/true/false", async () => {
    for (let i = 1; i <= 120; i++) {
      const res = await send(cookie, { id: randomUUID(), body: `m${i}` }, TEST_ORIGIN, fresh.app)
      expect(res.statusCode).toBe(200)
    }
    const pages: { messages: { seq: number }[]; hasMore: boolean; cursor: number }[] = []
    let before: number | undefined
    for (;;) {
      const url = before === undefined ? "/api/messages?limit=50" : `/api/messages?limit=50&before=${before}`
      const res = await fresh.app.inject({ method: "GET", url, headers: { cookie } })
      expect(res.statusCode).toBe(200)
      expect(res.headers["cache-control"]).toBe("no-store")
      const page = res.json()
      pages.push(page)
      if (!page.hasMore) break
      before = page.messages[0].seq
    }
    expect(pages.map((p) => p.messages.length)).toEqual([50, 50, 20])
    expect(pages.map((p) => p.hasMore)).toEqual([true, true, false])
    for (const p of pages) {
      const seqs = p.messages.map((m) => m.seq)
      expect(seqs).toEqual([...seqs].sort((a, b) => a - b))
      expect(p.cursor).toBe(120)
    }
    const all = pages.flatMap((p) => p.messages.map((m) => m.seq))
    expect(new Set(all).size).toBe(120)
    expect([...all].sort((a, b) => a - b)).toEqual(Array.from({ length: 120 }, (_, i) => i + 1))
  })

  it("returns exactly one message when there is exactly one before the bound", async () => {
    const res = await fresh.app.inject({ method: "GET", url: "/api/messages?before=2", headers: { cookie } })
    const page = res.json()
    expect(page.messages.map((m: { seq: number }) => m.seq)).toEqual([1])
    expect(page.hasMore).toBe(false)
  })
})

describe("fan-out over /ws and the chatEvents seam", () => {
  it("delivers a created message to every socket of both people; a replay delivers nothing", async () => {
    const a1 = await connect(aliceCookie)
    const a2 = await connect(alice2Cookie)
    const b = await connect(bobCookie)
    const id = randomUUID()

    const res = await send(aliceCookie, { id, body: "fan-out" })
    expect(res.statusCode).toBe(200)
    const sent = res.json().message
    for (const c of [a1, a2, b]) {
      const f = await c.next()
      expect(f).toEqual({ t: "msg", message: sent })
    }

    const replay = await send(aliceCookie, { id, body: "fan-out" })
    expect(replay.statusCode).toBe(200)
    for (const c of [a1, a2, b]) expect(await c.collect(150)).toEqual([])

    for (const c of [a1, a2, b]) c.ws.terminate()
  })

  it("calls onMessageCreated once per created message, never for a replay; a throwing listener does not fail the send", async () => {
    const seen: number[] = []
    const offThrow = t.app.chatEvents.onMessageCreated(() => {
      throw new Error("boom")
    })
    const offReject = t.app.chatEvents.onMessageCreated(async () => {
      throw new Error("async boom")
    })
    const off = t.app.chatEvents.onMessageCreated(({ message, senderId }) => {
      expect(senderId).toBe(bobId)
      seen.push(message.seq)
    })
    try {
      const id = randomUUID()
      const res = await send(bobCookie, { id, body: "event" })
      expect(res.statusCode).toBe(200)
      const replay = await send(bobCookie, { id, body: "event" })
      expect(replay.statusCode).toBe(200)
      expect(seen).toEqual([res.json().message.seq])
      await new Promise((r) => setTimeout(r, 20))
      expect(logLines.some((l) => l.includes('"evt":"chat_listener_failed"'))).toBe(true)
    } finally {
      off()
      offThrow()
      offReject()
    }
  })
})

describe("privacy (T-02-03)", () => {
  it("never writes a message body to the log", async () => {
    const secret = `secret-body-${randomUUID()}`
    const res = await send(aliceCookie, { id: randomUUID(), body: secret })
    expect(res.statusCode).toBe(200)
    await t.app.inject({ method: "GET", url: "/api/messages", headers: { cookie: aliceCookie } })
    await new Promise((r) => setTimeout(r, 20))
    expect(logLines.some((l) => l.includes('"evt":"msg_sent"'))).toBe(true)
    expect(logLines.join("")).not.toContain(secret)
  })
})
