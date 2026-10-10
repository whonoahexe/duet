import type { FastifyReply, FastifyRequest, onRequestHookHandler, onSendHookHandler } from "fastify"
import type { Config } from "../config"

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"])

/**
 * True when the request path is /api or under /api/. Percent-decodes the path first, because the
 * router decodes it before matching: classifying on the raw URL let `/%61pi/logout` skip a path check
 * while still reaching the /api/logout handler (CR-01). An undecodable path is treated as API.
 */
export function isApiPath(url: string): boolean {
  const q = url.indexOf("?")
  const raw = q === -1 ? url : url.slice(0, q)
  let path: string
  try {
    path = decodeURIComponent(raw)
  } catch {
    return true
  }
  return path === "/api" || path.startsWith("/api/")
}

/**
 * CSRF guard (T-01-08): every state-changing request must carry Origin === APP_ORIGIN. A missing
 * Origin is rejected too. It is deliberately not scoped by path: the server has no state-changing
 * routes outside /api, and a path check can be dodged with percent-encoding (CR-01). Runs onRequest,
 * before body parsing and any handler.
 */
export function originGuard(config: Config): onRequestHookHandler {
  return function originGuardHook(request: FastifyRequest, reply: FastifyReply, done) {
    if (!SAFE_METHODS.has(request.method) && request.headers.origin !== config.APP_ORIGIN) {
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
