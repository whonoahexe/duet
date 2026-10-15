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
  t: "chat" | "test"
  title: string
  body: string
}
