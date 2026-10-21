import { existsSync } from "node:fs"
import path from "node:path"
import { Readable } from "node:stream"
import { eq } from "drizzle-orm"
import type { FastifyInstance, FastifyReply } from "fastify"
import { requireUser } from "../auth/session"
import { attachments } from "../db/schema"
import { decryptChunks, readEncHeader } from "./crypto"
import { ATTACHMENT_ID_RE } from "./uploads"

/**
 * The only files GET /media can serve: regenerated variants with a fixed Content-Type (T-02-22).
 * The original is deliberately absent, and the URL has no extension, so the Cloudflare edge never
 * treats media as a cacheable static asset (T-02-27). avatar-sm / avatar-lg are the square crops of a
 * profile photo attachment (QT-5zd-photo-store): same session gate, ready check and decrypting path.
 */
const VARIANTS = {
  thumb: ["thumb.webp", "image/webp"],
  display: ["display.webp", "image/webp"],
  poster: ["poster.jpg", "image/jpeg"],
  video: ["video.mp4", "video/mp4"],
  audio: ["audio.m4a", "audio/mp4"],
  "avatar-sm": ["avatar-sm.webp", "image/webp"],
  "avatar-lg": ["avatar-lg.webp", "image/webp"],
} as const satisfies Record<string, readonly [string, string]>

type VariantName = keyof typeof VARIANTS

function isVariant(v: string): v is VariantName {
  return Object.hasOwn(VARIANTS, v)
}

/** Every miss is a JSON 404 that no cache keeps (Pitfall 10: a tile asked for too early recovers). */
function notFound(reply: FastifyReply) {
  return reply.code(404).header("Cache-Control", "no-store").send({ error: "not_found" })
}

export interface MediaRoutesOptions {
  /** <DATA_DIR>/media */
  mediaRoot: string
  /** AES-256 media key: every stored variant is DUETENC ciphertext (QT-4qu-serve). */
  key: Buffer
}

/**
 * A Range header against a plaintext of `size` bytes (QT-4qu-serve, T-4qu-05). Only one
 * "bytes=" range is honored: anything else (several ranges, another unit, garbage, start > end)
 * returns null and the full 200 is sent. A range that starts past the end, a zero-length suffix or
 * any range on an empty file is "unsatisfiable" (416). The end is clamped to the last byte.
 */
export function parseRange(
  header: string | undefined,
  size: number,
): { start: number; end: number } | "unsatisfiable" | null {
  if (header === undefined) return null
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim())
  if (!m) return null
  const [, rawStart, rawEnd] = m
  if (rawStart === "" && rawEnd === "") return null
  if (rawStart === "") {
    // Suffix: the last N bytes.
    const n = Number(rawEnd)
    if (n === 0 || size === 0) return "unsatisfiable"
    return { start: Math.max(0, size - n), end: size - 1 }
  }
  const start = Number(rawStart)
  if (rawEnd !== "" && Number(rawEnd) < start) return null
  if (start >= size) return "unsatisfiable"
  const end = rawEnd === "" ? size - 1 : Math.min(Number(rawEnd), size - 1)
  return { start, end }
}

/** If-None-Match: a comma list (weak W/ prefixes accepted) that contains the ETag or "*". */
function matchesIfNoneMatch(header: string | undefined, etag: string): boolean {
  if (!header) return false
  return header
    .split(",")
    .map((t) => t.trim().replace(/^W\//, ""))
    .some((t) => t === "*" || t === etag)
}

/**
 * Auth-gated media (MDIA-05, research Pattern 7): only the two logged-in people can read media, ready
 * files are private and immutable. Stored files are DUETENC ciphertext and are decrypted on the fly
 * (QT-4qu-serve): Range/206/416, If-Range and ETag/304 are handled here over the 64 KiB chunk
 * index, so a Range request (iOS video) decrypts only the chunks it covers and HEAD decrypts
 * nothing. Every path is built by the server from a validated id and a fixed variant (T-02-23).
 */
export async function mediaRoutes(app: FastifyInstance, opts: MediaRoutesOptions) {
  const { mediaRoot, key } = opts

  app.get("/media/:id/:variant", { preHandler: requireUser }, async (request, reply) => {
    const { id, variant } = request.params as { id: string; variant: string }
    if (!ATTACHMENT_ID_RE.test(id) || !isVariant(variant)) return notFound(reply)
    const row = app.db
      .select({ status: attachments.status })
      .from(attachments)
      .where(eq(attachments.id, id))
      .get()
    if (!row || row.status !== "ready") return notFound(reply)
    const [file, type] = VARIANTS[variant]
    const abs = path.join(mediaRoot, id, file)
    // A variant this kind does not have (a photo's poster): a no-store 404, never an immutable one.
    if (!existsSync(abs)) return notFound(reply)
    const header = await readEncHeader(abs)
    if (!header) {
      // Plaintext or damaged on disk: never serve garbage or unencrypted bytes (T-4qu-03).
      request.log.error({ evt: "media_unreadable", attachmentId: id, variant })
      return reply.code(500).header("Cache-Control", "no-store").send({ error: "media_unreadable" })
    }
    const size = header.plainSize
    const etag = `"${header.etag}"`
    reply
      .header("Cache-Control", "private, max-age=31536000, immutable")
      .header("ETag", etag)
      .header("Accept-Ranges", "bytes")
      .type(type)
    if (matchesIfNoneMatch(request.headers["if-none-match"], etag)) return reply.code(304).send()

    const ifRange = request.headers["if-range"]
    const range = ifRange === undefined || String(ifRange).trim() === etag ? parseRange(request.headers.range, size) : null
    if (range === "unsatisfiable") {
      return reply
        .code(416)
        .header("Cache-Control", "no-store")
        .header("Content-Range", `bytes */${size}`)
        .send()
    }
    let start = 0
    let end = size - 1
    if (range) {
      start = range.start
      end = range.end
      reply.code(206).header("Content-Range", `bytes ${start}-${end}/${size}`)
    }
    const length = size === 0 ? 0 : end - start + 1
    reply.header("Content-Length", length)
    if (request.method === "HEAD" || length === 0) return reply.send(Readable.from([], { objectMode: false }))
    return reply.send(Readable.from(decryptChunks(key, abs, header, start, end), { objectMode: false }))
  })
}
