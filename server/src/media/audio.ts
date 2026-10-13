import { rename, rm } from "node:fs/promises"
import path from "node:path"
import { VOICE_WAVEFORM_BARS } from "@duet/shared"
import { MediaError, runTool } from "./exec"
import { VOICE_FORMATS, inputFormatFor, probeMedia, type ProbeResult } from "./probe"

/** Even an hour-long note encodes in a fraction of this; past it the job is killed (T-02-31). */
export const AUDIO_TIMEOUT_MS = 5 * 60 * 1000
/** The waveform is computed from mono PCM at this rate (research Pattern 6). */
const PEAK_SAMPLE_RATE = 8000

const BASE_ARGS = ["-nostdin", "-hide_banner", "-loglevel", "error", "-y", "-protocol_whitelist", "file"]

export interface AudioResult {
  /** From ffprobe on audio.m4a, never the input (MediaRecorder WebM reports no duration). */
  durationMs: number
  /** VOICE_WAVEFORM_BARS integers 0..100: the loudest sample of each slice, scaled to the loudest slice. */
  waveform: number[]
}

/**
 * Voice note (MDIA-04, D-12, research Pattern 6): whatever the phone recorded (iOS audio/mp4 AAC,
 * Chrome audio/webm Opus) -> audio.m4a, AAC 64 kbps mono with faststart, so both phones play it and
 * seek through Range. Returns the output's duration and a 40-bar waveform. The original is kept.
 */
export async function processAudio(originalPath: string, outDir: string, probe: ProbeResult): Promise<AudioResult> {
  const inputFormat = inputFormatFor(probe, VOICE_FORMATS)
  if (!probe.streams.some((s) => s.codecType === "audio")) throw new MediaError("unsupported_media", "no audio stream")

  const target = path.join(outDir, "audio.m4a")
  const tmp = path.join(outDir, ".audio.tmp.m4a")
  try {
    await runTool(
      "ffmpeg",
      [
        ...BASE_ARGS,
        "-f",
        inputFormat,
        "-i",
        originalPath,
        "-map",
        "0:a:0",
        "-vn",
        "-map_metadata",
        "-1",
        "-c:a",
        "aac",
        "-b:a",
        "64k",
        "-ac",
        "1",
        "-movflags",
        "+faststart",
        "-f",
        "ipod",
        tmp,
      ],
      { timeoutMs: AUDIO_TIMEOUT_MS, failCode: "transcode_failed" },
    )
    const out = await probeMedia(tmp)
    if (out.durationMs === null) throw new MediaError("transcode_failed", "audio.m4a has no duration")
    const waveform = await peaks(tmp, out.durationMs)
    await rename(tmp, target)
    return { durationMs: out.durationMs, waveform }
  } catch (err) {
    await Promise.all([tmp, target].map((f) => rm(f, { force: true })))
    throw err
  }
}

/**
 * Decode `file` to 8 kHz mono s16le on stdout and fold it into VOICE_WAVEFORM_BARS buckets as it
 * streams (an hour-long note is never held in memory). The bucket of a sample comes from its index
 * against the expected sample count; the last bucket absorbs any overshoot.
 */
async function peaks(file: string, durationMs: number): Promise<number[]> {
  const bars = VOICE_WAVEFORM_BARS
  const expected = Math.max(1, Math.round((durationMs / 1000) * PEAK_SAMPLE_RATE))
  const max = new Array<number>(bars).fill(0)
  let index = 0
  let carry: Buffer | null = null

  await runTool(
    "ffmpeg",
    [...BASE_ARGS, "-f", "mov", "-i", file, "-vn", "-ac", "1", "-ar", String(PEAK_SAMPLE_RATE), "-f", "s16le", "-"],
    {
      timeoutMs: AUDIO_TIMEOUT_MS,
      failCode: "transcode_failed",
      onStdout: (chunk) => {
        let buf = chunk
        if (carry) {
          buf = Buffer.concat([carry, chunk])
          carry = null
        }
        const usable = buf.length - (buf.length % 2)
        for (let off = 0; off < usable; off += 2) {
          const v = Math.abs(buf.readInt16LE(off))
          const b = Math.min(bars - 1, Math.floor((index * bars) / expected))
          if (v > max[b]) max[b] = v
          index++
        }
        if (usable < buf.length) carry = buf.subarray(usable)
      },
    },
  )

  const loudest = Math.max(...max)
  if (loudest === 0) return max.map(() => 0)
  return max.map((v) => Math.round((v / loudest) * 100))
}
