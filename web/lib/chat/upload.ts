"use client"

import {
  CompleteUploadResponse,
  CreateUploadResponse,
  chunkCount,
  type AttachmentDto,
  type AttachmentKind,
  type CropRect,
} from "@duet/shared"
import { ApiError, apiPost } from "@/lib/api"

/** Tries per chunk before the upload fails (network blips on cellular). */
const CHUNK_ATTEMPTS = 3

/** PUT one chunk as raw bytes. XHR (not fetch) because only XHR reports upload progress. */
function putChunk(url: string, blob: Blob, onLoaded: (bytes: number) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    xhr.open("PUT", url)
    xhr.withCredentials = true
    xhr.setRequestHeader("Content-Type", "application/octet-stream")
    xhr.upload.onprogress = (e) => onLoaded(e.loaded)
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        onLoaded(blob.size)
        resolve()
        return
      }
      let code = "http_error"
      try {
        const body = JSON.parse(xhr.responseText) as { error?: unknown }
        if (typeof body.error === "string") code = body.error
      } catch {
        /* not JSON (an edge error page) */
      }
      reject(new ApiError(xhr.status, code))
    }
    xhr.onerror = () => reject(new ApiError(0, "network"))
    xhr.ontimeout = () => reject(new ApiError(0, "timeout"))
    xhr.onabort = () => reject(new ApiError(0, "aborted"))
    xhr.send(blob)
  })
}

/** Worth trying the same chunk again: network failures and server-side 5xx, never a 4xx. */
function retryable(err: unknown): boolean {
  return err instanceof ApiError && (err.status === 0 || err.status >= 500)
}

/**
 * Upload one file (MDIA-05, research Pattern 5): POST /api/uploads -> 8 MiB chunk PUTs in order
 * (each retried up to 3 times) -> POST /api/uploads/{id}/complete. onProgress gets whole percents
 * (0..100) across all chunks. Errors are ApiError (status 0 for network failures).
 *
 * The file sent is always the untouched original (QT-m25-crop-server, N-05): a photo's crop travels
 * as a normalised rect in the complete body, and the server applies it before making any variant.
 */
export async function uploadFile(
  file: Blob,
  kind: AttachmentKind,
  onProgress: (percent: number) => void,
  crop: CropRect | null = null,
): Promise<AttachmentDto> {
  const { id, chunkSize } = await apiPost("/api/uploads", { kind, size: file.size }, CreateUploadResponse)
  const count = chunkCount(file.size, chunkSize)
  let lastPercent = -1
  const report = (sent: number) => {
    const percent = Math.min(100, Math.floor((sent / file.size) * 100))
    if (percent !== lastPercent) {
      lastPercent = percent
      onProgress(percent)
    }
  }
  report(0)

  for (let i = 0; i < count; i++) {
    const start = i * chunkSize
    const blob = file.slice(start, Math.min(start + chunkSize, file.size))
    for (let attempt = 1; ; attempt++) {
      try {
        await putChunk(`/api/uploads/${encodeURIComponent(id)}/chunks/${i}`, blob, (loaded) => report(start + loaded))
        break
      } catch (err) {
        if (attempt >= CHUNK_ATTEMPTS || !retryable(err)) throw err
        await new Promise((r) => setTimeout(r, 500 * attempt))
      }
    }
  }

  const { attachment } = await apiPost(
    `/api/uploads/${encodeURIComponent(id)}/complete`,
    crop ? { crop } : {},
    CompleteUploadResponse,
  )
  return attachment
}
