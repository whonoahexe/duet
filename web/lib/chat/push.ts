import { toast } from "sonner"
import { OkResponse, PushTestResponse, VapidKeyResponse } from "@duet/shared"
import { apiGet, apiPost } from "@/lib/api"
import { OPEN_CHAT_EVENT } from "@/lib/chat/events"
import { isIos } from "@/lib/platform"

/**
 * Client side of Web Push (NOTF-01, SHEL-03). The service worker is registered by SwRegister; this
 * module only uses navigator.serviceWorker.ready, never registers again.
 *
 * - "unsupported": no service worker / PushManager / Notification (e.g. iOS Safari outside the app).
 * - "blocked": permission denied; the page cannot ask again.
 * - "off": not granted yet, or granted with no subscription on this device.
 * - "on": granted and subscribed.
 */
export type PushState = "unsupported" | "blocked" | "off" | "on"

let registration: ServiceWorkerRegistration | null = null
let vapidKey: string | null = null
let preparing: Promise<void> | null = null

export function pushSupported(): boolean {
  return (
    typeof window !== "undefined" &&
    "serviceWorker" in navigator &&
    "PushManager" in window &&
    "Notification" in window
  )
}

/** navigator.serviceWorker.ready never settles when registration failed: give up after a while. */
function swReady(timeoutMs = 10_000): Promise<ServiceWorkerRegistration> {
  return Promise.race([
    navigator.serviceWorker.ready,
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error("service worker not ready")), timeoutMs)),
  ])
}

async function fetchVapidKey(): Promise<string> {
  const { key } = await apiGet("/api/push/vapid-public-key", VapidKeyResponse)
  vapidKey = key
  return key
}

/**
 * Pre-resolve the service worker registration and the VAPID key on mount, so the Enable tap does no
 * slow awaits before the permission prompt (iOS only shows it inside a direct user gesture).
 */
export function prepare(): Promise<void> {
  if (!pushSupported()) return Promise.resolve()
  preparing ??= (async () => {
    try {
      registration = await swReady()
    } catch {
      /* resolved again on demand */
    }
    try {
      await fetchVapidKey()
    } catch {
      /* resolved again on demand */
    }
  })().finally(() => {
    preparing = null
  })
  return preparing
}

export async function getPushState(): Promise<PushState> {
  if (!pushSupported()) return "unsupported"
  if (Notification.permission === "denied") return "blocked"
  if (Notification.permission !== "granted") return "off"
  try {
    const reg = registration ?? (await swReady())
    registration = reg
    return (await reg.pushManager.getSubscription()) ? "on" : "off"
  } catch {
    return "off"
  }
}

function base64UrlToBytes(value: string): Uint8Array<ArrayBuffer> {
  const b64 = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=")
  const raw = atob(b64)
  const out = new Uint8Array(new ArrayBuffer(raw.length))
  for (let i = 0; i < raw.length; i += 1) out[i] = raw.charCodeAt(i)
  return out
}

function sameKey(a: ArrayBuffer | null | undefined, b: Uint8Array): boolean {
  if (!a) return false
  const x = new Uint8Array(a)
  return x.length === b.length && x.every((v, i) => v === b[i])
}

/** Save (upsert) this device's subscription on the server, bound to the current session. */
async function save(sub: PushSubscription): Promise<void> {
  await apiPost("/api/push/subscriptions", sub.toJSON(), OkResponse)
}

/**
 * The Enable tap (D-16). Notification.requestPermission() runs first, before any other await, so
 * the prompt stays attached to the user gesture. Resolves to the resulting state; throws when the
 * subscription could not be created or saved (the caller toasts).
 */
export async function enablePush(): Promise<PushState> {
  if (!pushSupported()) return "unsupported"
  const permission = await Notification.requestPermission()
  if (permission === "denied") return "blocked"
  if (permission !== "granted") return "off"

  const reg = registration ?? (await swReady())
  registration = reg
  const key = base64UrlToBytes(vapidKey ?? (await fetchVapidKey()))
  let sub = await reg.pushManager.getSubscription()
  // A subscription made for another VAPID key can never receive our pushes: replace it.
  if (sub && !sameKey(sub.options.applicationServerKey, key)) {
    await sub.unsubscribe().catch(() => false)
    sub = null
  }
  sub ??= await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key })
  await save(sub)
  return "on"
}

/** SHEL-03: push "Test notification" to this phone. Toasts the outcome (UI-SPEC copy). */
export async function sendTestPush(): Promise<boolean> {
  try {
    const { sent } = await apiPost("/api/push/test", {}, PushTestResponse)
    if (sent >= 1) {
      toast.success("Test sent. It should arrive in a few seconds.")
      return true
    }
  } catch {
    /* falls through to the failure toast */
  }
  toast.error("Couldn't send the test. Check your connection and try again.")
  return false
}

/**
 * On every launch while logged in with permission granted, re-save the current subscription. iOS
 * drops subscriptions silently and never fires pushsubscriptionchange; the upsert also re-binds the
 * subscription to the current session. Never prompts.
 */
export async function syncSubscription(): Promise<void> {
  if (!pushSupported() || Notification.permission !== "granted") return
  try {
    const reg = registration ?? (await swReady())
    registration = reg
    const sub = await reg.pushManager.getSubscription()
    if (sub) await save(sub)
  } catch {
    /* best effort: the next launch tries again */
  }
}

/** Close duet's notifications once the chat is on screen (the tray clears when the chat is read). */
export async function clearNotifications(): Promise<void> {
  if (!pushSupported()) return
  try {
    const reg = registration ?? (await swReady(3000))
    const open = await reg.getNotifications()
    for (const n of open) n.close()
  } catch {
    /* nothing to clear */
  }
}

let bridged = false

/** A notification tap on an open window: the service worker posts {t: "open-chat"}. */
export function bridgeServiceWorkerMessages(): void {
  if (bridged || typeof navigator === "undefined" || !("serviceWorker" in navigator)) return
  bridged = true
  navigator.serviceWorker.addEventListener("message", (event: MessageEvent) => {
    const data = event.data as { t?: unknown } | null
    if (data && data.t === "open-chat") window.dispatchEvent(new Event(OPEN_CHAT_EVENT))
  })
}

/** Platform-specific "Notifications are blocked" instructions (Copywriting Contract). */
export function blockedInstructions(): string {
  return isIos()
    ? "Open Settings › Notifications › duet and turn on Allow Notifications, then come back."
    : "Long-press the duet icon › App info › Notifications and turn them on, then come back."
}
