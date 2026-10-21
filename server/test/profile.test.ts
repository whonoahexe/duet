import { randomBytes, randomUUID } from "node:crypto"
import { existsSync, readdirSync } from "node:fs"
import path from "node:path"
import sharp from "sharp"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { eq } from "drizzle-orm"
import { attachments, users } from "../src/db/schema"
import { readEncHeader } from "../src/media/crypto"
import { decryptedCopy, loginCookie, makeTestApp, openWs, TEST_ORIGIN, uploadBytes, type TestApp, type WsTestClient } from "./helpers"

let t: TestApp
let aliceCookie: string
let bobCookie: string
let aliceId: string
let bobId: string
let mediaRoot: string

/** 800x400 JPEG: left half red, right half blue, so a centre crop is half red, half blue. */
async function splitJpeg(width = 800, height = 400): Promise<Buffer> {
  const half = Math.floor(width / 2)
  const red = await sharp({ create: { width: half, height, channels: 3, background: { r: 230, g: 10, b: 10 } } })
    .png()
    .toBuffer()
  return sharp({ create: { width, height, channels: 3, background: { r: 10, g: 10, b: 230 } } })
    .composite([{ input: red, left: 0, top: 0 }])
    .jpeg({ quality: 90 })
    .toBuffer()
}

function putPhoto(cookie: string | null, userId: string, payload: unknown) {
  return t.app.inject({
    method: "PUT",
    url: `/api/users/${userId}/photo`,
    headers: { ...(cookie !== null ? { cookie } : {}), origin: TEST_ORIGIN },
    payload: payload as object,
  })
}

async function readyUpload(cookie = aliceCookie): Promise<string> {
  const { id } = await uploadBytes(t.app, cookie, await splitJpeg())
  await t.app.media.idle()
  return id
}

function photoOf(userId: string): string | null {
  return t.app.db.select({ photoId: users.photoId }).from(users).where(eq(users.id, userId)).get()?.photoId ?? null
}

/** The next frame of type t, skipping others (hello, msg). */
async function nextOfType(ws: WsTestClient, type: string): Promise<Record<string, unknown>> {
  for (;;) {
    const f = await ws.next(3000)
    if (f.t === type) return f
  }
}

beforeAll(async () => {
  t = await makeTestApp({ seed: true })
  aliceCookie = await loginCookie(t.app, "alice")
  bobCookie = await loginCookie(t.app, "bob")
  aliceId = t.app.db.select({ id: users.id }).from(users).where(eq(users.username, "alice")).get()!.id
  bobId = t.app.db.select({ id: users.id }).from(users).where(eq(users.username, "bob")).get()!.id
  mediaRoot = path.join(t.dataDir, "media")
})
afterAll(async () => {
  await t.app.media.idle()
  await t.close()
})

