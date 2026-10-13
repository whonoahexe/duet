import { execFileSync } from "node:child_process"
import { randomUUID } from "node:crypto"
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import sharp from "sharp"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { eq } from "drizzle-orm"
import { formatDuration } from "@duet/shared"
import { attachments } from "../src/db/schema"
import { MediaError } from "../src/media/exec"
import { VIDEO_FORMATS, inputFormatFor, probeMedia } from "../src/media/probe"
import { loginCookie, makeTestApp, TEST_ORIGIN, uploadBytes, type TestApp } from "./helpers"

let t: TestApp
let aliceCookie: string
let bobCookie: string
let scratch: string

const QUIET = ["-nostdin", "-hide_banner", "-loglevel", "error", "-y"]

/** Run the host ffmpeg (fixtures only; the server always goes through runTool). */
function ffmpeg(args: string[]): void {
  execFileSync("ffmpeg", [...QUIET, ...args], { stdio: ["ignore", "ignore", "pipe"] })
}

/** ffprobe JSON of one file, any entries. */
function ffprobe(file: string, entries: string): any {
  return JSON.parse(execFileSync("ffprobe", ["-v", "error", "-show_entries", entries, "-of", "json", file]).toString())
}

function hostHas(listFlag: "-encoders" | "-filters", name: string): boolean {
  try {
    const out = execFileSync("ffmpeg", ["-hide_banner", listFlag], { stdio: ["ignore", "pipe", "ignore"] }).toString()
    return new RegExp(`\\s${name}\\s`).test(out)
  } catch {
    return false
  }
}

/** The host ffmpeg can build and tone-map the 10-bit HLG fixture (the container always can). */
const hdrTools = hostHas("-encoders", "libx265") && hostHas("-filters", "zscale") && hostHas("-filters", "tonemap")

function fixture(name: string): string {
  return path.join(scratch, name)
}

/** A testsrc + sine H.264/AAC MP4. */
function mp4(name: string, opts: { size?: string; seconds?: number; rate?: number } = {}): string {
  const file = fixture(name)
  const { size = "320x240", seconds = 2, rate = 25 } = opts
  ffmpeg([
    "-f", "lavfi", "-i", `testsrc=size=${size}:rate=${rate}`,
    "-f", "lavfi", "-i", "sine=frequency=440",
    "-t", String(seconds), "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-c:a", "aac", file,
  ])
  return file
}

function upload(cookie: string, bytes: Buffer, kind = "video") {
  return uploadBytes(t.app, cookie, bytes, kind as "video")
}

/** Create + chunks + complete without the helper's 200 assertion on complete. */
async function uploadRaw(cookie: string, bytes: Buffer, kind: string) {
  const created = await t.app.inject({
    method: "POST",
    url: "/api/uploads",
    headers: { cookie, origin: TEST_ORIGIN },
    payload: { kind, size: bytes.length },
  })
  expect(created.statusCode).toBe(200)
  const { id } = created.json() as { id: string }
  const put = await t.app.inject({
    method: "PUT",
    url: `/api/uploads/${id}/chunks/0`,
    headers: { cookie, origin: TEST_ORIGIN, "content-type": "application/octet-stream" },
    payload: bytes,
  })
  expect(put.statusCode).toBe(204)
  const done = await t.app.inject({ method: "POST", url: `/api/uploads/${id}/complete`, headers: { cookie, origin: TEST_ORIGIN } })
  return { id, done }
}

function row(id: string) {
  return t.app.db.select().from(attachments).where(eq(attachments.id, id)).get()!
}

function mediaDir(id: string): string {
  return path.join(t.dataDir, "media", id)
}

beforeAll(async () => {
  t = await makeTestApp({ seed: true })
  aliceCookie = await loginCookie(t.app, "alice")
  bobCookie = await loginCookie(t.app, "bob")
  scratch = mkdtempSync(path.join(tmpdir(), "duet-video-"))
})
afterAll(async () => {
  await t.app.media.idle()
  await t.close()
  rmSync(scratch, { recursive: true, force: true })
})

describe("probeMedia (T-02-30)", () => {
  it("reads format_name, duration and streams of an H.264 MP4", async () => {
    const probe = await probeMedia(mp4("probe.mp4", { seconds: 2 }))
    expect(probe.formatName).toContain("mp4")
    expect(VIDEO_FORMATS).toContain(probe.formatName)
    expect(inputFormatFor(probe, VIDEO_FORMATS)).toBe("mov")
    expect(Math.abs(probe.durationMs! - 2000)).toBeLessThan(100)
    expect(probe.streams.find((s) => s.codecType === "video")).toMatchObject({ codecName: "h264", width: 320, height: 240 })
    expect(probe.streams.some((s) => s.codecType === "audio")).toBe(true)
  })

  it("refuses an HLS playlist and an ffconcat file named like videos", async () => {
    const hls = fixture("playlist.mp4")
    writeFileSync(hls, "#EXTM3U\n#EXT-X-TARGETDURATION:10\n#EXTINF:10,\nfile:///etc/passwd\n#EXT-X-ENDLIST\n")
    const concat = fixture("concat.mov")
    writeFileSync(concat, "ffconcat version 1.0\nfile /etc/passwd\n")
    for (const file of [hls, concat]) {
      const err = await probeMedia(file).catch((e: unknown) => e)
      expect(err).toBeInstanceOf(MediaError)
      expect((err as MediaError).code).toBe("unsupported_media")
    }
  })

  it("rejects a probed format outside the allowlist", () => {
    expect(() => inputFormatFor({ formatName: "hls", durationMs: null, streams: [] }, VIDEO_FORMATS)).toThrow(MediaError)
    expect(() => inputFormatFor({ formatName: "ogg", durationMs: 1, streams: [] }, VIDEO_FORMATS)).toThrow(MediaError)
  })
})

