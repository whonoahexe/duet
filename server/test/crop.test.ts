import { randomBytes } from "node:crypto"
import { readdirSync } from "node:fs"
import path from "node:path"
import sharp from "sharp"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { eq } from "drizzle-orm"
import {
  CROP_MIN_SIDE,
  CropRect,
  centredSquare,
  cropToPixels,
  fullCrop,
  moveCrop,
  resizeCrop,
  scaleCrop,
  squareAround,
  type CropBounds,
} from "@duet/shared"
import { attachments } from "../src/db/schema"
import { readEncHeader } from "../src/media/crypto"
import { decryptedCopy, loginCookie, makeTestApp, TEST_ORIGIN, uploadBytes, type TestApp } from "./helpers"

/** Every edge of a normalised rect is inside 0..1. */
function expectInside(r: { x: number; y: number; w: number; h: number }) {
  expect(r.x).toBeGreaterThanOrEqual(0)
  expect(r.y).toBeGreaterThanOrEqual(0)
  expect(r.x + r.w).toBeLessThanOrEqual(1 + 1e-9)
  expect(r.y + r.h).toBeLessThanOrEqual(1 + 1e-9)
}

function expectRect(r: { x: number; y: number; w: number; h: number }, want: { x: number; y: number; w: number; h: number }) {
  expect(r.x).toBeCloseTo(want.x, 9)
  expect(r.y).toBeCloseTo(want.y, 9)
  expect(r.w).toBeCloseTo(want.w, 9)
  expect(r.h).toBeCloseTo(want.h, 9)
}

const free: CropBounds = { width: 1000, height: 1000, minW: 0.05, minH: 0.05, square: false }

