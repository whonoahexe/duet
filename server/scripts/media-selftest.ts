// Container media toolchain self-test (plan 02-04, MDIA-01): proves ffmpeg, sharp and (when present)
// heif-convert work together by pushing a generated JPEG and a generated HEVC HEIC through the real
// processImage. Works in a fresh temp dir and never touches DATA_DIR.
//
//   node --import tsx server/scripts/media-selftest.ts
//   docker compose exec -T duet node --import tsx server/scripts/media-selftest.ts
//
// Prints "heic ok" (or "heic skipped (no heif-enc)") and "media-selftest ok" last; exits 1 on failure.
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import sharp from "sharp"
import { hasTool, runTool } from "../src/media/exec"
import { DISPLAY_EDGE, THUMB_EDGE, processImage } from "../src/media/image"

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
  console.log(`${label} ok (display ${result.width}x${result.height})`)
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
  console.log("media-selftest ok")
} catch (err) {
  fail(err instanceof Error ? `${err.message}${"detail" in err && err.detail ? ` (${String(err.detail)})` : ""}` : String(err))
} finally {
  rmSync(root, { recursive: true, force: true })
}
