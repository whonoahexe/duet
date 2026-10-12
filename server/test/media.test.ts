import { randomUUID } from "node:crypto"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import sharp from "sharp"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { eq } from "drizzle-orm"
import { selectionSendLabel, selectionTitle } from "@duet/shared"
import { attachments, users } from "../src/db/schema"
import { hasTool, runTool } from "../src/media/exec"
import { processImage } from "../src/media/image"
import { loginCookie, makeDataDir, makeTestApp, openWs, TEST_ORIGIN, uploadBytes, type TestApp } from "./helpers"

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

describe("album order and attachment ownership (D-07, MDIA-05, T-02-28)", () => {
  it("keeps the attachmentIds order as positions 0..n-1 in the send, GET /api/messages and /api/sync", async () => {
    const a = await readyPhoto()
    const b = await readyPhoto()
    const c = await readyPhoto()
    const cursorBefore = (
      await t.app.inject({ method: "GET", url: "/api/messages?limit=1", headers: { cookie: bobCookie } })
    ).json().cursor as number
    const res = await send(aliceCookie, { body: "ordered", attachmentIds: [c, a, b] })
    expect(res.statusCode).toBe(200)
    const sent = res.json().message
    const order = (m: { attachments: { id: string; position: number }[] }) => m.attachments.map((x) => [x.id, x.position])
    expect(order(sent)).toEqual([
      [c, 0],
      [a, 1],
      [b, 2],
    ])

    const page = await t.app.inject({ method: "GET", url: "/api/messages?limit=5", headers: { cookie: bobCookie } })
    const fromPage = page.json().messages.find((m: { seq: number }) => m.seq === sent.seq)
    expect(order(fromPage)).toEqual(order(sent))

    const sync = await t.app.inject({ method: "GET", url: `/api/sync?since=${cursorBefore}`, headers: { cookie: bobCookie } })
    const fromSync = sync.json().messages.find((m: { seq: number }) => m.seq === sent.seq)
    expect(order(fromSync)).toEqual(order(sent))
  })

  it("answers 400 bad_attachment for an attachment already in a message or uploaded by the other person", async () => {
    const used = await readyPhoto()
    expect((await send(aliceCookie, { attachmentIds: [used] })).statusCode).toBe(200)
    const again = await send(aliceCookie, { attachmentIds: [used] })
    expect(again.statusCode).toBe(400)
    expect(again.json()).toEqual({ error: "bad_attachment" })

    const bobs = await readyPhoto(bobCookie)
    const stolen = await send(aliceCookie, { attachmentIds: [bobs] })
    expect(stolen.statusCode).toBe(400)
    expect(stolen.json()).toEqual({ error: "bad_attachment" })
    // Nothing was attached by the rejected sends.
    const row = t.app.db.select().from(attachments).where(eq(attachments.id, bobs)).get()
    expect(row?.messageSeq).toBeNull()
  })

  it("answers 400 bad_attachment for an upload that never completed or failed processing", async () => {
    const created = await t.app.inject({
      method: "POST",
      url: "/api/uploads",
      headers: { cookie: aliceCookie, origin: TEST_ORIGIN },
      payload: { kind: "image", size: 10 },
    })
    const unfinished = created.json().id as string
    expect((await send(aliceCookie, { attachmentIds: [unfinished] })).json()).toEqual({ error: "bad_attachment" })

    const { id: junk } = await uploadBytes(t.app, aliceCookie, Buffer.from("not an image at all"))
    await t.app.media.idle()
    const row = t.app.db.select().from(attachments).where(eq(attachments.id, junk)).get()
    expect(row).toMatchObject({ status: "failed", error: "unsupported_media" })
    expect((await send(aliceCookie, { attachmentIds: [junk] })).json()).toEqual({ error: "bad_attachment" })
  })

  it("rejects 11 attachments and duplicated ids as invalid_body", async () => {
    const ids = Array.from({ length: 11 }, (_, i) => `${"A".repeat(20)}${String(i).padStart(2, "0")}`)
    const eleven = await send(aliceCookie, { attachmentIds: ids })
    expect(eleven.statusCode).toBe(400)
    expect(eleven.json()).toEqual({ error: "invalid_body" })
    const id = await readyPhoto()
    const dup = await send(aliceCookie, { attachmentIds: [id, id] })
    expect(dup.statusCode).toBe(400)
    expect(dup.json()).toEqual({ error: "invalid_body" })
  })
})

