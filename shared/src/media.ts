import { z } from "zod"
import { AttachmentDto, AttachmentKind } from "./chat"

/**
 * Media upload contract (MDIA-01, MDIA-05). Uploads are chunked because the Cloudflare Free plan
 * rejects request bodies over 100 MB at the edge (Pitfall 1): POST /api/uploads creates the upload,
 * each 8 MiB chunk is a raw application/octet-stream PUT, and POST .../complete assembles it.
 */

/** Every chunk is exactly this long except the last one (size - index * UPLOAD_CHUNK_SIZE). */
export const UPLOAD_CHUNK_SIZE = 8 * 1024 * 1024

const MB = 1024 * 1024

/** Largest declared size per kind, in bytes (image: research Open Q2, 48 MP HEIC / ProRAW). */
export const UPLOAD_LIMITS = {
  image: 100 * MB,
  video: 200 * MB,
  audio: 200 * MB,
} as const satisfies Record<AttachmentKind, number>

/** POST /api/uploads body: what is about to be uploaded. The uploader comes from the session. */
export const CreateUploadBody = z.strictObject({
  kind: AttachmentKind,
  size: z.number().int().positive(),
})
export type CreateUploadBody = z.infer<typeof CreateUploadBody>

export const CreateUploadResponse = z.object({
  id: z.string().regex(/^[A-Za-z0-9_-]{22}$/),
  chunkSize: z.number().int().positive(),
})
export type CreateUploadResponse = z.infer<typeof CreateUploadResponse>

/** POST /api/uploads/:id/complete response: the attachment, usually "processing" (or already done). */
export const CompleteUploadResponse = z.object({
  attachment: AttachmentDto,
})
export type CompleteUploadResponse = z.infer<typeof CompleteUploadResponse>

/**
 * The regenerated files GET /media/:id/:variant may serve. The original is never one of them
 * (T-02-22): it may be HEIC with GPS EXIF or a mislabeled file.
 */
export const MediaVariant = z.enum(["thumb", "display", "poster", "video", "audio"])
export type MediaVariant = z.infer<typeof MediaVariant>

/** Number of chunks an upload of `size` bytes is split into. */
export function chunkCount(size: number, chunkSize: number = UPLOAD_CHUNK_SIZE): number {
  return Math.max(1, Math.ceil(size / chunkSize))
}

/** The noun for a picked selection (D-06): "photo"/"photos", "video"/"videos", "item"/"items" (mixed). */
function selectionNoun(kinds: AttachmentKind[]): { one: string; many: string } {
  const images = kinds.filter((k) => k === "image").length
  const videos = kinds.filter((k) => k === "video").length
  if (videos === 0) return { one: "photo", many: "photos" }
  if (images === 0) return { one: "video", many: "videos" }
  return { one: "item", many: "items" }
}

/** Preview drawer title (UI-SPEC copy): "1 photo", "3 photos", "1 video", "4 items". */
export function selectionTitle(kinds: AttachmentKind[]): string {
  const { one, many } = selectionNoun(kinds)
  return kinds.length === 1 ? `1 ${one}` : `${kinds.length} ${many}`
}

/** Preview drawer send button (UI-SPEC copy): "Send photo", "Send 3 photos", "Send 4 items". */
export function selectionSendLabel(kinds: AttachmentKind[]): string {
  const { one, many } = selectionNoun(kinds)
  return kinds.length === 1 ? `Send ${one}` : `Send ${kinds.length} ${many}`
}
