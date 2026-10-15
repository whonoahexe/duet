// duet service worker: installability plus Web Push (NOTF-01, NOTF-02).
// No network interception on purpose: it would interfere with auth and Range requests on /media,
// /api and /ws. Never add any other event listener than the four below.
self.addEventListener("install", () => {
  self.skipWaiting()
})

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim())
})

// Every push shows a notification on every path (iOS revokes push permission for pushes that show
// nothing, Pitfall 3). "Don't notify while viewing" is decided on the server, never here.
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
  event.waitUntil(
    (async () => {
      // D-14: one notification. iOS ignores tag/renotify, so close what is showing first.
      try {
        const open = await self.registration.getNotifications()
        for (const n of open) n.close()
      } catch {
        // keep going: the notification below must still show
      }
      await self.registration.showNotification(title, {
        body,
        tag: d.t === "test" ? "duet-test" : "duet-chat",
        renotify: true,
        icon: "/icons/icon-192.png",
        // Android status-bar glyph: white duet heart on transparent (iOS ignores it).
        badge: "/icons/badge-96.png",
        data: { url: "/" },
      })
    })(),
  )
})

// NOTF-02: a tap opens the chat. Focus an open duet window and ask it to scroll to the newest
// message, or open the app at "/", which lands on the chat.
self.addEventListener("notificationclick", (event) => {
  event.notification.close()
  event.waitUntil(
    (async () => {
      const wins = await self.clients.matchAll({ type: "window", includeUncontrolled: true })
      for (const c of wins) {
        try {
          await c.focus()
        } catch {
          // focus can be refused; still tell the page
        }
        c.postMessage({ t: "open-chat" })
        return
      }
      await self.clients.openWindow("/")
    })(),
  )
})
