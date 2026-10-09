/**
 * Seed CLI (AUTH-01, D-07): create/update the two duet accounts.
 *
 *   npm run seed                          interactive; passwords typed twice, hidden
 *   ... | npm run seed -- --stdin         JSON array on stdin
 *   DUET_SEED_FILE=/path npm run seed     JSON array in a file (keep it mode 600)
 *
 * JSON shape: [{ "username": "...", "displayName": "...", "password": "..." }, ...] (1 or 2 entries).
 * Passwords are never accepted as arguments and never printed or logged.
 */
import { readFileSync, statSync } from "node:fs"
import { createInterface } from "node:readline"
import { Writable } from "node:stream"
import { ConfigError, loadConfig } from "../src/config"
import { openDb } from "../src/db/client"
import { MAX_ACCOUNTS, SeedError, seedUsers, type SeedEntry, type SeedResult } from "../src/db/seed"

function fail(message: string): never {
  console.error(`seed: ${message}`)
  process.exit(1)
}

function parseEntries(raw: string, source: string): SeedEntry[] {
  let data: unknown
  try {
    data = JSON.parse(raw)
  } catch {
    // Do not echo the input: it contains passwords.
    fail(`${source} is not valid JSON`)
  }
  if (!Array.isArray(data)) fail(`${source} must be a JSON array of {username, displayName, password}`)
  return data as SeedEntry[]
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk))
  return Buffer.concat(chunks).toString("utf8")
}

async function promptInteractive(): Promise<SeedEntry[]> {
  if (!process.stdin.isTTY) fail("no TTY for interactive mode; use --stdin or DUET_SEED_FILE")

  let muted = false
  const output = new Writable({
    write(chunk, _enc, cb) {
      if (!muted) process.stdout.write(chunk)
      cb()
    },
  })
  const rl = createInterface({ input: process.stdin, output, terminal: true })
  const ask = (q: string) =>
    new Promise<string>((resolve) => {
      process.stdout.write(q)
      rl.question("", (a) => resolve(a))
    })
  const askHidden = async (q: string) => {
    process.stdout.write(q)
    muted = true
    const answer = await new Promise<string>((resolve) => rl.question("", (a) => resolve(a)))
    muted = false
    process.stdout.write("\n")
    return answer
  }

  const entries: SeedEntry[] = []
  try {
    while (entries.length < MAX_ACCOUNTS) {
      console.log(`\nAccount ${entries.length + 1}`)
      const username = (await ask("  username (a-z, 0-9, _ or -): ")).trim()
      const displayName = (await ask("  display name: ")).trim()
      const password = await askHidden("  password (hidden): ")
      const again = await askHidden("  password again: ")
      if (password !== again) fail(`${username || "account"}: passwords do not match`)
      entries.push({ username, displayName, password })
      if (entries.length < MAX_ACCOUNTS) {
        const more = (await ask("Add another account? [y/N] ")).trim().toLowerCase()
        if (more !== "y" && more !== "yes") break
      }
    }
  } finally {
    rl.close()
  }
  return entries
}

function describe(r: SeedResult): string {
  return r.status === "password-reset"
    ? `seeded ${r.username}: password-reset (${r.sessionsRevoked} session${r.sessionsRevoked === 1 ? "" : "s"} revoked)`
    : `seeded ${r.username}: ${r.status}`
}

async function main() {
  const args = process.argv.slice(2)
  const useStdin = args.includes("--stdin")
  // Never accept passwords (or anything else) as arguments; never echo unknown args back.
  if (args.some((a) => a !== "--stdin")) fail("unknown argument (only --stdin is accepted; passwords are never arguments)")

  let config
  try {
    config = loadConfig()
  } catch (err) {
    if (err instanceof ConfigError) fail(err.message)
    throw err
  }

  let entries: SeedEntry[]
  const seedFile = process.env.DUET_SEED_FILE?.trim()
  if (useStdin) {
    entries = parseEntries(await readStdin(), "stdin")
  } else if (seedFile) {
    let raw: string
    try {
      const mode = statSync(seedFile).mode & 0o777
      if (mode & 0o077) console.error(`seed: warning: ${seedFile} is readable by others (mode ${mode.toString(8)}); use chmod 600`)
      raw = readFileSync(seedFile, "utf8")
    } catch {
      fail(`cannot read DUET_SEED_FILE (${seedFile})`)
    }
    entries = parseEntries(raw, "DUET_SEED_FILE")
  } else {
    entries = await promptInteractive()
  }

  const { sqlite, db } = openDb(config.DATA_DIR)
  try {
    const results = await seedUsers(db, entries)
    for (const r of results) console.log(describe(r))
  } catch (err) {
    if (err instanceof SeedError) fail(err.message)
    throw err
  } finally {
    sqlite.close()
  }
}

main().catch((err) => {
  console.error(`seed: unexpected error: ${err instanceof Error ? err.message : String(err)}`)
  process.exit(1)
})
