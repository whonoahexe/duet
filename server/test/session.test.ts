import { afterAll, beforeAll, describe, expect, it } from "vitest"
import type { FastifyInstance } from "fastify"
import { eq } from "drizzle-orm"
import { hashToken, SESSION_TTL_MS } from "../src/auth/session"
import { sessions, users } from "../src/db/schema"
import { makeTestApp, TEST_USERS, type TestApp } from "./helpers"

const ORIGIN = "http://localhost:3000"
const HOUR = 60 * 60 * 1000

let ipCounter = 0
function freshIp(): string {
  ipCounter += 1
  return `10.1.${Math.floor(ipCounter / 250)}.${(ipCounter % 250) + 1}`
}

function setCookieHeader(res: { headers: Record<string, unknown> }): string {
  const raw = res.headers["set-cookie"]
  if (raw === undefined) return ""
  return Array.isArray(raw) ? raw.join("\n") : String(raw)
}

function tokenFrom(res: { headers: Record<string, unknown> }): string {
  const m = /duet_session=([^;]+)/.exec(setCookieHeader(res))
  if (!m) throw new Error("no duet_session cookie")
  return m[1]!
}

/** True when the Set-Cookie header clears duet_session (empty value with Max-Age=0 or a past Expires). */
function clearsSessionCookie(res: { headers: Record<string, unknown> }): boolean {
  const sc = setCookieHeader(res)
  const line = sc.split("\n").find((l) => l.startsWith("duet_session="))
  if (!line) return false
  if (!/^duet_session=;/.test(line)) return false
  const maxAgeZero = /Max-Age=0(;|$)/.test(line)
  const expires = /Expires=([^;]+)/.exec(line)
  const expiredInPast = expires ? new Date(expires[1]!).getTime() < Date.now() : false
  return maxAgeZero || expiredInPast
}

async function loginAs(app: FastifyInstance, username: "alice" | "bob"): Promise<string> {
  const row = app.db.select({ id: users.id }).from(users).where(eq(users.username, username)).get()
  const res = await app.inject({
    method: "POST",
    url: "/api/login",
    headers: { origin: ORIGIN, "cf-connecting-ip": freshIp() },
    payload: { userId: row!.id, password: TEST_USERS[username].password },
  })
  expect(res.statusCode).toBe(200)
  return tokenFrom(res)
}

function me(app: FastifyInstance, token: string) {
  return app.inject({ method: "GET", url: "/api/me", headers: { cookie: `duet_session=${token}` } })
}

function sessionRow(app: FastifyInstance, token: string) {
  return app.db.select().from(sessions).where(eq(sessions.id, hashToken(token))).get()
}

let t: TestApp
beforeAll(async () => {
  t = await makeTestApp({ seed: true })
})
afterAll(async () => {
  await t.close()
})

describe("rolling renewal", () => {
  it("does not re-issue the cookie on a fresh session", async () => {
    const token = await loginAs(t.app, "alice")
    const res = await me(t.app, token)
    expect(res.statusCode).toBe(200)
    expect(res.headers["set-cookie"]).toBeUndefined()
  })

  it("after 24 h extends expires_at to now + 90 days and re-issues a 90-day cookie", async () => {
    const token = await loginAs(t.app, "alice")
    const id = hashToken(token)
    const old = new Date(Date.now() - 25 * HOUR)
    t.app.db
      .update(sessions)
      .set({ lastSeenAt: old, expiresAt: new Date(old.getTime() + SESSION_TTL_MS) })
      .where(eq(sessions.id, id))
      .run()

    const res = await me(t.app, token)
    expect(res.statusCode).toBe(200)
    const sc = setCookieHeader(res)
    expect(sc).toContain(`duet_session=${token}`)
    expect(sc).toContain("Max-Age=7776000")
    expect(sc).toContain("HttpOnly")
    expect(sc).toContain("SameSite=Lax")
    expect(sc).toContain("Path=/")

    const row = sessionRow(t.app, token)!
    expect(Math.abs(row.expiresAt.getTime() - (Date.now() + SESSION_TTL_MS))).toBeLessThan(60_000)
    expect(Date.now() - row.lastSeenAt.getTime()).toBeLessThan(60_000)

    // Renewal is throttled: the very next request does not re-issue again.
    const again = await me(t.app, token)
    expect(again.statusCode).toBe(200)
    expect(again.headers["set-cookie"]).toBeUndefined()
  })
})

describe("expiry", () => {
  it("answers 401, deletes the row and clears the cookie for an expired session", async () => {
    const token = await loginAs(t.app, "alice")
    t.app.db
      .update(sessions)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(sessions.id, hashToken(token)))
      .run()

    const res = await me(t.app, token)
    expect(res.statusCode).toBe(401)
    expect(res.json()).toEqual({ error: "unauthenticated" })
    expect(clearsSessionCookie(res)).toBe(true)
    expect(sessionRow(t.app, token)).toBeUndefined()
  })
})

describe("POST /api/logout", () => {
  it("deletes only the caller's session, clears the cookie, and the old token is rejected", async () => {
    const aliceToken = await loginAs(t.app, "alice")
    const bobToken = await loginAs(t.app, "bob")

    const res = await t.app.inject({
      method: "POST",
      url: "/api/logout",
      headers: { origin: ORIGIN, cookie: `duet_session=${aliceToken}` },
      payload: {},
    })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ ok: true })
    expect(clearsSessionCookie(res)).toBe(true)
    expect(sessionRow(t.app, aliceToken)).toBeUndefined()

    const reuse = await me(t.app, aliceToken)
    expect(reuse.statusCode).toBe(401)

    expect(sessionRow(t.app, bobToken)).toBeDefined()
    const bob = await me(t.app, bobToken)
    expect(bob.statusCode).toBe(200)
  })

  it("is 401 without a session", async () => {
    const res = await t.app.inject({ method: "POST", url: "/api/logout", headers: { origin: ORIGIN }, payload: {} })
    expect(res.statusCode).toBe(401)
    expect(res.json()).toEqual({ error: "unauthenticated" })
  })

  it("is 403 without Origin, and the session survives", async () => {
    const token = await loginAs(t.app, "alice")
    const res = await t.app.inject({
      method: "POST",
      url: "/api/logout",
      headers: { cookie: `duet_session=${token}` },
      payload: {},
    })
    expect(res.statusCode).toBe(403)
    expect(res.json()).toEqual({ error: "bad_origin" })
    expect(sessionRow(t.app, token)).toBeDefined()
  })

  // CR-01: the router percent-decodes the path, so /%61pi/logout reaches the /api/logout handler.
  // The Origin guard must not be dodged by that encoding.
  for (const url of ["/%61pi/logout", "/%61%70%69/logout", "/api%2Flogout"]) {
    it(`is 403 for ${url} with a foreign Origin, and the session survives`, async () => {
      const token = await loginAs(t.app, "alice")
      const res = await t.app.inject({
        method: "POST",
        url,
        headers: { origin: "https://evil.example", cookie: `duet_session=${token}` },
        payload: {},
      })
      expect(res.statusCode).toBe(403)
      expect(res.json()).toEqual({ error: "bad_origin" })
      expect(sessionRow(t.app, token)).toBeDefined()
    })
  }
})
