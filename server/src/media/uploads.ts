import { randomBytes } from "node:crypto"
import { createReadStream, createWriteStream, existsSync } from "node:fs"
import { mkdir, rename, rm, writeFile } from "node:fs/promises"
import path from "node:path"
import { pipeline } from "node:stream/promises"
import { eq } from "drizzle-orm"
import type { FastifyInstance } from "fastify"
import {
  CreateUploadBody,
  UPLOAD_CHUNK_SIZE,
  UPLOAD_LIMITS,
  chunkCount,
  type AttachmentDto,
  type CompleteUploadResponse,
  type CreateUploadResponse,
} from "@duet/shared"
import { requireUser } from "../auth/session"
import { toAttachmentDto } from "../chat/service"
import { attachments } from "../db/schema"
import { attachmentDir, uploadTmpDir, type MediaProcessor } from "./process"

/** Attachment ids are 128-bit randomBytes as base64url: exactly 22 characters (T-02-23). */
export const ATTACHMENT_ID_RE = /^[A-Za-z0-9_-]{22}$/
/** Chunk index path parameter: a small decimal integer (a 200 MB video has 25 chunks). */
const INDEX_RE = /^(0|[1-9][0-9]{0,3})$/

export interface UploadRoutesOptions {
  processor: MediaProcessor
  /** <DATA_DIR>/media */
  mediaRoot: string
}

/**
 * Chunked uploads (MDIA-05, research Pattern 5). Cloudflare's Free plan rejects bodies over 100 MB
 * (Pitfall 1), so a file is sent as 8 MiB raw application/octet-stream chunks and assembled on
 * complete. The octet-stream parser exists only inside this plugin's scope, with an 8 MiB limit.
 * Only the uploader can write chunks, complete, or later attach the upload (T-02-28). Non-GET
 * requests are already Origin-checked globally.
 */
export async function uploadRoutes(app: FastifyInstance, opts: UploadRoutesOptions) {
  const { processor, mediaRoot } = opts

  app.addContentTypeParser(
    "application/octet-stream",
    { parseAs: "buffer", bodyLimit: UPLOAD_CHUNK_SIZE },
    (_request, body, done) => done(null, body),
  )

  function ownUpload(id: string, userId: string) {
    if (!ATTACHMENT_ID_RE.test(id)) return null
    const row = app.db.select().from(attachments).where(eq(attachments.id, id)).get()
    return row && row.uploaderId === userId ? row : null
  }

  app.post("/api/uploads", { preHandler: requireUser }, async (request, reply) => {
    reply.header("Cache-Control", "no-store")
    const parsed = CreateUploadBody.safeParse(request.body)
    if (!parsed.success) return reply.code(400).send({ error: "invalid_body" })
    const { kind, size } = parsed.data
    if (!processor.supports(kind)) return reply.code(422).send({ error: "unsupported_media" })
    if (size > UPLOAD_LIMITS[kind]) return reply.code(413).send({ error: "too_large" })

    const id = randomBytes(16).toString("base64url")
    app.db
      .insert(attachments)
      .values({
        id,
        uploaderId: request.user!.id,
        kind,
        status: "uploading",
        declaredSize: size,
        createdAt: new Date(),
      })
      .run()
    request.log.info({ evt: "upload_created", userId: request.user!.id, attachmentId: id, kind, size })
    const body: CreateUploadResponse = { id, chunkSize: UPLOAD_CHUNK_SIZE }
    return body
  })

  // onRequest auth: an unauthenticated client never gets the server to buffer 8 MiB (T-02-24).
  app.put(
    "/api/uploads/:id/chunks/:index",
    { onRequest: requireUser, bodyLimit: UPLOAD_CHUNK_SIZE },
    async (request, reply) => {
      reply.header("Cache-Control", "no-store")
      const { id, index: rawIndex } = request.params as { id: string; index: string }
      const row = ownUpload(id, request.user!.id)
      if (!row || row.status !== "uploading") return reply.code(404).send({ error: "not_found" })
      const body = request.body
      if (!INDEX_RE.test(rawIndex) || !Buffer.isBuffer(body)) return reply.code(400).send({ error: "bad_chunk" })
      const index = Number(rawIndex)
      const count = chunkCount(row.declaredSize)
      if (index >= count) return reply.code(400).send({ error: "bad_chunk" })
      const expected = Math.min(UPLOAD_CHUNK_SIZE, row.declaredSize - index * UPLOAD_CHUNK_SIZE)
      if (body.length !== expected) return reply.code(400).send({ error: "bad_chunk" })

      // A retried chunk overwrites atomically: write a unique temp file, then rename over the part.
      const dir = uploadTmpDir(mediaRoot, id)
      await mkdir(dir, { recursive: true })
      const tmp = path.join(dir, `${index}.part.${randomBytes(4).toString("hex")}.tmp`)
      try {
        await writeFile(tmp, body)
        await rename(tmp, path.join(dir, `${index}.part`))
      } catch (err) {
        await rm(tmp, { force: true })
        throw err
      }
      return reply.code(204).send()
    },
  )

  /** Completions in flight, so a doubled complete waits for the first instead of racing it. */
  const completing = new Map<string, Promise<AttachmentDto | "incomplete">>()

  async function complete(id: string, declaredSize: number): Promise<AttachmentDto | "incomplete"> {
    const dir = uploadTmpDir(mediaRoot, id)
    const count = chunkCount(declaredSize)
    const parts = Array.from({ length: count }, (_, i) => path.join(dir, `${i}.part`))
    if (!parts.every((p) => existsSync(p))) return "incomplete"

    const outDir = attachmentDir(mediaRoot, id)
    await mkdir(outDir, { recursive: true })
    const original = path.join(outDir, "original")
    const tmp = `${original}.tmp`
    const out = createWriteStream(tmp)
    try {
      for (let i = 0; i < parts.length; i++) {
        await pipeline(createReadStream(parts[i]), out, { end: i === parts.length - 1 })
      }
      await rename(tmp, original)
    } catch (err) {
      out.destroy()
      await rm(tmp, { force: true })
      throw err
    }
    await rm(dir, { recursive: true, force: true })

    const row = app.db
      .update(attachments)
      .set({ status: "processing" })
      .where(eq(attachments.id, id))
      .returning()
      .get()
    processor.enqueue(id)
    return toAttachmentDto(row)
  }

  app.post("/api/uploads/:id/complete", { preHandler: requireUser }, async (request, reply) => {
    reply.header("Cache-Control", "no-store")
    const { id } = request.params as { id: string }
    const row = ownUpload(id, request.user!.id)
    if (!row) return reply.code(404).send({ error: "not_found" })

    let attachment: AttachmentDto
    if (row.status !== "uploading") {
      attachment = toAttachmentDto(row)
    } else {
      let pending = completing.get(id)
      if (!pending) {
        pending = complete(id, row.declaredSize).finally(() => completing.delete(id))
        completing.set(id, pending)
      }
      const result = await pending
      if (result === "incomplete") return reply.code(409).send({ error: "incomplete" })
      attachment = result
      request.log.info({ evt: "upload_completed", userId: request.user!.id, attachmentId: id })
    }
    const body: CompleteUploadResponse = { attachment }
    return body
  })
}
