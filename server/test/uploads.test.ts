import { randomBytes } from "node:crypto"
import { existsSync, statSync } from "node:fs"
import path from "node:path"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { UPLOAD_CHUNK_SIZE } from "@duet/shared"
import { loginCookie, makeTestApp, TEST_ORIGIN, type TestApp } from "./helpers"

let t: TestApp
let aliceCookie: string
let bobCookie: string

function create(cookie: string | null, payload: unknown) {
  const headers: Record<string, string> = { origin: TEST_ORIGIN }
  if (cookie !== null) headers.cookie = cookie
  return t.app.inject({ method: "POST", url: "/api/uploads", headers, payload: payload as object })
}

function putChunk(cookie: string | null, id: string, index: number | string, bytes: Buffer) {
  const headers: Record<string, string> = { origin: TEST_ORIGIN, "content-type": "application/octet-stream" }
  if (cookie !== null) headers.cookie = cookie
  return t.app.inject({ method: "PUT", url: `/api/uploads/${id}/chunks/${index}`, headers, payload: bytes })
}

function complete(cookie: string, id: string) {
  return t.app.inject({
    method: "POST",
    url: `/api/uploads/${id}/complete`,
    headers: { cookie, origin: TEST_ORIGIN },
  })
}

async function newUpload(cookie: string, size: number): Promise<string> {
  const res = await create(cookie, { kind: "image", size })
  expect(res.statusCode).toBe(200)
  return res.json().id as string
}

beforeAll(async () => {
  t = await makeTestApp({ seed: true })
  aliceCookie = await loginCookie(t.app, "alice")
  bobCookie = await loginCookie(t.app, "bob")
})
afterAll(async () => {
  await t.app.media.idle()
  await t.close()
})

describe("chunked uploads (MDIA-05, Pattern 5)", () => {
  it("uploads 9 000 000 bytes in two chunks and assembles the original; the temp dir is gone", async () => {
    const res = await create(aliceCookie, { kind: "image", size: 9_000_000 })
    expect(res.statusCode).toBe(200)
    expect(res.headers["cache-control"]).toBe("no-store")
    const { id, chunkSize } = res.json()
    expect(id).toMatch(/^[A-Za-z0-9_-]{22}$/)
    expect(chunkSize).toBe(8_388_608)

    const bytes = randomBytes(9_000_000)
    expect((await putChunk(aliceCookie, id, 0, bytes.subarray(0, 8_388_608))).statusCode).toBe(204)
    expect((await putChunk(aliceCookie, id, 1, bytes.subarray(8_388_608))).statusCode).toBe(204)
    expect(bytes.length - 8_388_608).toBe(611_392)

    const done = await complete(aliceCookie, id)
    expect(done.statusCode).toBe(200)
    const { attachment } = done.json()
    expect(attachment.id).toBe(id)
    expect(attachment.kind).toBe("image")
    expect(["processing", "ready"]).toContain(attachment.status)

    const original = path.join(t.dataDir, "media", id, "original")
    expect(statSync(original).size).toBe(9_000_000)
    expect(existsSync(path.join(t.dataDir, "media", "tmp", id))).toBe(false)
    await t.app.media.idle()
  })

  it("rejects an unauthenticated 8 MiB chunk with 401 before reading its body", async () => {
    const id = await newUpload(aliceCookie, 9_000_000)
    const res = await putChunk(null, id, 0, Buffer.alloc(UPLOAD_CHUNK_SIZE))
    expect(res.statusCode).toBe(401)
    expect(res.json()).toEqual({ error: "unauthenticated" })
    // An over-limit body still gets the 401, not the parser's 413: the parser never ran.
    const big = await putChunk(null, id, 0, Buffer.alloc(UPLOAD_CHUNK_SIZE + 1))
    expect(big.statusCode).toBe(401)
  })

  it("answers 413 invalid_body for a chunk over 8 MiB", async () => {
    const id = await newUpload(aliceCookie, 20_000_000)
    const res = await putChunk(aliceCookie, id, 0, Buffer.alloc(UPLOAD_CHUNK_SIZE + 1))
    expect(res.statusCode).toBe(413)
    expect(res.json()).toEqual({ error: "invalid_body" })
  })

  it("answers 400 bad_chunk for a wrong length, an index past the end, or a malformed index", async () => {
    const id = await newUpload(aliceCookie, 9_000_000)
    const short = await putChunk(aliceCookie, id, 0, Buffer.alloc(100))
    expect(short.statusCode).toBe(400)
    expect(short.json()).toEqual({ error: "bad_chunk" })

    const past = await putChunk(aliceCookie, id, 2, Buffer.alloc(100))
    expect(past.statusCode).toBe(400)
    expect(past.json()).toEqual({ error: "bad_chunk" })

    const lastWrong = await putChunk(aliceCookie, id, 1, Buffer.alloc(611_391))
    expect(lastWrong.statusCode).toBe(400)

    for (const bad of ["-1", "01", "x", "1.5"]) {
      const res = await putChunk(aliceCookie, id, bad, Buffer.alloc(100))
      expect(res.statusCode).toBe(400)
    }
  })

  it("answers 404 not_found when bob writes to alice's upload, or for an unknown or malformed id", async () => {
    const id = await newUpload(aliceCookie, 100)
    const res = await putChunk(bobCookie, id, 0, Buffer.alloc(100))
    expect(res.statusCode).toBe(404)
    expect(res.json()).toEqual({ error: "not_found" })
    expect((await complete(bobCookie, id)).statusCode).toBe(404)
    expect((await putChunk(aliceCookie, "A".repeat(22), 0, Buffer.alloc(100))).statusCode).toBe(404)
    expect((await putChunk(aliceCookie, "..%2F..%2Fetc", 0, Buffer.alloc(100))).statusCode).toBe(404)
  })

  it("answers 409 incomplete when a part is missing", async () => {
    const id = await newUpload(aliceCookie, 9_000_000)
    expect((await putChunk(aliceCookie, id, 1, Buffer.alloc(611_392))).statusCode).toBe(204)
    const res = await complete(aliceCookie, id)
    expect(res.statusCode).toBe(409)
    expect(res.json()).toEqual({ error: "incomplete" })
  })

  it("answers 413 too_large past the image cap and accepts video (02-05 lane)", async () => {
    const big = await create(aliceCookie, { kind: "image", size: 104_857_601 })
    expect(big.statusCode).toBe(413)
    expect(big.json()).toEqual({ error: "too_large" })
    expect((await create(aliceCookie, { kind: "image", size: 104_857_600 })).statusCode).toBe(200)

    expect((await create(aliceCookie, { kind: "video", size: 1000 })).statusCode).toBe(200)
  })

  it("validates the create body strictly and requires a session", async () => {
    expect((await create(aliceCookie, { kind: "image", size: 0 })).statusCode).toBe(400)
    expect((await create(aliceCookie, { kind: "pdf", size: 10 })).statusCode).toBe(400)
    expect((await create(aliceCookie, { kind: "image", size: 10, uploaderId: "x" })).statusCode).toBe(400)
    expect((await create(null, { kind: "image", size: 10 })).statusCode).toBe(401)
  })
})
