import { randomUUID } from "node:crypto"
import { rmSync } from "node:fs"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import type { FastifyInstance } from "fastify"
import { eq } from "drizzle-orm"
import { buildApp } from "../src/app"
import { ConfigError } from "../src/config"
import { users } from "../src/db/schema"
import { seedUsers } from "../src/db/seed"
import { ipBucket, LOGIN_ACCOUNT_MAX_FAILURES } from "../src/auth/routes"
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

describe("login errors", () => {
  it("wrong password is a generic 401 with no cookie", async () => {
    const res = await login(t.app, { userId: userId(t.app, "alice"), password: "not-alices-password" })
    expect(res.statusCode).toBe(401)
    expect(res.json()).toEqual({ error: "wrong_password" })
    expect(res.headers["set-cookie"]).toBeUndefined()
  })

  it("an unknown but well-formed userId gets the identical 401 body", async () => {
    const res = await login(t.app, { userId: randomUUID(), password: "whatever-password" })
    expect(res.statusCode).toBe(401)
    expect(res.body).toBe(JSON.stringify({ error: "wrong_password" }))
    expect(res.headers["set-cookie"]).toBeUndefined()
  })

  const invalidBodies: Array<[string, () => unknown]> = [
    ["{}", () => ({})],
    ["non-uuid userId", () => ({ userId: "x", password: "y" })],
    ["empty password", () => ({ userId: userId(t.app, "alice"), password: "" })],
    ["missing password", () => ({ userId: userId(t.app, "alice") })],
    ["empty userId", () => ({ userId: "", password: "alice-test-password-1" })],
  ]
  for (const [name, body] of invalidBodies) {
    it(`invalid body (${name}) is 400 invalid_body with no cookie`, async () => {
      const res = await login(t.app, body())
      expect(res.statusCode).toBe(400)
      expect(res.json()).toEqual({ error: "invalid_body" })
      expect(res.headers["set-cookie"]).toBeUndefined()
    })
  }

  it("malformed JSON is 400 invalid_body, never 500", async () => {
    const res = await t.app.inject({
      method: "POST",
      url: "/api/login",
      headers: { origin: ORIGIN, "content-type": "application/json", "cf-connecting-ip": freshIp() },
      payload: "{not json",
    })
    expect(res.statusCode).toBe(400)
    expect(res.json()).toEqual({ error: "invalid_body" })
  })
})

describe("login rate limit (5 per 5 minutes per CF-Connecting-IP + userId)", () => {
  it("answers the 6th attempt for the same person from the same IP with 429, without affecting others", async () => {
    const alice = userId(t.app, "alice")
    const bob = userId(t.app, "bob")
    const ip = "1.1.1.1"
    for (let i = 0; i < 5; i++) {
      const res = await login(t.app, { userId: alice, password: `wrong-password-${i}` }, { ip })
      expect(res.statusCode).toBe(401)
    }
    const sixth = await login(t.app, { userId: alice, password: "wrong-password-6" }, { ip })
    expect(sixth.statusCode).toBe(429)
    expect(sixth.json()).toMatchObject({ error: "rate_limited" })
    expect(sixth.headers["set-cookie"]).toBeUndefined()

    const otherPerson = await login(t.app, { userId: bob, password: "wrong-password-b" }, { ip })
    expect(otherPerson.statusCode).toBe(401)

    const otherIp = await login(t.app, { userId: alice, password: "wrong-password-x" }, { ip: "2.2.2.2" })
    expect(otherIp.statusCode).toBe(401)
  })
})

describe("Origin check on non-GET /api/*", () => {
  it("rejects a foreign Origin with 403 bad_origin", async () => {
    const res = await login(
      t.app,
      { userId: userId(t.app, "alice"), password: TEST_USERS.alice.password },
      { origin: "https://evil.example" },
    )
    expect(res.statusCode).toBe(403)
    expect(res.json()).toEqual({ error: "bad_origin" })
    expect(res.headers["set-cookie"]).toBeUndefined()
  })

  it("rejects a missing Origin with 403", async () => {
    const res = await login(t.app, { userId: userId(t.app, "alice"), password: TEST_USERS.alice.password }, { origin: null })
    expect(res.statusCode).toBe(403)
    expect(res.json()).toEqual({ error: "bad_origin" })
  })

  it("lets APP_ORIGIN through", async () => {
    const res = await login(t.app, { userId: userId(t.app, "alice"), password: TEST_USERS.alice.password })
    expect(res.statusCode).toBe(200)
  })

  it("does not apply to GET", async () => {
    const res = await t.app.inject({ method: "GET", url: "/api/users" })
    expect(res.statusCode).toBe(200)
  })
})

