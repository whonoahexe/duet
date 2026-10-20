import { existsSync } from "node:fs"
import { mkdir, mkdtemp, readdir, rm, stat } from "node:fs/promises"
import path from "node:path"
import { and, eq, lt } from "drizzle-orm"
import type { FastifyBaseLogger } from "fastify"
import type { AttachmentKind } from "@duet/shared"
import type { Db } from "../db/client"
import { attachments } from "../db/schema"
import { decryptToFile, encryptFile } from "./crypto"
import { MediaError } from "./exec"
import { processAudio } from "./audio"
import { processImage } from "./image"
import { probeMedia } from "./probe"
import { processVideo } from "./video"

/** Temp chunk dirs and never-completed uploads older than this are deleted at boot. */
export const STALE_UPLOAD_MS = 24 * 60 * 60 * 1000

export type Lane = "fast" | "slow"

/** What a finished job stores on the attachment row (besides status). */
export interface JobResult {
  width?: number | null
  height?: number | null
  durationMs?: number | null
  waveform?: number[] | null
}

/** One processing step for an attachment kind: reads the plaintext original, writes variants into outDir. */
export type KindHandler = (original: string, outDir: string) => Promise<JobResult>

/**
 * Every variant a job can produce (QT-4qu-write). The job writes them into its scratch dir and only
 * their encrypted copies reach media/<id>.
 */
export const VARIANT_FILES = ["thumb.webp", "display.webp", "poster.jpg", "video.mp4", "audio.m4a"] as const

/**
 * media/work: per-job and per-complete plaintext scratch dirs (<id>-XXXXXX) for sharp and ffmpeg
 * (T-4qu-01). Each is removed when its step ends, and the whole dir is wiped at boot.
 */
export function workRoot(mediaRoot: string): string {
  return path.join(mediaRoot, "work")
}

export interface MediaProcessorOptions {
  db: Db
  /** <DATA_DIR>/media */
  mediaRoot: string
  log: FastifyBaseLogger
  /** AES-256 media key: variants are stored encrypted (QT-4qu-write). */
  key: Buffer
  /** Called after an attachment became ready or failed (the app bumps its message and broadcasts). */
  onAttachmentChanged: (id: string) => void
}

export interface MediaProcessor {
  /** Queue an attachment whose status is processing, on the lane its kind uses. */
  enqueue(id: string): void
  /** Boot: re-queue every attachment still processing; delete stale temp dirs and uploads. */
  start(): Promise<void>
  /** Hold jobs (tests): queued work waits until resume(). */
  pause(): void
  resume(): void
  /** Resolves once both lanes are empty and idle. */
  idle(): Promise<void>
  /** Stop starting jobs and wait for the running ones (app shutdown). */
  close(): Promise<void>
  /** Kinds this server can process (POST /api/uploads rejects the rest with 422 unsupported_media). */
  supports(kind: AttachmentKind): boolean
}

/** media/<id> for an attachment id the server generated (never a client string). */
export function attachmentDir(mediaRoot: string, id: string): string {
  return path.join(mediaRoot, id)
}

/** media/tmp/<id>: the chunk parts of an upload in progress. */
export function uploadTmpDir(mediaRoot: string, id: string): string {
  return path.join(mediaRoot, "tmp", id)
}

/**
 * Two serial in-process lanes (research Pattern 6): "fast" for images and voice notes, "slow" for
 * video, so a long transcode never delays a photo. Each lane runs one job at a time
 * (T-02-25). A job never touches the original (D-09).
 */
