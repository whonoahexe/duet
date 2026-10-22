"use client"

import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react"
import {
  CameraRotateIcon,
  CaretDownIcon,
  MicrophoneSlashIcon,
  PhoneDisconnectIcon,
  VideoCameraIcon,
  WarningCircleIcon,
  WifiLowIcon,
} from "@phosphor-icons/react"
import { formatCallDuration } from "@duet/shared"
import { initials } from "@/components/app/login-tiles"
import { PersonAvatar } from "@/components/app/person-avatar"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog"
import { useBackClose } from "@/lib/back-close"
import { callStore, useCall, type CallState, type PipCorner } from "@/lib/call/store"
import { usePeer } from "@/lib/chat/store"
import { cn } from "@/lib/utils"

/** Full-screen dialog layout shared by the call and incoming screens (the Phase 2 viewer's classes). */
export const FULL_SCREEN_DIALOG =
  "top-0 left-0 flex h-dvh w-full max-w-none translate-x-0 translate-y-0 flex-col gap-0 rounded-none bg-background p-0 ring-0 sm:max-w-none data-open:zoom-in-100 data-closed:zoom-out-100"

/** Solid destructive (Hang up / Decline): the glyph is text-background for contrast (UI-SPEC Color). */
export const SOLID_DESTRUCTIVE = "bg-destructive text-background hover:bg-destructive/80 dark:bg-destructive dark:hover:bg-destructive/80"

/**
 * Mode A identity block (D-04): 96px avatar (the shared profile photo, initials without one,
 * QT-5zd-photo-calls), 20px name, 14px status line.
 */
export function CallIdentity({ name, photoId, status }: { name: string; photoId: string | null; status: ReactNode }) {
  return (
    <div className="flex flex-col items-center px-6 pt-[calc(4rem+env(safe-area-inset-top))]">
      <PersonAvatar name={name} photoId={photoId} size="lg" className="size-24" fallbackClassName="text-xl font-medium" />
      <span className="mt-6 max-w-full truncate text-xl font-medium tracking-tight">{name}</span>
      {/* The timer is not live (it would be read every second); the screen's own region announces changes. */}
      <span data-testid="call-status" aria-live="off" className="mt-1 text-sm text-muted-foreground tabular-nums">
        {status}
      </span>
    </div>
  )
}

/** Pressed (on) in-call toggle: an inversion of existing tokens, never accent (UI-SPEC Color). */
export const PRESSED_TOGGLE = "bg-foreground text-background hover:bg-foreground/90 dark:hover:bg-foreground/90"

/** A round 56px control in the pill (UI-SPEC control table). */
const CONTROL = "size-14 rounded-full"

/**
 * A <video> showing `stream`. srcObject is attached by a ref callback, so it re-attaches whenever the
 * element mounts again (the Dialog unmounts its content while closed). Always muted: call audio plays
 * through the separate <audio> in CallProvider.
 */
function StreamVideo({
  stream,
  className,
  testId,
  onFrame,
}: {
  stream: MediaStream | null
  className?: string
  testId?: string
  onFrame?: (el: HTMLVideoElement) => void
}) {
  const ref = useCallback(
    (el: HTMLVideoElement | null) => {
      if (!el) return
      if (el.srcObject !== stream) el.srcObject = stream
      if (stream) el.play().catch(() => {})
    },
    [stream],
  )
  return (
    <video
      ref={ref}
      autoPlay
      playsInline
      muted
      data-testid={testId}
      className={className}
      onLoadedData={onFrame ? (e) => onFrame(e.currentTarget) : undefined}
      onResize={onFrame ? (e) => onFrame(e.currentTarget) : undefined}
    />
  )
}

/**
 * Whether the remote video has decoded a frame while the peer's camera is on (Mode B, Pitfall 7). The
 * remote track exists from setup, so the camera flag gates it; videoWidth > 0 proves real frames. Polled
 * every 250 ms until the first frame, reset when the peer's camera turns off.
 */
