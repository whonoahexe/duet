import { existsSync } from "node:fs"
import Fastify, { type FastifyInstance } from "fastify"
import fastifyCookie from "@fastify/cookie"
import fastifyRateLimit from "@fastify/rate-limit"
import fastifyStatic from "@fastify/static"
import type { Config } from "./config"
import { openDb, type Db } from "./db/client"
import { authRoutes } from "./auth/routes"
import { decorateAuth } from "./auth/session"
import { originGuard, securityHeaders } from "./http/guards"
import { usersRoutes } from "./routes/users"

declare module "fastify" {
  interface FastifyInstance {
    db: Db
    config: Config
  }
}

export async function buildApp(config: Config): Promise<FastifyInstance> {
  const app = Fastify({ logger: { level: config.LOG_LEVEL } })

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

  app.get("/healthz", async () => ({ ok: true }))

  await app.register(usersRoutes)
  await app.register(authRoutes)

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