describe("upload concurrency (MDIA-05)", () => {
  it("returns the same attachment when complete is called twice, also concurrently", async () => {
    const bytes = await jpeg(300, 300)
    const created = await t.app.inject({
      method: "POST",
      url: "/api/uploads",
      headers: { cookie: aliceCookie, origin: TEST_ORIGIN },
      payload: { kind: "image", size: bytes.length },
    })
    const id = created.json().id as string
    const put = await t.app.inject({
      method: "PUT",
      url: `/api/uploads/${id}/chunks/0`,
      headers: { cookie: aliceCookie, origin: TEST_ORIGIN, "content-type": "application/octet-stream" },
      payload: bytes,
    })
    expect(put.statusCode).toBe(204)
    t.app.media.pause()
    try {
      const complete = () =>
        t.app.inject({ method: "POST", url: `/api/uploads/${id}/complete`, headers: { cookie: aliceCookie, origin: TEST_ORIGIN } })
      const [first, second] = await Promise.all([complete(), complete()])
      const third = await complete()
      for (const r of [first, second, third]) {
        expect(r.statusCode).toBe(200)
        expect(r.json().attachment).toMatchObject({ id, status: "processing" })
      }
      expect(readFileSync(path.join(t.dataDir, "media", id, "original")).equals(bytes)).toBe(true)
    } finally {
      t.app.media.resume()
      await t.app.media.idle()
    }
  })

  it("keeps only the last bytes of a chunk that was sent twice", async () => {
    const created = await t.app.inject({
      method: "POST",
      url: "/api/uploads",
      headers: { cookie: aliceCookie, origin: TEST_ORIGIN },
      payload: { kind: "image", size: 1000 },
    })
    const id = created.json().id as string
    const put = (bytes: Buffer) =>
      t.app.inject({
        method: "PUT",
        url: `/api/uploads/${id}/chunks/0`,
        headers: { cookie: aliceCookie, origin: TEST_ORIGIN, "content-type": "application/octet-stream" },
        payload: bytes,
      })
    expect((await put(Buffer.alloc(1000, 1))).statusCode).toBe(204)
    const last = Buffer.alloc(1000, 2)
    expect((await put(last)).statusCode).toBe(204)
    const done = await t.app.inject({
      method: "POST",
      url: `/api/uploads/${id}/complete`,
      headers: { cookie: aliceCookie, origin: TEST_ORIGIN },
    })
    expect(done.statusCode).toBe(200)
    expect(readFileSync(path.join(t.dataDir, "media", id, "original")).equals(last)).toBe(true)
    await t.app.media.idle()
  })
})

describe("boot recovery (Pattern 6)", () => {
  it("processes attachments left in processing and deletes uploads and temp dirs older than 24 h", async () => {
    const dir = makeDataDir()
    const first = await makeTestApp({ dataDir: dir, seed: true })
    const aliceId = first.app.db.select({ id: users.id }).from(users).where(eq(users.username, "alice")).get()!.id
    const media = path.join(dir, "media")
    const HOUR = 60 * 60 * 1000
    const now = Date.now()

    // A finished upload whose processing never ran (the server stopped first).
    const leftover = "L".repeat(22)
    mkdirSync(path.join(media, leftover), { recursive: true })
    writeFileSync(path.join(media, leftover, "original"), await jpeg(500, 400))
    // Abandoned uploads: one 25 h old (deleted), one 1 h old (kept), each with a temp dir.
    const stale = "S".repeat(22)
    const fresh = "F".repeat(22)
    for (const [id, age] of [
      [stale, 25 * HOUR],
      [fresh, 1 * HOUR],
    ] as const) {
      const tmp = path.join(media, "tmp", id)
      mkdirSync(tmp, { recursive: true })
      writeFileSync(path.join(tmp, "0.part"), Buffer.alloc(10))
      const when = new Date(now - age)
      utimesSync(tmp, when, when)
    }
    // An orphaned temp dir with no row at all, 25 h old.
    const orphan = path.join(media, "tmp", "O".repeat(22))
    mkdirSync(orphan, { recursive: true })
    utimesSync(orphan, new Date(now - 25 * HOUR), new Date(now - 25 * HOUR))

    const row = { uploaderId: aliceId, kind: "image" as const, declaredSize: 10 }
    first.app.db
      .insert(attachments)
      .values([
        { ...row, id: leftover, status: "processing", createdAt: new Date(now - 2 * HOUR) },
        { ...row, id: stale, status: "uploading", createdAt: new Date(now - 25 * HOUR) },
        { ...row, id: fresh, status: "uploading", createdAt: new Date(now - 1 * HOUR) },
      ])
      .run()
    await first.app.close()

    const second = await makeTestApp({ dataDir: dir, seed: false })
    try {
      await second.app.ready()
      await second.app.media.idle()
      const byId = (id: string) => second.app.db.select().from(attachments).where(eq(attachments.id, id)).get()
      expect(byId(leftover)).toMatchObject({ status: "ready", width: 500, height: 400 })
      expect(existsSync(path.join(media, leftover, "display.webp"))).toBe(true)
      expect(byId(stale)).toBeUndefined()
      expect(existsSync(path.join(media, "tmp", stale))).toBe(false)
      expect(byId(fresh)).toMatchObject({ status: "uploading" })
      expect(existsSync(path.join(media, "tmp", fresh))).toBe(true)
      expect(existsSync(orphan)).toBe(false)
    } finally {
      await second.close()
    }
  })
})
