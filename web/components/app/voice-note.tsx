"use client"

import { useEffect, useRef, useState } from "react"
import { PauseIcon, PlayIcon, WarningCircleIcon } from "@phosphor-icons/react"
import { VOICE_WAVEFORM_BARS, formatDuration } from "@duet/shared"
import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner"
import { claimPlayback, releasePlayback } from "@/lib/chat/playback"
import { cn } from "@/lib/utils"

/** Waveform drawing (UI-SPEC spacing exception): 2px bars, 2px apart, 4..32px tall. */
const BAR_W = 2
const BAR_GAP = 2
const MIN_H = 4
const MAX_H = 32
const SVG_W = VOICE_WAVEFORM_BARS * (BAR_W + BAR_GAP) - BAR_GAP
/** Arrow keys move this far (UI-SPEC). */
const KEY_STEP_MS = 5000

export interface VoiceNoteProps {
  /** The audio attachment, once uploaded. */
  attachmentId: string | null
  /** The server finished audio.m4a (status ready): only then is /media/{id}/audio requested. */
  ready: boolean
  /** The server could not process the recording. */
  failed: boolean
  /** The server's duration (or the recorder's, while the note is still going up). */
  durationMs: number | null
  /** 40 values 0..100 from the server; null shows flat placeholder bars (a pending note). */
  waveform: number[] | null
}

/**
 * Voice-note bubble body (D-12, MDIA-04, UI-SPEC section 3): an accent round play/pause button, the
 * 40-bar waveform that is also the scrubber (role slider, tap or drag with pointer capture, arrow
 * keys 5 s), and the duration (the total while idle, the elapsed time once started). Its length comes
 * from the server's durationMs, never from the media element (MediaRecorder output reports
 * Infinity/NaN). Starting it pauses any other note or video; at the end it resets to the start.
 */
