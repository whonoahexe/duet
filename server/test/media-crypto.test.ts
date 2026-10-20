import { randomBytes } from "node:crypto"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import sharp from "sharp"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import {
  ENC_CHUNK,
  ENC_HEADER_LEN,
  MediaKeyError,
  decryptChunks,
  encryptBuffer,
  encryptFile,
  encryptedSize,
  loadMediaKey,
  readDecrypted,
  readEncHeader,
} from "../src/media/crypto"
import { parseRange } from "../src/media/routes"
import { loginCookie, makeTestApp, uploadBytes, type TestApp } from "./helpers"

/** QT-4qu: DUETENC v1 media at rest. */

let scratch: string
beforeAll(() => {
  scratch = mkdtempSync(path.join(tmpdir(), "duet-crypto-"))
})
afterAll(() => {
  rmSync(scratch, { recursive: true, force: true })
})

function tmpFile(name: string): string {
  return path.join(scratch, `${randomBytes(4).toString("hex")}-${name}`)
}

/** Plaintext of n bytes with a marker ("RIFF" + 32 known bytes) at the start when it fits. */
function plaintext(n: number): Buffer {
  const b = randomBytes(n)
  const marker = Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(32, 0x5a)])
  if (n >= marker.length) marker.copy(b, 0)
  return b
}

async function encryptedFixture(key: Buffer, plain: Buffer): Promise<string> {
  const src = tmpFile("plain")
  const dst = tmpFile("enc")
  writeFileSync(src, plain)
  await encryptFile(key, src, dst)
  return dst
}

async function collect(gen: AsyncGenerator<Buffer>): Promise<Buffer> {
  const parts: Buffer[] = []
  for await (const c of gen) parts.push(c)
  return Buffer.concat(parts)
}

describe("DUETENC v1 format (QT-4qu-format)", () => {
  const key = randomBytes(32)

  for (const n of [0, 1, 65535, 65536, 65537, 3 * 65536 + 5]) {
    it(`round-trips ${n} bytes through encryptFile / readDecrypted`, async () => {
      const plain = plaintext(n)
      const file = await encryptedFixture(key, plain)
      const disk = readFileSync(file)
      expect(disk.length).toBe(encryptedSize(n))
      expect(disk.subarray(0, 7).toString("ascii")).toBe("DUETENC")
      if (n >= 36) expect(disk.includes(plain.subarray(0, 36))).toBe(false)
      expect((await readDecrypted(key, file)).equals(plain)).toBe(true)
      expect(readdirSync(path.dirname(file)).some((f) => f.endsWith(".tmp"))).toBe(false)
    })
  }

  it("encryptBuffer writes the same layout as encryptFile", async () => {
    const plain = plaintext(ENC_CHUNK + 10)
    const file = tmpFile("buf")
    writeFileSync(file, encryptBuffer(key, plain))
    expect(statSync(file).size).toBe(encryptedSize(plain.length))
    expect((await readDecrypted(key, file)).equals(plain)).toBe(true)
  })

  it("decryptChunks returns exactly the requested range", async () => {
    const size = 3 * ENC_CHUNK + 5
    const plain = plaintext(size)
    const file = await encryptedFixture(key, plain)
    const header = (await readEncHeader(file))!
    const ranges: Array<[number, number]> = [
      [10, 20], // inside one chunk
      [ENC_CHUNK - 3, ENC_CHUNK + 3], // across one boundary
      [ENC_CHUNK - 1, 2 * ENC_CHUNK + 1], // across two boundaries
      [0, 0], // first byte
      [size - 1, size - 1], // last byte
      [0, size - 1], // whole file
    ]
    for (const [s, e] of ranges) {
      const got = await collect(decryptChunks(key, file, header, s, e))
      expect(got.equals(plain.subarray(s, e + 1)), `${s}-${e}`).toBe(true)
    }
  })

  it("rejects a flipped byte, swapped chunks and the wrong key", async () => {
    const plain = plaintext(3 * ENC_CHUNK)
    const stride = ENC_CHUNK + 28

    const flipped = await encryptedFixture(key, plain)
    const b = readFileSync(flipped)
    b[ENC_HEADER_LEN + stride + 100] ^= 0x01
    writeFileSync(flipped, b)
    const h1 = (await readEncHeader(flipped))!
    await expect(collect(decryptChunks(key, flipped, h1, ENC_CHUNK, ENC_CHUNK + 10))).rejects.toThrow()
    // Chunk 0 is untouched and still decrypts.
    expect((await collect(decryptChunks(key, flipped, h1, 0, 9))).equals(plain.subarray(0, 10))).toBe(true)

    const swapped = await encryptedFixture(key, plain)
    const s = readFileSync(swapped)
    const c0 = Buffer.from(s.subarray(ENC_HEADER_LEN, ENC_HEADER_LEN + stride))
    const c1 = Buffer.from(s.subarray(ENC_HEADER_LEN + stride, ENC_HEADER_LEN + 2 * stride))
    c1.copy(s, ENC_HEADER_LEN)
    c0.copy(s, ENC_HEADER_LEN + stride)
    writeFileSync(swapped, s)
    await expect(readDecrypted(key, swapped)).rejects.toThrow()

    const other = await encryptedFixture(randomBytes(32), plain)
    await expect(readDecrypted(key, other)).rejects.toThrow()
  })

  it("readEncHeader returns null for a JPEG, a truncated file and version 2", async () => {
    const jpg = tmpFile("photo.jpg")
    writeFileSync(jpg, await sharp({ create: { width: 8, height: 8, channels: 3, background: "#000" } }).jpeg().toBuffer())
    expect(await readEncHeader(jpg)).toBeNull()

    const enc = await encryptedFixture(key, plaintext(1000))
    const truncated = tmpFile("trunc")
    writeFileSync(truncated, readFileSync(enc).subarray(0, -1))
    expect(await readEncHeader(truncated)).toBeNull()

    const v2 = tmpFile("v2")
    const bytes = readFileSync(enc)
    bytes[7] = 2
    writeFileSync(v2, bytes)
    expect(await readEncHeader(v2)).toBeNull()

    const header = await readEncHeader(enc)
    expect(header).toMatchObject({ plainSize: 1000 })
    expect(header!.etag).toMatch(/^[0-9a-f]{32}$/)
  })
})