describe("security headers", () => {
  it("sets nosniff, DENY and same-origin referrer, without HSTS when not Secure", async () => {
    const res = await t.app.inject({ method: "GET", url: "/api/users" })
    expect(res.headers["x-content-type-options"]).toBe("nosniff")
    expect(res.headers["x-frame-options"]).toBe("DENY")
    expect(res.headers["referrer-policy"]).toBe("same-origin")
    expect(res.headers["strict-transport-security"]).toBeUndefined()
  })

  it("adds HSTS when COOKIE_SECURE is true", async () => {
    const dir = makeDataDir()
    const app = await buildApp({ ...testConfig(dir), COOKIE_SECURE: true })
    try {
      const res = await app.inject({ method: "GET", url: "/api/users" })
      expect(res.headers["strict-transport-security"]).toBe("max-age=15552000")
    } finally {
      await app.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe("Unicode normalization", () => {
  it("logs in with the NFC form of a password seeded as NFD", async () => {
    const dir = makeDataDir()
    const app = await buildApp(testConfig(dir))
    try {
      const nfc = "café-crème-brûlée"
      const nfd = nfc.normalize("NFD")
      expect(nfd).not.toBe(nfc)
      await seedUsers(app.db, [{ username: "uni", displayName: "Uni Code", password: nfd }])
      const res = await login(app, { userId: userId(app, "uni"), password: nfc })
      expect(res.statusCode).toBe(200)
    } finally {
      await app.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe("ipBucket (login rate-limit IP key)", () => {
  const cases: Array<[string, string]> = [
    ["203.0.113.7", "203.0.113.7"],
    ["::ffff:203.0.113.7", "203.0.113.7"],
    ["2001:db8:1:2:aaaa:bbbb:cccc:dddd", "2001:db8:1:2::/64"],
    ["2001:DB8:1:2::1", "2001:db8:1:2::/64"],
    ["2001:db8::1", "2001:db8:0:0::/64"],
    ["2001:0db8:0001:0002::", "2001:db8:1:2::/64"],
    ["::1", "0:0:0:0::/64"],
    ["1::2:3:4:5:1.2.3.4", "1:0:2:3::/64"],
    ["fe80::1%eth0", "fe80:0:0:0::/64"],
  ]
  for (const [ip, bucket] of cases) {
    it(`${ip} -> ${bucket}`, () => {
      expect(ipBucket(ip)).toBe(bucket)
    })
  }
})

describe("login rate limit across IPs (WR-01)", () => {
  it("addresses in one IPv6 /64 share a bucket", async () => {
    const bob = userId(t.app, "bob")
    for (let i = 0; i < 5; i++) {
      const res = await login(t.app, { userId: bob, password: `wrong-password-${i}` }, { ip: `2001:db8:77:1::${i + 1}` })
      expect(res.statusCode).toBe(401)
    }
    const sixth = await login(t.app, { userId: bob, password: "wrong-password-6" }, { ip: "2001:db8:77:1:ffff::9" })
    expect(sixth.statusCode).toBe(429)
    expect(sixth.json()).toMatchObject({ error: "rate_limited" })
  })

  it(`caps failed logins per account at ${LOGIN_ACCOUNT_MAX_FAILURES} per hour regardless of IP`, async () => {
    const own = await makeTestApp({ seed: true })
    try {
      const alice = userId(own.app, "alice")
      for (let i = 0; i < LOGIN_ACCOUNT_MAX_FAILURES; i++) {
        const res = await login(own.app, { userId: alice, password: `wrong-password-${i}` })
        expect(res.statusCode).toBe(401)
      }
      // Fresh IP, correct password: still refused while the account is over the cap.
      const locked = await login(own.app, { userId: alice, password: TEST_USERS.alice.password })
      expect(locked.statusCode).toBe(429)
      expect(locked.json()).toMatchObject({ error: "rate_limited" })
      expect((locked.json() as { retryAfterSeconds: number }).retryAfterSeconds).toBeGreaterThan(0)
      expect(locked.headers["set-cookie"]).toBeUndefined()

      // The other account is unaffected.
      const bob = await login(own.app, { userId: userId(own.app, "bob"), password: TEST_USERS.bob.password })
      expect(bob.statusCode).toBe(200)
    } finally {
      await own.close()
    }
  })

  it("successful logins do not count toward the account cap", async () => {
    const own = await makeTestApp({ seed: true })
    try {
      const alice = userId(own.app, "alice")
      for (let i = 0; i < LOGIN_ACCOUNT_MAX_FAILURES + 2; i++) {
        const res = await login(own.app, { userId: alice, password: TEST_USERS.alice.password })
        expect(res.statusCode).toBe(200)
      }
    } finally {
      await own.close()
    }
  })
})

describe("APP_ORIGIN normalization (WR-03)", () => {
  const dir = makeDataDir()
  afterAll(() => rmSync(dir, { recursive: true, force: true }))

  for (const [raw, normalized] of [
    ["https://duet.example.com", "https://duet.example.com"],
    ["https://duet.example.com/", "https://duet.example.com"],
    ["https://Duet.Example.COM", "https://duet.example.com"],
    ["HTTPS://duet.example.com:443/", "https://duet.example.com"],
    ["http://localhost:3000/", "http://localhost:3000"],
  ] as const) {
    it(`normalizes ${raw} to ${normalized}`, () => {
      expect(testConfig(dir, { APP_ORIGIN: raw }).APP_ORIGIN).toBe(normalized)
    })
  }

  for (const raw of [
    "https://duet.example.com/app",
    "https://duet.example.com/?x=1",
    "https://duet.example.com/#frag",
    "https://user:pw@duet.example.com",
    "ftp://duet.example.com",
  ]) {
    it(`rejects ${raw} at boot`, () => {
      expect(() => testConfig(dir, { APP_ORIGIN: raw })).toThrow(ConfigError)
    })
  }

  it("a trailing-slash, mixed-case APP_ORIGIN still accepts the browser's Origin", async () => {
    const own = await makeTestApp({ seed: true, env: { APP_ORIGIN: "https://Duet.Example.com/" } })
    try {
      const res = await login(
        own.app,
        { userId: userId(own.app, "alice"), password: TEST_USERS.alice.password },
        { origin: "https://duet.example.com" },
      )
      expect(res.statusCode).toBe(200)
    } finally {
      await own.close()
    }
  })
})
