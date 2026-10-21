import { randomUUID } from "node:crypto"
import { and, count, eq, gt, inArray, or } from "drizzle-orm"
import type { FastifyBaseLogger } from "fastify"
import webpush from "web-push"
import { messageTypeLabel, truncateGraphemes, type MessageDto, type PushPayload } from "@duet/shared"
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
/**
 * Push services keep an undelivered message for a day. No Topic header is sent to any push service:
 * since about mid-September 2026 web.push.apple.com answers any Topic with 400 BadWebPushTopic
 * (G-02-7). Collapsing into one notification happens on the device instead: the service worker
 * closes the previous duet notification before showing the next (D-14).
 */
const PUSH_TTL_SECONDS = 86_400
const PUSH_TIMEOUT_MS = 10_000
/**
 * D-09: an incoming-call push is worthless once the ring is over (45 s), so the push service drops it
 * instead of delivering a stale "Incoming call" to a phone that comes back online later.
 */
export const CALL_PUSH_TTL_SECONDS = 45

/** UI-SPEC section 9: the body of an incoming or missed call push. */
export function callPushBody(kind: "voice" | "video", which: "incoming" | "missed"): string {
  const icon = kind === "video" ? "🎥" : "📞"
  return `${icon} ${which === "incoming" ? "Incoming" : "Missed"} ${kind} call`
}

/** The push service's refusal reason is cut to this many code points before it is logged. */
export const PUSH_REASON_MAX_CHARS = 120

/** Apple-style reason codes ("BadWebPushTopic", "BadJwtToken") are logged as-is. */
const REASON_CODE = /^[A-Za-z0-9_.-]{1,64}$/
/** Endpoint path segments at least this long are capabilities (device tokens) and get redacted. */
const SECRET_SEGMENT_MIN_CHARS = 8

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

/**
 * A short, log-safe reason from a push service's error body (T-02-36, T-02-37), or undefined.
 * Identifier-shaped JSON `reason` codes pass through; any other text has the endpoint's path
 * segments replaced with "[redacted]" and URLs with "[url]", control characters flattened to spaces,
 * whitespace collapsed, and is capped at PUSH_REASON_MAX_CHARS code points.
 */
export function pushFailureReason(body: unknown, endpoint: string): string | undefined {
  if (typeof body !== "string" || body.trim() === "") return undefined
  let text = body
  try {
    const parsed: unknown = JSON.parse(body)
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
      const obj = parsed as Record<string, unknown>
      if (typeof obj.reason === "string" && REASON_CODE.test(obj.reason)) return obj.reason
      const field = [obj.reason, obj.message, obj.error].find((v): v is string => typeof v === "string")
      if (field !== undefined) text = field
    }
  } catch {
    /* plain text body */
  }
  let segments: string[] = []
  try {
    segments = new URL(endpoint).pathname.split("/").filter((seg) => seg.length >= SECRET_SEGMENT_MIN_CHARS)
  } catch {
    /* not a URL: nothing to redact by segment */
  }
  for (const seg of segments) {
    text = text.replace(new RegExp(escapeRegExp(seg), "g"), "[redacted]")
    // A URL-decoded copy of the segment is the same capability.
    let decoded = seg
    try {
      decoded = decodeURIComponent(seg)
    } catch {
      /* keep the raw segment */
    }
    if (decoded !== seg) text = text.replace(new RegExp(escapeRegExp(decoded), "g"), "[redacted]")
  }
  text = text
    .replace(/https?:\/\/\S+/gi, "[url]")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
  const capped = [...text].slice(0, PUSH_REASON_MAX_CHARS).join("").trim()
  return capped === "" ? undefined : capped
}

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
  /**
   * Push the sender's name as the title and the type-only label (messageTypeLabel) as the body,
   * never the text or a caption, to every saved subscription of the recipient. A sender photo id
   * becomes the payload's `avatar` (QT-5zd-push-icon). Returns successes.
   */
  notifyMessage(recipientId: string, message: MessageDto, senderName: string, senderPhotoId?: string | null): Promise<number>
  /**
   * D-09 / D-11: "Incoming voice call" (or video) to every subscription of the callee except those of
   * sessions for which `skipSession` is true (they show the in-app incoming screen already). TTL
   * CALL_PUSH_TTL_SECONDS. A caller photo id becomes the payload's `avatar`. Returns successes.
   */
  notifyCall(
    recipientId: string,
    call: CallPushInfo,
    callerName: string,
    skipSession: (sessionId: string) => boolean,
    callerPhotoId?: string | null,
  ): Promise<number>
  /**
   * D-12: "Missed voice call" (or video) after a ring that was cancelled or not answered, to the same
   * subscriptions as notifyCall; it replaces the incoming notification on the phone. Default TTL.
   * A caller photo id becomes the payload's `avatar`.
   */
  notifyMissedCall(
    recipientId: string,
    call: CallPushInfo,
    callerName: string,
    skipSession: (sessionId: string) => boolean,
    callerPhotoId?: string | null,
  ): Promise<number>
  /** SHEL-03: push the test notification to this session's subscriptions only. Returns successes. */
  sendTest(sessionId: string): Promise<number>
  /** Upsert a subscription by endpoint, re-binding it to this user and session. */
  saveSubscription(userId: string, sessionId: string, sub: { endpoint: string; p256dh: string; auth: string }): void
}