function useRemoteFrame(peerCamera: boolean): [boolean, (el: HTMLVideoElement) => void] {
  const [frame, setFrame] = useState(false)
  const [el, setEl] = useState<HTMLVideoElement | null>(null)
  const onFrame = useCallback(
    (video: HTMLVideoElement) => {
      setEl(video)
      if (peerCamera && video.videoWidth > 0) setFrame(true)
    },
    [peerCamera],
  )
  useEffect(() => {
    if (!peerCamera) {
      setFrame(false)
      return
    }
    if (frame) return
    const timer = setInterval(() => {
      const video = el ?? document.querySelector<HTMLVideoElement>('[data-testid="remote-video"]')
      if (video && video.videoWidth > 0) setFrame(true)
    }, 250)
    return () => clearInterval(timer)
  }, [peerCamera, frame, el])
  return [peerCamera && frame, onFrame]
}

/** The running m:ss timer, re-rendered every second from the first inbound media. */
export function useElapsed(since: number | null): string {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (since === null) return
    setNow(Date.now())
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [since])
  return formatCallDuration(since === null ? 0 : now - since)
}

/** The status line, highest priority first (UI-SPEC section 2): terminal, Reconnecting…, Ringing…, Connecting…, timer. */
function statusText(call: CallState, elapsed: string): string {
  if (call.phase === "ended") return call.endText ?? ""
  if (call.reconnecting) return "Reconnecting…"
  if (call.phase === "ringing-out") return "Ringing…"
  if (call.phase === "connecting") return "Connecting…"
  return elapsed
}

/** What the visually hidden aria-live region says for each state (UI-SPEC Accessibility). */
function announcement(call: CallState): string {
  if (call.phase === "ended") {
    if (call.endState === "couldnt-connect") return "Couldn't connect"
    if (call.endState === "call-dropped") return "Call dropped"
    return call.endText ?? ""
  }
  if (call.reconnecting) return "Reconnecting…"
  if (call.phase === "ringing-out") return "Ringing…"
  if (call.phase === "connecting") return "Connecting…"
  if (call.phase === "live") return "Connected"
  return ""
}

/**
 * The terminal states with actions (UI-SPEC section 5): "Couldn't connect" (D-19) with its body and
 * Retry, or "Call dropped" (D-17) with Call back; both then Close. Icon, title, 32px, the stacked buttons.
 */
function TerminalActions({ dropped }: { dropped: boolean }) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center px-6 text-center">
      <WarningCircleIcon weight="fill" className="size-12 text-muted-foreground" />
      <span className="mt-4 text-xl font-medium tracking-tight">{dropped ? "Call dropped" : "Couldn't connect"}</span>
      {!dropped && <span className="mt-1 text-base text-muted-foreground">Check your connection and try again.</span>}
      <div className="mt-8 flex w-full max-w-xs flex-col gap-2">
        <Button variant="default" size="lg" className="w-full" onClick={() => (dropped ? callStore.callBack() : callStore.retry())}>
          {dropped ? "Call back" : "Retry"}
        </Button>
        <Button variant="ghost" size="lg" className="w-full" onClick={() => callStore.dismiss()}>
          Close
        </Button>
      </div>
    </div>
  )
}

/** D-20: the top bar's right slot while the connection is poor (never during Reconnecting…). */
function PoorBadge() {
  return (
    <Badge variant="secondary" data-testid="poor-connection">
      <WifiLowIcon />
      Poor connection
    </Badge>
  )
}

/** Movement under this many px is a tap on the self-view (swap); this much or more is a drag (UI-SPEC). */
const DRAG_THRESHOLD_PX = 8
const SNAP_MS = 200
/** D-02: the video controls fade this long after the last tap or control press. */
const AUTO_HIDE_MS = 4000

function reducedMotion(): boolean {
  return typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches
}

/**
 * Corner placement of the self-view: 16px inside the safe area, top corners below the 56px top bar,
 * bottom corners 16px above the control pill (88px tall) while the pill shows.
 */
function cornerClasses(corner: PipCorner, pillShown: boolean): string {
  const vertical = corner.startsWith("t")
    ? "top-[calc(env(safe-area-inset-top)+56px+16px)]"
    : pillShown
      ? "bottom-[calc(max(24px,env(safe-area-inset-bottom))+88px+16px)]"
      : "bottom-[calc(env(safe-area-inset-bottom)+16px)]"
  const horizontal = corner.endsWith("l")
    ? "left-[calc(env(safe-area-inset-left)+16px)]"
    : "right-[calc(env(safe-area-inset-right)+16px)]"
  return `${vertical} ${horizontal}`
}

