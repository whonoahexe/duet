import { mkdir, mkdtemp, rm } from "node:fs/promises"
import path from "node:path"
import { eq } from "drizzle-orm"
import type { FastifyInstance } from "fastify"
import { z } from "zod"
import { ProfilePhotoBody, type ProfilePhotoResponse } from "@duet/shared"
import { requireUser } from "../auth/session"
import { attachments, users } from "../db/schema"
import { decryptToFile, encryptFile } from "./crypto"
import { MediaError } from "./exec"
import { processAvatar } from "./image"
import { attachmentDir, workRoot, type MediaProcessor } from "./process"

export interface ProfileRoutesOptions {
  processor: MediaProcessor
  /** <DATA_DIR>/media */
  mediaRoot: string
  /** AES-256 media key: the crops are stored as DUETENC ciphertext (T-5zd-03). */
  key: Buffer
  /** Longest wait for a still-processing upload before 409 not_ready (T-5zd-08). Default 60 s. */
  waitMs?: number
}

const AVATAR_FILES = ["avatar-sm.webp", "avatar-lg.webp"] as const

/** Answered as { error } with this status. */
class PhotoError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(code)
  }
}

/**
 * Shared profile photos (QT-5zd-photo-store, QT-5zd-photo-live): PUT /api/users/:id/photo sets or
 * removes a person's photo. Either logged-in person may change either photo (decided 2026-10-20,
 * T-5zd-01). The photo is the requester's own unattached image upload (T-5zd-02); its display.webp is
 * cropped to two squares in a media/work scratch dir and stored encrypted (T-5zd-03). The change is
 * broadcast to both people, and a replaced or removed avatar attachment is deleted, never message
 * media (T-5zd-06). Logs carry ids and the action only (T-5zd-09).
 */
export async function profileRoutes(app: FastifyInstance, opts: ProfileRoutesOptions) {
  const { processor, mediaRoot, key, waitMs = 60_000 } = opts

  /** True when some person already has this attachment as their photo (one photo, one person). */
  function isSomeonesPhoto(id: string): boolean {
    return app.db.select({ id: users.id }).from(users).where(eq(users.photoId, id)).get() !== undefined
  }

  /** Wait for the upload's processing job, at most waitMs, then return its row. */
  async function settledRow(id: string) {
    let timer: NodeJS.Timeout | undefined
    await Promise.race([
      processor.settled(id),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, waitMs)
      }),
    ])
    clearTimeout(timer)
    return app.db.select().from(attachments).where(eq(attachments.id, id)).get()
  }

  /** display.webp -> avatar-sm/lg.webp, plaintext only inside a scratch dir removed in a finally. */
  async function writeCrops(id: string): Promise<void> {
    const dir = attachmentDir(mediaRoot, id)
    await mkdir(workRoot(mediaRoot), { recursive: true, mode: 0o700 })
    const scratch = await mkdtemp(path.join(workRoot(mediaRoot), `${id}-`))
    try {
      const display = path.join(scratch, "display.webp")
      await decryptToFile(key, path.join(dir, "display.webp"), display)
      await processAvatar(display, scratch)
      for (const name of AVATAR_FILES) await encryptFile(key, path.join(scratch, name), path.join(dir, name))
    } finally {
      await rm(scratch, { recursive: true, force: true })
    }
  }

  /** Delete a previous avatar attachment, re-checking that it is no message's media and no one's photo. */
  async function cleanup(prev: string, log: FastifyInstance["log"]): Promise<void> {
    try {
      const row = app.db.select({ messageSeq: attachments.messageSeq }).from(attachments).where(eq(attachments.id, prev)).get()
      if (!row || row.messageSeq !== null || isSomeonesPhoto(prev)) return
      app.db.delete(attachments).where(eq(attachments.id, prev)).run()
      await rm(attachmentDir(mediaRoot, prev), { recursive: true, force: true })
    } catch (err) {
      log.warn({ evt: "profile_photo_cleanup_failed", attachmentId: prev, err: err instanceof Error ? err.message : String(err) })
    }
  }

  app.put("/api/users/:id/photo", { preHandler: requireUser }, async (request, reply) => {
    reply.header("Cache-Control", "no-store")
    const { id: rawTarget } = request.params as { id: string }
    const target = z.uuid().safeParse(rawTarget)
    if (!target.success || !app.db.select({ id: users.id }).from(users).where(eq(users.id, target.data)).get()) {
      return reply.code(404).send({ error: "not_found" })
    }
    const userId = target.data
    const parsed = ProfilePhotoBody.safeParse(request.body)
    if (!parsed.success) return reply.code(400).send({ error: "invalid_body" })
    const photoId = parsed.data.attachmentId
    const me = request.user!.id

    try {
      if (photoId !== null) {
        const row = app.db.select().from(attachments).where(eq(attachments.id, photoId)).get()
        if (
          !row ||
          row.uploaderId !== me ||
          row.kind !== "image" ||
          row.messageSeq !== null ||
          // A failed upload is answered 422 with its error below, an unfinished one is refused here.
          row.status === "uploading" ||
          isSomeonesPhoto(photoId)
        ) {
          throw new PhotoError(400, "bad_attachment")
        }
        const settled = await settledRow(photoId)
        if (!settled) throw new PhotoError(400, "bad_attachment")
        if (settled.status === "processing") throw new PhotoError(409, "not_ready")
        if (settled.status !== "ready") throw new PhotoError(422, settled.error ?? "processing_failed")
        try {
          await writeCrops(photoId)
        } catch (err) {
          if (err instanceof MediaError) throw new PhotoError(422, err.code)
          throw err
        }
      }

      // One synchronous transaction: the re-checks and the swap cannot interleave with a send.
      const prev = app.db.transaction((tx) => {
        if (photoId !== null) {
          const row = tx.select({ messageSeq: attachments.messageSeq }).from(attachments).where(eq(attachments.id, photoId)).get()
          const taken = tx.select({ id: users.id }).from(users).where(eq(users.photoId, photoId)).get()
          if (!row || row.messageSeq !== null || taken) throw new PhotoError(400, "bad_attachment")
        }
        const current = tx.select({ photoId: users.photoId }).from(users).where(eq(users.id, userId)).get()
        tx.update(users).set({ photoId }).where(eq(users.id, userId)).run()
        return current?.photoId ?? null
      })

      app.hub.broadcast({ t: "profile", userId, photoId })
      request.log.info({ evt: "profile_photo", userId, by: me, action: photoId === null ? "removed" : "set" })
      if (prev !== null && prev !== photoId) await cleanup(prev, request.log)

      const body: ProfilePhotoResponse = { userId, photoId }
      return body
    } catch (err) {
      if (err instanceof PhotoError) return reply.code(err.status).send({ error: err.code })
      throw err
    }
  })
}
