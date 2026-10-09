import { existsSync, readdirSync, rmSync } from "node:fs"
import path from "node:path"
import Database from "better-sqlite3"
import { sql } from "drizzle-orm"
import { afterEach, describe, expect, it } from "vitest"
import { buildApp } from "../src/app"
import { MIGRATIONS_FOLDER } from "../src/db/client"
import { makeDataDir, testConfig } from "./helpers"

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

function inspect(dataDir: string) {
  const ro = new Database(path.join(dataDir, "duet.sqlite"), { readonly: true, fileMustExist: true })
  try {
    const tables = (ro.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map(
      (r) => r.name,
    )
    const journalMode = ro.pragma("journal_mode", { simple: true })
    const migrations = (ro.prepare("SELECT count(*) AS n FROM __drizzle_migrations").get() as { n: number }).n
    return { tables, journalMode, migrations }
  } finally {
    ro.close()
  }
}

describe("database boot path", () => {
  it("creates duet.sqlite in WAL mode with users, sessions and __drizzle_migrations plus a media dir", async () => {
    const dataDir = makeDataDir()
    dirs.push(dataDir)
    const app = await buildApp(testConfig(dataDir))
    try {
      const fk = app.db.get<{ foreign_keys: number }>(sql`PRAGMA foreign_keys`)
      expect(fk?.foreign_keys).toBe(1)
    } finally {
      await app.close()
    }

    const { tables, journalMode } = inspect(dataDir)
    expect(tables).toEqual(expect.arrayContaining(["users", "sessions", "__drizzle_migrations"]))
    expect(journalMode).toBe("wal")
    expect(existsSync(path.join(dataDir, "media"))).toBe(true)
  })

  it("applies every migration exactly once across two boots", async () => {
    const dataDir = makeDataDir()
    dirs.push(dataDir)
    const sqlFiles = readdirSync(MIGRATIONS_FOLDER).filter((f) => f.endsWith(".sql")).length
    expect(sqlFiles).toBeGreaterThan(0)

    await (await buildApp(testConfig(dataDir))).close()
    const first = inspect(dataDir).migrations
    expect(first).toBe(sqlFiles)

    await (await buildApp(testConfig(dataDir))).close()
    expect(inspect(dataDir).migrations).toBe(first)
  })
})
