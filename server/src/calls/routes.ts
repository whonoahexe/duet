import type { FastifyInstance, FastifyRequest } from "fastify"
import { CallId, type CallStatusResponse } from "@duet/shared"
import { requireUser } from "../auth/session"

function headerValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value
}

/** Rate-limit key: the real client IP (every request arrives from cloudflared). */
function clientIp(request: FastifyRequest): string {
  return headerValue(request.headers["cf-connecting-ip"]) ?? request.ip
}

/** 60 lookups a minute per client IP (call-id guessing, T-03-09). */
function perIpLimit() {
  return {
    rateLimit: {
      max: 60,
      timeWindow: "1 minute",
      keyGenerator: clientIp,
      errorResponseBuilder: (_request: FastifyRequest, context: { ttl: number }) => ({
        statusCode: 429,
        error: "rate_limited",
        retryAfterSeconds: Math.max(1, Math.ceil(context.ttl / 1000)),
      }),
    },
  }
}

/**
 * GET /api/calls/:id (D-10): a tapped call notification asks whether its call still rings or ended
 * unanswered. Logged-in parties only; a malformed id, an unknown call and someone else's call are all
 * the same 404 (T-03-09). Never cached.
 */
export async function callsRoutes(app: FastifyInstance) {
  app.get<{ Params: { id: string } }>(
    "/api/calls/:id",
    { preHandler: requireUser, config: perIpLimit() },
    async (request, reply) => {
      reply.header("Cache-Control", "no-store")
      const id = CallId.safeParse(request.params.id)
      const status = id.success ? app.calls.statusFor(id.data, request.user!.id) : null
      if (!status) return reply.code(404).send({ error: "not_found" })
      return status satisfies CallStatusResponse
    },
  )
}
