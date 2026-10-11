/**
 * Platform checks for onboarding (SHEL-03, D-16). iPadOS reports itself as a Mac, so a touch-capable
 * "MacIntel" counts as iOS too.
 */
export function isIos(): boolean {
  if (typeof navigator === "undefined") return false
  return /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1)
}

/** Launched from the Home Screen (installed PWA) rather than in a browser tab. */
export function isStandalone(): boolean {
  if (typeof window === "undefined") return false
  return (
    window.matchMedia("(display-mode: standalone)").matches ||
    (navigator as Navigator & { standalone?: boolean }).standalone === true
  )
}
