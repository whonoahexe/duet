"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import { toast } from "sonner"
import { CaretLeftIcon, CaretUpIcon, LockSimpleIcon, MicrophoneIcon } from "@phosphor-icons/react"
import { formatDuration } from "@duet/shared"
import { InputGroupButton } from "@/components/ui/input-group"
import { startRecording, type Recording } from "@/lib/chat/recorder"
import { playSound } from "@/lib/sounds"
import { cn } from "@/lib/utils"

/** Gesture thresholds (D-10, UI-SPEC section 3). */
const TAP_MS = 300
const MIN_HOLD_MS = 1000
const CANCEL_DX = 96
const LOCK_DY = 64
/** The timer redraws this often. */
const TICK_MS = 250
/**
 * After switching to locked mode, Send ignores clicks this long: the click that ends a tap can land
 * on the Send button that just replaced the mic and would send a near-empty note.
 */
const LOCK_CLICK_GUARD_MS = 400

export const MIC_DENIED_TOAST =
  "duet can't use the microphone. Allow microphone access for duet in your phone's Settings, then try again."
export const TOO_SHORT_TOAST = "Too short. Hold to record, or tap the mic for hands-free."

/** idle -> starting (permission / mic opening) -> holding (finger down) or locked (hands-free). */
export type RecorderPhase = "idle" | "starting" | "holding" | "locked"

interface Press {
  pointerId: number
  x0: number
  y0: number
  t0: number
  /** The finger came up before the recording had started (tap, or the permission prompt). */
  releasedEarly: boolean
}

export interface VoiceRecorder {
  phase: RecorderPhase
  elapsedMs: number
  /** Pointer down on the mic: starts recording (D-10 hold / slide / lock / tap). */
  onMicPointerDown: (e: React.PointerEvent) => void
  /** Keyboard path (Enter/Space on the mic): start straight in locked mode. */
  startLocked: () => void
  /** Locked mode: stop and send (the Send button; ignores the click that ended the locking tap). */
  send: () => void
  /** Locked mode: throw it away (no confirmation, UI-SPEC). */
  discard: () => void
}

/**
 * Voice-note recording state for the composer (D-10, D-11). Release sends; sliding left more than
 * 96 px cancels with a haptic; sliding up more than 64 px locks; a tap under 300 ms starts locked; a
 * hold released between 300 ms and 1 s is discarded as too short. The pointer is tracked on window,
 * so the mic button may re-render or move without losing the gesture. Every way out releases the
 * microphone (recorder.ts). No length limit (D-11).
 */
