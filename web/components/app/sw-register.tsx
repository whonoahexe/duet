"use client"

import { useEffect } from "react"

/** Registers the minimal /sw.js (installability; push arrives in Phase 2). Renders nothing. */
export function SwRegister() {
  useEffect(() => {
    if (!("serviceWorker" in navigator)) return
    // Cloudflare's zone Browser Cache TTL rewrites the origin's no-cache on .js to max-age=14400,
    // so tell the browser to bypass the HTTP cache for SW update checks explicitly.
    navigator.serviceWorker.register("/sw.js", { scope: "/", updateViaCache: "none" }).catch((err: unknown) => {
      console.warn("duet: service worker registration failed", err)
    })
  }, [])
  return null
}
