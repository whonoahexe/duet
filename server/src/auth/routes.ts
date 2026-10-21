import { randomBytes } from "node:crypto"
import { isIPv6 } from "node:net"
import { asc, eq, ne } from "drizzle-orm"
import type { FastifyInstance, FastifyRequest } from "fastify"
import { LoginBody, type MeResponse, type OkResponse } from "@duet/shared"
import { sessions, users } from "../db/schema"
import { hashPassword, verifyPassword } from "./password"
import { clearSessionCookie, issueSession, requireUser } from "./session"

/** /api/me's view of a person: the public summary plus the shared photo (never on GET /api/users, T-5zd-04). */
const profile = { id: users.id, username: users.username, displayName: users.displayName, photoId: users.photoId }

/**
 * Verified against when the userId is unknown, so an unknown id costs the same argon2 work as a
 * wrong password and gets the identical 401 (T-01-06). Computed once at module init.
 */
const DUMMY_HASH: Promise<string> = hashPassword(randomBytes(32).toString("hex"))

function headerValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value
}

/**
 * IP part of the login rate-limit key. IPv6 addresses collapse to their /64, because one ordinary
 * IPv6 allocation is a whole /64 and would otherwise give an attacker ~2^64 separate buckets (WR-01).
 * IPv4 (including IPv4-mapped IPv6) is used as-is.
 */
export function ipBucket(ip: string): string {
  const addr = ip.split("%")[0]!.toLowerCase() // drop any zone id
  if (!isIPv6(addr)) return ip
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(addr)
  if (mapped) return mapped[1]!
  const [head = "", tail] = addr.split("::")
  const headGroups = head ? head.split(":") : []
  const tailGroups = tail ? tail.split(":") : []
  // An embedded dotted IPv4 tail (e.g. 64:ff9b::1.2.3.4) fills two 16-bit groups.
  const tailLength = tailGroups.reduce((n, g) => n + (g.includes(".") ? 2 : 1), 0)
  const groups =
    tail === undefined ? headGroups : [...headGroups, ...Array(Math.max(0, 8 - headGroups.length - tailLength)).fill("0"), ...tailGroups]
  const prefix = groups.slice(0, 4).map((g) => (Number.parseInt(g, 16) || 0).toString(16))
  while (prefix.length < 4) prefix.push("0")
  return `${prefix.join(":")}::/64`
}

/**
 * Rate-limit key: client IP from CF-Connecting-IP (Pitfall 4: req.ip is always cloudflared),
 * collapsed to /64 for IPv6, plus the userId from the parsed body (Pitfall 3: needs hook "preHandler").
 */
function loginRateLimitKey(request: FastifyRequest): string {
  const ip = headerValue(request.headers["cf-connecting-ip"]) ?? request.ip
  const body = request.body as { userId?: unknown } | null | undefined
  const userId = typeof body?.userId === "string" && body.userId.length > 0 ? body.userId.slice(0, 64) : "-"
  return `${ipBucket(ip)}:${userId}`
}

/** Account-wide cap on failed logins, regardless of client IP (WR-01). */
export const LOGIN_ACCOUNT_MAX_FAILURES = 20
export const LOGIN_ACCOUNT_WINDOW_MS = 60 * 60 * 1000

/**
 * In-memory failed-login log per existing account (so at most two keys). Only failures count, so the
 * owner's own successful logins never use up the budget. While an account is over the cap every
 * attempt is refused, the correct password included, so the cap really bounds guessing.
 */
function createAccountLimiter(now: () => number = Date.now) {
  const failures = new Map<string, number[]>()
  function recent(userId: string): number[] {
    const cutoff = now() - LOGIN_ACCOUNT_WINDOW_MS
    const list = (failures.get(userId) ?? []).filter((ts) => ts > cutoff)
    if (list.length === 0) failures.delete(userId)
    else failures.set(userId, list)
    return list
  }
  return {
    /** Seconds until the next attempt is allowed, or 0 when the account is under the cap. */
    retryAfterSeconds(userId: string): number {
      const list = recent(userId)
      if (list.length < LOGIN_ACCOUNT_MAX_FAILURES) return 0
      const oldest = list[list.length - LOGIN_ACCOUNT_MAX_FAILURES]!
      return Math.max(1, Math.ceil((oldest + LOGIN_ACCOUNT_WINDOW_MS - now()) / 1000))
    },
    recordFailure(userId: string): void {
      const list = recent(userId)
      list.push(now())
      failures.set(userId, list)
    },
  }
}

/** POST /api/login (rate-limited), GET /api/me, POST /api/logout. Request bodies are never logged. */
export async function authRoutes(app: FastifyInstance) {
  const accountLimiter = createAccountLimiter()

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
      const retryAfterSeconds = accountLimiter.retryAfterSeconds(user.id)
      if (retryAfterSeconds > 0) {
        return reply.code(429).header("retry-after", String(retryAfterSeconds)).send({ error: "rate_limited", retryAfterSeconds })
      }
      if (!(await verifyPassword(user.passwordHash, password))) {
        accountLimiter.recordFailure(user.id)
        return reply.code(401).send({ error: "wrong_password" })
      }
      issueSession(app.db, reply, user.id, request.headers["user-agent"], app.config)
      return { ok: true } satisfies OkResponse
    },
  )

  app.get("/api/me", { preHandler: requireUser }, async (request): Promise<MeResponse> => {
    const me = request.user!
    const self = app.db.select(profile).from(users).where(eq(users.id, me.id)).get()
    const peer =
      app.db.select(profile).from(users).where(ne(users.id, me.id)).orderBy(asc(users.createdAt)).get() ?? null
    return {
      user: self ?? { id: me.id, username: me.username, displayName: me.displayName, photoId: null },
      peer,
    }
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