export function VoiceNote({ attachmentId, ready, failed, durationMs, waveform }: VoiceNoteProps) {
  const audioRef = useRef<HTMLAudioElement>(null)
  const sliderRef = useRef<HTMLDivElement>(null)
  const [attempt, setAttempt] = useState(0)
  const [error, setError] = useState(false)
  const [playing, setPlaying] = useState(false)
  /** Between play() and the first "playing" (or a "waiting" stall): the button shows a Spinner. */
  const [buffering, setBuffering] = useState(false)
  const [positionMs, setPositionMs] = useState(0)
  /** A seek asked for before the element knew its metadata, applied on loadedmetadata. */
  const pendingSeekRef = useRef<number | null>(null)
  const draggingRef = useRef(false)

  const totalMs = durationMs ?? 0
  const playable = ready && attachmentId !== null && !failed
  const src = playable
    ? `/media/${encodeURIComponent(attachmentId)}/audio${attempt > 0 ? `?r=${attempt}` : ""}`
    : undefined
  const broken = failed || error
  const started = playing || positionMs > 0

  // Smooth progress while playing (timeupdate fires only about 4 times a second).
  useEffect(() => {
    if (!playing) return
    let raf = 0
    const tick = () => {
      const el = audioRef.current
      if (el && !draggingRef.current) setPositionMs(Math.min(totalMs, el.currentTime * 1000))
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [playing, totalMs])

  // Leaving the screen (unmount) or swapping the element (retry) stops playback and frees the
  // "now playing" slot. The element exists once src does.
  useEffect(() => {
    const el = audioRef.current
    return () => {
      if (!el) return
      el.pause()
      releasePlayback(el)
    }
  }, [src])

  function seekTo(ms: number) {
    const clamped = Math.max(0, Math.min(totalMs, ms))
    setPositionMs(clamped)
    const el = audioRef.current
    if (!el) return
    if (el.readyState >= 1) el.currentTime = clamped / 1000
    else pendingSeekRef.current = clamped
  }

  function toggle() {
    if (broken) {
      // Retry: a fresh URL so the browser does not reuse the failed response.
      setError(false)
      setAttempt((a) => a + 1)
      return
    }
    const el = audioRef.current
    if (!el || !playable) return
    if (!el.paused) {
      el.pause()
      return
    }
    claimPlayback(el)
    setBuffering(true)
    el.play().catch(() => setBuffering(false))
  }

  function fractionAt(clientX: number): number {
    const box = sliderRef.current?.getBoundingClientRect()
    if (!box || box.width === 0) return 0
    return Math.max(0, Math.min(1, (clientX - box.left) / box.width))
  }

  const progress = totalMs > 0 ? positionMs / totalMs : 0
  const playedBars = Math.round(progress * VOICE_WAVEFORM_BARS)
  const bars = waveform && waveform.length === VOICE_WAVEFORM_BARS ? waveform : null
  const valueNow = Math.round(positionMs / 100) / 10
  const valueMax = Math.round(totalMs / 100) / 10

  let icon: React.ReactNode
  if (broken) icon = <WarningCircleIcon weight="fill" />
  else if (!playable || buffering) icon = <Spinner />
  else if (playing) icon = <PauseIcon weight="fill" />
  else icon = <PlayIcon weight="fill" />

  return (
    <div className="flex w-full min-w-0 items-center gap-2" data-testid="voice-note">
      <Button
        type="button"
        variant="default"
        size="icon"
        className="size-11 shrink-0 rounded-full"
        aria-label={playing ? "Pause voice note" : "Play voice note"}
        disabled={!playable && !broken}
        onPointerDown={(e) => e.stopPropagation()}
        onClick={(e) => {
          e.stopPropagation()
          toggle()
        }}
      >
        {icon}
      </Button>
      <div
        ref={sliderRef}
        role="slider"
        tabIndex={playable ? 0 : -1}
        aria-label="Seek voice note"
        aria-valuemin={0}
        aria-valuemax={valueMax}
        aria-valuenow={valueNow}
        aria-valuetext={`${formatDuration(positionMs)} of ${formatDuration(totalMs)}`}
        aria-disabled={!playable}
        className="flex h-8 min-w-0 flex-1 touch-none items-center rounded-sm outline-none focus-visible:ring-3 focus-visible:ring-ring/30"
        onPointerDown={(e) => {
          e.stopPropagation()
          if (!playable || totalMs === 0) return
          e.currentTarget.setPointerCapture(e.pointerId)
          draggingRef.current = true
          seekTo(fractionAt(e.clientX) * totalMs)
        }}
        onPointerMove={(e) => {
          if (!draggingRef.current) return
          seekTo(fractionAt(e.clientX) * totalMs)
        }}
        onPointerUp={(e) => {
          draggingRef.current = false
          if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId)
        }}
        onPointerCancel={() => {
          draggingRef.current = false
        }}
        onKeyDown={(e) => {
          if (!playable) return
          if (e.key === "ArrowLeft") {
            e.preventDefault()
            e.stopPropagation()
            seekTo(positionMs - KEY_STEP_MS)
          } else if (e.key === "ArrowRight") {
            e.preventDefault()
            e.stopPropagation()
            seekTo(positionMs + KEY_STEP_MS)
          }
        }}
      >
        <svg
          viewBox={`0 0 ${SVG_W} ${MAX_H}`}
          width={SVG_W}
          height={MAX_H}
          preserveAspectRatio="none"
          aria-hidden="true"
          className="h-8 w-full max-w-[158px] min-w-0"
        >
          {Array.from({ length: VOICE_WAVEFORM_BARS }, (_, i) => {
            const v = bars ? bars[i] : 0
            const h = MIN_H + (v / 100) * (MAX_H - MIN_H)
            return (
              <rect
                key={i}
                x={i * (BAR_W + BAR_GAP)}
                y={(MAX_H - h) / 2}
                width={BAR_W}
                height={h}
                rx={1}
                fill="currentColor"
                className={i < playedBars ? "text-foreground" : "text-foreground/30"}
              />
            )
          })}
        </svg>
      </div>
      <span
        data-testid="voice-duration"
        className={cn(
          "shrink-0 text-xs font-medium whitespace-nowrap tabular-nums",
          broken ? "text-destructive" : "text-muted-foreground"
        )}
      >
        {broken ? "Couldn't load" : formatDuration(started ? positionMs : totalMs)}
      </span>
      {src && (
        <audio
          ref={audioRef}
          key={attempt}
          src={src}
          preload="metadata"
          className="hidden"
          onLoadedMetadata={(e) => {
            const pending = pendingSeekRef.current
            if (pending !== null) {
              pendingSeekRef.current = null
              e.currentTarget.currentTime = pending / 1000
            }
          }}
          onPlay={(e) => {
            claimPlayback(e.currentTarget)
            setPlaying(true)
          }}
          onPlaying={() => setBuffering(false)}
          onWaiting={() => setBuffering(true)}
          onPause={(e) => {
            setPlaying(false)
            setBuffering(false)
            setPositionMs(Math.min(totalMs, e.currentTarget.currentTime * 1000))
          }}
          onEnded={(e) => {
            e.currentTarget.currentTime = 0
            setPlaying(false)
            setBuffering(false)
            setPositionMs(0)
          }}
          onError={() => {
            setError(true)
            setPlaying(false)
            setBuffering(false)
          }}
        />
      )}
    </div>
  )
}
