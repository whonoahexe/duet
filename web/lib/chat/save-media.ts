import type { AttachmentKind } from "@duet/shared"
import { isIos } from "@/lib/platform"

/** "tap-again": the fetch outlasted the tap's user activation on iOS; the file is ready for a second tap. */
export type SaveResult = "saved" | "cancelled" | "tap-again"

/** A fetched file kept for the second tap, so that tap reaches the share sheet without awaiting anything. */
let ready: { id: string; file: File } | null = null

async function fetchFile(attachmentId: string, kind: AttachmentKind): Promise<File> {
  // The best copies the server serves; the original is deliberately never served (T-02-22).
  const video = kind === "video"
  const variant = video ? "video" : "display"
  const res = await fetch(`/media/${encodeURIComponent(attachmentId)}/${variant}`)
  if (!res.ok) throw new Error(`media fetch returned ${res.status}`)
  const blob = await res.blob()
  const type = blob.type || (video ? "video/mp4" : "image/webp")
  return new File([blob], `duet-${attachmentId}.${video ? "mp4" : "webp"}`, { type })
}

/**
 * Save the full-quality served copy of an attachment (display.webp for photos, video.mp4 for clips):
 * the share sheet on iPhone (Save Image / Save Video), a download elsewhere. Throws on failure.
 */
export async function saveMedia(attachmentId: string, kind: AttachmentKind): Promise<SaveResult> {
  const file = ready?.id === attachmentId ? ready.file : await fetchFile(attachmentId, kind)

  if (isIos() && navigator.canShare?.({ files: [file] })) {
    try {
      await navigator.share({ files: [file] })
      ready = null
      return "saved"
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") {
        ready = null
        return "cancelled"
      }
      if (err instanceof DOMException && err.name === "NotAllowedError") {
        ready = { id: attachmentId, file }
        return "tap-again"
      }
      throw err
    }
  }

  // Detached on purpose: the modal viewer can make content outside it inert.
  const url = URL.createObjectURL(file)
  const a = document.createElement("a")
  a.href = url
  a.download = file.name
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 30_000)
  ready = null
  return "saved"
}
