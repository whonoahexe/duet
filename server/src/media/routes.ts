import { existsSync } from "node:fs"
import path from "node:path"
import { eq } from "drizzle-orm"
import type { FastifyInstance, FastifyReply } from "fastify"
import { requireUser } from "../auth/session"
import { attachments } from "../db/schema"
import { ATTACHMENT_ID_RE } from "./uploads"

/**
 * The only files GET /media can serve: regenerated variants with a fixed Content-Type (T-02-22).
 * The original is deliberately absent, and the URL has no extension, so the Cloudflare edge never
 * treats media as a cacheable static asset (T-02-27).
 */
const VARIANTS = {
  thumb: ["thumb.webp", "image/webp"],
  display: ["display.webp", "image/webp"],
  poster: ["poster.jpg", "image/jpeg"],
  video: ["video.mp4", "video/mp4"],
  audio: ["audio.m4a", "audio/mp4"],
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
}

/**
 * Auth-gated media (MDIA-05, research Pattern 7): only the two logged-in people can read media, ready
 * files are private and immutable, and Range/206/416 come from @fastify/static's reply.sendFile
 * (iOS video needs Range). Every path is built by the server from a validated id and a fixed variant
 * (T-02-23).
 */
export async function mediaRoutes(app: FastifyInstance, opts: MediaRoutesOptions) {
  const { mediaRoot } = opts

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
    const rel = `${id}/${file}`
    // A variant this kind does not have (a photo's poster): never let sendFile fall through to the
    // HTML not-found page with an immutable header already set.
    if (!existsSync(path.join(mediaRoot, rel))) return notFound(reply)
    reply.header("Cache-Control", "private, max-age=31536000, immutable").type(type)
    return reply.sendFile(rel, mediaRoot, { cacheControl: false })
  })
}