describe("crop geometry (QT-m25-crop-rect)", () => {
  it("cropToPixels converts and clamps inside the image", () => {
    expect(cropToPixels({ x: 0.25, y: 0, w: 0.5, h: 1 }, 800, 400)).toEqual({ left: 200, top: 0, width: 400, height: 400 })
    const over = cropToPixels({ x: 0.7000001, y: 0.3, w: 0.3000001, h: 0.7000001 }, 801, 399)
    expect(over.left + over.width).toBeLessThanOrEqual(801)
    expect(over.top + over.height).toBeLessThanOrEqual(399)
    const tiny = cropToPixels({ x: 0.9999, y: 0.9999, w: 0.0001, h: 0.0001 }, 100, 100)
    expect(tiny.width).toBeGreaterThanOrEqual(1)
    expect(tiny.height).toBeGreaterThanOrEqual(1)
    expect(tiny.left + tiny.width).toBeLessThanOrEqual(100)
  })

  it("fullCrop, centredSquare and squareAround", () => {
    expect(fullCrop()).toEqual({ x: 0, y: 0, w: 1, h: 1 })
    expectRect(centredSquare(800, 400), { x: 0.25, y: 0, w: 0.5, h: 1 })
    expectRect(centredSquare(400, 800), { x: 0, y: 0.25, w: 1, h: 0.5 })
    expectRect(squareAround({ x: 0, y: 0, w: 1, h: 1 }, 1200, 900), { x: 0.125, y: 0, w: 0.75, h: 1 })
  })

  it("moveCrop clamps inside 0..1", () => {
    expectRect(moveCrop({ x: 0.5, y: 0.5, w: 0.4, h: 0.4 }, 0.3, -0.7), { x: 0.6, y: 0, w: 0.4, h: 0.4 })
  })

  it("resizeCrop moves one corner and keeps the opposite one", () => {
    expectRect(resizeCrop({ x: 0.1, y: 0.1, w: 0.5, h: 0.5 }, "se", 0.1, 0.05, free), { x: 0.1, y: 0.1, w: 0.6, h: 0.55 })
    const past = resizeCrop({ x: 0.1, y: 0.1, w: 0.5, h: 0.5 }, "nw", 0.9, 0.9, free)
    expect(past.w).toBeCloseTo(0.05, 9)
    expect(past.h).toBeCloseTo(0.05, 9)
    expect(past.x + past.w).toBeCloseTo(0.6, 9)
    expect(past.y + past.h).toBeCloseTo(0.6, 9)
    for (const corner of ["nw", "ne", "sw", "se"] as const) {
      for (const [dx, dy] of [
        [2, 2],
        [-2, -2],
        [2, -2],
        [-2, 2],
      ] as const) {
        expectInside(resizeCrop({ x: 0.2, y: 0.3, w: 0.4, h: 0.3 }, corner, dx, dy, free))
      }
    }
  })

  it("square bounds keep 1:1 in image pixels for resizeCrop and scaleCrop", () => {
    const square: CropBounds = { width: 2000, height: 1000, minW: 0.02, minH: 0.04, square: true }
    const start = centredSquare(2000, 1000)
    const corners = { nw: [1, 1], ne: [0, 1], sw: [1, 0], se: [0, 0] } as const
    for (const corner of ["nw", "ne", "sw", "se"] as const) {
      for (const [dx, dy] of [
        [-0.1, -0.3],
        [0.2, 0.05],
        [0.4, -0.4],
        [-2, 2],
      ] as const) {
        const r = resizeCrop(start, corner, dx, dy, square)
        expect(Math.abs(r.w * 2000 - r.h * 1000)).toBeLessThanOrEqual(1)
        expectInside(r)
        // The anchored (opposite) corner stays put.
        const [ax, ay] = corners[corner]
        expect(r.x + ax * r.w).toBeCloseTo(start.x + ax * start.w, 9)
        expect(r.y + ay * r.h).toBeCloseTo(start.y + ay * start.h, 9)
      }
    }
    const small = { x: 0.6, y: 0.1, w: 0.2, h: 0.4 }
    const grown = scaleCrop(small, 2, square)
    expect(Math.abs(grown.w * 2000 - grown.h * 1000)).toBeLessThanOrEqual(1)
    expectInside(grown)
    expect(grown.x + grown.w / 2).toBeCloseTo(0.7, 9)
    // The centre's y would put the top above 0, so it is shifted down inside.
    expect(grown.y).toBeCloseTo(0, 9)
    expect(grown.h).toBeCloseTo(0.8, 9)
    const shrunk = scaleCrop(small, 0.01, square)
    expect(shrunk.w).toBeCloseTo(0.02, 9)
    expect(shrunk.h).toBeCloseTo(0.04, 9)
    expectInside(scaleCrop(small, 50, square))
  })

  it("CropRect accepts the full image and rejects bad rects", () => {
    expect(CropRect.safeParse({ x: 0, y: 0, w: 1, h: 1 }).success).toBe(true)
    expect(CropRect.safeParse({ x: 0.5, y: 0.5, w: 0.5, h: 0.5 }).success).toBe(true)
    for (const bad of [
      { x: -0.1, y: 0, w: 0.5, h: 0.5 },
      { x: 0, y: 0, w: 1.1, h: 0.5 },
      { x: 0.6, y: 0, w: 0.5, h: 0.5 },
      { x: 0, y: 0, w: CROP_MIN_SIDE / 2, h: 0.5 },
      { x: 0, y: 0, w: 0.5, h: CROP_MIN_SIDE / 2 },
      { x: "0", y: 0, w: 0.5, h: 0.5 },
      { x: 0, y: 0, w: 0.5, h: 0.5, z: 1 },
    ]) {
      expect(CropRect.safeParse(bad).success).toBe(false)
    }
  })
})

let t: TestApp
let cookie: string
let mediaRoot: string

beforeAll(async () => {
  t = await makeTestApp({ seed: true })
  cookie = await loginCookie(t.app, "alice")
  mediaRoot = path.join(t.dataDir, "media")
})
afterAll(async () => {
  await t.app.media.idle()
  await t.close()
})

/** A JPEG whose left half is red and right half blue, optionally tagged with an EXIF orientation. */
async function splitJpeg(width: number, height: number, orientation?: number): Promise<Buffer> {
  const red = await sharp({ create: { width: width / 2, height, channels: 3, background: { r: 230, g: 10, b: 10 } } })
    .png()
    .toBuffer()
  let img = sharp({ create: { width, height, channels: 3, background: { r: 10, g: 10, b: 230 } } })
    .composite([{ input: red, left: 0, top: 0 }])
    .jpeg({ quality: 90 })
  if (orientation) img = img.withMetadata({ orientation })
  return img.toBuffer()
}

async function pixels(file: string) {
  const { data, info } = await sharp(file).raw().toBuffer({ resolveWithObject: true })
  return {
    info,
    px(x: number, y: number) {
      const i = (y * info.width + x) * info.channels
      return [data[i]!, data[i + 1]!, data[i + 2]!] as const
    },
  }
}

async function createUpload(kind: "image" | "video" | "audio", size: number): Promise<string> {
  const res = await t.app.inject({
    method: "POST",
    url: "/api/uploads",
    headers: { cookie, origin: TEST_ORIGIN },
    payload: { kind, size },
  })
  expect(res.statusCode).toBe(200)
  return res.json().id
}