/** What a call push needs to know about the call. */
export interface CallPushInfo {
  id: string
  kind: "voice" | "video"
}

export interface PushSenderDeps {
  db: Db
  config: Config
  log: FastifyBaseLogger
  send?: WebPushSend
}

/** Cut the body until the JSON payload fits PUSH_PAYLOAD_MAX_BYTES (emoji sequences can be long). */
export function buildPayload(
  t: PushPayload["t"],
  title: string,
  fullBody: string,
  extra?: Pick<PushPayload, "callId" | "kind" | "avatar">,
): string {
  const safeTitle = truncateGraphemes(title, 60)
  let max = PUSH_BODY_MAX_GRAPHEMES
  for (;;) {
    const payload: PushPayload = { t, title: safeTitle, body: truncateGraphemes(fullBody, max), ...extra }
    const json = JSON.stringify(payload)
    if (Buffer.byteLength(json, "utf8") <= PUSH_PAYLOAD_MAX_BYTES || max <= 10) return json
    max = Math.floor(max / 2)
  }
}

/** `{ avatar }` only for a real photo id, so a payload without a photo is byte-identical to before. */
function avatarField(photoId: string | null | undefined): Pick<PushPayload, "avatar"> {
  return typeof photoId === "string" ? { avatar: photoId } : {}
}

