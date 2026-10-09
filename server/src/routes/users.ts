import { asc } from "drizzle-orm"
import type { FastifyInstance } from "fastify"
import type { UsersResponse } from "@duet/shared"
import { users } from "../db/schema"

/**
 * GET /api/users — public by design (D-04: the two names are visible on the login screen).
 * Explicit column projection: the password hash can never be serialized (T-01-01).
 */
export async function usersRoutes(app: FastifyInstance) {
  app.get("/api/users", async (): Promise<UsersResponse> => {
    const rows = app.db
      .select({ id: users.id, username: users.username, displayName: users.displayName })
      .from(users)
      .orderBy(asc(users.createdAt), asc(users.username))
      .all()
    return { users: rows }
  })
}
