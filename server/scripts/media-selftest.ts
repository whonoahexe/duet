// Container media toolchain self-test (plans 02-04, 02-05; MDIA-01, MDIA-03, MDIA-04): proves the
// image's ffmpeg/ffprobe, sharp and (when present) heif-convert handle what the phones send, by
// pushing generated media through the real pipeline code:
// - a JPEG and an HEVC HEIC through processImage ("jpeg ok", "heic ok");
// - a rotated 10-bit HLG HEVC clip through processVideo: H.264, bt709, portrait, faststart, poster
//   ("video ok");
// - a WebM/Opus recording through processAudio: AAC, duration, 40 peaks ("voice ok").
// Works in a fresh temp dir and never touches DATA_DIR.
//
//   node --import tsx server/scripts/media-selftest.ts
//   docker compose exec -T duet node --import tsx server/scripts/media-selftest.ts
//
// Each check prints exactly "<name> ok" (details go on a separate "  ..." line) and "media-selftest ok"
// comes last; exits 1 on failure.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import sharp from "sharp"
import { VOICE_WAVEFORM_BARS } from "@duet/shared"
import { processAudio } from "../src/media/audio"
import { hasTool, runTool } from "../src/media/exec"
import { DISPLAY_EDGE, THUMB_EDGE, processImage } from "../src/media/image"
import { probeMedia } from "../src/media/probe"
import { VIDEO_EDGE, processVideo } from "../src/media/video"

const QUIET = ["-nostdin", "-hide_banner", "-loglevel", "error", "-y"]

function fail(message: string): never {
  console.error(`media-selftest: ${message}`)
  process.exit(1)
}

/** Run processImage on `source` into a fresh dir and check both variants. */
async function check(label: string, source: string, root: string, maxDisplayEdge: number): Promise<void> {
  const out = path.join(root, `${label}-out`)
  mkdirSync(out)
  const result = await processImage(source, out)
  for (const [file, edge] of [
    ["display.webp", maxDisplayEdge],
    ["thumb.webp", THUMB_EDGE],
  ] as const) {
    const target = path.join(out, file)
    if (!existsSync(target)) fail(`${label}: ${file} was not written`)
    const meta = await sharp(target).metadata()
    if (meta.format !== "webp") fail(`${label}: ${file} is ${meta.format}, not webp`)
    const longEdge = Math.max(meta.width ?? 0, meta.height ?? 0)
    if (longEdge === 0 || longEdge > edge) fail(`${label}: ${file} long edge ${longEdge} exceeds ${edge}`)
    if (meta.exif) fail(`${label}: ${file} still carries EXIF`)
  }
  console.log(`${label} ok`)
  console.log(`  display ${result.width}x${result.height}`)
}

/**
 * The iPhone worst case (MDIA-03, Pitfall 6): 3 s of 1920x1080 10-bit HEVC tagged HLG, held upright
 * (90-degree display matrix), with AAC sound -> processVideo -> H.264 bt709 portrait, faststart.
 */
async function checkVideo(root: string): Promise<void> {
  const hlg = path.join(root, "hlg.mov")
  await runTool(
    "ffmpeg",
    [
      ...QUIET,
      "-f", "lavfi", "-i", "testsrc2=size=1920x1080:rate=30",
      "-f", "lavfi", "-i", "sine=frequency=440",
      "-t", "3",
      "-c:v", "libx265", "-pix_fmt", "yuv420p10le",
      "-x265-params", "log-level=error:colorprim=bt2020:transfer=arib-std-b67:colormatrix=bt2020nc",
      "-color_primaries", "bt2020", "-color_trc", "arib-std-b67", "-colorspace", "bt2020nc",
      "-tag:v", "hvc1", "-c:a", "aac", hlg,
    ],
    { timeoutMs: 120_000 },
  )
  const rotated = path.join(root, "hlg-rotated.mov")
  try {
    // ffmpeg 6.1+ spelling.
    await runTool("ffmpeg", [...QUIET, "-display_rotation", "90", "-i", hlg, "-c", "copy", rotated], { timeoutMs: 60_000 })
  } catch {
    // ffmpeg 5.1 (the container's Debian 12 build) writes the display matrix from the rotate tag.
    await runTool("ffmpeg", [...QUIET, "-i", hlg, "-c", "copy", "-metadata:s:v:0", "rotate=90", rotated], { timeoutMs: 60_000 })
  }
  const source = await probeMedia(rotated)
  const sourceVideo = source.streams.find((s) => s.codecType === "video")
  if (sourceVideo?.codecName !== "hevc" || sourceVideo.colorTransfer !== "arib-std-b67") {
    fail(`video: fixture is ${sourceVideo?.codecName}/${sourceVideo?.colorTransfer}, expected hevc/arib-std-b67`)
  }

  const out = path.join(root, "video-out")
  mkdirSync(out)
  const result = await processVideo(rotated, out, source)
  const mp4 = path.join(out, "video.mp4")
  const probe = await probeMedia(mp4)
  const v = probe.streams.find((s) => s.codecType === "video")
  if (v?.codecName !== "h264") fail(`video: codec ${v?.codecName}, expected h264`)
  if (v.colorTransfer !== "bt709") fail(`video: color_transfer ${v.colorTransfer}, expected bt709`)
  if (!(result.height > result.width)) fail(`video: ${result.width}x${result.height} is not portrait`)
  if (Math.max(result.width, result.height) > VIDEO_EDGE) fail(`video: long edge over ${VIDEO_EDGE}`)
  if (!probe.streams.some((s) => s.codecType === "audio" && s.codecName === "aac")) fail("video: no AAC audio")
  const bytes = readFileSync(mp4)
  const moov = bytes.indexOf("moov")
  const mdat = bytes.indexOf("mdat")
  if (moov < 0 || mdat < 0 || moov > mdat) fail(`video: moov at ${moov}, mdat at ${mdat} (not faststart)`)
  if (!existsSync(path.join(out, "poster.jpg"))) fail("video: poster.jpg was not written")
  const poster = await sharp(path.join(out, "poster.jpg")).metadata()
  if (poster.format !== "jpeg" || Math.max(poster.width ?? 0, poster.height ?? 0) > 640) fail("video: bad poster")
  console.log("video ok")
  console.log(`  ${result.width}x${result.height} h264 bt709, ${result.durationMs} ms, moov@${moov} < mdat@${mdat}`)
}

