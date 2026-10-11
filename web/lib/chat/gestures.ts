"use client"

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react"

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
  useLayoutEffect(() => {
    onOpenRef.current = onOpen
  })

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

/** Horizontal movement before a swipe is recognised (vertical scrolling always wins below it). */
export const SWIPE_DEAD_ZONE_PX = 8
/** Releasing at or past this distance starts a reply; the reply icon is fully visible here. */
export const SWIPE_TRIGGER_PX = 56
/** The bubble never travels further than this. */
export const SWIPE_MAX_PX = 72

export interface SwipeReply {
  /** Pointer handlers for the bubble (style it touch-action: pan-y). */
  handlers: {
    onPointerDown: (e: React.PointerEvent) => void
    onPointerMove: (e: React.PointerEvent) => void
    onPointerUp: (e: React.PointerEvent) => void
    onPointerCancel: (e: React.PointerEvent) => void
    /** Swallows the click that ends a swipe. */
    onClickCapture: (e: React.MouseEvent) => void
  }
  /** Current travel in px (0..SWIPE_MAX_PX). */
  offset: number
  /** 0..1, reaching 1 at SWIPE_TRIGGER_PX: the reply icon's opacity. */
  progress: number
  /** A finger (or mouse) is moving the bubble right now: no spring transition while true. */
  dragging: boolean
}

/**
 * Swipe right to reply (D-01, Pitfall 11) for every pointer type. The gesture is decided once the
 * pointer has moved more than 8 px: horizontal-and-rightward captures the pointer, anything else is
 * left to the browser (vertical scrolling). The bubble follows up to 72 px; releasing at 56 px or
 * more calls onReply with a haptic tick. The caller animates the spring back (200 ms, none under
 * prefers-reduced-motion) whenever dragging is false.
 */
export function useSwipeReply({ onReply, disabled = false }: { onReply: () => void; disabled?: boolean }): SwipeReply {
  const [offset, setOffset] = useState(0)
  const [dragging, setDragging] = useState(false)
  const start = useRef<{ x: number; y: number; id: number; mode: "pending" | "swipe" | "ignore" } | null>(null)
  const offsetRef = useRef(0)
  const swiped = useRef(false)
  const onReplyRef = useRef(onReply)
  useLayoutEffect(() => {
    onReplyRef.current = onReply
  })

  const end = useCallback((commit: boolean) => {
    const s = start.current
    start.current = null
    if (!s || s.mode !== "swipe") return
    if (commit && offsetRef.current >= SWIPE_TRIGGER_PX) {
      haptic()
      onReplyRef.current()
    }
    offsetRef.current = 0
    setOffset(0)
    setDragging(false)
  }, [])

  return {
    handlers: {
      onPointerDown(e) {
        if (disabled) return
        if (e.pointerType === "mouse" && e.button !== 0) return
        swiped.current = false
        start.current = { x: e.clientX, y: e.clientY, id: e.pointerId, mode: "pending" }
      },
      onPointerMove(e) {
        const s = start.current
        if (!s || s.id !== e.pointerId || s.mode === "ignore") return
        const dx = e.clientX - s.x
        const dy = e.clientY - s.y
        if (s.mode === "pending") {
          if (Math.abs(dx) <= SWIPE_DEAD_ZONE_PX && Math.abs(dy) <= SWIPE_DEAD_ZONE_PX) return
          if (Math.abs(dx) > Math.abs(dy) && dx > SWIPE_DEAD_ZONE_PX) {
            s.mode = "swipe"
            swiped.current = true
            setDragging(true)
            try {
              ;(e.currentTarget as Element).setPointerCapture(e.pointerId)
            } catch {
              // The pointer may already be gone; the gesture still ends on pointerup/cancel.
            }
          } else {
            s.mode = "ignore"
            return
          }
        }
        const next = Math.max(0, Math.min(SWIPE_MAX_PX, dx))
        if (next !== offsetRef.current) {
          offsetRef.current = next
          setOffset(next)
        }
      },
      onPointerUp() {
        end(true)
      },
      onPointerCancel() {
        end(false)
      },
      onClickCapture(e) {
        if (!swiped.current) return
        swiped.current = false
        e.preventDefault()
        e.stopPropagation()
      },
    },
    offset,
    progress: Math.min(1, offset / SWIPE_TRIGGER_PX),
    dragging,
  }
}

type AnyHandler = (e: unknown) => void

/** Run two gesture handler sets on one element: every event reaches both, in order. */
export function mergeHandlers<A extends object, B extends object>(a: A, b: B): A & B {
  const ra = a as Record<string, AnyHandler | undefined>
  const rb = b as Record<string, AnyHandler | undefined>
  const out: Record<string, AnyHandler> = {}
  for (const key of new Set([...Object.keys(ra), ...Object.keys(rb)])) {
    const fa = ra[key]
    const fb = rb[key]
    out[key] = (e) => {
      fa?.(e)
      fb?.(e)
    }
  }
  return out as A & B
}