describe("PUT /api/users/:id/photo validation (QT-5zd-photo-store, T-5zd-02)", () => {
  it("401 without a cookie", async () => {
    const res = await putPhoto(null, bobId, { attachmentId: null })
    expect(res.statusCode).toBe(401)
  })

  it("400 invalid_body for a bad id, an extra key or a missing key", async () => {
    for (const payload of [{ attachmentId: "x" }, { attachmentId: null, extra: 1 }, {}]) {
      const res = await putPhoto(aliceCookie, bobId, payload)
      expect(res.statusCode).toBe(400)
      expect(res.json()).toEqual({ error: "invalid_body" })
      expect(res.headers["cache-control"]).toBe("no-store")
    }
  })

  it("404 not_found for a non-uuid or unknown user id", async () => {
    for (const id of ["not-a-uuid", randomUUID()]) {
      const res = await putPhoto(aliceCookie, id, { attachmentId: null })
      expect(res.statusCode).toBe(404)
      expect(res.json()).toEqual({ error: "not_found" })
    }
  })

  it("400 bad_attachment for another person's upload, message media, audio, or an existing photo", async () => {
    const bobs = await readyUpload(bobCookie)
    expect((await putPhoto(aliceCookie, bobId, { attachmentId: bobs })).json()).toEqual({ error: "bad_attachment" })

    const sent = await readyUpload()
    const msg = await t.app.inject({
      method: "POST",
      url: "/api/messages",
      headers: { cookie: aliceCookie, origin: TEST_ORIGIN },
      payload: { id: randomUUID(), attachmentIds: [sent] },
    })
    expect(msg.statusCode).toBe(200)
    const viaMessage = await putPhoto(aliceCookie, aliceId, { attachmentId: sent })
    expect(viaMessage.statusCode).toBe(400)
    expect(viaMessage.json()).toEqual({ error: "bad_attachment" })

    const audioId = randomBytes(16).toString("base64url")
    t.app.db
      .insert(attachments)
      .values({ id: audioId, uploaderId: aliceId, kind: "audio", status: "ready", declaredSize: 10, createdAt: new Date() })
      .run()
    expect((await putPhoto(aliceCookie, aliceId, { attachmentId: audioId })).json()).toEqual({ error: "bad_attachment" })

    const unknown = randomBytes(16).toString("base64url")
    expect((await putPhoto(aliceCookie, aliceId, { attachmentId: unknown })).json()).toEqual({ error: "bad_attachment" })

    const taken = await readyUpload()
    expect((await putPhoto(aliceCookie, bobId, { attachmentId: taken })).statusCode).toBe(200)
    const again = await putPhoto(aliceCookie, aliceId, { attachmentId: taken })
    expect(again.statusCode).toBe(400)
    expect(again.json()).toEqual({ error: "bad_attachment" })
    expect(photoOf(aliceId)).toBeNull()

    // An avatar is never message media either.
    const send = await t.app.inject({
      method: "POST",
      url: "/api/messages",
      headers: { cookie: aliceCookie, origin: TEST_ORIGIN },
      payload: { id: randomUUID(), attachmentIds: [taken] },
    })
    expect(send.statusCode).toBe(400)
    expect(send.json()).toEqual({ error: "bad_attachment" })

    // Reset Bob's photo for the tests below.
    expect((await putPhoto(aliceCookie, bobId, { attachmentId: null })).statusCode).toBe(200)
  })

  it("422 with the row's error when processing failed", async () => {
    const { id } = await uploadBytes(t.app, aliceCookie, randomBytes(4096))
    await t.app.media.idle()
    const row = t.app.db.select().from(attachments).where(eq(attachments.id, id)).get()!
    expect(row.status).toBe("failed")
    const res = await putPhoto(aliceCookie, aliceId, { attachmentId: id })
    expect(res.statusCode).toBe(422)
    expect(res.json()).toEqual({ error: row.error })
    expect(photoOf(aliceId)).toBeNull()
  })
})

