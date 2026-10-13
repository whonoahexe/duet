import { MediaError, runTool } from "./exec"

/**
 * ffprobe gate for uploaded video and audio (MDIA-03, MDIA-04, T-02-30, research Pitfall 7).
 *
 * A crafted "video" can be an HLS or concat playlist that makes ffmpeg read local files or URLs.
 * Three layers keep that from happening:
 * - ffprobe itself only opens the file with the `file` protocol and only with the demuxers on the
 *   allowlist (-format_whitelist), so a playlist demuxer never even starts while probing;
 * - the probed format_name must be exactly one of the allowlisted demuxer names;
 * - ffmpeg is then run with an explicit -f for that demuxer (see inputFormatFor), never a guess.
 */

/** ffprobe format_name values accepted for video clips (D-08): MP4/MOV family and Matroska/WebM. */
export const VIDEO_FORMATS: readonly string[] = ["mov,mp4,m4a,3gp,3g2,mj2", "matroska,webm"]

/**
 * format_name values accepted for voice notes (D-12): the video containers (iOS records audio/mp4,
 * Chrome audio/webm) plus plain audio files.
 */
export const VOICE_FORMATS: readonly string[] = [...VIDEO_FORMATS, "ogg", "wav", "mp3", "aac"]

/** The -f value that opens each allowlisted format_name with its own demuxer. */
const INPUT_FORMAT: Readonly<Record<string, string>> = {
  "mov,mp4,m4a,3gp,3g2,mj2": "mov",
  "matroska,webm": "matroska",
  ogg: "ogg",
  wav: "wav",
  mp3: "mp3",
  aac: "aac",
}

/** Demuxers ffprobe may open at all (short names; the mov demuxer matches "mov"). */
const PROBE_WHITELIST = Object.values(INPUT_FORMAT).join(",")

/** ffprobe's own budget: it reads headers only, so anything slow is a hostile file. */
const PROBE_TIMEOUT_MS = 30_000
/** Most ffprobe JSON kept (a normal answer is well under 2 KB). */
const PROBE_STDOUT_MAX = 256 * 1024

export interface ProbeStream {
  codecType: string | null
  codecName: string | null
  width: number | null
  height: number | null
  /** e.g. "arib-std-b67" (HLG), "smpte2084" (PQ), "bt709". */
  colorTransfer: string | null
}

export interface ProbeResult {
  /** ffprobe's format_name, e.g. "mov,mp4,m4a,3gp,3g2,mj2". */
  formatName: string
  /** Container duration in ms, or null when the container does not say (MediaRecorder WebM). */
  durationMs: number | null
  streams: ProbeStream[]
}

interface RawProbe {
  format?: { format_name?: unknown; duration?: unknown }
  streams?: Array<Record<string, unknown>>
}

function str(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null
}

function int(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? Math.round(v) : null
}

/**
 * Probe a server-built path with ffprobe (format_name, duration and per-stream codec_type,
 * codec_name, width, height, color_transfer). Anything ffprobe cannot open with an allowlisted
 * demuxer (a playlist, a photo, junk bytes) rejects with MediaError("unsupported_media").
 */
export async function probeMedia(path: string): Promise<ProbeResult> {
  const chunks: Buffer[] = []
  let size = 0
  await runTool(
    "ffprobe",
    [
      "-v",
      "error",
      "-protocol_whitelist",
      "file",
      "-format_whitelist",
      PROBE_WHITELIST,
      "-show_entries",
      "format=format_name,duration:stream=codec_type,codec_name,width,height,color_transfer",
      "-of",
      "json",
      path,
    ],
    {
      timeoutMs: PROBE_TIMEOUT_MS,
      failCode: "unsupported_media",
      onStdout: (chunk) => {
        size += chunk.length
        if (size > PROBE_STDOUT_MAX) throw new MediaError("unsupported_media", "ffprobe output too large")
        chunks.push(chunk)
      },
    },
  )
  let raw: RawProbe
  try {
    raw = JSON.parse(Buffer.concat(chunks).toString("utf8")) as RawProbe
  } catch {
    throw new MediaError("unsupported_media", "ffprobe printed no JSON")
  }
  const formatName = str(raw.format?.format_name)
  if (!formatName) throw new MediaError("unsupported_media", "no format_name")
  const seconds = Number(raw.format?.duration)
  return {
    formatName,
    durationMs: Number.isFinite(seconds) && seconds > 0 ? Math.round(seconds * 1000) : null,
    streams: (raw.streams ?? []).map((s) => ({
      codecType: str(s.codec_type),
      codecName: str(s.codec_name),
      width: int(s.width),
      height: int(s.height),
      colorTransfer: str(s.color_transfer),
    })),
  }
}

/**
 * The -f value for a probed file when its format is in `allowed`, else MediaError("unsupported_media").
 * Callers always pass the result to ffmpeg as an explicit input format.
 */
export function inputFormatFor(probe: ProbeResult, allowed: readonly string[]): string {
  const fmt = allowed.includes(probe.formatName) ? INPUT_FORMAT[probe.formatName] : undefined
  if (!fmt) throw new MediaError("unsupported_media", `format ${probe.formatName} is not allowlisted`)
  return fmt
}
