// duet service worker: installability plus Web Push (NOTF-01, NOTF-02).
// No network interception on purpose: it would interfere with auth and Range requests on /media,
// /api and /ws. Never add any other event listener than the four below.
self.addEventListener("install", () => {
  self.skipWaiting()
})

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim())
})

// A call id as the server sends it (lowercase uuid). Anything else never reaches a URL (T-03-10).
const CALL_ID = /^[0-9a-f-]{36}$/

// Every push shows a notification on every path (iOS revokes push permission for pushes that show
// nothing, Pitfall 3). "Don't notify while viewing" is decided on the server, never here.
// Call pushes (D-09, D-12): "call" rings, "call-missed" replaces it; both carry the call id so a tap
// can open /?call=<id> or /?missed=<id>.
self.addEventListener("push", (event) => {
  let d = {}
  try {
    d = event.data ? event.data.json() : {}
  } catch {
    d = {}
  }
  if (!d || typeof d !== "object") d = {}
  const title = typeof d.title === "string" && d.title ? d.title : "duet"
  const body = typeof d.body === "string" && d.body ? d.body : "New message"
  const isCall = d.t === "call" || d.t === "call-missed"
  const tag = isCall ? "duet-call" : d.t === "test" ? "duet-test" : "duet-chat"
  let data = { url: "/" }
  if (isCall && typeof d.callId === "string" && CALL_ID.test(d.callId)) {
    data = { url: (d.t === "call" ? "/?call=" : "/?missed=") + d.callId, callId: d.callId }
  }
  event.waitUntil(
    (async () => {
      // D-14: one notification per kind. iOS ignores tag/renotify, so close what is showing first, but
      // only the same kind (WR-07): a chat push never removes "Incoming call" or "Missed call", and a
      // call push never removes the chat notification.
      try {
        const open = await self.registration.getNotifications()
        for (const n of open) if (isCall ? n.tag === "duet-call" : n.tag !== "duet-call") n.close()
      } catch {
        // keep going: the notification below must still show
      }
      await self.registration.showNotification(title, {
        body,
        tag,
        renotify: true,
        icon: "/icons/icon-192.png",
        // Android status-bar glyph: white duet heart on transparent (iOS ignores it).
        badge: "/icons/badge-96.png",
        data,
      })
    })(),
  )
})

// NOTF-02: a tap opens the chat. Focus an open duet window and ask it to scroll to the newest
// message, or open the app at "/", which lands on the chat.
// D-09 / D-10: a call notification posts {t: "open-call", callId} instead, or opens /?call=<id>
// (/?missed=<id>) when no window exists. On iOS both are hints only: the incoming screen comes from
// the server's ring-on-attach (Pitfall 4).
self.addEventListener("notificationclick", (event) => {
  event.notification.close()
  const data = event.notification.data || {}
  const callId = typeof data.callId === "string" && CALL_ID.test(data.callId) ? data.callId : null
  // Only the two links the push handler builds itself (T-03-10).
  const url = callId && (data.url === "/?call=" + callId || data.url === "/?missed=" + callId) ? data.url : "/"
  event.waitUntil(
    (async () => {
      const wins = await self.clients.matchAll({ type: "window", includeUncontrolled: true })
      for (const c of wins) {
        try {
          await c.focus()
        } catch {
          // focus can be refused; still tell the page
        }
        c.postMessage(callId ? { t: "open-call", callId } : { t: "open-chat" })
        return
      }
      await self.clients.openWindow(url)
    })(),
  )
})
