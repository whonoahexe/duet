import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import type { FastifyInstance } from "fastify"
import { buildApp } from "../src/app"
import { loadConfig, type Config } from "../src/config"
import { seedUsers, type SeedEntry } from "../src/db/seed"

/** Test-only accounts. Passwords are fixtures, never real credentials. */
export const TEST_USERS = {
  alice: { username: "alice", displayName: "Alice Test", password: "alice-test-password-1" },
  bob: { username: "bob", displayName: "Bob Test", password: "bob-test-password-22" },
} satisfies Record<string, SeedEntry>

export function testConfig(dataDir: string): Config {
  return loadConfig({
    NODE_ENV: "test",
    DATA_DIR: dataDir,
    WEB_OUT: path.join(dataDir, "no-web-out"), // does not exist -> static serving is skipped
    APP_ORIGIN: "http://localhost:3000",
    COOKIE_SECURE: "false",
    LOG_LEVEL: "silent",
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

export async function makeTestApp({ seed = true, dataDir }: { seed?: boolean; dataDir?: string } = {}): Promise<TestApp> {
  const dir = dataDir ?? makeDataDir()
  const app = await buildApp(testConfig(dir))
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
