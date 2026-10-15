import { existsSync, readdirSync, rmSync } from "node:fs"
import path from "node:path"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import type { FastifyInstance } from "fastify"
import { buildApp } from "../src/app"
import { REPO_ROOT, loadConfig } from "../src/config"
import { makeDataDir } from "./helpers"

// Runs against the REAL static export: build it first (`npm run build`).
const WEB_OUT = path.join(REPO_ROOT, "web", "out")
const DARK_BG = "#090b0c"

let app: FastifyInstance
let dataDir: string

beforeAll(async () => {
  if (!existsSync(path.join(WEB_OUT, "index.html"))) {
    throw new Error(`no static export at ${WEB_OUT}; run \`npm run build\` first`)
  }
  dataDir = makeDataDir()
  app = await buildApp(
    loadConfig({
      NODE_ENV: "test",
      DATA_DIR: dataDir,
      WEB_OUT,
      APP_ORIGIN: "http://localhost:3000",
      COOKIE_SECURE: "false",
      LOG_LEVEL: "silent",
    }),
  )
})

afterAll(async () => {
  await app?.close()
  if (dataDir) rmSync(dataDir, { recursive: true, force: true })
})

describe("PWA manifest", () => {
  it("is served as application/manifest+json with the duet identity and dark colors", async () => {
    const res = await app.inject({ method: "GET", url: "/manifest.webmanifest" })
    expect(res.statusCode).toBe(200)
    expect(res.headers["content-type"]).toContain("application/manifest+json")
    const m = res.json()
    expect(m).toMatchObject({
      id: "/",
      name: "duet",
      short_name: "duet",
      start_url: "/",
      scope: "/",
      display: "standalone",
      background_color: DARK_BG,
      theme_color: DARK_BG,
    })
    expect(m.icons).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ src: "/icons/icon-192.png", sizes: "192x192", type: "image/png" }),
        expect.objectContaining({ src: "/icons/icon-512.png", sizes: "512x512", type: "image/png" }),
        expect.objectContaining({ src: "/icons/icon-maskable-512.png", sizes: "512x512", purpose: "maskable" }),
      ]),
    )
  })
})

describe("icons", () => {
  for (const name of ["icon-192.png", "icon-512.png", "icon-maskable-512.png", "apple-touch-icon.png", "badge-96.png"]) {
    it(`serves /icons/${name} as image/png`, async () => {
      const res = await app.inject({ method: "GET", url: `/icons/${name}` })
      expect(res.statusCode).toBe(200)
      expect(res.headers["content-type"]).toContain("image/png")
      // PNG signature
      expect(res.rawPayload.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a")
    })
  }
})

describe("index.html head", () => {
  it("carries the manifest, apple-touch-icon, status bar, theme-color and viewport-fit tags", async () => {
    const res = await app.inject({ method: "GET", url: "/" })
    expect(res.statusCode).toBe(200)
    const html = res.body
    expect(html).toMatch(/<link rel="manifest" href="\/manifest\.webmanifest"/)
    expect(html).toMatch(/<link rel="apple-touch-icon" href="\/icons\/apple-touch-icon\.png"/)
    expect(html).toMatch(/<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent"/)
    expect(html).toMatch(new RegExp(`<meta name="theme-color" content="${DARK_BG}"`))
    expect(html).toMatch(/<meta name="viewport" content="[^"]*viewport-fit=cover/)
    expect(html).toMatch(/<html[^>]*class="([^"]* )?dark( [^"]*)?"/)
  })
})

describe("cache headers", () => {
  it("serves /sw.js no-cache as JavaScript", async () => {
    const res = await app.inject({ method: "GET", url: "/sw.js" })
    expect(res.statusCode).toBe(200)
    expect(res.headers["cache-control"]).toBe("no-cache")
    expect(res.headers["content-type"]).toContain("javascript")
  })

  it("serves /_next/static assets immutable", async () => {
    const dir = path.join(WEB_OUT, "_next", "static", "chunks")
    const file = readdirSync(dir).find((f) => f.endsWith(".js"))
    expect(file).toBeDefined()
    const res = await app.inject({ method: "GET", url: `/_next/static/chunks/${file}` })
    expect(res.statusCode).toBe(200)
    expect(res.headers["cache-control"]).toContain("immutable")
  })
})

describe("404 handling", () => {
  it("an unknown non-API path gets the HTML 404 page", async () => {
    const res = await app.inject({ method: "GET", url: "/nope-not-a-page" })
    expect(res.statusCode).toBe(404)
    expect(res.headers["content-type"]).toContain("text/html")
  })

  // CR-01: the router percent-decodes paths, so /%61pi/... is an /api path and gets the JSON 404.
  for (const url of ["/api/nope", "/%61pi/nope", "/%61%70%69/nope?x=1"]) {
    it(`${url} is the JSON 404, not the HTML one`, async () => {
      const res = await app.inject({ method: "GET", url })
      expect(res.statusCode).toBe(404)
      expect(res.json()).toEqual({ error: "not_found" })
    })
  }
})
