import { execFileSync } from "node:child_process"
import { randomUUID } from "node:crypto"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import sharp from "sharp"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { eq } from "drizzle-orm"
import { VOICE_WAVEFORM_BARS } from "@duet/shared"
import { attachments } from "../src/db/schema"
import { decryptedCopy, loginCookie, makeTestApp, TEST_ORIGIN, uploadBytes, type TestApp } from "./helpers"

let t: TestApp
let aliceCookie: string
let bobCookie: string
let scratch: string

const QUIET = ["-nostdin", "-hide_banner", "-loglevel", "error", "-y"]

function ffprobe(file: string, entries: string): any {
  return JSON.parse(execFileSync("ffprobe", ["-v", "error", "-show_entries", entries, "-of", "json", file]).toString())
}

/**
 * A Chrome-style recording: Opus in WebM written to a pipe, so the container carries no duration
 * (exactly what MediaRecorder produces).
 */
function webmRecording(seconds: number): Buffer {
  return execFileSync(
    "ffmpeg",
    [...QUIET, "-f", "lavfi", "-i", `sine=frequency=300:duration=${seconds}`, "-c:a", "libopus", "-f", "webm", "pipe:1"],
    { stdio: ["ignore", "pipe", "pipe"], maxBuffer: 64 * 1024 * 1024 },
  )
}

/** An iOS-style recording: AAC in a fragmented MP4 (moov up front without durations). */
function fragmentedMp4Recording(seconds: number): Buffer {
  const file = path.join(scratch, `frag-${randomUUID()}.mp4`)
  execFileSync(
    "ffmpeg",
    [...QUIET, "-f", "lavfi", "-i", `sine=frequency=500:duration=${seconds}`, "-c:a", "aac", "-movflags", "frag_keyframe+empty_moov", "-f", "mp4", file],
    { stdio: ["ignore", "ignore", "pipe"] },
  )
  return readFileSync(file)
}

function row(id: string) {
  return t.app.db.select().from(attachments).where(eq(attachments.id, id)).get()!
}

function send(cookie: string, payload: Record<string, unknown>) {
  return t.app.inject({
    method: "POST",
    url: "/api/messages",
    headers: { cookie, origin: TEST_ORIGIN },
    payload: { id: randomUUID(), ...payload },
  })
}

async function readyVoice(seconds = 1): Promise<string> {
  const { id } = await uploadBytes(t.app, aliceCookie, webmRecording(seconds), "audio")
  await t.app.media.idle()
  return id
}

beforeAll(async () => {
  t = await makeTestApp({ seed: true })
  aliceCookie = await loginCookie(t.app, "alice")
  bobCookie = await loginCookie(t.app, "bob")
  scratch = mkdtempSync(path.join(tmpdir(), "duet-voice-"))
})
afterAll(async () => {
  await t.app.media.idle()
  await t.close()
  rmSync(scratch, { recursive: true, force: true })
})

describe("processAudio through the fast lane (MDIA-04, D-12)", () => {
  it("normalizes a WebM/Opus recording without a container duration to mono AAC .m4a with duration and 40 peaks", async () => {
    const bytes = webmRecording(6)
    const tmp = path.join(scratch, "probe.webm")
    execFileSync("sh", ["-c", 'cat > "$1"', "sh", tmp], { input: bytes })
    expect(ffprobe(tmp, "format=duration").format.duration).toBeUndefined()

    const { id, attachment } = await uploadBytes(t.app, aliceCookie, bytes, "audio")
    expect(attachment.status).toBe("processing")
    await t.app.media.idle()

    const r = row(id)
    expect(r.status).toBe("ready")
    expect(Math.abs(r.durationMs! - 6000)).toBeLessThanOrEqual(150)
    const waveform = JSON.parse(r.waveform!) as number[]
    expect(waveform).toHaveLength(VOICE_WAVEFORM_BARS)
    expect(waveform.every((v) => Number.isInteger(v) && v >= 0 && v <= 100)).toBe(true)
    expect(waveform.some((v) => v > 0)).toBe(true)

    const out = ffprobe(await decryptedCopy(t, path.join(t.dataDir, "media", id, "audio.m4a")), "stream=codec_name,channels")
    expect(out.streams[0]).toMatchObject({ codec_name: "aac", channels: 1 })
  })

  it("normalizes a fragmented MP4/AAC recording with a correct duration", async () => {
    const { id } = await uploadBytes(t.app, aliceCookie, fragmentedMp4Recording(4), "audio")
    await t.app.media.idle()
    const r = row(id)
    expect(r.status).toBe("ready")
    expect(Math.abs(r.durationMs! - 4000)).toBeLessThanOrEqual(150)
    expect(JSON.parse(r.waveform!)).toHaveLength(VOICE_WAVEFORM_BARS)
  })

  it("serves audio.m4a as audio/mp4 with Range", async () => {
    const id = await readyVoice()
    const full = await t.app.inject({ method: "GET", url: `/media/${id}/audio`, headers: { cookie: bobCookie } })
    expect(full.statusCode).toBe(200)
    expect(full.headers["content-type"]).toBe("audio/mp4")
    expect(full.headers["accept-ranges"]).toBe("bytes")
    const ranged = await t.app.inject({ method: "GET", url: `/media/${id}/audio`, headers: { cookie: bobCookie, range: "bytes=0-1" } })
    expect(ranged.statusCode).toBe(206)
    expect(ranged.headers["content-range"]).toMatch(/^bytes 0-1\/\d+$/)
  })
})

