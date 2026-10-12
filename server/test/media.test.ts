import { randomUUID } from "node:crypto"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import sharp from "sharp"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { selectionSendLabel, selectionTitle } from "@duet/shared"
import { hasTool, runTool } from "../src/media/exec"
import { processImage } from "../src/media/image"
import { loginCookie, makeTestApp, openWs, TEST_ORIGIN, uploadBytes, type TestApp } from "./helpers"

let t: TestApp
let aliceCookie: string
let bobCookie: string
let scratch: string
/** heif-convert and heif-enc exist in the container (libheif-examples), not on the dev host. */
const heifTools = (await hasTool("heif-convert")) && (await hasTool("heif-enc"))

/** A JPEG of the given size (solid color) with optional EXIF orientation and GPS tags. */
async function jpeg(width: number, height: number, opts: { orientation?: number; gps?: boolean } = {}): Promise<Buffer> {
  let img = sharp({ create: { width, height, channels: 3, background: { r: 180, g: 40, b: 70 } } }).jpeg({ quality: 80 })
  if (opts.orientation) img = img.withMetadata({ orientation: opts.orientation })
  if (opts.gps) {
    img = img.withExifMerge({
      IFD0: { Make: "TestCam" },
      IFD3: { GPSLatitudeRef: "N", GPSLatitude: "48/1 51/1 2400/100", GPSLongitudeRef: "E", GPSLongitude: "2/1 17/1 4000/100" },
    })
  }
  return img.toBuffer()
}

/** EXIF GPSInfo pointer tag (0x8825) in either byte order. */
function hasGpsIfd(exif: Buffer): boolean {
  return exif.includes(Buffer.from([0x88, 0x25])) || exif.includes(Buffer.from([0x25, 0x88]))
}

function send(cookie: string, payload: Record<string, unknown>) {
  return t.app.inject({
    method: "POST",
    url: "/api/messages",
    headers: { cookie, origin: TEST_ORIGIN },
    payload: { id: randomUUID(), ...payload },
  })
}

function getMedia(cookie: string | null, url: string, headers: Record<string, string> = {}) {
  return t.app.inject({ method: "GET", url, headers: { ...(cookie !== null ? { cookie } : {}), ...headers } })
}

/** Upload a small JPEG as alice and wait until it is processed. */
async function readyPhoto(cookie = aliceCookie, w = 400, h = 300): Promise<string> {
  const { id } = await uploadBytes(t.app, cookie, await jpeg(w, h))
  await t.app.media.idle()
  return id
}

beforeAll(async () => {
  t = await makeTestApp({ seed: true })
  aliceCookie = await loginCookie(t.app, "alice")
  bobCookie = await loginCookie(t.app, "bob")
  scratch = mkdtempSync(path.join(tmpdir(), "duet-media-"))
})
afterAll(async () => {
  await t.app.media.idle()
  await t.close()
  rmSync(scratch, { recursive: true, force: true })
})

