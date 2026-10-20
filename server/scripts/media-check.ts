/**
 * Media at rest check (QT-4qu-migrate, T-4qu-01 / T-4qu-07): deep-decrypt every file under
 * <DATA_DIR>/media with the existing key (it never creates one) and sort it into
 *   encrypted  valid DUETENC header and every chunk's GCM tag verifies,
 *   plaintext  no valid header,
 *   corrupt    a header, but decryption fails (tampered, truncated chunk, other key).
 *
 *   npm --prefix server run media-check
 *   npm --prefix server run media-check -- --compare DIR
 *
 * --compare DIR: every regular file under DIR (same layout as media/, e.g. a plaintext backup taken
 * before the migration) must exist under media/ and decrypt to the same sha256.
 * Prints every non-encrypted path, one summary line, and "media-check ok" last only when nothing
 * is plaintext, corrupt, missing or mismatched; otherwise it exits 1. Never prints the key.
 */
import { createHash } from "node:crypto"
import { createReadStream } from "node:fs"
import { readdir } from "node:fs/promises"
import path from "node:path"
import { pipeline } from "node:stream/promises"
import { ConfigError, loadConfig } from "../src/config"
import { MediaKeyError, readEncHeader, readMediaKey, sha256Decrypted } from "../src/media/crypto"

function fail(message: string): never {
  console.error(`media-check: ${message}`)
  process.exit(1)
}

/** Every regular file under root, as paths relative to root (sorted). A missing root is empty. */
async function walk(root: string): Promise<string[]> {
  try {
    const entries = await readdir(root, { recursive: true, withFileTypes: true })
    return entries
      .filter((e) => e.isFile())
      .map((e) => path.relative(root, path.join(e.parentPath, e.name)))
      .sort()
  } catch (err) {
    if ((err as { code?: string }).code === "ENOENT") return []
    throw err
  }
}

async function sha256File(file: string): Promise<string> {
  const hash = createHash("sha256")
  await pipeline(createReadStream(file), hash)
  return hash.digest("hex")
}

const args = process.argv.slice(2)
let compareDir: string | null = null
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--compare") {
    const dir = args[++i]
    if (!dir) fail("--compare needs a directory")
    compareDir = path.resolve(dir)
  } else {
    fail(`unknown argument ${args[i]}`)
  }
}

let config
let key: Buffer
try {
  config = loadConfig()
  key = await readMediaKey(config.MEDIA_KEY_FILE)
} catch (err) {
  if (err instanceof MediaKeyError || err instanceof ConfigError) fail(err.message)
  throw err
}
const mediaRoot = path.join(config.DATA_DIR, "media")

let encrypted = 0
let plaintext = 0
let corrupt = 0
const digests = new Map<string, string>()
/** Present under media/ but not verifiable (plaintext or corrupt): a compare counts it mismatched. */
const unverified = new Set<string>()
for (const rel of await walk(mediaRoot)) {
  const file = path.join(mediaRoot, rel)
  if (!(await readEncHeader(file))) {
    plaintext++
    unverified.add(rel)
    console.log(`plaintext ${rel}`)
    continue
  }
  try {
    digests.set(rel, await sha256Decrypted(key, file))
    encrypted++
  } catch {
    corrupt++
    unverified.add(rel)
    console.log(`corrupt ${rel}`)
  }
}

let compared = 0
let missing = 0
let mismatched = 0
if (compareDir) {
  for (const rel of await walk(compareDir)) {
    compared++
    const got = digests.get(rel)
    if (got === undefined && unverified.has(rel)) {
      mismatched++
      console.log(`mismatched ${rel}`)
      continue
    }
    if (got === undefined) {
      missing++
      console.log(`missing ${rel}`)
      continue
    }
    if (got !== (await sha256File(path.join(compareDir, rel)))) {
      mismatched++
      console.log(`mismatched ${rel}`)
    }
  }
}

console.log(
  `media-check: ${mediaRoot}: encrypted ${encrypted}, plaintext ${plaintext}, corrupt ${corrupt}` +
    (compareDir ? `; compared ${compared} against ${compareDir}: missing ${missing}, mismatched ${mismatched}` : ""),
)
if (plaintext + corrupt + missing + mismatched > 0) process.exit(1)
console.log("media-check ok")
