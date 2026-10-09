import { mkdirSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import Database from "better-sqlite3"
import { drizzle, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3"
import { migrate } from "drizzle-orm/better-sqlite3/migrator"
import * as schema from "./schema"

/** server/drizzle, resolved from this file (server/src/db/client.ts -> ../../drizzle). */
export const MIGRATIONS_FOLDER = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../drizzle")

export type Db = BetterSQLite3Database<typeof schema>

export interface OpenedDb {
  sqlite: Database.Database
  db: Db
}

/**
 * Open (creating if needed) `${dataDir}/duet.sqlite`, ensure `${dataDir}/media` exists (INFR-02),
 * set WAL / foreign keys / busy timeout, and apply pending migrations.
 */
export function openDb(dataDir: string): OpenedDb {
  mkdirSync(dataDir, { recursive: true })
  mkdirSync(path.join(dataDir, "media"), { recursive: true })

  const sqlite = new Database(path.join(dataDir, "duet.sqlite"))
  try {
    sqlite.pragma("journal_mode = WAL")
    sqlite.pragma("foreign_keys = ON")
    sqlite.pragma("busy_timeout = 5000")

    const db = drizzle(sqlite, { schema })
    migrate(db, { migrationsFolder: MIGRATIONS_FOLDER })
    return { sqlite, db }
  } catch (err) {
    sqlite.close()
    throw err
  }
}
