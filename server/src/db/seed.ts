import { randomUUID } from "node:crypto"
import { count, eq } from "drizzle-orm"
import { hashPassword, passwordLength, verifyPassword } from "../auth/password"
import type { Db } from "./client"
import { sessions, users } from "./schema"

export const MAX_ACCOUNTS = 2
export const MIN_PASSWORD_LENGTH = 12
export const MAX_PASSWORD_LENGTH = 1024
const USERNAME_RE = /^[a-z0-9_-]{1,32}$/

export interface SeedEntry {
  username: string
  displayName: string
  password: string
}

export type SeedResult =
  | { username: string; status: "created" }
  | { username: string; status: "updated" }
  | { username: string; status: "unchanged" }
  | { username: string; status: "password-reset"; sessionsRevoked: number }

/** Seed validation/limit failure. Messages name the username, never the password. */
export class SeedError extends Error {
  override name = "SeedError"
}

interface Prepared {
  username: string
  displayName: string
  existingId: string | null
  /** Hash to store; equals the existing hash when the password is unchanged. */
  passwordHash: string
  passwordChanged: boolean
  displayNameChanged: boolean
}

function validate(entries: SeedEntry[]): SeedEntry[] {
  if (!Array.isArray(entries) || entries.length < 1 || entries.length > MAX_ACCOUNTS) {
    throw new SeedError(`provide 1 to ${MAX_ACCOUNTS} accounts`)
  }
  const seen = new Set<string>()
  return entries.map((e, i) => {
    if (!e || typeof e !== "object") throw new SeedError(`entry ${i + 1} is not an object`)
    const username = typeof e.username === "string" ? e.username : ""
    if (!USERNAME_RE.test(username)) {
      throw new SeedError(`entry ${i + 1}: username must match ${USERNAME_RE.source}`)
    }
    if (seen.has(username)) throw new SeedError(`${username}: listed twice`)
    seen.add(username)
    const displayName = typeof e.displayName === "string" ? e.displayName.trim() : ""
    if (displayName.length < 1 || displayName.length > 40) {
      throw new SeedError(`${username}: display name must be 1-40 characters`)
    }
    if (typeof e.password !== "string") throw new SeedError(`${username}: password missing`)
    const len = passwordLength(e.password)
    if (len < MIN_PASSWORD_LENGTH) {
      throw new SeedError(`${username}: password must be at least ${MIN_PASSWORD_LENGTH} characters`)
    }
    if (len > MAX_PASSWORD_LENGTH) {
      throw new SeedError(`${username}: password must be at most ${MAX_PASSWORD_LENGTH} characters`)
    }
    return { username, displayName, password: e.password }
  })
}

/**
 * Create or update up to two accounts (D-07). Idempotent: re-running the same input changes
 * nothing. A new password for an existing user replaces the hash and revokes their sessions.
 * Refuses to leave more than two accounts in the database.
 */
export async function seedUsers(db: Db, entries: SeedEntry[]): Promise<SeedResult[]> {
  const valid = validate(entries)

  // Hashing/verifying is async and slow; do it before the (synchronous) write transaction.
  const prepared: Prepared[] = []
  for (const e of valid) {
    const existing = db.select().from(users).where(eq(users.username, e.username)).get()
    if (existing) {
      const same = await verifyPassword(existing.passwordHash, e.password)
      prepared.push({
        username: e.username,
        displayName: e.displayName,
        existingId: existing.id,
        passwordHash: same ? existing.passwordHash : await hashPassword(e.password),
        passwordChanged: !same,
        displayNameChanged: existing.displayName !== e.displayName,
      })
    } else {
      prepared.push({
        username: e.username,
        displayName: e.displayName,
        existingId: null,
        passwordHash: await hashPassword(e.password),
        passwordChanged: false,
        displayNameChanged: false,
      })
    }
  }

  return db.transaction((tx) => {
    const results: SeedResult[] = []
    for (const p of prepared) {
      const now = new Date()
      tx.insert(users)
        .values({
          id: randomUUID(),
          username: p.username,
          displayName: p.displayName,
          passwordHash: p.passwordHash,
          createdAt: now,
        })
        .onConflictDoUpdate({
          target: users.username,
          set: { displayName: p.displayName, passwordHash: p.passwordHash },
        })
        .run()

      if (p.existingId === null) {
        results.push({ username: p.username, status: "created" })
      } else if (p.passwordChanged) {
        const revoked = tx.delete(sessions).where(eq(sessions.userId, p.existingId)).run()
        results.push({ username: p.username, status: "password-reset", sessionsRevoked: revoked.changes })
      } else if (p.displayNameChanged) {
        results.push({ username: p.username, status: "updated" })
      } else {
        results.push({ username: p.username, status: "unchanged" })
      }
    }

    const total = tx.select({ n: count() }).from(users).get()?.n ?? 0
    if (total > MAX_ACCOUNTS) {
      // Throwing inside the transaction rolls back every write above.
      throw new SeedError("duet supports exactly two accounts")
    }
    return results
  })
}