/**
 * The self-view PiP (D-02): a 96x128 button. A drag of 8px or more follows the finger and snaps to the
 * nearest corner in 200ms (instant under reduced motion); a tap under 8px swaps the large and small
 * views. Pointer capture keeps the drag on the PiP when the finger leaves it.
 */
function SelfViewPip({
  corner,
  pillShown,
  children,
}: {
  corner: PipCorner
  pillShown: boolean
  children: ReactNode
}) {
  const ref = useRef<HTMLButtonElement>(null)
  const drag = useRef<{ id: number; x: number; y: number; moved: boolean } | null>(null)
  /** A drag just ended: the click that follows the pointerup is not a tap. */
  const dragged = useRef(false)
  /** Where the PiP was dropped, for the snap animation once the new corner is laid out. */
  const dropped = useRef<DOMRect | null>(null)

  /** Animate from the dropped position to the corner it is laid out at now (FLIP). */
  const animateFrom = useCallback((from: DOMRect) => {
    const el = ref.current
    if (!el) return
    el.style.transition = "none"
    el.style.transform = ""
    if (reducedMotion()) return
    const to = el.getBoundingClientRect()
    el.style.transform = `translate(${from.left - to.left}px, ${from.top - to.top}px)`
    void el.offsetWidth
    el.style.transition = `transform ${SNAP_MS}ms ease-out`
    el.style.transform = ""
  }, [])

  useLayoutEffect(() => {
    const from = dropped.current
    dropped.current = null
    if (from) animateFrom(from)
  }, [corner, animateFrom])

  function release(e: React.PointerEvent<HTMLButtonElement>) {
    const d = drag.current
    if (!d || d.id !== e.pointerId) return
    drag.current = null
    if (!d.moved) return
    dragged.current = true
    const el = e.currentTarget
    const rect = el.getBoundingClientRect()
    const cx = rect.left + rect.width / 2
    const cy = rect.top + rect.height / 2
    const next = `${cy < window.innerHeight / 2 ? "t" : "b"}${cx < window.innerWidth / 2 ? "l" : "r"}` as PipCorner
    if (next === corner) animateFrom(rect)
    else {
      dropped.current = rect
      callStore.setPipCorner(next)
    }
  }

  return (
    <button
      ref={ref}
      type="button"
      aria-label="Swap videos"
      data-testid="self-view"
      className={cn(
        "absolute z-20 h-32 w-24 touch-none overflow-hidden rounded-2xl bg-muted ring-1 ring-border outline-none focus-visible:ring-3 focus-visible:ring-ring/50",
        cornerClasses(corner, pillShown),
      )}
      onPointerDown={(e) => {
        dragged.current = false
        drag.current = { id: e.pointerId, x: e.clientX, y: e.clientY, moved: false }
        e.currentTarget.setPointerCapture?.(e.pointerId)
        e.currentTarget.style.transition = "none"
      }}
      onPointerMove={(e) => {
        const d = drag.current
        if (!d || d.id !== e.pointerId) return
        const dx = e.clientX - d.x
        const dy = e.clientY - d.y
        if (!d.moved && Math.hypot(dx, dy) >= DRAG_THRESHOLD_PX) d.moved = true
        if (d.moved) e.currentTarget.style.transform = `translate(${dx}px, ${dy}px)`
      }}
      onPointerUp={release}
      onPointerCancel={release}
      onClick={() => {
        if (dragged.current) {
          dragged.current = false
          return
        }
        callStore.swap()
      }}
    >
      {children}
    </button>
  )
}

/**
 * D-02 auto-hide: in Mode B the top bar and the pill fade 4 s after the last tap, control press or key
 * press, and come back on the next one. They never hide while `canHide` is false (Mode A, a status
 * other than the timer, keyboard focus inside them).
 */