export function createMediaProcessor(opts: MediaProcessorOptions): MediaProcessor {
  const { db, mediaRoot, log, key, onAttachmentChanged } = opts
  const handlers: Partial<Record<AttachmentKind, { lane: Lane; run: KindHandler }>> = {
    image: {
      lane: "fast",
      run: async (original, outDir) => processImage(original, outDir),
    },
    // Voice notes are short jobs and share the fast lane with photos (research Pattern 6).
    audio: {
      lane: "fast",
      run: async (original, outDir) => processAudio(original, outDir, await probeMedia(original)),
    },
    // A transcode can take minutes: its own serial lane, so photos never wait behind it (T-02-31).
    video: {
      lane: "slow",
      run: async (original, outDir) => processVideo(original, outDir, await probeMedia(original)),
    },
  }

  /**
   * Run a handler in a fresh media/work/<id>-XXXXXX scratch dir (T-4qu-01): the encrypted original
   * is decrypted into scratch/original, sharp/ffmpeg write their variants next to it, and each
   * variant is stored encrypted in media/<id>. The scratch dir is removed whatever happens.
   */
  async function runInScratch(id: string, run: KindHandler): Promise<JobResult> {
    const dir = attachmentDir(mediaRoot, id)
    await mkdir(workRoot(mediaRoot), { recursive: true, mode: 0o700 })
    const scratch = await mkdtemp(path.join(workRoot(mediaRoot), `${id}-`))
    try {
      const original = path.join(scratch, "original")
      await decryptToFile(key, path.join(dir, "original"), original)
      const result = await run(original, scratch)
      for (const name of VARIANT_FILES) {
        const produced = path.join(scratch, name)
        if (existsSync(produced)) await encryptFile(key, produced, path.join(dir, name))
      }
      return result
    } finally {
      await rm(scratch, { recursive: true, force: true })
    }
  }

  const queues: Record<Lane, string[]> = { fast: [], slow: [] }
  const running: Record<Lane, Promise<void> | null> = { fast: null, slow: null }
  const queued = new Set<string>()
  let paused = false
  let closed = false
  let idleWaiters: Array<() => void> = []

  function isIdle(): boolean {
    return queues.fast.length === 0 && queues.slow.length === 0 && !running.fast && !running.slow
  }

  function notifyIdle(): void {
    if (!isIdle()) return
    const waiters = idleWaiters
    idleWaiters = []
    for (const w of waiters) w()
  }

  function pump(lane: Lane): void {
    if (paused || closed || running[lane]) return
    const id = queues[lane].shift()
    if (id === undefined) {
      notifyIdle()
      return
    }
    queued.delete(id)
    running[lane] = runJob(id)
      .catch((err: unknown) => {
        log.error({ evt: "media_job_crash", attachmentId: id, err: err instanceof Error ? err.message : String(err) })
      })
      .finally(() => {
        running[lane] = null
        pump(lane)
        notifyIdle()
      })
  }

  async function runJob(id: string): Promise<void> {
    const row = db.select().from(attachments).where(eq(attachments.id, id)).get()
    if (!row || row.status !== "processing") return
    const handler = handlers[row.kind]
    const started = Date.now()
    let patch: Partial<typeof attachments.$inferInsert>
    if (!handler) {
      patch = { status: "failed", error: "unsupported_media" }
    } else {
      try {
        const result = await runInScratch(id, handler.run)
        patch = {
          status: "ready",
          error: null,
          width: result.width ?? null,
          height: result.height ?? null,
          durationMs: result.durationMs ?? null,
          waveform: result.waveform ? JSON.stringify(result.waveform) : null,
        }
      } catch (err) {
        const code = err instanceof MediaError ? err.code : row.kind === "image" ? "processing_failed" : "transcode_failed"
        if (err instanceof MediaError && err.detail) log.debug({ evt: "media_job_detail", attachmentId: id, detail: err.detail })
        patch = { status: "failed", error: code }
      }
    }
    db.update(attachments).set(patch).where(eq(attachments.id, id)).run()
    log.info({
      evt: "media_processed",
      attachmentId: id,
      kind: row.kind,
      status: patch.status,
      ...(patch.error ? { code: patch.error } : {}),
      ms: Date.now() - started,
    })
    onAttachmentChanged(id)
  }

  async function cleanupStale(now: number): Promise<void> {
    const cutoff = now - STALE_UPLOAD_MS
    // Never-completed uploads: their row, chunk dir and any partial media dir.
    const stale = db
      .select({ id: attachments.id })
      .from(attachments)
      .where(and(eq(attachments.status, "uploading"), lt(attachments.createdAt, new Date(cutoff))))
      .all()
    for (const { id } of stale) {
      await rm(uploadTmpDir(mediaRoot, id), { recursive: true, force: true })
      await rm(attachmentDir(mediaRoot, id), { recursive: true, force: true })
      db.delete(attachments).where(eq(attachments.id, id)).run()
    }
    // Orphaned chunk dirs (no row, or a row that has moved on) older than the cutoff.
    const tmpRoot = path.join(mediaRoot, "tmp")
    if (!existsSync(tmpRoot)) return
    for (const name of await readdir(tmpRoot)) {
      const dir = path.join(tmpRoot, name)
      try {
        const s = await stat(dir)
        if (s.mtimeMs < cutoff) await rm(dir, { recursive: true, force: true })
      } catch {
        /* vanished meanwhile */
      }
    }
    if (stale.length > 0) log.info({ evt: "media_cleanup", uploads: stale.length })
  }

  const processor: MediaProcessor = {
    enqueue(id) {
      if (closed || queued.has(id)) return
      const row = db.select({ kind: attachments.kind }).from(attachments).where(eq(attachments.id, id)).get()
      if (!row) return
      const lane = handlers[row.kind]?.lane ?? "fast"
      queued.add(id)
      queues[lane].push(id)
      pump(lane)
    },
    async start() {
      // Only this process writes media/work, so anything left there is plaintext from a crash.
      await rm(workRoot(mediaRoot), { recursive: true, force: true })
      await cleanupStale(Date.now())
      const pending = db
        .select({ id: attachments.id })
        .from(attachments)
        .where(eq(attachments.status, "processing"))
        .all()
      for (const { id } of pending) processor.enqueue(id)
      if (pending.length > 0) log.info({ evt: "media_requeued", count: pending.length })
    },
    pause() {
      paused = true
    },
    resume() {
      paused = false
      pump("fast")
      pump("slow")
      notifyIdle()
    },
    idle() {
      if (isIdle() || (paused && !running.fast && !running.slow)) return Promise.resolve()
      return new Promise((resolve) => idleWaiters.push(resolve))
    },
    async close() {
      closed = true
      queues.fast.length = 0
      queues.slow.length = 0
      queued.clear()
      await Promise.all([running.fast, running.slow])
      notifyIdle()
    },
    supports(kind) {
      return handlers[kind] !== undefined
    },
  }
  return processor
}