describe("audio uploads (D-11 backstop, T-02-30)", () => {
  async function create(size: number) {
    return t.app.inject({
      method: "POST",
      url: "/api/uploads",
      headers: { cookie: aliceCookie, origin: TEST_ORIGIN },
      payload: { kind: "audio", size },
    })
  }

  it("accepts 200 MB and answers 413 too_large one byte above", async () => {
    expect((await create(200 * 1024 * 1024)).statusCode).toBe(200)
    const big = await create(200 * 1024 * 1024 + 1)
    expect(big.statusCode).toBe(413)
    expect(big.json()).toEqual({ error: "too_large" })
  })

  it("answers 422 unsupported_media for formats outside the voice allowlist", async () => {
    const flac = execFileSync("ffmpeg", [...QUIET, "-f", "lavfi", "-i", "sine=duration=1", "-c:a", "flac", "-f", "flac", "pipe:1"], {
      stdio: ["ignore", "pipe", "pipe"],
    })
    const jpeg = await sharp({ create: { width: 8, height: 8, channels: 3, background: "#000" } }).jpeg().toBuffer()
    for (const bytes of [flac, jpeg]) {
      const created = await create(bytes.length)
      const { id } = created.json() as { id: string }
      await t.app.inject({
        method: "PUT",
        url: `/api/uploads/${id}/chunks/0`,
        headers: { cookie: aliceCookie, origin: TEST_ORIGIN, "content-type": "application/octet-stream" },
        payload: bytes,
      })
      const done = await t.app.inject({ method: "POST", url: `/api/uploads/${id}/complete`, headers: { cookie: aliceCookie, origin: TEST_ORIGIN } })
      expect(done.statusCode).toBe(422)
      expect(done.json()).toEqual({ error: "unsupported_media" })
      expect(row(id)).toMatchObject({ status: "failed", error: "unsupported_media" })
    }
  })
})

describe("voice messages (MDIA-04)", () => {
  it("sends exactly one audio attachment without a body as kind voice", async () => {
    const id = await readyVoice()
    const res = await send(aliceCookie, { attachmentIds: [id] })
    expect(res.statusCode).toBe(200)
    const { message } = res.json()
    expect(message.kind).toBe("voice")
    expect(message.body).toBeNull()
    expect(message.attachments).toHaveLength(1)
    expect(message.attachments[0]).toMatchObject({ id, kind: "audio", status: "ready", position: 0 })
    expect(message.attachments[0].waveform).toHaveLength(VOICE_WAVEFORM_BARS)
    expect(message.attachments[0].durationMs).toBeGreaterThan(0)
  })

  it("rejects audio mixed with an image, two audio notes, and audio with a caption", async () => {
    const img = await sharp({ create: { width: 16, height: 16, channels: 3, background: "#123456" } }).jpeg().toBuffer()
    const photo = (await uploadBytes(t.app, aliceCookie, img, "image")).id
    const a1 = await readyVoice()
    const a2 = await readyVoice()
    for (const payload of [
      { attachmentIds: [a1, photo] },
      { attachmentIds: [photo, a1] },
      { attachmentIds: [a1, a2] },
      { attachmentIds: [a1], body: "a caption" },
    ]) {
      const res = await send(aliceCookie, payload)
      expect(res.statusCode).toBe(400)
      expect(res.json()).toEqual({ error: "bad_attachment" })
    }
    // Nothing was attached by the rejected sends: the note can still go out on its own.
    expect((await send(aliceCookie, { attachmentIds: [a1] })).json().message.kind).toBe("voice")
  })
})
