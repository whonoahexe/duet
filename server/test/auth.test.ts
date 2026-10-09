import { rmSync } from "node:fs"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import type { FastifyInstance } from "fastify"
import { eq } from "drizzle-orm"
import { buildApp } from "../src/app"
import { users } from "../src/db/schema"
import { seedUsers } from "../src/db/seed"
import { makeDataDir, makeTestApp, testConfig, TEST_USERS, type TestApp } from "./helpers"

const ORIGIN = "http://localhost:3000"

function userId(app: FastifyInstance, username: string): string {
  const row = app.db.select({ id: users.id }).from(users).where(eq(users.username, username)).get()
  if (!row) throw new Error(`no user ${username}`)
  return row.id
}

function setCookieHeader(res: { headers: Record<string, unknown> }): string {
  const raw = res.headers["set-cookie"]
  if (raw === undefined) return ""
  return Array.isArray(raw) ? raw.join("\n") : String(raw)
}

/** "duet_session=<token>" from a Set-Cookie header, for the Cookie request header. */
function sessionCookie(res: { headers: Record<string, unknown> }): string {
  const m = /duet_session=([^;]+)/.exec(setCookieHeader(res))
  if (!m) throw new Error("no duet_session cookie")
  return `duet_session=${m[1]}`
}

let ipCounter = 0
/** A distinct client IP per call so the login rate limit never couples unrelated tests. */
function freshIp(): string {
  ipCounter += 1
  return `10.0.${Math.floor(ipCounter / 250)}.${(ipCounter % 250) + 1}`
}

function login(
  app: FastifyInstance,
  body: unknown,
  { origin = ORIGIN, ip = freshIp() }: { origin?: string | null; ip?: string } = {},
) {
  const headers: Record<string, string> = { "cf-connecting-ip": ip }
  if (origin !== null) headers.origin = origin
  return app.inject({ method: "POST", url: "/api/login", headers, payload: body as Record<string, unknown> })
}

let t: TestApp
beforeAll(async () => {
  t = await makeTestApp({ seed: true })
})
afterAll(async () => {
  await t.close()
})

describe("login happy path", () => {
  it("sets an httpOnly SameSite=Lax 90-day duet_session cookie", async () => {
    const res = await login(t.app, { userId: userId(t.app, "alice"), password: TEST_USERS.alice.password })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ ok: true })
    const sc = setCookieHeader(res)
    expect(sc).toContain("duet_session=")
    expect(sc).toContain("HttpOnly")
    expect(sc).toContain("SameSite=Lax")
    expect(sc).toContain("Path=/")
    expect(sc).toContain("Max-Age=7776000")
    expect(sc).not.toContain("Secure")
  })

  it("adds Secure when COOKIE_SECURE is true", async () => {
    const dir = makeDataDir()
    const app = await buildApp({ ...testConfig(dir), COOKIE_SECURE: true })
    try {
      await seedUsers(app.db, [TEST_USERS.alice, TEST_USERS.bob])
      const res = await login(app, { userId: userId(app, "alice"), password: TEST_USERS.alice.password })
      expect(res.statusCode).toBe(200)
      expect(setCookieHeader(res)).toMatch(/duet_session=[^;]+;.*Secure/)
    } finally {
      await app.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("GET /api/me returns the user and the peer with the cookie", async () => {
    const res = await login(t.app, { userId: userId(t.app, "alice"), password: TEST_USERS.alice.password })
    const me = await t.app.inject({ method: "GET", url: "/api/me", headers: { cookie: sessionCookie(res) } })
    expect(me.statusCode).toBe(200)
    const body = me.json() as { user: Record<string, unknown>; peer: Record<string, unknown> | null }
    expect(body.user).toEqual({ id: userId(t.app, "alice"), username: "alice", displayName: "Alice Test" })
    expect(body.peer).toEqual({ id: userId(t.app, "bob"), username: "bob", displayName: "Bob Test" })
    expect(me.body).not.toMatch(/argon2|password/i)
  })

  it("GET /api/me without a cookie is 401", async () => {
    const me = await t.app.inject({ method: "GET", url: "/api/me" })
    expect(me.statusCode).toBe(401)
    expect(me.json()).toEqual({ error: "unauthenticated" })
  })

  it("GET /api/me with an unknown token is 401", async () => {
    const me = await t.app.inject({ method: "GET", url: "/api/me", headers: { cookie: "duet_session=not-a-real-token" } })
    expect(me.statusCode).toBe(401)
  })
})
