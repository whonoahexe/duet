import { useEffect, useEffectEvent } from "react"

/**
 * Back closes the top overlay. An installed Android PWA closes when back has no history entry to
 * return to, and duet is a single page, so every open overlay (viewer, drawers, menus, the call
 * screen) holds one same-URL history entry while it is open. Back pops the newest entry and closes
 * its overlay; an overlay closed any other way (X, swipe, Escape, a menu item) gives its entry back,
 * so entries never pile up and a later back press is never swallowed.
 *
 * One entry per overlay rather than one shared sentinel: nested overlays never need a re-push from
 * a popstate handler, which Chrome's back-button intervention would skip (no user activation).
 *
 * Entries are pushed through Next's patched pushState with null state and no URL, so Next copies its
 * own router state into them and treats traversals between them as same-URL restores (never a
 * reload). Depth is tracked in memory, never through history.state.
 */

interface Entry {
  close: () => void
}

/** Open overlays, newest last. */
const stack: Entry[] = []
/** Entries this module pushed that are still behind the current position. */
let depth = 0
/** True between a traversal this module started and its popstate. */
let pendingBack = false
/** A document to navigate to once our entries are unwound (see leaveTo). */
let leavingTo: string | null = null
let scheduled = false
let listening = false

function onPopState() {
  if (pendingBack) {
    pendingBack = false
    schedule()
    return
  }
  // Not ours (no overlay entry behind us): Next handles it.
  if (depth === 0) return
  depth -= 1
  // Removed before close() runs, so the overlay's effect cleanup finds nothing and never traverses again.
  const entry = stack.pop()
  entry?.close()
  schedule()
}

/** Bring history in line with the stack. Runs once per tick, so a close and an open in one commit net out. */
function reconcile() {
  scheduled = false
  if (pendingBack) return
  if (leavingTo !== null) {
    if (depth > 0) {
      pendingBack = true
      const n = depth
      depth = 0
      window.history.go(-n)
    } else {
      const url = leavingTo
      leavingTo = null
      // eslint-disable-next-line @next/next/no-location-assign-relative-destination -- a full document load on purpose (a static export page outside the chat)
      window.location.assign(url)
    }
    return
  }
  while (stack.length > depth) {
    window.history.pushState(null, "")
    depth += 1
  }
  if (stack.length < depth) {
    pendingBack = true
    const n = depth - stack.length
    depth = stack.length
    window.history.go(-n)
  }
}

function schedule() {
  if (!listening) {
    listening = true
    window.addEventListener("popstate", onPopState)
  }
  if (scheduled) return
  scheduled = true
  setTimeout(reconcile, 0)
}

/** While `open`, the system back button calls `onClose` instead of leaving the app. */
export function useBackClose(open: boolean, onClose: () => void): void {
  const close = useEffectEvent(onClose)
  useEffect(() => {
    if (!open) return
    const entry: Entry = { close: () => close() }
    stack.push(entry)
    schedule()
    return () => {
      const i = stack.indexOf(entry)
      if (i !== -1) stack.splice(i, 1)
      schedule()
    }
  }, [open])
}

/**
 * Navigate to another document after our history entries are unwound: a traversal racing
 * location.assign can cancel the navigation.
 */
export function leaveTo(url: string): void {
  leavingTo = url
  schedule()
}
