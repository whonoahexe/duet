import { z } from "zod"

/** Longest push endpoint the server stores (real ones are ~200-500 characters). */
export const PUSH_ENDPOINT_MAX = 2048

const base64url = /^[A-Za-z0-9_-]+={0,2}$/

/**
 * POST /api/push/subscriptions body: exactly what PushSubscription.toJSON() returns. The endpoint
 * host is further limited to the known push services on the server (SSRF guard, T-02-14).
 */
export const PushSubscriptionBody = z.strictObject({
  endpoint: z
    .string()
    .max(PUSH_ENDPOINT_MAX)
    .refine((v) => {
      try {
        return new URL(v).protocol === "https:"
      } catch {
        return false
      }
    }, "endpoint must be an https URL"),
  expirationTime: z.number().nullable().optional(),
  keys: z.strictObject({
    /** Uncompressed P-256 public key, 65 bytes -> 87 base64url characters. */
    p256dh: z.string().min(80).max(100).regex(base64url),
    /** 16-byte auth secret -> 22 base64url characters. */
    auth: z.string().min(16).max(32).regex(base64url),
  }),
})
export type PushSubscriptionBody = z.infer<typeof PushSubscriptionBody>

/** GET /api/push/vapid-public-key: the applicationServerKey for pushManager.subscribe. */
export const VapidKeyResponse = z.object({ key: z.string().min(1) })
export type VapidKeyResponse = z.infer<typeof VapidKeyResponse>

/** POST /api/push/test: how many of this session's subscriptions accepted the test push. */
export const PushTestResponse = z.object({ sent: z.number().int().min(0) })
export type PushTestResponse = z.infer<typeof PushTestResponse>

/** What the service worker receives (JSON push payload). */
export interface PushPayload {
  /**
   * "call" rings a closed app (D-09); "call-missed" replaces that ring when nobody answered (D-12);
   * "reminder" is a fired reminder (QT-nw9-reminder-fire), its own notification that never replaces
   * the chat one.
   */
  t: "chat" | "test" | "call" | "call-missed" | "reminder"
  title: string
  body: string
  /** Call pushes only: the call's id (the tap opens /?call=<id> or /?missed=<id>). */
  callId?: string
  /** Call pushes only: voice or video. */
  kind?: "voice" | "video"
  /**
   * The sender's or caller's profile photo attachment id (QT-5zd-push-icon), absent without a photo.
   * The service worker turns it into /media/<id>/avatar-round itself (T-5zd-05), the photo as a circle
   * with transparent corners (QT-m25-sw-icon); Android shows it as the notification icon, iOS always
   * shows the app icon.
   */
  avatar?: string
}