describe("processImage (MDIA-01, D-09)", () => {
  it("autorotates, caps display at 2048 and thumb at 640, strips EXIF/GPS and leaves the original byte-identical", async () => {
    const dir = mkdtempSync(path.join(scratch, "rot-"))
    const original = path.join(dir, "original")
    const bytes = await jpeg(3000, 2000, { orientation: 6, gps: true })
    writeFileSync(original, bytes)
    const meta = await sharp(original).metadata()
    expect(meta.orientation).toBe(6)
    expect(hasGpsIfd(meta.exif!)).toBe(true)

    const result = await processImage(original, dir)
    // Orientation 6 turns 3000x2000 into a 2000x3000 portrait, fitted inside 2048.
    expect(result).toEqual({ width: 1365, height: 2048 })

    const display = await sharp(path.join(dir, "display.webp")).metadata()
    expect(display.format).toBe("webp")
    expect([display.width, display.height]).toEqual([1365, 2048])
    expect(display.exif).toBeUndefined()
    expect(display.orientation).toBeUndefined()

    const thumb = await sharp(path.join(dir, "thumb.webp")).metadata()
    expect(thumb.format).toBe("webp")
    expect(Math.max(thumb.width!, thumb.height!)).toBe(640)
    expect(thumb.height!).toBeGreaterThan(thumb.width!)
    expect(thumb.exif).toBeUndefined()

    expect(readFileSync(original).equals(bytes)).toBe(true)
  })

  it("never enlarges a small photo", async () => {
    const dir = mkdtempSync(path.join(scratch, "small-"))
    writeFileSync(path.join(dir, "original"), await jpeg(300, 200))
    expect(await processImage(path.join(dir, "original"), dir)).toEqual({ width: 300, height: 200 })
  })

  it("rejects bytes that are not an image with unsupported_media", async () => {
    const dir = mkdtempSync(path.join(scratch, "junk-"))
    writeFileSync(path.join(dir, "original"), Buffer.from("<html><script>alert(1)</script></html>"))
    await expect(processImage(path.join(dir, "original"), dir)).rejects.toMatchObject({ code: "unsupported_media" })
  })

  it.skipIf(!heifTools)("converts HEVC HEIF through heif-convert (iPhone HEIC, Pitfall 5)", async () => {
    const dir = mkdtempSync(path.join(scratch, "heic-"))
    const src = path.join(dir, "src.jpg")
    writeFileSync(src, await jpeg(1200, 900))
    const original = path.join(dir, "original")
    await runTool("heif-enc", ["-q", "80", "-o", original, src], { timeoutMs: 60_000 })
    const meta = await sharp(original).metadata()
    expect(meta.format).toBe("heif")
    expect(meta.compression).toBe("hevc")
    expect(await processImage(original, dir)).toEqual({ width: 1200, height: 900 })
    expect((await sharp(path.join(dir, "thumb.webp")).metadata()).width).toBe(640)
  })
})

describe("sending a photo (POST /api/messages with attachmentIds)", () => {
  it("creates a media message with the caption and the attachment at position 0", async () => {
    const id = await readyPhoto()
    const res = await send(aliceCookie, { body: "cap", attachmentIds: [id] })
    expect(res.statusCode).toBe(200)
    const { message } = res.json()
    expect(message.kind).toBe("media")
    expect(message.body).toBe("cap")
    expect(message.attachments).toHaveLength(1)
    expect(message.attachments[0]).toMatchObject({ id, position: 0, kind: "image", status: "ready", width: 400, height: 300 })
  })

  it("accepts attachments without a caption and rejects a message with neither", async () => {
    const id = await readyPhoto()
    const res = await send(aliceCookie, { attachmentIds: [id] })
    expect(res.statusCode).toBe(200)
    expect(res.json().message.body).toBeNull()

    const neither = await send(aliceCookie, {})
    expect(neither.statusCode).toBe(400)
    expect(neither.json()).toEqual({ error: "invalid_body" })
    expect((await send(aliceCookie, { body: "   ", attachmentIds: [await readyPhoto()] })).statusCode).toBe(400)
  })
})