describe("setting a photo (QT-5zd-photo-store, QT-5zd-photo-live)", () => {
  let photoA: string

  it("stores encrypted 192/640 square crops, broadcasts to both people and shows in /api/me", async () => {
    const aliceWs = await openWs(t.app, aliceCookie, TEST_ORIGIN)
    const bobWs = await openWs(t.app, bobCookie, TEST_ORIGIN)
    await nextOfType(aliceWs, "hello")
    await nextOfType(bobWs, "hello")

    photoA = await readyUpload()
    const res = await putPhoto(aliceCookie, bobId, { attachmentId: photoA })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ userId: bobId, photoId: photoA })

    for (const [file, edge] of [
      ["avatar-sm.webp", 192],
      ["avatar-lg.webp", 640],
    ] as const) {
      const abs = path.join(mediaRoot, photoA, file)
      expect(await readEncHeader(abs)).not.toBeNull()
      const plain = await decryptedCopy(t, abs)
      const meta = await sharp(plain).metadata()
      expect(meta.format).toBe("webp")
      expect(meta.width).toBe(edge)
      expect(meta.height).toBe(edge)
      expect(meta.exif).toBeUndefined()
      // Centre crop of the red|blue split: red on the left edge, blue on the right edge.
      const { data, info } = await sharp(plain).raw().toBuffer({ resolveWithObject: true })
      const px = (x: number, y: number) => {
        const i = (y * info.width + x) * info.channels
        return [data[i]!, data[i + 1]!, data[i + 2]!]
      }
      const mid = Math.floor(edge / 2)
      expect(px(4, mid)[0]).toBeGreaterThan(150)
      expect(px(edge - 5, mid)[2]).toBeGreaterThan(150)
    }
    expect(readdirSync(path.join(mediaRoot, "work"))).toEqual([])

    const sm = await t.app.inject({ method: "GET", url: `/media/${photoA}/avatar-sm`, headers: { cookie: bobCookie } })
    expect(sm.statusCode).toBe(200)
    expect(sm.headers["content-type"]).toBe("image/webp")
    const lg = await t.app.inject({ method: "GET", url: `/media/${photoA}/avatar-lg`, headers: { cookie: aliceCookie } })
    expect(lg.statusCode).toBe(200)
    const anon = await t.app.inject({ method: "GET", url: `/media/${photoA}/avatar-sm` })
    expect(anon.statusCode).toBe(401)

    expect(await nextOfType(aliceWs, "profile")).toEqual({ t: "profile", userId: bobId, photoId: photoA })
    expect(await nextOfType(bobWs, "profile")).toEqual({ t: "profile", userId: bobId, photoId: photoA })
    aliceWs.ws.close()
    bobWs.ws.close()

    const meBob = (await t.app.inject({ method: "GET", url: "/api/me", headers: { cookie: bobCookie } })).json()
    expect(meBob.user.photoId).toBe(photoA)
    expect(meBob.peer.photoId).toBeNull()
    const meAlice = (await t.app.inject({ method: "GET", url: "/api/me", headers: { cookie: aliceCookie } })).json()
    expect(meAlice.user.photoId).toBeNull()
    expect(meAlice.peer.photoId).toBe(photoA)

    // The public login list never carries the photo (T-5zd-04).
    const list = (await t.app.inject({ method: "GET", url: "/api/users" })).json()
    for (const u of list.users) expect(Object.keys(u).sort()).toEqual(["displayName", "id", "username"])
  })

  it("waits for a job that is still processing (processor.settled)", async () => {
    t.app.media.pause()
    const { id, attachment } = await uploadBytes(t.app, aliceCookie, await splitJpeg(600, 900))
    expect(attachment.status).toBe("processing")
    const pending = putPhoto(aliceCookie, aliceId, { attachmentId: id })
    await new Promise((r) => setTimeout(r, 50))
    t.app.media.resume()
    const res = await pending
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ userId: aliceId, photoId: id })
    expect(existsSync(path.join(mediaRoot, id, "avatar-sm.webp"))).toBe(true)
  })

  it("replacing deletes the old avatar row and dir", async () => {
    expect(photoOf(bobId)).toBe(photoA)
    const photoB = await readyUpload()
    const res = await putPhoto(aliceCookie, bobId, { attachmentId: photoB })
    expect(res.statusCode).toBe(200)
    expect(photoOf(bobId)).toBe(photoB)
    expect(t.app.db.select().from(attachments).where(eq(attachments.id, photoA)).get()).toBeUndefined()
    expect(existsSync(path.join(mediaRoot, photoA))).toBe(false)
    expect(existsSync(path.join(mediaRoot, photoB, "avatar-lg.webp"))).toBe(true)
    photoA = photoB
  })

  it("removing clears the photo, deletes the old avatar and broadcasts null", async () => {
    const bobWs = await openWs(t.app, bobCookie, TEST_ORIGIN)
    await nextOfType(bobWs, "hello")
    const res = await putPhoto(bobCookie, bobId, { attachmentId: null })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ userId: bobId, photoId: null })
    expect(photoOf(bobId)).toBeNull()
    expect(t.app.db.select().from(attachments).where(eq(attachments.id, photoA)).get()).toBeUndefined()
    expect(existsSync(path.join(mediaRoot, photoA))).toBe(false)
    expect(await nextOfType(bobWs, "profile")).toEqual({ t: "profile", userId: bobId, photoId: null })
    bobWs.ws.close()
  })
})
