"use client"

import { useCallback, useEffect, useRef } from "react"

/** Hold this long to open the message menu (D-01). */
export const LONG_PRESS_MS = 450
/** Movement beyond this cancels a long-press (the finger is scrolling or swiping). */
export const LONG_PRESS_SLOP_PX = 8

/** A light haptic tick. iOS has no navigator.vibrate, so it is optional (Pitfall 11). */
export function haptic(): void {
  try {
    navigator.vibrate?.(10)
  } catch {
    // Some browsers throw when vibration is blocked; the gesture still works without it.
  }
}

export interface LongPressHandlers {
  onPointerDown: (e: React.PointerEvent) => void
  onPointerMove: (e: React.PointerEvent) => void
  onPointerUp: (e: React.PointerEvent) => void
  onPointerCancel: (e: React.PointerEvent) => void
  onContextMenu: (e: React.MouseEvent) => void
  onKeyDown: (e: React.KeyboardEvent) => void
  /** Swallows the click that follows a long-press, so releasing never also counts as a tap. */
  onClickCapture: (e: React.MouseEvent) => void
}

/**
 * Long-press for every pointer type (D-01, Pitfall 11): a 450 ms timer cancelled by movement over
 * 8 px, pointerup or pointercancel. contextmenu (right-click, and Android's own long-press) always
 * calls preventDefault and opens through the same path; one gesture opens at most once, so Android
 * firing both the timer and contextmenu never toggles the menu twice. Enter on the focused element
 * itself also opens. The haptic fires once per open.
 */
export function useLongPress({ onOpen, disabled = false }: { onOpen: () => void; disabled?: boolean }): LongPressHandlers {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const start = useRef<{ x: number; y: number; id: number } | null>(null)
  /** The current gesture already opened the menu. */
  const fired = useRef(false)
  const onOpenRef = useRef(onOpen)
  onOpenRef.current = onOpen

  const clear = useCallback(() => {
    if (timer.current !== null) {
      clearTimeout(timer.current)
      timer.current = null
    }
  }, [])

  useEffect(() => clear, [clear])

  const open = useCallback(() => {
    if (fired.current) return
    fired.current = true
    haptic()
    onOpenRef.current()
  }, [])

  return {
    onPointerDown(e) {
      if (disabled) return
      // Right-click goes through contextmenu; only the primary button / a touch starts the timer.
      if (e.pointerType === "mouse" && e.button !== 0) return
      clear()
      fired.current = false
      start.current = { x: e.clientX, y: e.clientY, id: e.pointerId }
      timer.current = setTimeout(() => {
        timer.current = null
        open()
      }, LONG_PRESS_MS)
    },
    onPointerMove(e) {
      const s = start.current
      if (!s || s.id !== e.pointerId || timer.current === null) return
      if (Math.hypot(e.clientX - s.x, e.clientY - s.y) > LONG_PRESS_SLOP_PX) clear()
    },
    onPointerUp() {
      clear()
      start.current = null
    },
    onPointerCancel() {
      clear()
      start.current = null
    },
    onContextMenu(e) {
      if (disabled) return
      e.preventDefault()
      clear()
      // A right-click (no pointer gesture in progress) is a fresh gesture of its own.
      if (start.current === null) fired.current = false
      open()
    },
    onKeyDown(e) {
      if (disabled || e.key !== "Enter" || e.target !== e.currentTarget) return
      e.preventDefault()
      fired.current = false
      open()
    },
    onClickCapture(e) {
      if (!fired.current) return
      fired.current = false
      e.preventDefault()
      e.stopPropagation()
    },
  }
}
