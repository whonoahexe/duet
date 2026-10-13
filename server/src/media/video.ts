import { rename, rm } from "node:fs/promises"
import path from "node:path"
import { VIDEO_MAX_DURATION_MS } from "@duet/shared"
import { MediaError, runTool } from "./exec"
import { VIDEO_FORMATS, inputFormatFor, probeMedia, type ProbeResult } from "./probe"

/** A 3-minute 4K HEVC clip transcodes in well under this on the box; past it the job is killed. */
export const VIDEO_TIMEOUT_MS = 15 * 60 * 1000
/** Poster frames are one decode + one JPEG encode. */
const POSTER_TIMEOUT_MS = 60_000
/** Long edge of the transcoded video (D-08). */
export const VIDEO_EDGE = 1280
/** Long edge of the poster (album tiles use the same 640 px as photo thumbnails). */
export const POSTER_EDGE = 640

/** HLG and PQ need tone mapping, or an 8-bit H.264 copy keeps the HDR tag and looks washed out (Pitfall 6). */
const HDR_TRANSFERS = new Set(["arib-std-b67", "smpte2084"])
const TONEMAP_CHAIN =
  "zscale=t=linear:npl=100,format=gbrpf32le,zscale=p=bt709,tonemap=tonemap=hable:desat=0,zscale=t=bt709:m=bt709:r=tv,"
const SCALE_CHAIN = `scale=w='min(${VIDEO_EDGE},iw)':h='min(${VIDEO_EDGE},ih)':force_original_aspect_ratio=decrease:force_divisible_by=2,format=yuv420p`

/** Common ffmpeg flags: no stdin, quiet, overwrite, local files only (T-02-30). */
const BASE_ARGS = ["-nostdin", "-hide_banner", "-loglevel", "error", "-y", "-protocol_whitelist", "file"]

export interface VideoResult {
  /** Size of video.mp4 (after autorotation). */
  width: number
  height: number
  durationMs: number
}

/**
 * Original clip -> video.mp4 + poster.jpg in outDir (MDIA-03, D-08, research Pattern 6):
 * - H.264 High (libx264 veryfast CRF 23) + AAC 128 kbps stereo, at most 1280 px on the long side,
 *   yuv420p, faststart (moov before mdat) so both phones can start playing before the end arrives;
 * - autorotated (ffmpeg applies the display matrix, the output carries none);
 * - HLG/PQ HDR (iPhone 10-bit HEVC) tone-mapped to bt709;
 * - no container metadata (-map_metadata -1: an iPhone .MOV carries the recording location);
 * - poster.jpg from video.mp4 at min(0.5 s, half the clip), at most 640 px.
 * The input is opened with the explicit demuxer of its allowlisted format; the original is kept
 * (planner resolution of research Open Q1). Outputs are written to temp names and renamed.
 */
export async function processVideo(originalPath: string, outDir: string, probe: ProbeResult): Promise<VideoResult> {
  const inputFormat = inputFormatFor(probe, VIDEO_FORMATS)
  const video = probe.streams.find((s) => s.codecType === "video")
  if (!video) throw new MediaError("unsupported_media", "no video stream")
  const hdr = video.colorTransfer !== null && HDR_TRANSFERS.has(video.colorTransfer)

  const target = path.join(outDir, "video.mp4")
  const poster = path.join(outDir, "poster.jpg")
  const tmpVideo = path.join(outDir, ".video.tmp.mp4")
  const tmpPoster = path.join(outDir, ".poster.tmp.jpg")
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
        "0:v:0",
        "-map",
        "0:a:0?",
        "-map_metadata",
        "-1",
        "-map_chapters",
        "-1",
        "-vf",
        `${hdr ? TONEMAP_CHAIN : ""}${SCALE_CHAIN}`,
        "-c:v",
        "libx264",
        "-preset",
        "veryfast",
        "-crf",
        "23",
        "-profile:v",
        "high",
        "-c:a",
        "aac",
        "-b:a",
        "128k",
        "-ac",
        "2",
        "-movflags",
        "+faststart",
        "-f",
        "mp4",
        tmpVideo,
      ],
      { timeoutMs: VIDEO_TIMEOUT_MS, failCode: "transcode_failed" },
    )

    const out = await probeMedia(tmpVideo)
    const outVideo = out.streams.find((s) => s.codecType === "video")
    if (!outVideo?.width || !outVideo.height || out.durationMs === null) {
      throw new MediaError("transcode_failed", "transcoded file has no video size or duration")
    }
    // The input may not have said how long it is (a streamed WebM): the output always does.
    if (out.durationMs > VIDEO_MAX_DURATION_MS) throw new MediaError("too_long", `${out.durationMs} ms`)

    const at = Math.min(0.5, out.durationMs / 2000).toFixed(3)
    await runTool(
      "ffmpeg",
      [
        ...BASE_ARGS,
        "-ss",
        at,
        "-f",
        "mov",
        "-i",
        tmpVideo,
        "-frames:v",
        "1",
        "-vf",
        `scale=w='min(${POSTER_EDGE},iw)':h='min(${POSTER_EDGE},ih)':force_original_aspect_ratio=decrease`,
        "-q:v",
        "4",
        "-f",
        "image2",
        "-update",
        "1",
        tmpPoster,
      ],
      { timeoutMs: POSTER_TIMEOUT_MS, failCode: "transcode_failed" },
    )

    await rename(tmpPoster, poster)
    await rename(tmpVideo, target)
    return { width: outVideo.width, height: outVideo.height, durationMs: out.durationMs }
  } catch (err) {
    await Promise.all([tmpVideo, tmpPoster, target, poster].map((f) => rm(f, { force: true })))
    throw err
  }
}
