"use client"

/**
 * Screen wake lock for the length of a call (CALL-08, D-21, research Pattern 8). The OS releases the
 * lock whenever duet is hidden, so while a call holds it every visibilitychange back to visible asks
 * again. A browser without the API (or a refused request) does nothing visible (UI-SPEC default).
 */

let wanted = false
let sentinel: WakeLockSentinel | null = null
let requesting = false
let listening = false

async function acquire(): Promise<void> {
  if (!wanted || sentinel || requesting) return
  if (typeof navigator === "undefined" || !navigator.wakeLock) return
  if (typeof document !== "undefined" && document.visibilityState !== "visible") return
  requesting = true
  try {
    const s = await navigator.wakeLock.request("screen")
    if (!wanted) {
      // The call ended while the request was in flight.
      s.release().catch(() => {})
      return
    }
    sentinel = s
    s.addEventListener("release", () => {
      if (sentinel === s) sentinel = null
    })
  } catch {
    // Refused (battery saver, not visible, unsupported in this context): stay quiet.
  } finally {
    requesting = false
  }
}

function onVisibilityChange(): void {
  if (wanted && document.visibilityState === "visible" && !sentinel) void acquire()
}

/** Keep the screen on until releaseWakeLock(); safe to call again (one lock at a time). */
export function holdWakeLock(): void {
  wanted = true
  if (!listening && typeof document !== "undefined") {
    document.addEventListener("visibilitychange", onVisibilityChange)
    listening = true
  }
  void acquire()
}

/** Let the screen sleep again and stop re-acquiring (every call end path, T-03-16). */
export function releaseWakeLock(): void {
  wanted = false
  const s = sentinel
  sentinel = null
  if (s && !s.released) s.release().catch(() => {})
}