export function useVoiceRecorder({ onSend }: { onSend: (blob: Blob, durationMs: number) => void }): VoiceRecorder {
  const [phase, setPhaseState] = useState<RecorderPhase>("idle")
  const [elapsedMs, setElapsedMs] = useState(0)
  const phaseRef = useRef<RecorderPhase>("idle")
  const recordingRef = useRef<Recording | null>(null)
  const pressRef = useRef<Press | null>(null)
  const detachRef = useRef<(() => void) | null>(null)
  const lockedAtRef = useRef(0)
  const onSendRef = useRef(onSend)
  useEffect(() => {
    onSendRef.current = onSend
  }, [onSend])

  const setPhase = useCallback((next: RecorderPhase) => {
    phaseRef.current = next
    setPhaseState(next)
    if (next === "idle") setElapsedMs(0)
  }, [])

  const detach = useCallback(() => {
    detachRef.current?.()
    detachRef.current = null
  }, [])

  const reset = useCallback(() => {
    detach()
    pressRef.current = null
    recordingRef.current = null
    setPhase("idle")
  }, [detach, setPhase])

  const discard = useCallback(() => {
    // Slide-to-cancel, too short and the Discard button: the stop click, only for a running recording.
    if (recordingRef.current !== null) playSound("record-stop")
    recordingRef.current?.cancel()
    reset()
  }, [reset])

  const send = useCallback(() => {
    const rec = recordingRef.current
    if (!rec) return reset()
    playSound("record-stop")
    const durationMs = Math.round(rec.elapsedMs())
    reset()
    void rec.stop().then((blob) => {
      if (blob.size > 0) onSendRef.current(blob, durationMs)
    })
  }, [reset])

  const lock = useCallback(() => {
    detach()
    pressRef.current = null
    lockedAtRef.current = performance.now()
    setPhase("locked")
  }, [detach, setPhase])

  const sendLocked = useCallback(() => {
    if (phaseRef.current !== "locked" || performance.now() - lockedAtRef.current < LOCK_CLICK_GUARD_MS) return
    send()
  }, [send])

  /** Open the mic; `locked` starts hands-free. Returns once recording runs (or failed). */
  const begin = useCallback(
    async (locked: boolean) => {
      setPhase("starting")
      const res = await startRecording({ onInterrupted: reset })
      if (phaseRef.current !== "starting") {
        // Cancelled while the mic was opening (a pointercancel, unmount): release it again at once.
        if (res.ok) res.recording.cancel()
        return
      }
      if (!res.ok) {
        reset()
        toast.error(MIC_DENIED_TOAST)
        return
      }
      recordingRef.current = res.recording
      playSound("record-start")
      // A tap, or a release while the permission prompt was up: carry on hands-free.
      if (locked || pressRef.current === null || pressRef.current.releasedEarly) lock()
      else setPhase("holding")
    },
    [lock, reset, setPhase]
  )

  const onMicPointerDown = useCallback(
    (e: React.PointerEvent) => {
      if (e.button !== 0 || phaseRef.current !== "idle") return
      e.preventDefault()
      const press: Press = {
        pointerId: e.pointerId,
        x0: e.clientX,
        y0: e.clientY,
        t0: performance.now(),
        releasedEarly: false,
      }
      pressRef.current = press

      const onMove = (ev: PointerEvent) => {
        if (ev.pointerId !== press.pointerId || phaseRef.current !== "holding") return
        if (ev.clientX - press.x0 < -CANCEL_DX) {
          navigator.vibrate?.(10)
          discard()
        } else if (ev.clientY - press.y0 < -LOCK_DY) {
          lock()
        }
      }
      const onUp = (ev: PointerEvent) => {
        if (ev.pointerId !== press.pointerId) return
        detach()
        if (phaseRef.current === "starting") {
          press.releasedEarly = true
          return
        }
        if (phaseRef.current !== "holding") return
        const held = performance.now() - press.t0
        if (held < TAP_MS) lock()
        else if (held < MIN_HOLD_MS) {
          discard()
          toast(TOO_SHORT_TOAST)
        } else send()
      }
      // The browser took the gesture over: keep the recording, hands-free.
      const onCancel = (ev: PointerEvent) => {
        if (ev.pointerId !== press.pointerId) return
        detach()
        if (phaseRef.current === "starting") press.releasedEarly = true
        else if (phaseRef.current === "holding") lock()
      }
      window.addEventListener("pointermove", onMove)
      window.addEventListener("pointerup", onUp)
      window.addEventListener("pointercancel", onCancel)
      detachRef.current = () => {
        window.removeEventListener("pointermove", onMove)
        window.removeEventListener("pointerup", onUp)
        window.removeEventListener("pointercancel", onCancel)
      }
      void begin(false)
    },
    [begin, detach, discard, lock, send]
  )

  const startLocked = useCallback(() => {
    if (phaseRef.current !== "idle") return
    pressRef.current = null
    void begin(true)
  }, [begin])

  // The timer (D-11: keeps counting past 59:59 as 1:00:00).
  useEffect(() => {
    if (phase !== "holding" && phase !== "locked") return
    const id = setInterval(() => setElapsedMs(recordingRef.current?.elapsedMs() ?? 0), TICK_MS)
    return () => clearInterval(id)
  }, [phase])

  // Leaving the chat while recording throws the recording away and frees the microphone.
  useEffect(
    () => () => {
      detachRef.current?.()
      recordingRef.current?.cancel()
      phaseRef.current = "idle"
    },
    []
  )

  return { phase, elapsedMs, onMicPointerDown, startLocked, send: sendLocked, discard }
}

/** The mic button (D-10): ghost while idle, accent and 1.25x under the finger, lock pill above. */
export function MicButton({ recorder }: { recorder: VoiceRecorder }) {
  const { phase } = recorder
  const active = phase === "starting" || phase === "holding"
  return (
    <span className="relative flex">
      {phase === "holding" && (
        <span
          data-testid="lock-hint"
          aria-hidden="true"
          className="pointer-events-none absolute bottom-full left-1/2 mb-4 flex w-11 -translate-x-1/2 flex-col items-center gap-1 rounded-full bg-muted py-2 text-muted-foreground"
        >
          <LockSimpleIcon className="size-4" />
          <CaretUpIcon className="size-4" />
        </span>
      )}
      <InputGroupButton
        variant={active ? "default" : "ghost"}
        size="icon-sm"
        className={cn(
          "size-11 touch-none rounded-full transition-transform duration-150 select-none [-webkit-touch-callout:none] motion-reduce:transition-none",
          phase === "holding" && "scale-125"
        )}
        aria-label="Record voice note"
        onPointerDown={recorder.onMicPointerDown}
        onContextMenu={(e) => e.preventDefault()}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault()
            recorder.startLocked()
          }
        }}
      >
        <MicrophoneIcon weight="fill" />
      </InputGroupButton>
    </span>
  )
}

/**
 * What replaces the text field while recording: the pulsing 8px destructive dot (static under
 * reduced motion), the 16px timer, and while holding "Slide to cancel" with CaretLeftIcon.
 */
export function RecordingStatus({ recorder }: { recorder: VoiceRecorder }) {
  return (
    <div data-testid="recording-row" className="flex min-h-11 min-w-0 flex-1 items-center gap-2 px-3">
      <span className="size-2 shrink-0 animate-pulse rounded-full bg-destructive motion-reduce:animate-none" />
      <span data-testid="recording-timer" className="text-base whitespace-nowrap tabular-nums">
        {formatDuration(recorder.elapsedMs)}
      </span>
      {recorder.phase === "holding" && (
        <span className="ml-auto flex items-center gap-1 text-sm whitespace-nowrap text-muted-foreground">
          <CaretLeftIcon className="size-3.5" />
          Slide to cancel
        </span>
      )}
    </div>
  )
}
