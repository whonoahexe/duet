import { and, desc, eq, inArray, sql } from "drizzle-orm"
import type { FastifyInstance } from "fastify"
import { GalleryQuery, MAX_ALBUM_ITEMS, galleryKey, type GalleryItem, type GalleryPage } from "@duet/shared"
import { requireUser } from "../auth/session"
import { toAttachmentDto } from "../chat/service"
import type { Db } from "../db/client"
import { attachments, messages } from "../db/schema"

/**
 * One page of the shared media gallery (QT-5zd-gallery): every ready photo and video that belongs to
 * a message, newest first by (message seq, album position). Profile photos never have a message, so
 * the inner join leaves them out. Voice notes, failed and processing
 * uploads are filtered out.
 */
export function galleryPage(db: Db, { before, limit }: { before?: number; limit: number }): GalleryPage {
  const conditions = [eq(attachments.status, "ready"), inArray(attachments.kind, ["image", "video"])]
  if (before !== undefined) {
    conditions.push(sql`${attachments.messageSeq} * ${MAX_ALBUM_ITEMS} + ${attachments.position} < ${before}`)
  }
  const rows = db
    .select({ attachment: attachments, seq: messages.seq, senderId: messages.senderId, createdAt: messages.createdAt })
    .from(attachments)
    .innerJoin(messages, eq(attachments.messageSeq, messages.seq))
    .where(and(...conditions))
    .orderBy(desc(messages.seq), desc(attachments.position))
    .limit(limit + 1)
    .all()
  const hasMore = rows.length > limit
  const items: GalleryItem[] = rows.slice(0, limit).map((r) => ({
    key: galleryKey(r.seq, r.attachment.position),
    seq: r.seq,
    senderId: r.senderId,
    createdAt: r.createdAt.getTime(),
    attachment: toAttachmentDto(r.attachment),
  }))
  return { items, hasMore, next: hasMore ? items[items.length - 1]!.key : null }
}

/** GET /api/media: the gallery, for the two logged-in people only, never cached (T-5zd-08). */
export async function galleryRoutes(app: FastifyInstance) {
  app.get("/api/media", { preHandler: requireUser }, async (request, reply) => {
    reply.header("Cache-Control", "no-store")
    const parsed = GalleryQuery.safeParse(request.query)
    if (!parsed.success) return reply.code(400).send({ error: "invalid_query" })
    return galleryPage(app.db, parsed.data)
  })
}
