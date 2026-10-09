import { existsSync } from "node:fs"
import Fastify, { type FastifyInstance } from "fastify"
import fastifyStatic from "@fastify/static"
import type { Config } from "./config"
import { openDb, type Db } from "./db/client"
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

  app.get("/healthz", async () => ({ ok: true }))

  await app.register(usersRoutes)

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
