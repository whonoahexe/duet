"use client"

import { useCallback, useEffect, useState, type ReactNode } from "react"
import { PhoneDisconnectIcon, VideoCameraIcon, WarningCircleIcon } from "@phosphor-icons/react"
import { formatCallDuration } from "@duet/shared"
import { initials } from "@/components/app/login-tiles"
import { Avatar, AvatarFallback } from "@/components/ui/avatar"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog"
import { callStore, useCall, type CallState } from "@/lib/call/store"
import { cn } from "@/lib/utils"

/** Full-screen dialog layout shared by the call and incoming screens (the Phase 2 viewer's classes). */
export const FULL_SCREEN_DIALOG =
  "top-0 left-0 flex h-dvh w-full max-w-none translate-x-0 translate-y-0 flex-col gap-0 rounded-none bg-background p-0 ring-0 sm:max-w-none data-open:zoom-in-100 data-closed:zoom-out-100"

/** Solid destructive (Hang up / Decline): the glyph is text-background for contrast (UI-SPEC Color). */
export const SOLID_DESTRUCTIVE = "bg-destructive text-background hover:bg-destructive/80 dark:bg-destructive dark:hover:bg-destructive/80"

/** Mode A identity block (D-04): 96px initials avatar, 20px name, 14px status line. */
export function CallIdentity({ name, status }: { name: string; status: ReactNode }) {
  return (
    <div className="flex flex-col items-center px-6 pt-[calc(4rem+env(safe-area-inset-top))]">
      <Avatar className="size-24">
        <AvatarFallback className="text-xl font-medium">{initials(name)}</AvatarFallback>
      </Avatar>
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

function statusText(call: CallState, elapsed: string): string {
  if (call.phase === "ended") return call.endText ?? ""
  if (call.phase === "ringing-out") return "Ringing…"
  if (call.phase === "connecting") return "Connecting…"
  return elapsed
}

/** What the visually hidden aria-live region says for each state (UI-SPEC Accessibility). */
function announcement(call: CallState): string {
  if (call.phase === "ended") return call.endState === "couldnt-connect" ? "Couldn't connect" : (call.endText ?? "")
  if (call.phase === "ringing-out") return "Ringing…"
  if (call.phase === "connecting") return "Connecting…"
  if (call.phase === "live") return "Connected"
  return ""
}

/** "Couldn't connect" (D-19, UI-SPEC section 5): icon, title, body, then Retry (accent) and Close. */
function CouldntConnect() {
  return (
    <div className="flex flex-1 flex-col items-center justify-center px-6 text-center">
      <WarningCircleIcon weight="fill" className="size-12 text-muted-foreground" />
      <span className="mt-4 text-xl font-medium tracking-tight">Couldn&apos;t connect</span>
      <span className="mt-1 text-base text-muted-foreground">Check your connection and try again.</span>
      <div className="mt-8 flex w-full max-w-xs flex-col gap-2">
        <Button variant="default" size="lg" className="w-full" onClick={() => callStore.retry()}>
          Retry
        </Button>
        <Button variant="ghost" size="lg" className="w-full" onClick={() => callStore.dismiss()}>
          Close
        </Button>
      </div>
    </div>
  )
}

/**
 * The call screen (UI-SPEC section 2). Mode A (no remote video): who you are talking to and the status
 * line. Mode B (the peer's camera is on and a frame decoded): the remote video fills the screen under a
 * translucent top bar. Either mode shows the self-view while this side's camera is on, and the control
 * pill. Open while a call rings out, connects, runs, or shows its end text.
 */
export function CallScreen() {
  const call = useCall()
  const elapsed = useElapsed(call.phase === "live" ? call.mediaStartedAt : null)
  const [remoteFrame, onRemoteFrame] = useRemoteFrame(call.peerCamera)
  const modeB = remoteFrame && call.phase !== "ended"
  const status = statusText(call, elapsed)
  const open =
    call.phase === "ringing-out" ||
    call.phase === "connecting" ||
    call.phase === "live" ||
    (call.phase === "ended" && (call.endText !== null || call.endState !== null))
  const failed = call.phase === "ended" && call.endState === "couldnt-connect"
  const showPill = call.phase !== "ended"

  return (
    <Dialog open={open} disablePointerDismissal>
      <DialogContent showCloseButton={false} className={FULL_SCREEN_DIALOG}>
        <DialogTitle className="sr-only">Call with {call.peerName}</DialogTitle>
        <div aria-live="polite" className="sr-only">
          {announcement(call)}
        </div>
        {/* Always mounted while a call runs, so its first frame can be seen before Mode B shows it. */}
        {call.remoteVideo && call.phase !== "ended" && (
          <StreamVideo
            stream={call.remoteVideo}
            testId="remote-video"
            onFrame={onRemoteFrame}
            className={cn("absolute inset-0 size-full bg-background object-cover", !modeB && "opacity-0")}
          />
        )}
        {failed ? (
          <CouldntConnect />
        ) : modeB ? (
          <>
            <div className="relative z-10 bg-background/60 pt-[env(safe-area-inset-top)] backdrop-blur-md">
              <div className="flex h-14 items-center gap-3 px-4">
                <div className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate text-sm font-medium">{call.peerName}</span>
                  <span data-testid="call-status" aria-live="off" className="text-xs text-muted-foreground tabular-nums">
                    {status}
                  </span>
                </div>
              </div>
            </div>
            <div className="flex-1" />
          </>
        ) : (
          <>
            <div data-testid="call-avatar" className="relative z-10">
              <CallIdentity name={call.peerName} status={status} />
            </div>
            <div className="flex-1" />
          </>
        )}
        {call.camera && call.localVideo && call.phase !== "ended" && (
          <div
            data-testid="self-view"
            className="absolute right-4 bottom-[calc(max(24px,env(safe-area-inset-bottom))+88px+16px)] z-20 h-32 w-24 overflow-hidden rounded-2xl bg-muted ring-1 ring-border"
          >
            <StreamVideo
              stream={call.localVideo}
              className={cn("size-full object-cover", call.facing === "user" && "-scale-x-100")}
            />
          </div>
        )}
        {showPill && (
          <div className="relative z-10 mx-auto mb-[max(24px,env(safe-area-inset-bottom))] flex items-center gap-4 rounded-4xl bg-background/60 px-4 py-4 backdrop-blur-md max-[379px]:gap-2">
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
