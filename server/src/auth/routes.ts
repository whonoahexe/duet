import { randomBytes } from "node:crypto"
import { asc, eq, ne } from "drizzle-orm"
import type { FastifyInstance, FastifyRequest } from "fastify"
import { LoginBody, type MeResponse, type OkResponse } from "@duet/shared"
import { sessions, users } from "../db/schema"
import { hashPassword, verifyPassword } from "./password"
import { clearSessionCookie, issueSession, requireUser } from "./session"

const summary = { id: users.id, username: users.username, displayName: users.displayName }

/**
 * Verified against when the userId is unknown, so an unknown id costs the same argon2 work as a
 * wrong password and gets the identical 401 (T-01-06). Computed once at module init.
 */
const DUMMY_HASH: Promise<string> = hashPassword(randomBytes(32).toString("hex"))

function headerValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value
}

/**
 * Rate-limit key: client IP from CF-Connecting-IP (Pitfall 4: req.ip is always cloudflared)
 * plus the userId from the parsed body (Pitfall 3: needs hook "preHandler").
 */
function loginRateLimitKey(request: FastifyRequest): string {
  const ip = headerValue(request.headers["cf-connecting-ip"]) ?? request.ip
  const body = request.body as { userId?: unknown } | null | undefined
  const userId = typeof body?.userId === "string" && body.userId.length > 0 ? body.userId.slice(0, 64) : "-"
  return `${ip}:${userId}`
}

/** POST /api/login (rate-limited), GET /api/me, POST /api/logout. Request bodies are never logged. */
export async function authRoutes(app: FastifyInstance) {
  app.post(
    "/api/login",
    {
      config: {
        rateLimit: {
          max: 5,
          timeWindow: "5 minutes",
          hook: "preHandler", // REQUIRED: with the default onRequest hook req.body is undefined
          keyGenerator: loginRateLimitKey,
          errorResponseBuilder: (_request, context) => ({
            statusCode: 429,
            error: "rate_limited",
            retryAfterSeconds: Math.max(1, Math.ceil(context.ttl / 1000)),
          }),
        },
      },
    },
    async (request, reply) => {
      const parsed = LoginBody.safeParse(request.body)
      if (!parsed.success) {
        return reply.code(400).send({ error: "invalid_body" })
      }
      const { userId, password } = parsed.data
      const user = app.db.select().from(users).where(eq(users.id, userId)).get()
      if (!user) {
        await verifyPassword(await DUMMY_HASH, password)
        return reply.code(401).send({ error: "wrong_password" })
      }
      if (!(await verifyPassword(user.passwordHash, password))) {
        return reply.code(401).send({ error: "wrong_password" })
      }
      issueSession(app.db, reply, user.id, request.headers["user-agent"], app.config)
      return { ok: true } satisfies OkResponse
    },
  )

  app.get("/api/me", { preHandler: requireUser }, async (request): Promise<MeResponse> => {
    const me = request.user!
    const peer =
      app.db.select(summary).from(users).where(ne(users.id, me.id)).orderBy(asc(users.createdAt)).get() ?? null
    return { user: { id: me.id, username: me.username, displayName: me.displayName }, peer }
  })

  /** D-06: logout revokes this device's session server-side and clears the cookie. */
  app.post("/api/logout", { preHandler: requireUser }, async (request, reply) => {
    app.db.delete(sessions).where(eq(sessions.id, request.session!.id)).run()
    // This device's open /ws sockets end with 4401; other sessions' sockets stay open.
    app.hub.closeSession(request.session!.id)
    clearSessionCookie(reply, app.config)
    return { ok: true } satisfies OkResponse
  })
}
