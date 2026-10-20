import type { FastifyInstance, FastifyRequest } from "fastify"
import { CALL_DIAG_BODY_LIMIT, CallDiagBatch, CallId, type CallStatusResponse } from "@duet/shared"
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
 * the same 404 (T-03-09). Never cached. logLevel "warn" (261020-oj7): Fastify's request lines would put
 * the callId (in the URL) next to remoteAddress/remotePort, and `grep <callId>` must show no address.
 */
export async function callsRoutes(app: FastifyInstance) {
  app.get<{ Params: { id: string } }>(
    "/api/calls/:id",
    { preHandler: requireUser, config: perIpLimit(), logLevel: "warn" },
    async (request, reply) => {
      reply.header("Cache-Control", "no-store")
      const id = CallId.safeParse(request.params.id)
      const status = id.success ? app.calls.statusFor(id.data, request.user!.id) : null
      if (!status) return reply.code(404).send({ error: "not_found" })
      return status satisfies CallStatusResponse
    },
  )

  /**
   * POST /api/calls/diag (quick task 261020-oj7): one phone's log of a call, written as call_diag lines
   * next to the registry's own call lines, so `grep <callId>` over the server log shows the whole call
   * from both sides (the 2026-10-20 hangup/redial calls could not be explained from the server alone).
   *
   * The body is the strict enum/int/boolean contract of shared/src/call-diag.ts, so a parsed batch
   * holds no personal data and is logged field by field as is. userId comes from the session, never
   * the body. A rejection logs only a count and a zod issue code: never the body, issue messages or
   * paths (paths can echo client-chosen key names).
   *
   * logLevel "warn" silences Fastify's per-request "incoming request"/"request completed" lines for
   * this chatty route: they carry remoteAddress and remotePort. The call lines therefore go through
   * app.log (the root logger), which the route's level does not affect.
   */
  app.post(
    "/api/calls/diag",
    { preHandler: requireUser, config: perIpLimit(), bodyLimit: CALL_DIAG_BODY_LIMIT, logLevel: "warn" },
    async (request, reply) => {
      reply.header("Cache-Control", "no-store")
      const userId = request.user!.id
      const parsed = CallDiagBatch.safeParse(request.body)
      if (!parsed.success) {
        app.log.warn({
          evt: "call_diag_rejected",
          userId,
          issues: parsed.error.issues.length,
          code: parsed.error.issues[0]?.code ?? "unknown",
        })
        return reply.code(400).send({ error: "invalid_body" })
      }
      const { callId, role, seq, dropped, sentAt, env, events } = parsed.data
      app.log.info({
        evt: "call_diag",
        k: "batch",
        callId,
        userId,
        role,
        seq,
        dropped,
        events: events.length,
        skewMs: Date.now() - sentAt,
        ...env,
      })
      for (const event of events) {
        app.log.info({ evt: "call_diag", callId, userId, role, seq, ...event })
      }
      return reply.code(204).send()
    },
  )
}
