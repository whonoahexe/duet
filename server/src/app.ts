import { existsSync } from "node:fs"
import path from "node:path"
import Fastify, { type FastifyInstance } from "fastify"
import fastifyCookie from "@fastify/cookie"
import fastifyRateLimit from "@fastify/rate-limit"
import fastifyStatic from "@fastify/static"
import fastifyWebsocket from "@fastify/websocket"
import { WS_MAX_PAYLOAD } from "@duet/shared"
import type { Config } from "./config"
import { openDb, type Db } from "./db/client"
import { authRoutes } from "./auth/routes"
import { decorateAuth, isSessionLive } from "./auth/session"
import { isApiPath, originGuard, securityHeaders } from "./http/guards"
import { usersRoutes } from "./routes/users"
import { rtcRoutes } from "./rtc/routes"
import { callsRoutes } from "./calls/routes"
import { chatRoutes } from "./chat/routes"
import { pushRoutes } from "./push/routes"
import { createPushSender, type PushSender, type WebPushSend } from "./push/sender"
import { createChatEvents, type ChatEvents } from "./chat/events"
import { messageChangedForAttachment } from "./chat/service"
import { loadMediaKey } from "./media/crypto"
import { encryptMediaAtRest } from "./media/migrate"
import { createMediaProcessor, type MediaProcessor } from "./media/process"
import { mediaRoutes } from "./media/routes"
import { uploadRoutes } from "./media/uploads"
import { profileRoutes } from "./media/avatar"
import { createHub, type Hub } from "./ws/hub"
import { createCallRegistry, type CallRegistry } from "./calls/registry"
import { users } from "./db/schema"
import { eq, ne } from "drizzle-orm"
import { wsRoutes } from "./ws/routes"

declare module "fastify" {
  interface FastifyInstance {
    db: Db
    config: Config
    /** In-memory /ws signaling hub. */
    hub: Hub
    /** "A new message was stored" seam (push subscribes in plan 02-03). */
    chatEvents: ChatEvents
    /** Media processing lanes (plan 02-04): uploads enqueue, tests pause/resume/idle. */
    media: MediaProcessor
    /** In-memory single-call registry (Phase 3): ringing, accept/decline/end, call rooms. */
    calls: CallRegistry
    /** The one Web Push sender: chat pushes (pushRoutes) and call pushes (the call registry). */
    push: PushSender
  }
}

/** Injection points for tests (no network, readable logs). Production passes nothing. */
export interface AppDeps {
  /** fetch used for Cloudflare TURN minting. Default: globalThis.fetch. */
  fetch?: typeof fetch
  /** Cloudflare TURN mint timeout. Default: 5000 ms. */
  turnTimeoutMs?: number
  /** When set, logs go here at level info (tests read them). Default: stdout at LOG_LEVEL. */
  logStream?: NodeJS.WritableStream
  /** /ws heartbeat ping interval. Default: 25000 ms (under Cloudflare's ~100 s idle cutoff). */
  heartbeatMs?: number
  /** web-push send used for every Web Push. Default: webpush.sendNotification (real push services). */
  webPushSend?: WebPushSend
  /** Call registry timers (tests shorten them). Defaults: config.CALL_RING_TIMEOUT_MS, 10 s, 35 s. */
  callTimers?: { ringTimeoutMs?: number; callerAbsentMs?: number; absentGraceMs?: number }
}