describe("video uploads (MDIA-03, D-08)", () => {
  async function create(size: number) {
    return t.app.inject({
      method: "POST",
      url: "/api/uploads",
      headers: { cookie: aliceCookie, origin: TEST_ORIGIN },
      payload: { kind: "video", size },
    })
  }

  it("accepts a video up to 200 MB and answers 413 too_large above", async () => {
    expect((await create(200 * 1024 * 1024)).statusCode).toBe(200)
    const big = await create(200 * 1024 * 1024 + 1)
    expect(big.statusCode).toBe(413)
    expect(big.json()).toEqual({ error: "too_large" })
  })

  it("answers 422 unsupported_media for a playlist and never processes it", async () => {
    const bytes = Buffer.from("#EXTM3U\n#EXT-X-TARGETDURATION:10\n#EXTINF:10,\nfile:///etc/passwd\n#EXT-X-ENDLIST\n")
    const { id, done } = await uploadRaw(aliceCookie, bytes, "video")
    expect(done.statusCode).toBe(422)
    expect(done.json()).toEqual({ error: "unsupported_media" })
    expect(row(id)).toMatchObject({ status: "failed", error: "unsupported_media" })
    await t.app.media.idle()
    expect(existsSync(mediaDir(id))).toBe(false)
    // A repeated complete gives the same answer.
    const again = await t.app.inject({ method: "POST", url: `/api/uploads/${id}/complete`, headers: { cookie: aliceCookie, origin: TEST_ORIGIN } })
    expect(again.statusCode).toBe(422)
    expect(again.json()).toEqual({ error: "unsupported_media" })
  })

  it("answers 422 too_long for a clip over 200 s and fails the attachment", async () => {
    const long = mp4("long.mp4", { size: "64x64", seconds: 210, rate: 1 })
    const { id, done } = await uploadRaw(aliceCookie, readFileSync(long), "video")
    expect(done.statusCode).toBe(422)
    expect(done.json()).toEqual({ error: "too_long" })
    expect(row(id)).toMatchObject({ status: "failed", error: "too_long" })
  })
})

