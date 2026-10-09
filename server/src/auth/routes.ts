import { asc, eq, ne } from "drizzle-orm"
import type { FastifyInstance } from "fastify"
import { LoginBody, type MeResponse, type OkResponse } from "@duet/shared"
import { users } from "../db/schema"
import { verifyPassword } from "./password"
import { issueSession, requireUser } from "./session"

const summary = { id: users.id, username: users.username, displayName: users.displayName }

/** POST /api/login, GET /api/me. */
export async function authRoutes(app: FastifyInstance) {
  app.post("/api/login", async (request, reply) => {
    const { userId, password } = LoginBody.parse(request.body)
    const user = app.db.select().from(users).where(eq(users.id, userId)).get()
    const ok = user ? await verifyPassword(user.passwordHash, password) : false
    if (!user || !ok) {
      return reply.code(401).send({ error: "wrong_password" })
    }
    issueSession(app.db, reply, user.id, request.headers["user-agent"], app.config)
    return { ok: true } satisfies OkResponse
  })

  app.get("/api/me", { preHandler: requireUser }, async (request): Promise<MeResponse> => {
    const me = request.user!
    const peer =
      app.db.select(summary).from(users).where(ne(users.id, me.id)).orderBy(asc(users.createdAt)).get() ?? null
    return { user: { id: me.id, username: me.username, displayName: me.displayName }, peer }
  })
}
