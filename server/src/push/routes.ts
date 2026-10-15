import type { FastifyInstance, FastifyRequest } from "fastify"
import { ne } from "drizzle-orm"
import { PushSubscriptionBody, type OkResponse, type PushTestResponse, type VapidKeyResponse } from "@duet/shared"
import { requireUser } from "../auth/session"
import { users } from "../db/schema"
import { isAllowedPushEndpoint } from "./sender"

function headerValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value
}

/** Rate-limit key: the real client IP (every request arrives from cloudflared). */
function clientIp(request: FastifyRequest): string {
  return headerValue(request.headers["cf-connecting-ip"]) ?? request.ip
}

function perIpLimit(max: number) {
  return {
    rateLimit: {
      max,
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
 * Web Push (NOTF-01..03). Subscriptions are bound to the session that saved them, so logout removes
 * them (ON DELETE CASCADE, T-02-15). Every new message is pushed to the other person unless they are
 * viewing the chat right now (D-15); suppression happens here, never in the service worker
 * (Pitfall 3). Logs never carry an endpoint path, a key or a message body.
 */
export async function pushRoutes(app: FastifyInstance) {
  // One sender per app (app.push), shared with the call registry's ringing pushes (Phase 3).
  const sender = app.push

  app.get("/api/push/vapid-public-key", { preHandler: requireUser }, async (_request, reply) => {
    reply.header("Cache-Control", "no-store")
    if (!sender.publicKey) return reply.code(503).send({ error: "push_unconfigured" })
    return { key: sender.publicKey } satisfies VapidKeyResponse
  })

  app.post(
    "/api/push/subscriptions",
    { preHandler: requireUser, config: perIpLimit(30) },
    async (request, reply) => {
      reply.header("Cache-Control", "no-store")
      const parsed = PushSubscriptionBody.safeParse(request.body)
      if (!parsed.success || !isAllowedPushEndpoint(parsed.data.endpoint)) {
        return reply.code(400).send({ error: "invalid_body" })
      }
      if (!sender.configured) return reply.code(503).send({ error: "push_unconfigured" })
      sender.saveSubscription(request.user!.id, request.session!.id, {
        endpoint: parsed.data.endpoint,
        p256dh: parsed.data.keys.p256dh,
        auth: parsed.data.keys.auth,
      })
      request.log.info({ evt: "push_subscribed", userId: request.user!.id, host: new URL(parsed.data.endpoint).host })
      return { ok: true } satisfies OkResponse
    },
  )

  /** SHEL-03: "Send test notification" reaches this phone (this session's subscriptions) only. */
  app.post("/api/push/test", { preHandler: requireUser, config: perIpLimit(10) }, async (request, reply) => {
    reply.header("Cache-Control", "no-store")
    if (!sender.configured) return reply.code(503).send({ error: "push_unconfigured" })
    const sent = await sender.sendTest(request.session!.id)
    request.log.info({ evt: "push_test", userId: request.user!.id, sent })
    return { sent } satisfies PushTestResponse
  })

  app.chatEvents.onMessageCreated(async ({ message, senderId }) => {
    if (!sender.configured) return
    const people = app.db.select({ id: users.id, displayName: users.displayName }).from(users).all()
    const senderName = people.find((p) => p.id === senderId)?.displayName ?? "duet"
    const recipients = app.db.select({ id: users.id }).from(users).where(ne(users.id, senderId)).all()
    await Promise.all(
      recipients.map(async ({ id }) => {
        if (app.hub.isViewing(id)) {
          app.log.info({ evt: "push_suppressed", userId: id, seq: message.seq })
          return
        }
        await sender.notifyMessage(id, message, senderName)
      }),
    )
  })
}