function useAutoHide(canHide: boolean, open: boolean): { hidden: boolean; poke: () => void } {
  const [hidden, setHidden] = useState(false)
  const [activity, setActivity] = useState(0)
  const poke = useCallback(() => {
    setHidden(false)
    setActivity((n) => n + 1)
  }, [])
  useEffect(() => {
    if (!canHide || hidden) return
    const timer = setTimeout(() => setHidden(true), AUTO_HIDE_MS)
    return () => clearTimeout(timer)
  }, [canHide, hidden, activity])
  useEffect(() => {
    if (!open) return
    window.addEventListener("keydown", poke)
    return () => window.removeEventListener("keydown", poke)
  }, [open, poke])
  return { hidden: hidden && canHide, poke }
}

/** Keyboard / screen-reader focus inside a group keeps it from hiding (mouse and touch focus do not). */
function useFocusInside(): [boolean, { onFocus: (e: React.FocusEvent) => void; onBlur: (e: React.FocusEvent) => void }] {
  const [inside, setInside] = useState(false)
  return [
    inside,
    {
      onFocus: (e) => {
        if ((e.target as HTMLElement).matches?.(":focus-visible")) setInside(true)
      },
      onBlur: (e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setInside(false)
      },
    },
  ]
}

/**
 * The call screen (UI-SPEC section 2). Mode A (no remote video): who you are talking to and the status
 * line. Mode B (the peer's camera is on and a frame decoded): the remote video fills the screen under a
 * translucent top bar, and the bar and the pill auto-hide. Either mode shows the self-view while this
 * side's camera is on; tapping it swaps the large and small views. Open while a call rings out,
 * connects, runs, or shows its end text.
 */