async function putChunks(id: string, bytes: Buffer) {
  const res = await t.app.inject({
    method: "PUT",
    url: `/api/uploads/${id}/chunks/0`,
    headers: { cookie, origin: TEST_ORIGIN, "content-type": "application/octet-stream" },
    payload: bytes,
  })
  expect(res.statusCode).toBe(204)
}

function completeWith(id: string, payload: Record<string, unknown>) {
  return t.app.inject({
    method: "POST",
    url: `/api/uploads/${id}/complete`,
    headers: { cookie, origin: TEST_ORIGIN },
    payload,
  })
}

describe("POST /api/uploads/:id/complete with a crop (QT-m25-crop-server)", () => {
  it("crops the stored original before any variant exists", async () => {
    const { id } = await uploadBytes(t.app, cookie, await splitJpeg(800, 400), "image", { crop: { x: 0, y: 0, w: 0.5, h: 1 } })
    await t.app.media.idle()
    const row = t.app.db.select().from(attachments).where(eq(attachments.id, id)).get()!
    expect(row.status).toBe("ready")

    const dir = path.join(mediaRoot, id)
    for (const name of ["display.webp", "original"]) {
      expect(await readEncHeader(path.join(dir, name))).not.toBeNull()
      const plain = await decryptedCopy(t, path.join(dir, name))
      const meta = await sharp(plain).metadata()
      expect([meta.width, meta.height]).toEqual([400, 400])
      if (name === "original") expect(meta.exif).toBeUndefined()
      const { px } = await pixels(plain)
      expect(px(200, 200)[0]).toBeGreaterThan(150)
      expect(px(200, 200)[2]).toBeLessThan(100)
      expect(px(395, 200)[0]).toBeGreaterThan(150)
    }
    const thumb = await sharp(await decryptedCopy(t, path.join(dir, "thumb.webp"))).metadata()
    expect([thumb.width, thumb.height]).toEqual([400, 400])
    expect(readdirSync(path.join(mediaRoot, "work"))).toEqual([])
  })

  it("reads the rect in EXIF-upright coordinates", async () => {
    // Stored 800x400 with the left half red; orientation 6 shows it 400x800, red on top, blue below.
    const { id } = await uploadBytes(t.app, cookie, await splitJpeg(800, 400, 6), "image", { crop: { x: 0, y: 0.5, w: 1, h: 0.5 } })
    await t.app.media.idle()
    const display = await decryptedCopy(t, path.join(mediaRoot, id, "display.webp"))
    const { info, px } = await pixels(display)
    expect([info.width, info.height]).toEqual([400, 400])
    expect(px(200, 200)[2]).toBeGreaterThan(150)
    expect(px(200, 200)[0]).toBeLessThan(100)
  })

  it("400 invalid_body for an out-of-bounds rect, an extra key or a crop on audio", async () => {
    const bytes = await splitJpeg(800, 400)
    const id = await createUpload("image", bytes.length)
    await putChunks(id, bytes)
    for (const payload of [{ crop: { x: 0.6, y: 0, w: 0.5, h: 1 } }, { crop: { x: 0, y: 0, w: 1, h: 1 }, extra: true }]) {
      const res = await completeWith(id, payload)
      expect(res.statusCode).toBe(400)
      expect(res.json()).toEqual({ error: "invalid_body" })
    }
    // Still completable afterwards.
    expect((await completeWith(id, {})).statusCode).toBe(200)

    const audio = await createUpload("audio", 1000)
    const res = await completeWith(audio, { crop: { x: 0, y: 0, w: 1, h: 1 } })
    expect(res.statusCode).toBe(400)
    expect(res.json()).toEqual({ error: "invalid_body" })
  })

  it("422 unsupported_media and a failed row for undecodable bytes sent with a crop", async () => {
    const bytes = randomBytes(4096)
    const id = await createUpload("image", bytes.length)
    await putChunks(id, bytes)
    const res = await completeWith(id, { crop: { x: 0, y: 0, w: 0.5, h: 0.5 } })
    expect(res.statusCode).toBe(422)
    expect(res.json()).toEqual({ error: "unsupported_media" })
    const row = t.app.db.select().from(attachments).where(eq(attachments.id, id)).get()!
    expect(row.status).toBe("failed")
    expect(row.error).toBe("unsupported_media")
    await t.app.media.idle()
    expect(readdirSync(path.join(mediaRoot, "work"))).toEqual([])
  })
})
