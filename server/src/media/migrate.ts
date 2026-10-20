import { createHash, randomBytes } from "node:crypto"
import { createReadStream } from "node:fs"
import { readdir, rename, rm, stat, utimes } from "node:fs/promises"
import path from "node:path"
import { pipeline } from "node:stream/promises"
import type { FastifyBaseLogger } from "fastify"
import { encryptFile, readEncHeader, sha256Decrypted } from "./crypto"
import { ATTACHMENT_ID_RE } from "./uploads"

export interface MediaAtRestCounts {
  /** Plaintext files encrypted in place by this run. */
  encrypted: number
  /** Files that already carried a valid DUETENC header (left untouched). */
  alreadyEncrypted: number
  /** Crash scratch (*.tmp, dotfiles) deleted. */
  removed: number
  /** Files that could not be encrypted (logged, left as they were; media-check reports them). */
  failed: number
}

export interface EncryptMediaAtRestOptions {
  key: Buffer
  /** <DATA_DIR>/media */
  mediaRoot: string
  log: FastifyBaseLogger
}

async function sha256File(file: string): Promise<string> {
  const hash = createHash("sha256")
  await pipeline(createReadStream(file), hash)
  return hash.digest("hex")
}

function errCode(err: unknown): string | undefined {
  return typeof err === "object" && err !== null && "code" in err ? String((err as { code: unknown }).code) : undefined
}

/**
 * One-time, idempotent boot migration to media at rest (QT-4qu-migrate, T-4qu-07). Runs in onReady
 * before media.start(), so every stored file is ciphertext before the first request is served and
 * before any job is requeued.
 *
 * - media/<id>/*: *.tmp and dotfiles are crash scratch and are deleted; a file with a valid header
 *   is skipped; any other file is encrypted to a temp file, the decrypted sha256 is checked against
 *   the plaintext, and only then is the temp renamed over the file.
 * - media/tmp/<id>/<n>.part: the same encrypt-in-place step (the dir's mtime is restored, so the
 *   24 h stale-upload cleanup keeps its clock); *.tmp there is deleted.
 * - media/work is skipped (process.start wipes it), as is every other top-level entry.
 *
 * A single file never makes it throw: failures are logged with the relative path and counted.
 */
export async function encryptMediaAtRest(opts: EncryptMediaAtRestOptions): Promise<MediaAtRestCounts> {
  const { key, mediaRoot, log } = opts
  const started = Date.now()
  const counts: MediaAtRestCounts = { encrypted: 0, alreadyEncrypted: 0, removed: 0, failed: 0 }
  const rel = (file: string) => path.relative(mediaRoot, file)

  async function remove(file: string): Promise<void> {
    try {
      await rm(file, { force: true })
      counts.removed++
    } catch (err) {
      counts.failed++
      log.error({ evt: "media_at_rest_failed", path: rel(file), err: errCode(err) ?? "error" })
    }
  }

  async function encryptInPlace(file: string): Promise<void> {
    const temp = `${file}.enc-${randomBytes(4).toString("hex")}.tmp`
    try {
      if (await readEncHeader(file)) {
        counts.alreadyEncrypted++
        return
      }
      const expected = await sha256File(file)
      await encryptFile(key, file, temp)
      if ((await sha256Decrypted(key, temp)) !== expected) throw new Error("decrypted sha256 mismatch")
      await rename(temp, file)
      counts.encrypted++
    } catch (err) {
      await rm(temp, { force: true }).catch(() => {})
      counts.failed++
      log.error({
        evt: "media_at_rest_failed",
        path: rel(file),
        err: errCode(err) ?? (err instanceof Error ? err.message : String(err)),
      })
    }
  }

  async function listDir(dir: string) {
    try {
      return await readdir(dir, { withFileTypes: true })
    } catch (err) {
      if (errCode(err) === "ENOENT") return []
      throw err
    }
  }

  for (const entry of await listDir(mediaRoot)) {
    if (!entry.isDirectory()) continue
    const dir = path.join(mediaRoot, entry.name)
    if (ATTACHMENT_ID_RE.test(entry.name)) {
      for (const f of await listDir(dir)) {
        if (!f.isFile()) continue
        const file = path.join(dir, f.name)
        if (f.name.endsWith(".tmp") || f.name.startsWith(".")) await remove(file)
        else await encryptInPlace(file)
      }
    } else if (entry.name === "tmp") {
      for (const up of await listDir(dir)) {
        if (!up.isDirectory()) continue
        const upDir = path.join(dir, up.name)
        let times: { atime: Date; mtime: Date } | null = null
        try {
          times = await stat(upDir)
        } catch {
          /* vanished meanwhile */
        }
        for (const f of await listDir(upDir)) {
          if (!f.isFile()) continue
          const file = path.join(upDir, f.name)
          if (f.name.endsWith(".tmp")) await remove(file)
          else if (f.name.endsWith(".part")) await encryptInPlace(file)
        }
        if (times) await utimes(upDir, times.atime, times.mtime).catch(() => {})
      }
    }
  }

  log.info({ evt: "media_at_rest", ...counts, ms: Date.now() - started })
  return counts
}