export function createPushSender({ db, config, log, send }: PushSenderDeps): PushSender {
  const configured = Boolean(config.VAPID_PUBLIC_KEY && config.VAPID_PRIVATE_KEY && config.VAPID_SUBJECT)
  if (configured) {
    webpush.setVapidDetails(config.VAPID_SUBJECT!, config.VAPID_PUBLIC_KEY!, config.VAPID_PRIVATE_KEY!)
  }
  const doSend: WebPushSend = send ?? webpush.sendNotification

  /**
   * One send, without a Topic header (G-02-7). 404/410 means the subscription is gone for good:
   * delete it. Logs code, host and a sanitized reason only.
   */
  async function sendOne(sub: SubscriptionRow, payload: string, ttlSeconds = PUSH_TTL_SECONDS): Promise<boolean> {
    try {
      await doSend({ endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } }, payload, {
        TTL: ttlSeconds,
        urgency: "high",
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
      // Never the error object, the endpoint path or the keys (T-02-16): the path is a per-device
      // capability. The push service's body is reduced to a short sanitized reason (T-02-36).
      const reason = pushFailureReason((err as { body?: unknown } | null)?.body, sub.endpoint)
      const pruned = code === 404 || code === 410
      log.warn(reason === undefined ? { evt: "push_failed", code, host, pruned } : { evt: "push_failed", code, host, pruned, reason })
      return false
    }
  }

  async function sendAll(subs: SubscriptionRow[], payload: string, ttlSeconds = PUSH_TTL_SECONDS): Promise<number> {
    const results = await Promise.all(subs.map((s) => sendOne(s, payload, ttlSeconds)))
    return results.filter(Boolean).length
  }

  /**
   * One call push (incoming or missed) to the recipient's subscriptions minus the skipped sessions.
   * Logs the call id and counts only, never an endpoint or a key (T-03-12).
   */
  async function sendCallPush(
    evt: "push_call" | "push_call_missed",
    recipientId: string,
    call: CallPushInfo,
    payload: string,
    ttlSeconds: number,
    skipSession: (sessionId: string) => boolean,
  ): Promise<number> {
    if (!configured) return 0
    const all = db.select().from(pushSubscriptions).where(eq(pushSubscriptions.userId, recipientId)).all()
    const subs = all.filter((s) => !skipSession(s.sessionId))
    const ok = subs.length === 0 ? 0 : await sendAll(subs, payload, ttlSeconds)
    log.info({ evt, callId: call.id, subs: subs.length, skipped: all.length - subs.length, ok })
    return ok
  }

  return {
    configured,
    publicKey: configured ? config.VAPID_PUBLIC_KEY! : null,

    async notifyMessage(recipientId, message, senderName, senderPhotoId) {
      if (!configured) return 0
      const subs = db.select().from(pushSubscriptions).where(eq(pushSubscriptions.userId, recipientId)).all()
      if (subs.length === 0) return 0

      // D-13: "{name} · {n} new messages" once 2+ of the sender's messages are unread by the recipient.
      // QT-nw9-call-unread: only real messages and missed calls count; other call lines and reminder
      // lines never do (shared countsAsUnread).
      const lastRead =
        db.select({ seq: readState.lastReadSeq }).from(readState).where(eq(readState.userId, recipientId)).get()?.seq ?? 0
      const unread =
        db
          .select({ n: count() })
          .from(messages)
          .where(
            and(
              eq(messages.senderId, message.senderId),
              gt(messages.seq, lastRead),
              or(
                inArray(messages.kind, ["text", "media", "voice"]),
                and(eq(messages.kind, "call"), eq(messages.callOutcome, "missed")),
              ),
            ),
          )
          .get()?.n ?? 1
      const title = unread >= 2 ? `${senderName} · ${unread} new messages` : senderName
      const payload = buildPayload("chat", title, messageTypeLabel(message), avatarField(senderPhotoId))
      const ok = await sendAll(subs, payload)
      log.info({ evt: "push_sent", userId: recipientId, seq: message.seq, subs: subs.length, ok })
      return ok
    },

    notifyCall(recipientId, call, callerName, skipSession, callerPhotoId) {
      const payload = buildPayload("call", callerName, callPushBody(call.kind, "incoming"), {
        callId: call.id,
        kind: call.kind,
        ...avatarField(callerPhotoId),
      })
      return sendCallPush("push_call", recipientId, call, payload, CALL_PUSH_TTL_SECONDS, skipSession)
    },

    notifyMissedCall(recipientId, call, callerName, skipSession, callerPhotoId) {
      const payload = buildPayload("call-missed", callerName, callPushBody(call.kind, "missed"), {
        callId: call.id,
        kind: call.kind,
        ...avatarField(callerPhotoId),
      })
      return sendCallPush("push_call_missed", recipientId, call, payload, PUSH_TTL_SECONDS, skipSession)
    },

    async sendTest(sessionId) {
      if (!configured) return 0
      const subs = db.select().from(pushSubscriptions).where(eq(pushSubscriptions.sessionId, sessionId)).all()
      if (subs.length === 0) return 0
      return sendAll(subs, buildPayload("test", "duet", "Test notification. You're all set."))
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
