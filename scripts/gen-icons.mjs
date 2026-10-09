#!/usr/bin/env node
// Dev-time icon generator (D-09). Output is committed; nothing runs in Docker.
//
//   node scripts/gen-icons.mjs
//
// A Phosphor "Heart" (fill weight) glyph in the preset's dark --primary-foreground on the
// dark --primary square, rasterized with ImageMagick. The Phosphor path is read from the
// package's defs file (rendering Phosphor React components through next/og fails in a static
// export, Pitfall 8). Colors come from the preset's own .dark tokens in web/app/globals.css.
import { execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const ICONS = path.join(ROOT, "web/public/icons")
const FAVICON = path.join(ROOT, "web/app/favicon.ico")

// --- Colors: oklch tokens from the .dark block -> sRGB hex ------------------
function darkToken(name) {
  const css = readFileSync(path.join(ROOT, "web/app/globals.css"), "utf8")
  const block = css.match(/\.dark\s*\{([^}]*)\}/)
  if (!block) throw new Error("no .dark block in globals.css")
  const m = block[1].match(new RegExp(`--${name}:\\s*oklch\\(([^)]+)\\)`))
  if (!m) throw new Error(`--${name} is not an oklch() value in .dark`)
  return m[1].trim().split(/\s+/).map(Number)
}

function oklchToHex([L, C, h]) {
  const hr = (h * Math.PI) / 180
  const a = C * Math.cos(hr)
  const b = C * Math.sin(hr)
  const l_ = L + 0.3963377774 * a + 0.2158037573 * b
  const m_ = L - 0.1055613458 * a - 0.0638541728 * b
  const s_ = L - 0.0894841775 * a - 1.291485548 * b
  const l = l_ ** 3
  const m = m_ ** 3
  const s = s_ ** 3
  const lin = [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ]
  const gamma = (x) => (x <= 0.0031308 ? 12.92 * x : 1.055 * x ** (1 / 2.4) - 0.055)
  return (
    "#" +
    lin
      .map((x) => Math.round(Math.min(1, Math.max(0, gamma(x))) * 255))
      .map((v) => v.toString(16).padStart(2, "0"))
      .join("")
  )
}

const BG = oklchToHex(darkToken("primary"))
const FG = oklchToHex(darkToken("primary-foreground"))
const APP_BG = oklchToHex(darkToken("background"))

// --- Glyph: fill-weight Heart path from the Phosphor defs ------------------
function heartPath() {
  const defsDir = (() => {
    const direct = path.join(ROOT, "node_modules/@phosphor-icons/react/dist/defs")
    try {
      readdirSync(direct)
      return direct
    } catch {
      // Fallback: search the package for a defs dir holding Heart.es.js.
      const pkg = path.join(ROOT, "node_modules/@phosphor-icons/react")
      const stack = [pkg]
      while (stack.length) {
        const dir = stack.pop()
        for (const ent of readdirSync(dir, { withFileTypes: true })) {
          const p = path.join(dir, ent.name)
          if (ent.isDirectory()) stack.push(p)
          else if (ent.name === "Heart.es.js") return dir
        }
      }
      throw new Error("Phosphor Heart.es.js not found")
    }
  })()
  const src = readFileSync(path.join(defsDir, "Heart.es.js"), "utf8")
  const m = src.match(/"fill",[\s\S]*?\bd:\s*"([^"]+)"/)
  if (!m) throw new Error("fill-weight path not found in Heart.es.js")
  return m[1]
}

const D = heartPath()
// Bounding box of the fill heart in its 256 viewBox (x 16..240, y 40..232).
const BBOX = { x0: 16, y0: 40, x1: 240, y1: 232 }

/** Square SVG: BG square, FG glyph whose width is `frac` of the canvas, centered. */
function svg(size, frac) {
  const w = BBOX.x1 - BBOX.x0
  const k = (frac * size) / w
  const cx = (BBOX.x0 + BBOX.x1) / 2
  const cy = (BBOX.y0 + BBOX.y1) / 2
  const tx = size / 2 - k * cx
  const ty = size / 2 - k * cy
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
<rect width="${size}" height="${size}" fill="${BG}"/>
<path transform="translate(${tx.toFixed(3)} ${ty.toFixed(3)}) scale(${k.toFixed(5)})" fill="${FG}" d="${D}"/>
</svg>`
}

const tmp = mkdtempSync(path.join(tmpdir(), "duet-icons-"))
const PNG_OPTS = ["-background", BG, "-alpha", "remove", "-alpha", "off", "-depth", "8", "-strip", "-define", "png:exclude-chunks=date,time"]

function render(size, frac, out) {
  const file = path.join(tmp, `${size}-${frac}.svg`)
  writeFileSync(file, svg(size, frac))
  execFileSync("magick", [file, ...PNG_OPTS, `PNG24:${out}`])
}

try {
  mkdirSync(ICONS, { recursive: true })
  render(180, 0.6, path.join(ICONS, "apple-touch-icon.png"))
  render(192, 0.6, path.join(ICONS, "icon-192.png"))
  render(512, 0.6, path.join(ICONS, "icon-512.png"))
  // Maskable: glyph inside the 80% safe-zone circle (about 44% of the canvas).
  render(512, 0.44, path.join(ICONS, "icon-maskable-512.png"))

  const fav = [16, 32, 48].map((s) => {
    const out = path.join(tmp, `fav-${s}.png`)
    render(s, 0.72, out)
    return out
  })
  execFileSync("magick", [...fav, FAVICON])

  console.log(`colors: primary ${BG}, primary-foreground ${FG}, background ${APP_BG}`)
  console.log("icons ok")
} finally {
  rmSync(tmp, { recursive: true, force: true })
}
