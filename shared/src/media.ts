import { z } from "zod"
import { AttachmentDto, AttachmentKind, MAX_ALBUM_ITEMS } from "./chat"
import { CropRect } from "./crop"

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
 * POST /api/uploads/:id/complete body (QT-m25-crop-server): optionally the crop the phone picked for
 * an image. The upload itself is always the untouched original; the server applies the crop before
 * any variant exists, so the stored original is the cropped image (N-05).
 */
export const CompleteUploadBody = z.strictObject({
  crop: CropRect.optional(),
})
export type CompleteUploadBody = z.infer<typeof CompleteUploadBody>

/**
 * The regenerated files GET /media/:id/:variant may serve. The original is never one of them
 * (T-02-22): it may be HEIC with GPS EXIF or a mislabeled file.
 */
export const MediaVariant = z.enum(["thumb", "display", "poster", "video", "audio", "avatar-sm", "avatar-lg"])
export type MediaVariant = z.infer<typeof MediaVariant>

/**
 * A profile photo's square crop (QT-5zd-photo-ui): "sm" is 192x192, "lg" is 640x640. A new photo is
 * a new attachment id, so the URL changes with the photo and immutable caching stays correct.
 */
export function avatarUrl(photoId: string, size: "sm" | "lg"): string {
  return `/media/${encodeURIComponent(photoId)}/avatar-${size}`
}

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

/**
 * Longest video clip the server accepts, by its probed duration (D-08 "about 3 minutes", research
 * A7: a little slack over the client's 3-minute pick check for containers that round up).
 */
export const VIDEO_MAX_DURATION_MS = 200_000

/** Longest video the picker lets through (D-08, UI-SPEC toast "Videos can be up to 3 minutes."). */
export const VIDEO_PICK_MAX_SECONDS = 180

/** Bars in a voice note's waveform (D-12, UI-SPEC: 40 SVG bars). Values are integers 0..100. */
export const VOICE_WAVEFORM_BARS = 40

/**
 * A clip or voice-note length as the UI shows it (UI-SPEC "0:42", D-11 "1:00:00"): m:ss under an
 * hour, h:mm:ss from one hour on. Rounds down to whole seconds; negative or non-finite values are 0.
 */
export function formatDuration(ms: number): string {
  const total = Number.isFinite(ms) && ms > 0 ? Math.floor(ms / 1000) : 0
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  const ss = String(s).padStart(2, "0")
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`
}

/** Shared media gallery page size (QT-5zd-gallery): default and largest accepted ?limit. */
export const GALLERY_PAGE_DEFAULT = 60
export const GALLERY_PAGE_MAX = 120

/**
 * A gallery item's paging key: position is always below MAX_ALBUM_ITEMS, so keys are unique and sort
 * exactly like (message seq, album position).
 */
export function galleryKey(seq: number, position: number): number {
  return seq * MAX_ALBUM_ITEMS + position
}

/** GET /api/media query: items with a key below `before` (newest first), at most `limit`. */
export const GalleryQuery = z.object({
  before: z.coerce.number().int().positive().optional(),
  limit: z.coerce.number().int().min(1).max(GALLERY_PAGE_MAX).default(GALLERY_PAGE_DEFAULT),
})
export type GalleryQuery = z.infer<typeof GalleryQuery>

/** One ready photo or video shared in the chat, with the message it belongs to. */
export const GalleryItem = z.object({
  key: z.number().int().positive(),
  seq: z.number().int().positive(),
  senderId: z.uuid(),
  /** The message's time, epoch ms. */
  createdAt: z.number().int(),
  attachment: AttachmentDto,
})
export type GalleryItem = z.infer<typeof GalleryItem>

/** GET /api/media response: `next` is the `before` for the following page (null on the last page). */
export const GalleryPage = z.object({
  items: z.array(GalleryItem),
  hasMore: z.boolean(),
  next: z.number().int().positive().nullable(),
})
export type GalleryPage = z.infer<typeof GalleryPage>