export async function buildApp(config: Config, deps: AppDeps = {}): Promise<FastifyInstance> {
  const app = Fastify({
    logger: deps.logStream ? { level: "info", stream: deps.logStream } : { level: config.LOG_LEVEL },
  })

  const { sqlite, db } = openDb(config.DATA_DIR)
  app.decorate("db", db)
  app.decorate("config", config)
  app.addHook("onClose", async () => {
    sqlite.close()
  })

  // Guards first, so they cover every route registered below (and the 404 handler).
  app.addHook("onRequest", originGuard(config))
  app.addHook("onSend", securityHeaders(config))

  // Unparseable request bodies (malformed JSON, bad content type) are a generic invalid_body,
  // never a 500 and never an echo of the input. The rate limiter throws its errorResponseBuilder
  // result (a plain object with statusCode), which is sent as the body. Everything else falls
  // through to Fastify's default handler.
  app.setErrorHandler((error: unknown, _request, reply) => {
    const e = error as { code?: unknown; statusCode?: unknown }
    if (typeof e.code === "string" && e.code.startsWith("FST_ERR_CTP_")) {
      const status = typeof e.statusCode === "number" && e.statusCode < 500 ? e.statusCode : 400
      return reply.code(status).send({ error: "invalid_body" })
    }
    if (!(error instanceof Error) && typeof e.statusCode === "number") {
      const { statusCode, ...body } = error as { statusCode: number } & Record<string, unknown>
      return reply.code(statusCode).send(body)
    }
    throw error
  })

  decorateAuth(app)
  await app.register(fastifyCookie)
  // Per-route limits only (POST /api/login). Must be registered before the routes.
  await app.register(fastifyRateLimit, { global: false })
  // Must be registered before any route. maxPayload: larger messages close the socket with 1009.
  await app.register(fastifyWebsocket, { options: { maxPayload: WS_MAX_PAYLOAD } })
  const hub = createHub({
    log: app.log,
    heartbeatMs: deps.heartbeatMs ?? 25_000,
    isSessionLive: (sessionId) => isSessionLive(db, sessionId),
  })
  app.decorate("hub", hub)

  const push = createPushSender({ db, config, log: app.log, send: deps.webPushSend })
  app.decorate("push", push)

  /** The caller in a call push: title name ("duet" when the account is gone) and photo (QT-5zd-push-icon). */
  function personOf(userId: string): { name: string; photoId: string | null } {
    const row = db.select({ name: users.displayName, photoId: users.photoId }).from(users).where(eq(users.id, userId)).get()
    return { name: row?.name ?? "duet", photoId: row?.photoId ?? null }
  }

  // Phase 3: call.* frames go to the registry, which answers through the hub. Two accounts only: the
  // callee of any call is the one other user.
  const calls = createCallRegistry({
    log: app.log,
    transport: hub,
    // D-09 / D-11: ring the callee's phones by push, except sessions that show the in-app incoming
    // screen right now (research A1). Never awaited: the ring over /ws must not wait for push services.
    push: {
      notifyCall(call) {
        void Promise.resolve()
          .then(() => {
            const caller = personOf(call.callerId)
            return push.notifyCall(call.calleeId, call, caller.name, (sid) => hub.isSessionViewing(sid), caller.photoId)
          })
          .catch(() => app.log.warn({ evt: "push_call_failed", callId: call.id }))
      },
      notifyMissed(call) {
        void Promise.resolve()
          .then(() => {
            const caller = personOf(call.callerId)
            return push.notifyMissedCall(call.calleeId, call, caller.name, (sid) => hub.isSessionViewing(sid), caller.photoId)
          })
          .catch(() => app.log.warn({ evt: "push_call_missed_failed", callId: call.id }))
      },
    },
    otherUser: (userId) => db.select({ id: users.id }).from(users).where(ne(users.id, userId)).get()?.id,
    ringTimeoutMs: deps.callTimers?.ringTimeoutMs ?? config.CALL_RING_TIMEOUT_MS,
    inviteLimit: config.CALL_INVITE_LIMIT,
    callerAbsentMs: deps.callTimers?.callerAbsentMs,
    absentGraceMs: deps.callTimers?.absentGraceMs,
  })
  hub.setCallHooks(calls)
  app.decorate("calls", calls)
  app.addHook("onClose", async () => {
    calls.close()
    hub.close()
  })

  app.decorate("chatEvents", createChatEvents(app.log))

  // Media processing (MDIA-01): when an attachment that already belongs to a message becomes ready
  // or failed, its message is bumped and re-broadcast, so the other phone's tile turns into the photo.
  const mediaRoot = path.join(config.DATA_DIR, "media")
  // QT-4qu-key: media at rest is AES-256-GCM. A MediaKeyError (missing key while encrypted media
  // exists, malformed key, unreadable path) propagates: buildApp rejects and index.ts exits 1.
  let loaded: Awaited<ReturnType<typeof loadMediaKey>>
  try {
    loaded = await loadMediaKey({ keyFile: config.MEDIA_KEY_FILE, mediaRoot })
  } catch (err) {
    sqlite.close()
    throw err
  }
  const { key, created, loosePermissions } = loaded
  if (created) {
    app.log.warn(
      { evt: "media_key", path: config.MEDIA_KEY_FILE, created },
      "new media key created: back this file up, without it every stored photo, video and voice note is unreadable",
    )
  } else {
    app.log.info({ evt: "media_key", path: config.MEDIA_KEY_FILE, created })
  }
  if (loosePermissions) {
    app.log.warn({ evt: "media_key_permissions", path: config.MEDIA_KEY_FILE }, "media key file is readable by group or others; chmod 600 it")
  }
  const media = createMediaProcessor({
    db,
    mediaRoot,
    log: app.log,
    key,
    onAttachmentChanged: (id) => {
      const message = messageChangedForAttachment(db, id)
      if (message) app.hub.broadcast({ t: "msg", message })
    },
  })
  app.decorate("media", media)
  // Boot: encrypt any plaintext media left from before QT-4qu (idempotent), then recovery: re-queue
  // attachments still processing, drop stale temp parts and uploads. Both finish before listen().
  app.addHook("onReady", async () => {
    await encryptMediaAtRest({ key, mediaRoot, log: app.log })
    await media.start()
  })
  // Before onClose closes the database: let a running job finish its write.
  app.addHook("preClose", async () => {
    await media.close()
  })

  app.get("/healthz", async () => ({ ok: true }))

  await app.register(usersRoutes)
  await app.register(authRoutes)
  await app.register(rtcRoutes, { fetch: deps.fetch ?? globalThis.fetch, timeoutMs: deps.turnTimeoutMs ?? 5000 })
  await app.register(callsRoutes)
  await app.register(chatRoutes)
  await app.register(pushRoutes)
  await app.register(wsRoutes)

  // One line at boot so a deploy without TURN is visible in the logs (never the key id or bearer).
  if (config.CF_TURN_KEY_ID && config.CF_TURN_KEY_API_TOKEN) {
    app.log.info({ evt: "turn_config", configured: true })
  } else {
    app.log.warn({ evt: "turn_config", configured: false })
  }

  // Same for Web Push (never a key value).
  if (config.VAPID_PUBLIC_KEY && config.VAPID_PRIVATE_KEY && config.VAPID_SUBJECT) {
    app.log.info({ evt: "push_config", configured: true })
  } else {
    app.log.warn({ evt: "push_config", configured: false })
  }

  // Static export (web/out). Skipped when it has not been built (tests, server-only dev).
  const hasStatic = existsSync(config.WEB_OUT)
  if (hasStatic) {
    await app.register(fastifyStatic, {
      root: config.WEB_OUT,
      redirect: true,
      // Keep the default `wildcard` option: `wildcard: false` crashes at boot.
      // @fastify/static v10: the first argument is the Fastify reply (Pitfall 7).
      setHeaders(reply, filePath) {
        if (filePath.endsWith(".html") || filePath.endsWith("sw.js") || filePath.endsWith(".webmanifest")) {
          reply.header("Cache-Control", "no-cache")
        } else if (filePath.includes("/_next/static/")) {
          reply.header("Cache-Control", "public, max-age=31536000, immutable")
        }
      },
    })
  }

  await app.register(uploadRoutes, { processor: media, mediaRoot, key })
  await app.register(profileRoutes, { processor: media, mediaRoot, key })
  await app.register(mediaRoutes, { mediaRoot, key })

  app.setNotFoundHandler((req, reply) => {
    if (isApiPath(req.url)) {
      return reply.code(404).send({ error: "not_found" })
    }
    if (hasStatic && existsSync(`${config.WEB_OUT}/404.html`)) {
      return reply.code(404).type("text/html").sendFile("404.html")
    }
    return reply.code(404).send({ error: "not_found" })
  })

  return app
}
