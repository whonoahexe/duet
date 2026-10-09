import type { FastifyReply, FastifyRequest, onRequestHookHandler, onSendHookHandler } from "fastify"
import type { Config } from "../config"

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"])

function isApiUrl(url: string): boolean {
  return url === "/api" || url.startsWith("/api/") || url.startsWith("/api?")
}

/**
 * CSRF guard (T-01-08): every state-changing /api/* request must carry Origin === APP_ORIGIN.
 * A missing Origin is rejected too. Runs onRequest, before body parsing and any handler.
 */
export function originGuard(config: Config): onRequestHookHandler {
  return function originGuardHook(request: FastifyRequest, reply: FastifyReply, done) {
    if (!SAFE_METHODS.has(request.method) && isApiUrl(request.url) && request.headers.origin !== config.APP_ORIGIN) {
      reply.code(403).send({ error: "bad_origin" })
      return
    }
    done()
  }
}

/** Baseline response headers (T-01-12). HSTS only when the app is served over HTTPS (COOKIE_SECURE). */
export function securityHeaders(config: Config): onSendHookHandler {
  return function securityHeadersHook(_request, reply, payload, done) {
    reply.header("X-Content-Type-Options", "nosniff")
    reply.header("X-Frame-Options", "DENY")
    reply.header("Referrer-Policy", "same-origin")
    if (config.COOKIE_SECURE) {
      reply.header("Strict-Transport-Security", "max-age=15552000")
    }
    done(null, payload)
  }
}
