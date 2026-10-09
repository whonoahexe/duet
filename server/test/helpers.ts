import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import type { FastifyInstance } from "fastify"
import { eq } from "drizzle-orm"
import { buildApp } from "../src/app"
import { loadConfig, type Config } from "../src/config"
import { users } from "../src/db/schema"
import { seedUsers, type SeedEntry } from "../src/db/seed"

/** Test-only accounts. Passwords are fixtures, never real credentials. */
export const TEST_USERS = {
  alice: { username: "alice", displayName: "Alice Test", password: "alice-test-password-1" },
  bob: { username: "bob", displayName: "Bob Test", password: "bob-test-password-22" },
} satisfies Record<string, SeedEntry>

export const TEST_ORIGIN = "http://localhost:3000"

/** Fixture TURN key values. Never real values. */
export const TURN_TEST_ENV = {
  CF_TURN_KEY_ID: "test-key-id-0000",
  CF_TURN_KEY_API_TOKEN: "test-turn-bearer-0000",
} as const

export function testConfig(dataDir: string, extraEnv: Record<string, string | undefined> = {}): Config {
  return loadConfig({
    NODE_ENV: "test",
    DATA_DIR: dataDir,
    WEB_OUT: path.join(dataDir, "no-web-out"), // does not exist -> static serving is skipped
    APP_ORIGIN: TEST_ORIGIN,
    COOKIE_SECURE: "false",
    LOG_LEVEL: "silent",
    ...extraEnv,
  })
}

export function makeDataDir(): string {
  return mkdtempSync(path.join(tmpdir(), "duet-test-"))
}

export interface TestApp {
  app: FastifyInstance
  users: typeof TEST_USERS
  dataDir: string
  close: () => Promise<void>
}

export interface MakeTestAppOptions {
  seed?: boolean
  dataDir?: string
  env?: Record<string, string | undefined>
  fetch?: typeof fetch
  turnTimeoutMs?: number
  logStream?: NodeJS.WritableStream
}

export async function makeTestApp({
  seed = true,
  dataDir,
  env,
  fetch,
  turnTimeoutMs,
  logStream,
}: MakeTestAppOptions = {}): Promise<TestApp> {
  const dir = dataDir ?? makeDataDir()
  const app = await buildApp(testConfig(dir, env), { fetch, turnTimeoutMs, logStream })
  if (seed) {
    await seedUsers(app.db, [TEST_USERS.alice, TEST_USERS.bob])
  }
  return {
    app,
    users: TEST_USERS,
    dataDir: dir,
    close: async () => {
      await app.close()
      rmSync(dir, { recursive: true, force: true })
    },
  }
}

let loginIpCounter = 0
function loginIp(): string {
  loginIpCounter += 1
  return `10.9.${Math.floor(loginIpCounter / 250)}.${(loginIpCounter % 250) + 1}`
}

/** Log in as a seeded test user and return the "duet_session=<token>" cookie string. */
export async function loginCookie(app: FastifyInstance, username: "alice" | "bob"): Promise<string> {
  const row = app.db.select({ id: users.id }).from(users).where(eq(users.username, username)).get()
  if (!row) throw new Error(`test user ${username} is not seeded`)
  const res = await app.inject({
    method: "POST",
    url: "/api/login",
    headers: { origin: TEST_ORIGIN, "cf-connecting-ip": loginIp() },
    payload: { userId: row.id, password: TEST_USERS[username].password },
  })
  if (res.statusCode !== 200) throw new Error(`login as ${username} failed with ${res.statusCode}`)
  const raw = res.headers["set-cookie"]
  const header = Array.isArray(raw) ? raw.join("\n") : String(raw ?? "")
  const m = /duet_session=([^;]+)/.exec(header)
  if (!m) throw new Error("login set no duet_session cookie")
  return `duet_session=${m[1]}`
}
