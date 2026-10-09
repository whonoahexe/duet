import type { FastifyInstance, FastifyRequest } from "fastify"
import type { IceServersResponse } from "@duet/shared"
import { requireUser } from "../auth/session"
import { mintIceServers, TurnError } from "./turn"

export interface RtcRoutesOptions {
  fetch: typeof fetch
  timeoutMs: number
}

function headerValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value
}

/** Rate-limit key: the real client IP (every request arrives from cloudflared, Pitfall 4). */
function clientIp(request: FastifyRequest): string {
  return headerValue(request.headers["cf-connecting-ip"]) ?? request.ip
}

/**
 * POST /api/rtc/ice-servers (INFR-03, T-01-32): logged-in users only, Origin-checked by the global
 * originGuard, 30/min per client IP, never cached. Responses carry the minted credential, so nothing
 * from Cloudflare (username, credential, key id, bearer) is ever logged.
 */
export async function rtcRoutes(app: FastifyInstance, opts: RtcRoutesOptions) {
  app.post(
    "/api/rtc/ice-servers",
    {
      preHandler: requireUser,
      config: {
        rateLimit: {
          max: 30,
          timeWindow: "1 minute",
          keyGenerator: clientIp,
          errorResponseBuilder: (_request, context) => ({
            statusCode: 429,
            error: "rate_limited",
            retryAfterSeconds: Math.max(1, Math.ceil(context.ttl / 1000)),
          }),
        },
      },
    },
    async (request, reply) => {
      const userId = request.user!.id
      try {
        const result: IceServersResponse = await mintIceServers({
          fetch: opts.fetch,
          timeoutMs: opts.timeoutMs,
          apiBase: app.config.CF_TURN_API_BASE,
          keyId: app.config.CF_TURN_KEY_ID,
          apiToken: app.config.CF_TURN_KEY_API_TOKEN,
          ttlSeconds: app.config.TURN_CREDENTIAL_TTL_SECONDS,
        })
        request.log.info({ evt: "turn_mint", userId, ok: true })
        reply.header("Cache-Control", "no-store")
        return result
      } catch (err) {
        if (err instanceof TurnError) {
          request.log.warn({ evt: "turn_mint", userId, ok: false, code: err.code })
          reply.header("Cache-Control", "no-store")
          const status = err.code === "turn_unconfigured" ? 503 : 502
          return reply.code(status).send({ error: err.code })
        }
        throw err
      }
    },
  )
}
