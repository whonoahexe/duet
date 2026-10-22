import { randomBytes } from "node:crypto"
import { existsSync } from "node:fs"
import { rename, rm } from "node:fs/promises"
import path from "node:path"
import sharp, { type Metadata } from "sharp"
import { cropToPixels, type CropRect } from "@duet/shared"
import { MediaError, runTool } from "./exec"

/** D-09 display copy: long edge at most 2048 px, WebP quality 82. */
export const DISPLAY_EDGE = 2048
const DISPLAY_QUALITY = 82
/** Album tile / quote thumbnail: long edge at most 640 px, WebP quality 70. */
export const THUMB_EDGE = 640
const THUMB_QUALITY = 70
/** Profile photo crops (QT-5zd-photo-store): exact squares, centre-cropped. */
export const AVATAR_SMALL_EDGE = 192
export const AVATAR_LARGE_EDGE = 640
/** Round profile photo (QT-m25-round-variant): the push notification icon on Android. */
export const AVATAR_ROUND_EDGE = 192
const AVATAR_QUALITY = 80
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
  return withSharpSource(originalPath, outDir, async (source) => {
    const display = await writeVariant(source, path.join(outDir, "display.webp"), DISPLAY_EDGE, DISPLAY_QUALITY)
    await writeVariant(source, path.join(outDir, "thumb.webp"), THUMB_EDGE, THUMB_QUALITY)
    return display
  })
}

/**
 * Run fn with a path sharp can decode for originalPath. An unreadable file is
 * MediaError("unsupported_media"). iPhone HEIC (HEVC-compressed HEIF) is first turned into a JPEG in
 * workDir by heif-convert (Pitfall 5), which applies the HEIF rotation itself; that scratch file is
 * always removed afterwards. Everything else is passed through as is.
 */
export async function withSharpSource<T>(
  originalPath: string,
  workDir: string,
  fn: (source: string) => Promise<T>,
): Promise<T> {
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
      const base = path.join(workDir, `.heic-${randomBytes(6).toString("hex")}`)
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
    return await fn(source)
  } finally {
    await Promise.all(scratch.map((f) => rm(f, { force: true })))
  }
}

/** JPEG quality of a cropped original: it is re-encoded once, so it stays near-lossless. */
const CROP_JPEG_QUALITY = 95

/**
 * Apply the phone's crop rect to an original (QT-m25-crop-server, N-05) and write the result to
 * targetPath. The rect is relative to the EXIF-upright image: rotate() runs first, and extract()
 * after it works on the upright pixels. The output is PNG when the source has alpha, otherwise
 * JPEG quality 95 with full 4:4:4 chroma. sharp writes no metadata, so EXIF and GPS are dropped.
 * Any failure is MediaError("unsupported_media"); a half-written file is never left behind.
 */
export async function cropImage(
  originalPath: string,
  targetPath: string,
  crop: CropRect,
  workDir: string,
): Promise<ImageResult> {
  return withSharpSource(originalPath, workDir, async (source) => {
    const tmp = `${targetPath}.tmp`
    try {
      const meta = await sharp(source).metadata()
      const { width, height } = meta.autoOrient
      const pixels = cropToPixels(crop, width, height)
      const img = sharp(source).rotate().extract(pixels)
      const info = await (meta.hasAlpha ? img.png() : img.jpeg({ quality: CROP_JPEG_QUALITY, chromaSubsampling: "4:4:4" })).toFile(tmp)
      await rename(tmp, targetPath)
      return { width: info.width, height: info.height }
    } catch (err) {
      await rm(tmp, { force: true })
      if (err instanceof MediaError) throw err
      throw new MediaError("unsupported_media", err instanceof Error ? err.message : String(err))
    }
  })
}

/**
 * A profile photo's display.webp -> avatar-sm.webp (192x192), avatar-lg.webp (640x640) and
 * avatar-round.png (192x192 circle) in outDir (QT-5zd-photo-store, QT-m25-round-variant). Always
 * exactly NxN, centre-cropped and enlarged when the source is smaller. A photo framed in the circle
 * cropper is already square, so the centre crop changes nothing there; it remains the fallback for a
 * photo the browser could not show in the cropper. The source is already autorotated and has no
 * metadata, and sharp writes none (T-5zd-07). A failure is MediaError("processing_failed").
 */
export async function processAvatar(sourcePath: string, outDir: string): Promise<void> {
  const square = { fit: "cover", position: "centre" } as const
  await writeVariant(sourcePath, path.join(outDir, "avatar-sm.webp"), AVATAR_SMALL_EDGE, AVATAR_QUALITY, square, "processing_failed")
  await writeVariant(sourcePath, path.join(outDir, "avatar-lg.webp"), AVATAR_LARGE_EDGE, AVATAR_QUALITY, square, "processing_failed")
  await writeRoundAvatar(sourcePath, path.join(outDir, "avatar-round.png"))
}

/** A filled circle covering the whole square: dest-in keeps the photo inside it only. */
const ROUND_MASK = Buffer.from(
  `<svg xmlns="http://www.w3.org/2000/svg" width="${AVATAR_ROUND_EDGE}" height="${AVATAR_ROUND_EDGE}">` +
    `<circle cx="${AVATAR_ROUND_EDGE / 2}" cy="${AVATAR_ROUND_EDGE / 2}" r="${AVATAR_ROUND_EDGE / 2}" fill="#fff"/></svg>`,
)

/**
 * The photo as a 192x192 circle with transparent corners, as PNG (QT-m25-round-variant, N-07).
 * Android shows a web-push icon exactly as the file is, so the circle has to be in the pixels.
 * Written to a temp name and renamed; a failure is MediaError("processing_failed").
 */
export async function writeRoundAvatar(sourcePath: string, targetPath: string): Promise<void> {
  const tmp = `${targetPath}.tmp`
  try {
    // Two passes, so the mask always lands on the finished 192x192 square with an alpha channel.
    const square = await sharp(sourcePath)
      .rotate()
      .resize(AVATAR_ROUND_EDGE, AVATAR_ROUND_EDGE, { fit: "cover", position: "centre" })
      .ensureAlpha()
      .png()
      .toBuffer()
    await sharp(square)
      .composite([{ input: ROUND_MASK, blend: "dest-in" }])
      .png()
      .toFile(tmp)
    await rename(tmp, targetPath)
  } catch (err) {
    await rm(tmp, { force: true })
    throw new MediaError("processing_failed", err instanceof Error ? err.message : String(err))
  }
}

type ResizeFit = { fit: "inside"; withoutEnlargement: true } | { fit: "cover"; position: "centre" }

async function writeVariant(
  source: string,
  target: string,
  edge: number,
  quality: number,
  resize: ResizeFit = { fit: "inside", withoutEnlargement: true },
  failCode = "unsupported_media",
): Promise<ImageResult> {
  const tmp = `${target}.tmp`
  try {
    const info = await sharp(source).rotate().resize(edge, edge, resize).webp({ quality }).toFile(tmp)
    await rename(tmp, target)
    return { width: info.width, height: info.height }
  } catch (err) {
    await rm(tmp, { force: true })
    if (err instanceof MediaError) throw err
    throw new MediaError(failCode, err instanceof Error ? err.message : String(err))
  }
}