describe("GET /media/:id/:variant (MDIA-05)", () => {
  let id: string
  beforeAll(async () => {
    id = await readyPhoto(aliceCookie, 800, 600)
    expect((await send(aliceCookie, { attachmentIds: [id] })).statusCode).toBe(200)
  })

  it("requires a session", async () => {
    const res = await getMedia(null, `/media/${id}/thumb`)
    expect(res.statusCode).toBe(401)
  })

  it("serves the thumb and display to both people as private, immutable WebP with Accept-Ranges", async () => {
    for (const cookie of [aliceCookie, bobCookie]) {
      for (const variant of ["thumb", "display"]) {
        const res = await getMedia(cookie, `/media/${id}/${variant}`)
        expect(res.statusCode).toBe(200)
        expect(res.headers["content-type"]).toBe("image/webp")
        expect(res.headers["accept-ranges"]).toBe("bytes")
        expect(res.headers["cache-control"]).toBe("private, max-age=31536000, immutable")
        expect(res.headers["x-content-type-options"]).toBe("nosniff")
        expect(res.rawPayload.subarray(0, 4).toString("latin1")).toBe("RIFF")
      }
    }
  })

  it("answers Range requests with 206 at both ends and 416 past the end", async () => {
    const full = await getMedia(aliceCookie, `/media/${id}/display`)
    const n = full.rawPayload.length
    expect(n).toBeGreaterThan(2)

    const first = await getMedia(aliceCookie, `/media/${id}/display`, { range: "bytes=0-1" })
    expect(first.statusCode).toBe(206)
    expect(first.headers["content-range"]).toBe(`bytes 0-1/${n}`)
    expect(first.rawPayload.length).toBe(2)

    const last = await getMedia(aliceCookie, `/media/${id}/display`, { range: `bytes=${n - 1}-` })
    expect(last.statusCode).toBe(206)
    expect(last.rawPayload.length).toBe(1)
    expect(last.rawPayload[0]).toBe(full.rawPayload[n - 1])

    const past = await getMedia(aliceCookie, `/media/${id}/display`, { range: `bytes=${n}-` })
    expect(past.statusCode).toBe(416)
    expect(past.headers["content-range"]).toBe(`bytes */${n}`)
  })

  it("never serves the original, a variant the photo lacks, an unknown or malformed id, as no-store 404s", async () => {
    for (const url of [
      `/media/${id}/original`,
      `/media/${id}/poster`,
      `/media/${id}/thumb.webp`,
      `/media/${"A".repeat(22)}/thumb`,
      `/media/..%2F..%2Fetc/thumb`,
      `/media/${id.slice(0, 21)}/thumb`,
    ]) {
      const res = await getMedia(aliceCookie, url)
      expect(res.statusCode, url).toBe(404)
      expect(res.headers["cache-control"], url).toBe("no-store")
      expect(res.json(), url).toEqual({ error: "not_found" })
    }
  })

  it("answers 404 no-store while an attachment is not ready yet", async () => {
    t.app.media.pause()
    try {
      const { id: pending } = await uploadBytes(t.app, aliceCookie, await jpeg(200, 200))
      const res = await getMedia(aliceCookie, `/media/${pending}/thumb`)
      expect(res.statusCode).toBe(404)
      expect(res.headers["cache-control"]).toBe("no-store")
    } finally {
      t.app.media.resume()
      await t.app.media.idle()
    }
  })
})

describe("processing that finishes after the send (MDIA-01)", () => {
  it("bumps the message and sends both people a msg frame with the ready attachment", async () => {
    const alice = await openWs(t.app, aliceCookie, TEST_ORIGIN)
    const bob = await openWs(t.app, bobCookie, TEST_ORIGIN)
    expect((await alice.next()).t).toBe("hello")
    expect((await bob.next()).t).toBe("hello")

    t.app.media.pause()
    let sent: { updatedSeq: number; seq: number }
    let attId: string
    try {
      const { id, attachment } = await uploadBytes(t.app, aliceCookie, await jpeg(640, 480))
      attId = id
      expect(attachment.status).toBe("processing")
      const res = await send(aliceCookie, { body: "late", attachmentIds: [id] })
      expect(res.statusCode).toBe(200)
      sent = res.json().message
      expect(res.json().message.attachments[0].status).toBe("processing")
      for (const c of [alice, bob]) expect((await c.next()).t).toBe("msg")
    } finally {
      t.app.media.resume()
    }
    await t.app.media.idle()

    for (const c of [alice, bob]) {
      const frame = await c.next(3000)
      expect(frame.t).toBe("msg")
      expect(frame.message.seq).toBe(sent.seq)
      expect(frame.message.updatedSeq).toBeGreaterThan(sent.updatedSeq)
      expect(frame.message.attachments[0]).toMatchObject({ id: attId!, status: "ready", width: 640, height: 480 })
    }
    alice.ws.terminate()
    bob.ws.terminate()
  })
})

describe("selection labels (D-06)", () => {
  it("counts photos, videos and mixed items", () => {
    expect(selectionTitle(["image"])).toBe("1 photo")
    expect(selectionTitle(["image", "image", "image"])).toBe("3 photos")
    expect(selectionTitle(["video"])).toBe("1 video")
    expect(selectionTitle(["image", "video", "image", "video"])).toBe("4 items")
    expect(selectionSendLabel(["image"])).toBe("Send photo")
    expect(selectionSendLabel(["image", "image"])).toBe("Send 2 photos")
    expect(selectionSendLabel(["video", "video"])).toBe("Send 2 videos")
    expect(selectionSendLabel(["image", "video"])).toBe("Send 2 items")
  })
})