describe("parseRange (T-4qu-05)", () => {
  const size = 100
  const cases: Array<[string | undefined, number, ReturnType<typeof parseRange>]> = [
    [undefined, size, null],
    ["bytes=0-1", size, { start: 0, end: 1 }],
    ["bytes=5-", size, { start: 5, end: size - 1 }],
    ["bytes=-3", size, { start: size - 3, end: size - 1 }],
    ["bytes=0-99999999", size, { start: 0, end: size - 1 }],
    [`bytes=${size}-`, size, "unsatisfiable"],
    ["bytes=-0", size, "unsatisfiable"],
    ["bytes=0-1", 0, "unsatisfiable"],
    ["bytes=-5", 0, "unsatisfiable"],
    ["bytes=0-1,4-5", size, null],
    ["items=0-1", size, null],
    ["bytes=3-1", size, null],
    ["bytes=x-", size, null],
  ]
  for (const [header, n, expected] of cases) {
    it(`${String(header)} on ${n} bytes -> ${JSON.stringify(expected)}`, () => {
      expect(parseRange(header, n)).toEqual(expected)
    })
  }
})

describe("loadMediaKey (QT-4qu-key, T-4qu-04)", () => {
  it("creates a missing key (mode 600, parent dir created) and reuses it", async () => {
    const dir = mkdtempSync(path.join(scratch, "key-"))
    const keyFile = path.join(dir, "nested", "media.key")
    const first = await loadMediaKey({ keyFile, mediaRoot: path.join(dir, "media") })
    expect(first.created).toBe(true)
    expect(first.key.length).toBe(32)
    const text = readFileSync(keyFile, "utf8")
    expect(text).toMatch(/^[A-Za-z0-9+/]{43}=\n$/)
    expect(statSync(keyFile).mode & 0o777).toBe(0o600)
    const second = await loadMediaKey({ keyFile, mediaRoot: path.join(dir, "media") })
    expect(second.created).toBe(false)
    expect(second.loosePermissions).toBe(false)
    expect(second.key.equals(first.key)).toBe(true)
  })

  it("throws MediaKeyError on a malformed key and leaves it untouched", async () => {
    const dir = mkdtempSync(path.join(scratch, "key-"))
    for (const bad of ["not base64 !!\n", `${randomBytes(16).toString("base64")}\n`, ""]) {
      const keyFile = path.join(dir, `bad-${randomBytes(3).toString("hex")}.key`)
      writeFileSync(keyFile, bad, { mode: 0o600 })
      await expect(loadMediaKey({ keyFile, mediaRoot: path.join(dir, "media") })).rejects.toBeInstanceOf(MediaKeyError)
      expect(readFileSync(keyFile, "utf8")).toBe(bad)
    }
  })

  it("refuses to create a key when encrypted media already exists", async () => {
    const dir = mkdtempSync(path.join(scratch, "key-"))
    const mediaRoot = path.join(dir, "media")
    mkdirSync(path.join(mediaRoot, "x"), { recursive: true })
    writeFileSync(path.join(mediaRoot, "x", "thumb.webp"), encryptBuffer(randomBytes(32), Buffer.from("hello")))
    const keyFile = path.join(dir, "media.key")
    const err = await loadMediaKey({ keyFile, mediaRoot }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(MediaKeyError)
    expect((err as Error).message).toContain(keyFile)
    expect(existsSync(keyFile)).toBe(false)
  })
})

describe("stored variants are encrypted and /media decrypts them (QT-4qu-serve)", () => {
  let t: TestApp
  let cookie: string
  let id: string

  beforeAll(async () => {
    t = await makeTestApp({ seed: true })
    cookie = await loginCookie(t.app, "alice")
    const jpg = await sharp({ create: { width: 900, height: 600, channels: 3, background: "#884422" } }).jpeg().toBuffer()
    id = (await uploadBytes(t.app, cookie, jpg)).id
    await t.app.media.idle()
  })
  afterAll(async () => {
    await t.close()
  })

  it("keeps display.webp and thumb.webp as DUETENC ciphertext on disk", async () => {
    for (const name of ["display.webp", "thumb.webp"]) {
      const file = path.join(t.dataDir, "media", id, name)
      expect(await readEncHeader(file), name).not.toBeNull()
      expect(readFileSync(file).subarray(0, 4).toString("latin1")).not.toBe("RIFF")
    }
    const work = path.join(t.dataDir, "media", "work")
    expect(existsSync(work) ? readdirSync(work) : []).toEqual([])
  })

  it("serves plaintext with ETag, 304, If-Range and HEAD", async () => {
    const url = `/media/${id}/display`
    const full = await t.app.inject({ method: "GET", url, headers: { cookie } })
    expect(full.statusCode).toBe(200)
    expect(full.rawPayload.subarray(0, 4).toString("latin1")).toBe("RIFF")
    const etag = String(full.headers.etag)
    expect(etag).toMatch(/^"[0-9a-f]{32}"$/)
    expect(Number(full.headers["content-length"])).toBe(full.rawPayload.length)

    const notModified = await t.app.inject({ method: "GET", url, headers: { cookie, "if-none-match": etag } })
    expect(notModified.statusCode).toBe(304)
    expect(notModified.rawPayload.length).toBe(0)

    const ranged = await t.app.inject({ method: "GET", url, headers: { cookie, range: "bytes=0-1", "if-range": etag } })
    expect(ranged.statusCode).toBe(206)
    expect(ranged.rawPayload.toString("latin1")).toBe("RI")

    const stale = await t.app.inject({ method: "GET", url, headers: { cookie, range: "bytes=0-1", "if-range": '"other"' } })
    expect(stale.statusCode).toBe(200)
    expect(stale.rawPayload.length).toBe(full.rawPayload.length)

    const head = await t.app.inject({ method: "HEAD", url, headers: { cookie } })
    expect(head.statusCode).toBe(200)
    expect(Number(head.headers["content-length"])).toBe(full.rawPayload.length)
    expect(head.rawPayload.length).toBe(0)
  })

  it("answers 500 media_unreadable for a plaintext variant", async () => {
    const file = path.join(t.dataDir, "media", id, "thumb.webp")
    const saved = readFileSync(file)
    try {
      writeFileSync(file, Buffer.from("RIFF plain bytes"))
      const res = await t.app.inject({ method: "GET", url: `/media/${id}/thumb`, headers: { cookie } })
      expect(res.statusCode).toBe(500)
      expect(res.headers["cache-control"]).toBe("no-store")
      expect(res.json()).toEqual({ error: "media_unreadable" })
    } finally {
      writeFileSync(file, saved)
    }
  })
})