describe("processVideo through the slow lane (MDIA-03, D-08)", () => {
  let id: string
  let original: Buffer
  const SOURCE_MS = 2000

  beforeAll(async () => {
    const base = mp4("landscape.mp4", { size: "1920x1080", seconds: SOURCE_MS / 1000, rate: 30 })
    const rotated = fixture("rotated.mp4")
    // A phone held upright records landscape pixels plus a 90-degree display matrix.
    ffmpeg(["-display_rotation", "90", "-i", base, "-c", "copy", rotated])
    expect(ffprobe(rotated, "stream_side_data=rotation").streams[0].side_data_list[0].rotation).toBe(90)
    original = readFileSync(rotated)
    const up = await upload(aliceCookie, original)
    expect(up.attachment.status).toBe("processing")
    id = up.id
    await t.app.media.idle()
  })

  it("writes an upright H.264 High / AAC faststart MP4 with no rotation side data", async () => {
    expect(row(id)).toMatchObject({ status: "ready", error: null, width: 720, height: 1280 })
    const file = path.join(mediaDir(id), "video.mp4")
    const info = ffprobe(file, "stream=codec_type,codec_name,profile,width,height,channels:stream_side_data=rotation")
    const v = info.streams.find((s: any) => s.codec_type === "video")
    const a = info.streams.find((s: any) => s.codec_type === "audio")
    expect(v).toMatchObject({ codec_name: "h264", profile: "High", width: 720, height: 1280 })
    expect(v.side_data_list ?? []).toEqual([])
    expect(a).toMatchObject({ codec_name: "aac", channels: 2 })
    const bytes = readFileSync(file)
    expect(bytes.indexOf("moov")).toBeGreaterThan(0)
    expect(bytes.indexOf("moov")).toBeLessThan(bytes.indexOf("mdat"))
  })

  it("records durationMs within 100 ms of the source and writes a poster of at most 640 px", async () => {
    expect(Math.abs(row(id).durationMs! - SOURCE_MS)).toBeLessThan(100)
    const poster = await sharp(path.join(mediaDir(id), "poster.jpg")).metadata()
    expect(poster.format).toBe("jpeg")
    expect(Math.max(poster.width!, poster.height!)).toBeLessThanOrEqual(640)
    expect(poster.height!).toBeGreaterThan(poster.width!)
  })

  it("keeps the original byte-identical and serves video and poster with Range", async () => {
    expect(readFileSync(path.join(mediaDir(id), "original")).equals(original)).toBe(true)
    const ranged = await t.app.inject({ method: "GET", url: `/media/${id}/video`, headers: { cookie: bobCookie, range: "bytes=0-1" } })
    expect(ranged.statusCode).toBe(206)
    expect(ranged.headers["content-type"]).toBe("video/mp4")
    expect(ranged.headers["content-range"]).toMatch(/^bytes 0-1\/\d+$/)
    const poster = await t.app.inject({ method: "GET", url: `/media/${id}/poster`, headers: { cookie: bobCookie } })
    expect(poster.statusCode).toBe(200)
    expect(poster.headers["content-type"]).toBe("image/jpeg")
  })

  it.skipIf(!hdrTools)("tone-maps 10-bit HLG HEVC to bt709 (Pitfall 6)", async () => {
    const hlg = fixture("hlg.mov")
    ffmpeg([
      "-f", "lavfi", "-i", "testsrc2=size=1280x720:rate=30", "-t", "1",
      "-c:v", "libx265", "-pix_fmt", "yuv420p10le",
      "-x265-params", "log-level=error:colorprim=bt2020:transfer=arib-std-b67:colormatrix=bt2020nc",
      "-color_primaries", "bt2020", "-color_trc", "arib-std-b67", "-colorspace", "bt2020nc", "-tag:v", "hvc1", hlg,
    ])
    expect(ffprobe(hlg, "stream=color_transfer").streams[0].color_transfer).toBe("arib-std-b67")
    const up = await upload(aliceCookie, readFileSync(hlg))
    await t.app.media.idle()
    expect(row(up.id).status).toBe("ready")
    const v = ffprobe(path.join(mediaDir(up.id), "video.mp4"), "stream=codec_name,color_transfer").streams[0]
    expect(v).toMatchObject({ codec_name: "h264", color_transfer: "bt709" })
  })

  it("marks a clip ffmpeg cannot decode as failed with transcode_failed", async () => {
    // A faststart MP4 (moov first) whose media data is all zeros: it probes as a normal MP4, so it
    // passes the gate, but no frame decodes and ffmpeg exits non-zero.
    const file = fixture("zeroed.mp4")
    ffmpeg([
      "-f", "lavfi", "-i", "testsrc=size=320x240:rate=25", "-t", "1",
      "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-movflags", "+faststart", file,
    ])
    const bytes = readFileSync(file)
    const mdat = bytes.indexOf("mdat")
    expect(mdat).toBeGreaterThan(bytes.indexOf("moov"))
    bytes.fill(0, mdat + 4)
    const up = await upload(aliceCookie, bytes)
    expect(up.attachment.status).toBe("processing")
    await t.app.media.idle()
    expect(row(up.id)).toMatchObject({ status: "failed", error: "transcode_failed" })
    expect(existsSync(path.join(mediaDir(up.id), "video.mp4"))).toBe(false)
    expect(existsSync(path.join(mediaDir(up.id), "poster.jpg"))).toBe(false)
  })
})

describe("mixed albums (D-07)", () => {
  it("sends one image and one video as kind media, in order", async () => {
    const img = await sharp({ create: { width: 64, height: 48, channels: 3, background: "#336699" } }).jpeg().toBuffer()
    const photo = await upload(aliceCookie, img, "image")
    const clip = await upload(aliceCookie, readFileSync(mp4("mixed.mp4", { seconds: 1 })))
    const res = await t.app.inject({
      method: "POST",
      url: "/api/messages",
      headers: { cookie: aliceCookie, origin: TEST_ORIGIN },
      payload: { id: randomUUID(), body: "both", attachmentIds: [photo.id, clip.id] },
    })
    expect(res.statusCode).toBe(200)
    const { message } = res.json()
    expect(message.kind).toBe("media")
    expect(message.attachments.map((a: any) => [a.id, a.kind, a.position])).toEqual([
      [photo.id, "image", 0],
      [clip.id, "video", 1],
    ])
    await t.app.media.idle()
  })
})

describe("formatDuration (UI-SPEC, D-11)", () => {
  it("formats m:ss under an hour and h:mm:ss from an hour on", () => {
    expect(formatDuration(0)).toBe("0:00")
    expect(formatDuration(42_900)).toBe("0:42")
    expect(formatDuration(599_000)).toBe("9:59")
    expect(formatDuration(3_599_999)).toBe("59:59")
    expect(formatDuration(3_600_000)).toBe("1:00:00")
    expect(formatDuration(3_725_000)).toBe("1:02:05")
    expect(formatDuration(Number.NaN)).toBe("0:00")
    expect(formatDuration(-5)).toBe("0:00")
  })
})
