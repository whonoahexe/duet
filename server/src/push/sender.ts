import { randomUUID } from "node:crypto"
import { and, count, eq, gt } from "drizzle-orm"
import type { FastifyBaseLogger } from "fastify"
import webpush from "web-push"
import { messageLabel, PUSH_TOPIC_CHAT, PUSH_TOPIC_TEST, truncateGraphemes, type MessageDto, type PushPayload } from "@duet/shared"
import type { Config } from "../config"
import type { Db } from "../db/client"
import { messages, pushSubscriptions, readState } from "../db/schema"

/** web-push's sendNotification shape; injected in tests so nothing reaches a real push service. */
export type WebPushSend = (
  subscription: webpush.PushSubscription,
  payload: string,
  options: webpush.RequestOptions,
) => Promise<unknown>

/** D-13: the notification body is cut to this many grapheme clusters plus "…". */
export const PUSH_BODY_MAX_GRAPHEMES = 120
/** Apple rejects payloads over 4 KB; keep the JSON well under that after encryption overhead. */
export const PUSH_PAYLOAD_MAX_BYTES = 3072
/** Push services keep an undelivered message for a day; Apple coalesces by topic meanwhile. */
const PUSH_TTL_SECONDS = 86_400
const PUSH_TIMEOUT_MS = 10_000

/**
 * SSRF guard (T-02-14): the server only ever POSTs to the real browser push services. https only,
 * default port, no credentials, and a host from: FCM (Chrome/Android), *.push.apple.com (Safari/iOS),
 * Mozilla autopush, Windows WNS.
 */
export function isAllowedPushEndpoint(raw: string): boolean {
  let u: URL
  try {
    u = new URL(raw)
  } catch {
    return false
  }
  if (u.protocol !== "https:" || u.port !== "" || u.username !== "" || u.password !== "") return false
  const host = u.hostname.toLowerCase()
  return (
    host === "fcm.googleapis.com" ||
    host.endsWith(".push.apple.com") ||
    host === "updates.push.services.mozilla.com" ||
    host.endsWith(".notify.windows.com")
  )
}

type SubscriptionRow = typeof pushSubscriptions.$inferSelect

export interface PushSender {
  /** True when the VAPID pair and subject are configured. Otherwise nothing is ever sent. */
  configured: boolean
  publicKey: string | null
  /** Push "{senderName}: {label}" to every saved subscription of the recipient. Returns successes. */
  notifyMessage(recipientId: string, message: MessageDto, senderName: string): Promise<number>
  /** SHEL-03: push the test notification to this session's subscriptions only. Returns successes. */
  sendTest(sessionId: string): Promise<number>
  /** Upsert a subscription by endpoint, re-binding it to this user and session. */
  saveSubscription(userId: string, sessionId: string, sub: { endpoint: string; p256dh: string; auth: string }): void
}

export interface PushSenderDeps {
  db: Db
  config: Config
  log: FastifyBaseLogger
  send?: WebPushSend
}

/** Cut the body until the JSON payload fits PUSH_PAYLOAD_MAX_BYTES (emoji sequences can be long). */
export function buildPayload(t: PushPayload["t"], title: string, fullBody: string): string {
  const safeTitle = truncateGraphemes(title, 60)
  let max = PUSH_BODY_MAX_GRAPHEMES
  for (;;) {
    const payload: PushPayload = { t, title: safeTitle, body: truncateGraphemes(fullBody, max) }
    const json = JSON.stringify(payload)
    if (Buffer.byteLength(json, "utf8") <= PUSH_PAYLOAD_MAX_BYTES || max <= 10) return json
    max = Math.floor(max / 2)
  }
}

export function createPushSender({ db, config, log, send }: PushSenderDeps): PushSender {
  const configured = Boolean(config.VAPID_PUBLIC_KEY && config.VAPID_PRIVATE_KEY && config.VAPID_SUBJECT)
  if (configured) {
    webpush.setVapidDetails(config.VAPID_SUBJECT!, config.VAPID_PUBLIC_KEY!, config.VAPID_PRIVATE_KEY!)
  }
  const doSend: WebPushSend = send ?? webpush.sendNotification

  /** One send. 404/410 means the subscription is gone for good: delete it. Logs code + host only. */
  async function sendOne(sub: SubscriptionRow, payload: string, topic: string): Promise<boolean> {
    try {
      await doSend({ endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } }, payload, {
        TTL: PUSH_TTL_SECONDS,
        urgency: "high",
        topic,
        timeout: PUSH_TIMEOUT_MS,
      })
      db.update(pushSubscriptions).set({ lastOkAt: new Date() }).where(eq(pushSubscriptions.id, sub.id)).run()
      return true
    } catch (err) {
      const status = (err as { statusCode?: unknown } | null)?.statusCode
      const code = typeof status === "number" ? status : 0
      if (code === 404 || code === 410) {
        db.delete(pushSubscriptions).where(eq(pushSubscriptions.id, sub.id)).run()
      }
      let host = "invalid"
      try {
        host = new URL(sub.endpoint).host
      } catch {
        /* keep "invalid" */
      }
      // Never the endpoint path or keys (T-02-16): the path is a per-device capability.
      log.warn({ evt: "push_failed", code, host, pruned: code === 404 || code === 410 })
      return false
    }
  }

  async function sendAll(subs: SubscriptionRow[], payload: string, topic: string): Promise<number> {
    const results = await Promise.all(subs.map((s) => sendOne(s, payload, topic)))
    return results.filter(Boolean).length
  }

  return {
    configured,
    publicKey: configured ? config.VAPID_PUBLIC_KEY! : null,

    async notifyMessage(recipientId, message, senderName) {
      if (!configured) return 0
      const subs = db.select().from(pushSubscriptions).where(eq(pushSubscriptions.userId, recipientId)).all()
      if (subs.length === 0) return 0

      // D-13: "{name} · {n} new messages" once 2+ of the sender's messages are unread by the recipient.
      const lastRead =
        db.select({ seq: readState.lastReadSeq }).from(readState).where(eq(readState.userId, recipientId)).get()?.seq ?? 0
      const unread =
        db
          .select({ n: count() })
          .from(messages)
          .where(and(eq(messages.senderId, message.senderId), gt(messages.seq, lastRead)))
          .get()?.n ?? 1
      const title = unread >= 2 ? `${senderName} · ${unread} new messages` : senderName
      const payload = buildPayload("chat", title, messageLabel(message))
      const ok = await sendAll(subs, payload, PUSH_TOPIC_CHAT)
      log.info({ evt: "push_sent", userId: recipientId, seq: message.seq, subs: subs.length, ok })
      return ok
    },

    async sendTest(sessionId) {
      if (!configured) return 0
      const subs = db.select().from(pushSubscriptions).where(eq(pushSubscriptions.sessionId, sessionId)).all()
      if (subs.length === 0) return 0
      return sendAll(subs, buildPayload("test", "duet", "Test notification. You're all set."), PUSH_TOPIC_TEST)
    },

    saveSubscription(userId, sessionId, sub) {
      db.insert(pushSubscriptions)
        .values({
          id: randomUUID(),
          userId,
          sessionId,
          endpoint: sub.endpoint,
          p256dh: sub.p256dh,
          auth: sub.auth,
          createdAt: new Date(),
        })
        .onConflictDoUpdate({
          target: pushSubscriptions.endpoint,
          set: { userId, sessionId, p256dh: sub.p256dh, auth: sub.auth, createdAt: new Date() },
        })
        .run()
    },
  }
}
