// duet service worker (Phase 1): installability only.
// No network interception on purpose: it would interfere with auth and Range requests.
// Push handlers arrive in Phase 2.
self.addEventListener("install", () => {
  self.skipWaiting()
})

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim())
})
