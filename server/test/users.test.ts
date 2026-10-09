import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { makeTestApp, type TestApp } from "./helpers"

let t: TestApp
beforeAll(async () => {
  t = await makeTestApp({ seed: true })
})
afterAll(async () => {
  await t.close()
})

describe("GET /api/users", () => {
  it("returns both users with exactly id, username and displayName", async () => {
    const res = await t.app.inject({ method: "GET", url: "/api/users" })
    expect(res.statusCode).toBe(200)
    const body = res.json() as { users: Record<string, unknown>[] }
    expect(body.users).toHaveLength(2)
    for (const u of body.users) {
      expect(Object.keys(u).sort()).toEqual(["displayName", "id", "username"])
    }
    expect(body.users.map((u) => u.displayName).sort()).toEqual(["Alice Test", "Bob Test"])
    expect(res.body).not.toMatch(/argon2|password/i)
  })
})

describe("no sign-up path", () => {
  for (const url of ["/api/register", "/api/signup"]) {
    it(`POST ${url} is a JSON 404`, async () => {
      const res = await t.app.inject({ method: "POST", url, payload: { username: "eve", password: "x".repeat(20) } })
      expect(res.statusCode).toBe(404)
      expect(res.json()).toEqual({ error: "not_found" })
    })
  }
})
