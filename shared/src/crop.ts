import { z } from "zod"

/**
 * Photo crop rect (QT-m25-crop-rect, N-05): normalised 0..1 and relative to the EXIF-upright image,
 * which is what a browser draws and what sharp's rotate() produces. The phone only picks the rect;
 * the server applies it to the untouched original. Every helper here is pure, returns a new object
 * and never produces a rect outside 0..1. The cropper calls them on every pointer move.
 */

/** Smallest side of a crop, as a fraction of the image side (1 %). */
export const CROP_MIN_SIDE = 0.01

/** Float slack allowed on x+w and y+h (a rect built from pixel maths may overshoot 1 by a hair). */
const EDGE_EPSILON = 1e-6

export const CropRect = z
  .strictObject({
    x: z.number().min(0).max(1),
    y: z.number().min(0).max(1),
    w: z.number().min(CROP_MIN_SIDE).max(1),
    h: z.number().min(CROP_MIN_SIDE).max(1),
  })
  .refine((r) => r.x + r.w <= 1 + EDGE_EPSILON && r.y + r.h <= 1 + EDGE_EPSILON, { message: "crop outside the image" })
export type CropRect = z.infer<typeof CropRect>

export type CropCorner = "nw" | "ne" | "sw" | "se"

/**
 * What a gesture may do. width/height are the upright image size in pixels, minW/minH the smallest
 * normalised sides, and square locks 1:1 in image pixels (h = w * width / height in normalised units).
 */
export interface CropBounds {
  width: number
  height: number
  minW: number
  minH: number
  square: boolean
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))

/** Integer pixel rect for sharp's extract(): at least 1x1 and always inside the image. */
export function cropToPixels(
  rect: CropRect,
  width: number,
  height: number,
): { left: number; top: number; width: number; height: number } {
  const left = clamp(Math.floor(rect.x * width), 0, width - 1)
  const top = clamp(Math.floor(rect.y * height), 0, height - 1)
  return {
    left,
    top,
    width: clamp(Math.round(rect.w * width), 1, width - left),
    height: clamp(Math.round(rect.h * height), 1, height - top),
  }
}

/** The whole image. */
export function fullCrop(): CropRect {
  return { x: 0, y: 0, w: 1, h: 1 }
}

/** The largest centred square (in image pixels). */
export function centredSquare(width: number, height: number): CropRect {
  return squareAround(fullCrop(), width, height)
}

/** The largest pixel square inside rect, centred on rect's centre. */
export function squareAround(rect: CropRect, width: number, height: number): CropRect {
  const side = Math.min(rect.w * width, rect.h * height)
  const w = Math.min(1, side / width)
  const h = Math.min(1, side / height)
  const cx = rect.x + rect.w / 2
  const cy = rect.y + rect.h / 2
  return { x: clamp(cx - w / 2, 0, 1 - w), y: clamp(cy - h / 2, 0, 1 - h), w, h }
}

/** Shift by normalised deltas, stopping at the image edges. */
export function moveCrop(rect: CropRect, dx: number, dy: number): CropRect {
  return {
    x: clamp(rect.x + dx, 0, 1 - rect.w),
    y: clamp(rect.y + dy, 0, 1 - rect.h),
    w: rect.w,
    h: rect.h,
  }
}

/**
 * Drag one corner by normalised deltas; the opposite corner stays fixed. Respects the minimum sides,
 * the image edges and (with bounds.square) the 1:1 lock.
 */
export function resizeCrop(rect: CropRect, corner: CropCorner, dx: number, dy: number, bounds: CropBounds): CropRect {
  const east = corner === "ne" || corner === "se"
  const south = corner === "sw" || corner === "se"
  // The fixed corner and how much room there is towards the dragged one.
  const ax = east ? rect.x : rect.x + rect.w
  const ay = south ? rect.y : rect.y + rect.h
  const roomW = east ? 1 - ax : ax
  const roomH = south ? 1 - ay : ay
  const wantW = rect.w + (east ? dx : -dx)
  const wantH = rect.h + (south ? dy : -dy)

  let w: number
  let h: number
  if (bounds.square) {
    const ratio = bounds.width / bounds.height
    const min = Math.max(bounds.minW, bounds.minH / ratio)
    const max = Math.min(roomW, roomH / ratio)
    w = clamp(Math.max(wantW, wantH / ratio), min, max)
    h = w * ratio
  } else {
    w = clamp(wantW, bounds.minW, roomW)
    h = clamp(wantH, bounds.minH, roomH)
  }
  return { x: east ? ax : ax - w, y: south ? ay : ay - h, w, h }
}

/**
 * Pinch: scale about the centre with the aspect kept (1:1 in pixels with bounds.square), limited to
 * the minimum sides and the image, then shifted back inside where the centre would push it out.
 */
export function scaleCrop(rect: CropRect, factor: number, bounds: CropBounds): CropRect {
  const cx = rect.x + rect.w / 2
  const cy = rect.y + rect.h / 2
  let w: number
  let h: number
  if (bounds.square) {
    const ratio = bounds.width / bounds.height
    w = clamp(rect.w * factor, Math.max(bounds.minW, bounds.minH / ratio), Math.min(1, 1 / ratio))
    h = w * ratio
  } else {
    const f = clamp(factor, Math.max(bounds.minW / rect.w, bounds.minH / rect.h), Math.min(1 / rect.w, 1 / rect.h))
    w = rect.w * f
    h = rect.h * f
  }
  return { x: clamp(cx - w / 2, 0, 1 - w), y: clamp(cy - h / 2, 0, 1 - h), w, h }
}
