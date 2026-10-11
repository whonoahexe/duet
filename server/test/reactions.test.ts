import { randomUUID } from "node:crypto"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { eq } from "drizzle-orm"
import { users } from "../src/db/schema"
import { loginCookie, makeTestApp, openWs, TEST_ORIGIN, type TestApp, type WsTestClient } from "./helpers"

let t: TestApp
let aliceCookie: string
let bobCookie: string
let aliceId: string
let bobId: string

function userId(username: string): string {
  const row = t.app.db.select({ id: users.id }).from(users).where(eq(users.username, username)).get()
  if (!row) throw new Error(`no user ${username}`)
  return row.id
}

function send(cookie: string, body: string) {
  return t.app.inject({
    method: "POST",
    url: "/api/messages",
    headers: { cookie, origin: TEST_ORIGIN },
    payload: { id: randomUUID(), body },
  })
}

function react(cookie: string | null, seq: number | string, payload: unknown) {
  const headers: Record<string, string> = { origin: TEST_ORIGIN }
  if (cookie !== null) headers.cookie = cookie
  return t.app.inject({
    method: "PUT",
    url: `/api/messages/${seq}/reaction`,
    headers,
    payload: payload as object,
  })
}

async function connect(cookie: string): Promise<WsTestClient> {
  const c = await openWs(t.app, cookie, TEST_ORIGIN)
  expect((await c.next()).t).toBe("hello")
  return c
}

beforeAll(async () => {
  t = await makeTestApp({ seed: true })
  aliceCookie = await loginCookie(t.app, "alice")
  bobCookie = await loginCookie(t.app, "bob")
  aliceId = userId("alice")
  bobId = userId("bob")
  expect((await send(aliceCookie, "react to me")).statusCode).toBe(200)
})
afterAll(async () => {
  await t.close()
})

describe("PUT /api/messages/:seq/reaction (CHAT-08, D-04)", () => {
  it("adds bob's reaction, bumps updatedSeq and broadcasts the changed message to alice", async () => {
    const before = (await send(aliceCookie, "filler")).json().message.updatedSeq as number
    const alice = await connect(aliceCookie)
    const res = await react(bobCookie, 1, { emoji: "💕" })
    expect(res.statusCode).toBe(200)
    const { message } = res.json()
    expect(message.seq).toBe(1)
    expect(message.reactions).toEqual([{ userId: bobId, emoji: "💕" }])
    expect(message.updatedSeq).toBeGreaterThan(before)

    const frame = await alice.next()
    expect(frame).toEqual({ t: "msg", message })
    alice.ws.terminate()
  })

  it("replaces bob's reaction (one row per person), removes it with null, and a second null is a no-op", async () => {
    const replaced = await react(bobCookie, 1, { emoji: "😭" })
    expect(replaced.statusCode).toBe(200)
    expect(replaced.json().message.reactions).toEqual([{ userId: bobId, emoji: "😭" }])

    const removed = await react(bobCookie, 1, { emoji: null })
    expect(removed.statusCode).toBe(200)
    expect(removed.json().message.reactions).toEqual([])
    const removedSeq = removed.json().message.updatedSeq as number

    const alice = await connect(aliceCookie)
    const again = await react(bobCookie, 1, { emoji: null })
    expect(again.statusCode).toBe(200)
    expect(again.json().message.reactions).toEqual([])
    expect(again.json().message.updatedSeq).toBe(removedSeq)
    expect(await alice.collect(150)).toEqual([])
    alice.ws.terminate()
  })

  it("keeps one reaction per person: both picking 💕 gives two reactions, and bob never changes alice's", async () => {
    expect((await react(aliceCookie, 1, { emoji: "💕" })).statusCode).toBe(200)
    const res = await react(bobCookie, 1, { emoji: "💕" })
    expect(res.statusCode).toBe(200)
    const reactions = res.json().message.reactions as { userId: string; emoji: string }[]
    expect(reactions).toHaveLength(2)
    expect(reactions).toEqual(
      expect.arrayContaining([
        { userId: aliceId, emoji: "💕" },
        { userId: bobId, emoji: "💕" },
      ]),
    )
    const bobChange = await react(bobCookie, 1, { emoji: "😋" })
    expect(bobChange.json().message.reactions).toEqual(
      expect.arrayContaining([
        { userId: aliceId, emoji: "💕" },
        { userId: bobId, emoji: "😋" },
      ]),
    )
  })

  it("rejects emoji outside REACTIONS by exact string equality (400 invalid_body)", async () => {
    for (const payload of [{ emoji: "💕️" }, { emoji: "❤️" }, { emoji: "x" }, {}, { emoji: "💕", userId: aliceId }]) {
      const res = await react(bobCookie, 1, payload)
      expect(res.statusCode, JSON.stringify(payload)).toBe(400)
      expect(res.json()).toEqual({ error: "invalid_body" })
    }
  })

  it("rejects a non-positive or non-numeric seq with 400 invalid_body", async () => {
    for (const seq of ["0", "-1", "abc", "1.5"]) {
      const res = await react(bobCookie, seq, { emoji: "💕" })
      expect(res.statusCode, seq).toBe(400)
      expect(res.json()).toEqual({ error: "invalid_body" })
    }
  })

  it("answers 404 not_found for an unknown seq and 401 without a cookie", async () => {
    const missing = await react(bobCookie, 999, { emoji: "💕" })
    expect(missing.statusCode).toBe(404)
    expect(missing.json()).toEqual({ error: "not_found" })
    const anon = await react(null, 1, { emoji: "💕" })
    expect(anon.statusCode).toBe(401)
  })

  it("returns the reacted message through GET /api/sync from a cursor taken before the reaction", async () => {
    const sync0 = await t.app.inject({ method: "GET", url: "/api/sync?since=0", headers: { cookie: bobCookie } })
    const cursor = sync0.json().cursor as number
    expect((await react(bobCookie, 1, { emoji: "😘" })).statusCode).toBe(200)
    const sync = await t.app.inject({ method: "GET", url: `/api/sync?since=${cursor}`, headers: { cookie: bobCookie } })
    expect(sync.statusCode).toBe(200)
    const changed = sync.json().messages as { seq: number; reactions: { userId: string; emoji: string }[] }[]
    expect(changed.map((m) => m.seq)).toEqual([1])
    expect(changed[0].reactions).toEqual(expect.arrayContaining([{ userId: bobId, emoji: "😘" }]))
  })
})
