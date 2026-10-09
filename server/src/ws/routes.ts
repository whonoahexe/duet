import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify"
import { requireUserNoRenew } from "../auth/session"

/**
 * GET /ws: the signaling WebSocket (D-16). Both checks run before the upgrade, so a rejected
 * request gets a plain HTTP 403/401 and never a socket.
 * - Origin must equal APP_ORIGIN (D-03): blocks cross-site WebSocket hijacking (Pitfall M2). The
 *   global originGuard skips GET, so this route checks it itself.
 * - requireUserNoRenew: a 101 response cannot carry Set-Cookie, so the session is not renewed here
 *   (Pitfall M1); ordinary HTTP requests keep it rolling.
 */
export async function wsRoutes(app: FastifyInstance) {
  async function wsOriginCheck(request: FastifyRequest, reply: FastifyReply) {
    if (request.headers.origin !== app.config.APP_ORIGIN) {
      return reply.code(403).send({ error: "bad_origin" })
    }
  }

  app.get("/ws", { websocket: true, preHandler: [wsOriginCheck, requireUserNoRenew] }, (socket, request) => {
    app.hub.attach(socket, request.user!, request.session!.id)
  })
}
