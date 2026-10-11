import { randomUUID } from "node:crypto"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { eq } from "drizzle-orm"
import { users } from "../src/db/schema"
import { loginCookie, makeTestApp, openWs, TEST_ORIGIN, type TestApp, type WsTestClient } from "./helpers"

let t: TestApp
let aliceCookie: string
let alice2Cookie: string
let bobCookie: string
let bob2Cookie: string
let aliceId: string
let bobId: string

function userId(username: string): string {
  const row = t.app.db.select({ id: users.id }).from(users).where(eq(users.username, username)).get()
  if (!row) throw new Error(`no user ${username}`)
  return row.id
}

async function connect(cookie: string): Promise<WsTestClient> {
  const c = await openWs(t.app, cookie, TEST_ORIGIN)
  expect((await c.next()).t).toBe("hello")
  return c
}

function read(cookie: string | null, payload: unknown) {
  const headers: Record<string, string> = { origin: TEST_ORIGIN }
  if (cookie !== null) headers.cookie = cookie
  return t.app.inject({ method: "POST", url: "/api/read", headers, payload: payload as object })
}

beforeAll(async () => {
  t = await makeTestApp({ seed: true })
  aliceCookie = await loginCookie(t.app, "alice")
  alice2Cookie = await loginCookie(t.app, "alice")
  bobCookie = await loginCookie(t.app, "bob")
  bob2Cookie = await loginCookie(t.app, "bob")
  aliceId = userId("alice")
  bobId = userId("bob")
})
afterAll(async () => {
  await t.close()
})

describe("typing relay (CHAT-06)", () => {
  it("relays alice's typing frame to every bob socket and to no alice socket", async () => {
    const [alice, alice2, bob, bob2] = await Promise.all([
      connect(aliceCookie),
      connect(alice2Cookie),
      connect(bobCookie),
      connect(bob2Cookie),
    ])
    alice.send({ t: "typing" })
    expect(await bob.next()).toEqual({ t: "typing", userId: aliceId })
    expect(await bob2.next()).toEqual({ t: "typing", userId: aliceId })
    expect(await alice.collect(150)).toEqual([])
    expect(await alice2.collect(0)).toEqual([])
    for (const c of [alice, alice2, bob, bob2]) c.ws.terminate()
  })

  it("rejects a typing frame with an extra key as bad_frame", async () => {
    const alice = await connect(aliceCookie)
    alice.send({ t: "typing", extra: 1 })
    expect(await alice.next()).toEqual({ t: "error", code: "bad_frame" })
    alice.ws.terminate()
  })
})

describe("POST /api/read (CHAT-07, D-03)", () => {
  it("advances bob's read cursor forward only, broadcasting each advance, and clamps to the newest seq", async () => {
    for (const body of ["one", "two", "three"]) {
      const res = await t.app.inject({
        method: "POST",
        url: "/api/messages",
        headers: { cookie: aliceCookie, origin: TEST_ORIGIN },
        payload: { id: randomUUID(), body },
      })
      expect(res.statusCode).toBe(200)
    }
    const [alice, bob] = await Promise.all([connect(aliceCookie), connect(bobCookie)])

    const first = await read(bobCookie, { seq: 2 })
    expect(first.statusCode).toBe(200)
    expect(first.json()).toEqual({ ok: true })
    for (const c of [alice, bob]) {
      expect(await c.next()).toEqual({ t: "read", userId: bobId, seq: 2, at: expect.any(Number) })
    }

    const back = await read(bobCookie, { seq: 1 })
    expect(back.statusCode).toBe(200)
    expect(back.json()).toEqual({ ok: true })
    expect(await alice.collect(150)).toEqual([])

    const ahead = await read(bobCookie, { seq: 99 })
    expect(ahead.statusCode).toBe(200)
    expect(await alice.next()).toEqual({ t: "read", userId: bobId, seq: 3, at: expect.any(Number) })
    alice.ws.terminate()
    bob.ws.terminate()
  })

  it("returns the read cursors from GET /api/messages and /api/sync", async () => {
    const page = await t.app.inject({ method: "GET", url: "/api/messages", headers: { cookie: aliceCookie } })
    expect(page.json().reads).toContainEqual({ userId: bobId, seq: 3, at: expect.any(Number) })
    const sync = await t.app.inject({ method: "GET", url: "/api/sync?since=0", headers: { cookie: aliceCookie } })
    expect(sync.json().reads).toContainEqual({ userId: bobId, seq: 3, at: expect.any(Number) })
  })

  it("rejects seq 0, a missing seq and extra keys with 400 invalid_body, and answers 401 without a cookie", async () => {
    for (const payload of [{ seq: 0 }, {}, { seq: "2" }, { seq: 2, userId: aliceId }]) {
      const res = await read(bobCookie, payload)
      expect(res.statusCode, JSON.stringify(payload)).toBe(400)
      expect(res.json()).toEqual({ error: "invalid_body" })
    }
    expect((await read(null, { seq: 1 })).statusCode).toBe(401)
  })
})