export function CallScreen() {
  const call = useCall()
  // The narrow hook: this always-mounted screen must not re-render on every chat message.
  const peerPhotoId = usePeer()?.photoId ?? null
  const elapsed = useElapsed(call.phase === "live" ? call.mediaStartedAt : null)
  const [remoteFrame, onRemoteFrame] = useRemoteFrame(call.peerCamera)
  const ended = call.phase === "ended"
  const modeB = remoteFrame && !ended
  const selfOn = call.camera && call.localVideo !== null && !ended
  const swapped = call.swapped && selfOn
  /** A video fills the screen: the translucent top bar replaces the centered identity block. */
  const videoLayout = modeB || swapped
  const status = statusText(call, elapsed)
  const active = call.phase === "ringing-out" || call.phase === "connecting" || call.phase === "live"
  // D-06: a minimized call keeps running with this Dialog closed (the on-call bar brings it back).
  const open = call.screen === "open" && (active || (ended && (call.endText !== null || call.endState !== null)))
  // Back minimizes to the chat like Escape and never hangs up (same document, so capture keeps running).
  useBackClose(open, () => callStore.minimize())
  const failed = ended && call.endState !== null
  const showPill = !ended
  const [focusInside, focusHandlers] = useFocusInside()
  // Never auto-hide while a status other than the timer shows (Reconnecting…, Poor connection, UI-SPEC section 2).
  const { hidden, poke } = useAutoHide(modeB && call.phase === "live" && !call.reconnecting && !call.poor && !focusInside, open)
  const pillShown = showPill && !hidden
  const fade = cn("transition-opacity duration-200 motion-reduce:transition-none", hidden && "opacity-0")
  const mirrored = call.facing === "user" && "-scale-x-100"
  const showPoor = call.poor && !call.reconnecting && active

  const backToChat = active && (
    <Button variant="ghost" size="icon" aria-label="Back to chat" onClick={() => callStore.minimize()}>
      <CaretDownIcon />
    </Button>
  )

  const remoteVideo = call.remoteVideo && !ended && (
    <StreamVideo
      stream={call.remoteVideo}
      testId="remote-video"
      onFrame={onRemoteFrame}
      className={swapped ? "size-full object-cover" : cn("absolute inset-0 size-full bg-background object-cover", !modeB && "opacity-0")}
    />
  )

  return (
    <Dialog
      open={open}
      disablePointerDismissal
      onOpenChange={(next) => {
        // Escape (or any close request) minimizes; it never hangs up.
        if (!next) callStore.minimize()
      }}
    >
      <DialogContent showCloseButton={false} className={FULL_SCREEN_DIALOG} onPointerDownCapture={poke}>
        <DialogTitle className="sr-only">Call with {call.peerName}</DialogTitle>
        <div aria-live="polite" className="sr-only">
          {announcement(call)}
        </div>
        {/* Its own region: the badge is announced once per appearance and its removal says nothing. */}
        <div aria-live="polite" className="sr-only">
          {showPoor ? "Poor connection" : ""}
        </div>
        {/* The remote video stays mounted while a call runs, so its first frame is seen before Mode B. */}
        {swapped ? (
          <StreamVideo stream={call.localVideo} className={cn("absolute inset-0 size-full bg-background object-cover", mirrored)} />
        ) : (
          remoteVideo
        )}
        {failed ? (
          <TerminalActions dropped={call.endState === "call-dropped"} />
        ) : videoLayout ? (
          <>
            <div
              className={cn("relative z-10 bg-background/60 pt-[env(safe-area-inset-top)] backdrop-blur-md", fade)}
              inert={hidden}
              {...focusHandlers}
            >
              <div className="flex h-14 items-center gap-3 px-4">
                {backToChat}
                <div className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate text-sm font-medium">{call.peerName}</span>
                  <span data-testid="call-status" aria-live="off" className="text-xs text-muted-foreground tabular-nums">
                    {status}
                  </span>
                </div>
                {showPoor && <PoorBadge />}
              </div>
            </div>
            <div className="flex-1" />
          </>
        ) : (
          <>
            {active && (
              <div className="absolute inset-x-0 top-0 z-20 pt-[env(safe-area-inset-top)]">
                <div className="flex h-14 items-center px-4">
                  {backToChat}
                  <div className="flex-1" />
                  {showPoor && <PoorBadge />}
                </div>
              </div>
            )}
            <div data-testid="call-avatar" className="relative z-10">
              <CallIdentity name={call.peerName} photoId={peerPhotoId} status={status} />
            </div>
            <div className="flex-1" />
          </>
        )}
        {selfOn && (
          <SelfViewPip corner={call.pipCorner} pillShown={pillShown}>
            {!swapped ? (
              <StreamVideo stream={call.localVideo} className={cn("size-full object-cover", mirrored)} />
            ) : modeB ? (
              remoteVideo
            ) : peerPhotoId ? (
              <div className="flex size-full items-center justify-center">
                <PersonAvatar
                  name={call.peerName}
                  photoId={peerPhotoId}
                  size="lg"
                  className="size-16"
                  fallbackClassName="text-xl font-medium"
                  data-testid="pip-peer-photo"
                />
              </div>
            ) : (
              <span className="flex size-full items-center justify-center text-xl font-medium">{initials(call.peerName)}</span>
            )}
          </SelfViewPip>
        )}
        {swapped && !modeB && <div className="hidden">{remoteVideo}</div>}
        {showPill && (
          <div
            data-testid="call-controls"
            className={cn(
              "relative z-10 mx-auto mb-[max(24px,env(safe-area-inset-bottom))] flex items-center gap-4 rounded-4xl bg-background/60 px-4 py-4 backdrop-blur-md max-[379px]:gap-2",
              fade,
            )}
            inert={hidden}
            {...focusHandlers}
          >
            <Button
              size="icon"
              variant="secondary"
              className={cn(CONTROL, call.muted && PRESSED_TOGGLE)}
              aria-label="Mute"
              aria-pressed={call.muted}
              onClick={() => callStore.toggleMute()}
            >
              <MicrophoneSlashIcon weight="fill" className="size-6" />
            </Button>
            <Button
              size="icon"
              variant="secondary"
              className={cn(CONTROL, call.camera && PRESSED_TOGGLE)}
              aria-label="Camera"
              aria-pressed={call.camera}
              onClick={() => void callStore.toggleCamera()}
            >
              <VideoCameraIcon weight="fill" className="size-6" />
            </Button>
            {call.camera && (
              <Button
                size="icon"
                variant="secondary"
                className={CONTROL}
                aria-label="Switch camera"
                onClick={() => void callStore.flip()}
              >
                <CameraRotateIcon weight="fill" className="size-6" />
              </Button>
            )}
            <Button
              size="icon"
              variant="destructive"
              className={`size-14 rounded-full ${SOLID_DESTRUCTIVE}`}
              aria-label={call.phase === "ringing-out" ? "Cancel call" : "Hang up"}
              onClick={() => callStore.hangUp()}
            >
              <PhoneDisconnectIcon weight="fill" className="size-6" />
            </Button>
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}
