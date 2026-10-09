import { existsSync } from "node:fs"
import Fastify, { type FastifyInstance } from "fastify"
import fastifyCookie from "@fastify/cookie"
import fastifyRateLimit from "@fastify/rate-limit"
import fastifyStatic from "@fastify/static"
import fastifyWebsocket from "@fastify/websocket"
import { WS_MAX_PAYLOAD } from "@duet/shared"
import type { Config } from "./config"
import { openDb, type Db } from "./db/client"
import { authRoutes } from "./auth/routes"
import { decorateAuth } from "./auth/session"
import { originGuard, securityHeaders } from "./http/guards"
import { usersRoutes } from "./routes/users"
import { rtcRoutes } from "./rtc/routes"
import { createHub, type Hub } from "./ws/hub"
import { wsRoutes } from "./ws/routes"

declare module "fastify" {
  interface FastifyInstance {
    db: Db
    config: Config
    /** In-memory /ws signaling hub. */
    hub: Hub
  }
}

/** Injection points for tests (no network, readable logs). Production passes nothing. */
export interface AppDeps {
  /** fetch used for Cloudflare TURN minting. Default: globalThis.fetch. */
  fetch?: typeof fetch
  /** Cloudflare TURN mint timeout. Default: 5000 ms. */
  turnTimeoutMs?: number
  /** When set, logs go here at level info (tests read them). Default: stdout at LOG_LEVEL. */
  logStream?: NodeJS.WritableStream
  /** /ws heartbeat ping interval. Default: 25000 ms (under Cloudflare's ~100 s idle cutoff). */
  heartbeatMs?: number
}

export async function buildApp(config: Config, deps: AppDeps = {}): Promise<FastifyInstance> {
  const app = Fastify({
    logger: deps.logStream ? { level: "info", stream: deps.logStream } : { level: config.LOG_LEVEL },
  })

  const { sqlite, db } = openDb(config.DATA_DIR)
  app.decorate("db", db)
  app.decorate("config", config)
  app.addHook("onClose", async () => {
    sqlite.close()
  })

  // Guards first, so they cover every route registered below (and the 404 handler).
  app.addHook("onRequest", originGuard(config))
  app.addHook("onSend", securityHeaders(config))

  // Unparseable request bodies (malformed JSON, bad content type) are a generic invalid_body,
  // never a 500 and never an echo of the input. The rate limiter throws its errorResponseBuilder
  // result (a plain object with statusCode), which is sent as the body. Everything else falls
  // through to Fastify's default handler.
  app.setErrorHandler((error: unknown, _request, reply) => {
    const e = error as { code?: unknown; statusCode?: unknown }
    if (typeof e.code === "string" && e.code.startsWith("FST_ERR_CTP_")) {
      const status = typeof e.statusCode === "number" && e.statusCode < 500 ? e.statusCode : 400
      return reply.code(status).send({ error: "invalid_body" })
    }
    if (!(error instanceof Error) && typeof e.statusCode === "number") {
      const { statusCode, ...body } = error as { statusCode: number } & Record<string, unknown>
      return reply.code(statusCode).send(body)
    }
    throw error
  })

  decorateAuth(app)
  await app.register(fastifyCookie)
  // Per-route limits only (POST /api/login). Must be registered before the routes.
  await app.register(fastifyRateLimit, { global: false })
  // Must be registered before any route. maxPayload: larger messages close the socket with 1009.
  await app.register(fastifyWebsocket, { options: { maxPayload: WS_MAX_PAYLOAD } })
  const hub = createHub({ log: app.log, heartbeatMs: deps.heartbeatMs ?? 25_000 })
  app.decorate("hub", hub)
  app.addHook("onClose", async () => {
    hub.close()
  })

  app.get("/healthz", async () => ({ ok: true }))

  await app.register(usersRoutes)
  await app.register(authRoutes)
  await app.register(rtcRoutes, { fetch: deps.fetch ?? globalThis.fetch, timeoutMs: deps.turnTimeoutMs ?? 5000 })
  await app.register(wsRoutes)

  // One line at boot so a deploy without TURN is visible in the logs (never the key id or bearer).
  if (config.CF_TURN_KEY_ID && config.CF_TURN_KEY_API_TOKEN) {
    app.log.info({ evt: "turn_config", configured: true })
  } else {
    app.log.warn({ evt: "turn_config", configured: false })
  }

  // Static export (web/out). Skipped when it has not been built (tests, server-only dev).
  const hasStatic = existsSync(config.WEB_OUT)
  if (hasStatic) {
    await app.register(fastifyStatic, {
      root: config.WEB_OUT,
      redirect: true,
      // Keep the default `wildcard` option: `wildcard: false` crashes at boot.
      // @fastify/static v10: the first argument is the Fastify reply (Pitfall 7).
      setHeaders(reply, filePath) {
        if (filePath.endsWith(".html") || filePath.endsWith("sw.js") || filePath.endsWith(".webmanifest")) {
          reply.header("Cache-Control", "no-cache")
        } else if (filePath.includes("/_next/static/")) {
          reply.header("Cache-Control", "public, max-age=31536000, immutable")
        }
      },
    })
  }

  app.setNotFoundHandler((req, reply) => {
    if (req.url === "/api" || req.url.startsWith("/api/") || req.url.startsWith("/api?")) {
      return reply.code(404).send({ error: "not_found" })
    }
    if (hasStatic && existsSync(`${config.WEB_OUT}/404.html`)) {
      return reply.code(404).type("text/html").sendFile("404.html")
    }
    return reply.code(404).send({ error: "not_found" })
  })

  return app
}
