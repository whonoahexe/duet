import { randomBytes } from "node:crypto"
import { existsSync } from "node:fs"
import { rename, rm } from "node:fs/promises"
import path from "node:path"
import sharp, { type Metadata } from "sharp"
import { MediaError, runTool } from "./exec"

/** D-09 display copy: long edge at most 2048 px, WebP quality 82. */
export const DISPLAY_EDGE = 2048
const DISPLAY_QUALITY = 82
/** Album tile / quote thumbnail: long edge at most 640 px, WebP quality 70. */
export const THUMB_EDGE = 640
const THUMB_QUALITY = 70
/** heif-convert on a 48 MP HEIC takes a few seconds; anything near this is a hostile file. */
const HEIF_CONVERT_TIMEOUT_MS = 120_000

export interface ImageResult {
  /** Size of display.webp (after autorotation). */
  width: number
  height: number
}

/**
 * Original photo -> display.webp + thumb.webp in outDir (MDIA-01, D-09). The original is only read.
 *
 * - iPhone HEIC is HEVC-compressed HEIF, which sharp's prebuilt libvips cannot decode (Pitfall 5):
 *   heif-convert turns it into a JPEG first (it applies the HEIF rotation itself).
 * - Everything else sharp decodes directly (JPEG, PNG, WebP, GIF first frame, AVIF, TIFF).
 * - rotate() applies the EXIF orientation; sharp writes no metadata unless asked, so neither variant
 *   carries EXIF or GPS (T-02-26). sharp's default limitInputPixels guards against decompression bombs.
 * - Each variant is written to a temp name and renamed, so a half-written file is never served.
 */
export async function processImage(originalPath: string, outDir: string): Promise<ImageResult> {
  let meta: Metadata
  try {
    meta = await sharp(originalPath).metadata()
  } catch (err) {
    throw new MediaError("unsupported_media", err instanceof Error ? err.message : String(err))
  }

  const scratch: string[] = []
  let source = originalPath
  try {
    if (meta.format === "heif" && meta.compression === "hevc") {
      const base = path.join(outDir, `.heic-${randomBytes(6).toString("hex")}`)
      const jpg = `${base}.jpg`
      scratch.push(jpg, `${base}-1.jpg`)
      await runTool("heif-convert", ["-q", "92", originalPath, jpg], {
        timeoutMs: HEIF_CONVERT_TIMEOUT_MS,
        failCode: "unsupported_media",
      })
      // A file with several top-level images is written as <name>-1.jpg, <name>-2.jpg, ...: the first
      // one is the primary photo.
      source = existsSync(jpg) ? jpg : `${base}-1.jpg`
      if (!existsSync(source)) throw new MediaError("unsupported_media", "heif-convert wrote no image")
    }

    const display = await writeVariant(source, path.join(outDir, "display.webp"), DISPLAY_EDGE, DISPLAY_QUALITY)
    await writeVariant(source, path.join(outDir, "thumb.webp"), THUMB_EDGE, THUMB_QUALITY)
    return display
  } finally {
    await Promise.all(scratch.map((f) => rm(f, { force: true })))
  }
}

async function writeVariant(source: string, target: string, edge: number, quality: number): Promise<ImageResult> {
  const tmp = `${target}.tmp`
  try {
    const info = await sharp(source)
      .rotate()
      .resize(edge, edge, { fit: "inside", withoutEnlargement: true })
      .webp({ quality })
      .toFile(tmp)
    await rename(tmp, target)
    return { width: info.width, height: info.height }
  } catch (err) {
    await rm(tmp, { force: true })
    if (err instanceof MediaError) throw err
    throw new MediaError("unsupported_media", err instanceof Error ? err.message : String(err))
  }
}
