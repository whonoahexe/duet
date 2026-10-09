import { randomUUID } from "node:crypto"
import { count, eq } from "drizzle-orm"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { verifyPassword } from "../src/auth/password"
import { sessions, users } from "../src/db/schema"
import { SeedError, seedUsers } from "../src/db/seed"
import { makeTestApp, TEST_USERS, type TestApp } from "./helpers"

let t: TestApp
beforeEach(async () => {
  t = await makeTestApp({ seed: false })
})
afterEach(async () => {
  await t.close()
})

const userCount = () => t.app.db.select({ n: count() }).from(users).get()?.n ?? 0
const hashes = () =>
  Object.fromEntries(
    t.app.db
      .select({ username: users.username, passwordHash: users.passwordHash })
      .from(users)
      .all()
      .map((r) => [r.username, r.passwordHash]),
  )

function addSession(userId: string) {
  const now = new Date()
  t.app.db
    .insert(sessions)
    .values({ id: randomUUID(), userId, createdAt: now, lastSeenAt: now, expiresAt: new Date(now.getTime() + 60_000) })
    .run()
}
const sessionCount = (userId: string) =>
  t.app.db.select({ n: count() }).from(sessions).where(eq(sessions.userId, userId)).get()?.n ?? 0
const idOf = (username: string) => t.app.db.select().from(users).where(eq(users.username, username)).get()!.id

describe("seedUsers", () => {
  it("creates two accounts", async () => {
    const results = await seedUsers(t.app.db, [TEST_USERS.alice, TEST_USERS.bob])
    expect(results).toEqual([
      { username: "alice", status: "created" },
      { username: "bob", status: "created" },
    ])
    expect(userCount()).toBe(2)
  })

  it("is idempotent: re-running the same input changes nothing", async () => {
    await seedUsers(t.app.db, [TEST_USERS.alice, TEST_USERS.bob])
    const before = hashes()
    const results = await seedUsers(t.app.db, [TEST_USERS.alice, TEST_USERS.bob])
    expect(results.map((r) => r.status)).toEqual(["unchanged", "unchanged"])
    expect(hashes()).toEqual(before)
  })

  it("rejects an 11-code-point password and writes nothing", async () => {
    await expect(seedUsers(t.app.db, [{ ...TEST_USERS.alice, password: "abcdefghijk" }])).rejects.toBeInstanceOf(
      SeedError,
    )
    expect(userCount()).toBe(0)
  })

  it("counts code points, not UTF-16 units (11 emoji is too short)", async () => {
    const pw = "😀".repeat(11) // 22 UTF-16 units, 11 code points
    await expect(seedUsers(t.app.db, [TEST_USERS.bob, { ...TEST_USERS.alice, password: pw }])).rejects.toBeInstanceOf(
      SeedError,
    )
    expect(userCount()).toBe(0)
  })

  it("never names the password in a SeedError", async () => {
    const pw = "short-pw"
    const err = await seedUsers(t.app.db, [{ ...TEST_USERS.alice, password: pw }]).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(SeedError)
    expect((err as Error).message).toContain("alice")
    expect((err as Error).message).not.toContain(pw)
  })

  it("refuses a third account and keeps the count at two", async () => {
    await seedUsers(t.app.db, [TEST_USERS.alice, TEST_USERS.bob])
    const before = hashes()
    await expect(
      seedUsers(t.app.db, [{ username: "carol", displayName: "Carol Test", password: "carol-test-password-3" }]),
    ).rejects.toThrow(/exactly two accounts/)
    expect(userCount()).toBe(2)
    expect(hashes()).toEqual(before)
  })

  it("resets a changed password and revokes only that user's sessions", async () => {
    await seedUsers(t.app.db, [TEST_USERS.alice, TEST_USERS.bob])
    const aliceId = idOf("alice")
    const bobId = idOf("bob")
    addSession(aliceId)
    addSession(bobId)

    const results = await seedUsers(t.app.db, [{ ...TEST_USERS.alice, password: "alice-new-password-99" }])
    expect(results).toEqual([{ username: "alice", status: "password-reset", sessionsRevoked: 1 }])
    expect(idOf("alice")).toBe(aliceId)
    expect(sessionCount(aliceId)).toBe(0)
    expect(sessionCount(bobId)).toBe(1)
  })

  it("normalizes to NFC: a password seeded in NFD verifies with its NFC form", async () => {
    const nfc = "café-crème-brûlée"
    const nfd = nfc.normalize("NFD")
    expect(nfd).not.toBe(nfc)
    await seedUsers(t.app.db, [{ ...TEST_USERS.alice, password: nfd }])
    const stored = hashes().alice
    expect(await verifyPassword(stored, nfc)).toBe(true)
  })
})