/** A Chrome-style recording (MDIA-04, D-12): 3 s WebM/Opus -> processAudio -> AAC .m4a + waveform. */
async function checkVoice(root: string): Promise<void> {
  const webm = path.join(root, "voice.webm")
  await runTool(
    "ffmpeg",
    [...QUIET, "-f", "lavfi", "-i", "sine=frequency=300:duration=3", "-c:a", "libopus", "-f", "webm", webm],
    { timeoutMs: 60_000 },
  )
  const out = path.join(root, "voice-out")
  mkdirSync(out)
  const result = await processAudio(webm, out, await probeMedia(webm))
  const probe = await probeMedia(path.join(out, "audio.m4a"))
  const a = probe.streams.find((s) => s.codecType === "audio")
  if (a?.codecName !== "aac") fail(`voice: codec ${a?.codecName}, expected aac`)
  if (Math.abs(result.durationMs - 3000) > 150) fail(`voice: duration ${result.durationMs} ms, expected about 3000`)
  if (result.waveform.length !== VOICE_WAVEFORM_BARS) fail(`voice: ${result.waveform.length} waveform values`)
  if (!result.waveform.some((x) => x > 0)) fail("voice: the waveform is flat")
  console.log("voice ok")
  console.log(`  aac ${result.durationMs} ms, peaks ${result.waveform.slice(0, 8).join(",")}...`)
}

const root = mkdtempSync(path.join(tmpdir(), "duet-media-selftest-"))
try {
  if (!(await hasTool("ffmpeg"))) fail("ffmpeg is not on PATH")
  const jpg = path.join(root, "source.jpg")
  await runTool(
    "ffmpeg",
    ["-nostdin", "-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "testsrc=size=2000x1500", "-frames:v", "1", jpg],
    { timeoutMs: 60_000 },
  )
  // A 2000 px source is never enlarged: its display copy keeps a 2000 px long edge.
  await check("jpeg", jpg, root, Math.min(2000, DISPLAY_EDGE))

  if (await hasTool("heif-enc")) {
    if (!(await hasTool("heif-convert"))) fail("heif-enc exists but heif-convert does not")
    const heic = path.join(root, "source.heic")
    await runTool("heif-enc", ["-q", "80", "-o", heic, jpg], { timeoutMs: 120_000 })
    const meta = await sharp(heic).metadata()
    if (meta.format !== "heif" || meta.compression !== "hevc") {
      fail(`heif-enc wrote ${meta.format}/${meta.compression}, expected heif/hevc`)
    }
    await check("heic", heic, root, Math.min(2000, DISPLAY_EDGE))
  } else {
    console.log("heic skipped (no heif-enc)")
  }
  if (!(await hasTool("ffprobe"))) fail("ffprobe is not on PATH")
  await checkVideo(root)
  await checkVoice(root)
  console.log("media-selftest ok")
} catch (err) {
  fail(err instanceof Error ? `${err.message}${"detail" in err && err.detail ? ` (${String(err.detail)})` : ""}` : String(err))
} finally {
  rmSync(root, { recursive: true, force: true })
}
