import { createHash, randomBytes } from "node:crypto"
import { eq } from "drizzle-orm"
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify"
import type { Config } from "../config"
import type { Db } from "../db/client"
import { sessions, users } from "../db/schema"

export const COOKIE_NAME = "duet_session"
/** D-06: 90-day rolling session. */
export const SESSION_TTL_MS = 90 * 24 * 60 * 60 * 1000
/** Renew (DB write + cookie re-issue) at most once a day. */
export const RENEW_AFTER_MS = 24 * 60 * 60 * 1000

export interface AuthUser {
  id: string
  username: string
  displayName: string
}

export interface AuthSession {
  /** sha256(token) hex: the sessions row id. */
  id: string
  /** The raw cookie value; needed to re-issue the cookie on renewal. Never stored. */
  token: string
  lastSeenAt: Date
}

declare module "fastify" {
  interface FastifyRequest {
    /** Set by requireUser; null on routes that do not run it. */
    user: AuthUser | null
    /** Set by requireUser; null on routes that do not run it. */
    session: AuthSession | null
  }
}

/** Register the request decorators once at the root (stable object shape). */
export function decorateAuth(app: FastifyInstance): void {
  app.decorateRequest("user", null)
  app.decorateRequest("session", null)
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex")
}

export function setSessionCookie(reply: FastifyReply, token: string, config: Config): void {
  reply.setCookie(COOKIE_NAME, token, {
    httpOnly: true,
    secure: config.COOKIE_SECURE,
    sameSite: "lax",
    path: "/",
    maxAge: SESSION_TTL_MS / 1000, // @fastify/cookie maxAge is in SECONDS
  })
}

export function clearSessionCookie(reply: FastifyReply, config: Config): void {
  reply.clearCookie(COOKIE_NAME, {
    httpOnly: true,
    secure: config.COOKIE_SECURE,
    sameSite: "lax",
    path: "/",
  })
}

/** Create a new session (fresh 256-bit token per login, so no fixation) and set the cookie. */
export function issueSession(
  db: Db,
  reply: FastifyReply,
  userId: string,
  userAgent: string | undefined,
  config: Config,
): void {
  const token = randomBytes(32).toString("base64url")
  const now = Date.now()
  db.insert(sessions)
    .values({
      id: hashToken(token),
      userId,
      createdAt: new Date(now),
      lastSeenAt: new Date(now),
      expiresAt: new Date(now + SESSION_TTL_MS),
      userAgent: userAgent ? userAgent.slice(0, 512) : null,
    })
    .run()
  setSessionCookie(reply, token, config)
}

/**
 * preHandler for authenticated routes. Missing or unknown session: 401.
 * Expired session: the row is deleted, the cookie cleared, 401.
 * Rolling renewal: more than RENEW_AFTER_MS after the last renewal, expires_at moves to
 * now + SESSION_TTL_MS AND Set-Cookie is re-issued with a fresh 90-day Max-Age.
 */
export async function requireUser(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  return authenticate(request, reply, true)
}

/**
 * preHandler for the /ws upgrade (Pitfall M1). Same checks as requireUser (401 on a missing or
 * unknown session, an expired row is deleted), but it never renews: a 101 response cannot carry
 * Set-Cookie, so moving expires_at here would put the DB ahead of the browser cookie. It never
 * touches the cookie at all. Ordinary HTTP requests (GET /api/me) keep the session rolling.
 */
export async function requireUserNoRenew(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  return authenticate(request, reply, false)
}

async function authenticate(request: FastifyRequest, reply: FastifyReply, renew: boolean): Promise<void> {
  const { db, config } = request.server
  const token = request.cookies[COOKIE_NAME]
  if (!token) {
    return reply.code(401).send({ error: "unauthenticated" })
  }

  const id = hashToken(token)
  const row = db
    .select({
      sessionId: sessions.id,
      lastSeenAt: sessions.lastSeenAt,
      expiresAt: sessions.expiresAt,
      userId: users.id,
      username: users.username,
      displayName: users.displayName,
    })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .where(eq(sessions.id, id))
    .get()

  if (!row) {
    return reply.code(401).send({ error: "unauthenticated" })
  }

  const now = Date.now()
  if (row.expiresAt.getTime() <= now) {
    db.delete(sessions).where(eq(sessions.id, id)).run()
    if (renew) clearSessionCookie(reply, config)
    return reply.code(401).send({ error: "unauthenticated" })
  }

  let lastSeenAt = row.lastSeenAt
  if (renew && now - row.lastSeenAt.getTime() > RENEW_AFTER_MS) {
    // Pitfall 5: extending only the DB row would still log the person out on day 90, because the
    // browser cookie keeps its original Max-Age. Re-issue the same token with a fresh Max-Age.
    lastSeenAt = new Date(now)
    db.update(sessions)
      .set({ lastSeenAt, expiresAt: new Date(now + SESSION_TTL_MS) })
      .where(eq(sessions.id, id))
      .run()
    setSessionCookie(reply, token, config)
  }

  request.user = { id: row.userId, username: row.username, displayName: row.displayName }
  request.session = { id, token, lastSeenAt }
}
