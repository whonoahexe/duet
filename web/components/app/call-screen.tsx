"use client"

import { useEffect, useState, type ReactNode } from "react"
import { PhoneDisconnectIcon, WarningCircleIcon } from "@phosphor-icons/react"
import { formatCallDuration } from "@duet/shared"
import { initials } from "@/components/app/login-tiles"
import { Avatar, AvatarFallback } from "@/components/ui/avatar"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog"
import { callStore, useCall, type CallState } from "@/lib/call/store"

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

/** The running m:ss timer, re-rendered every second from the first inbound media. */
function useElapsed(since: number | null): string {
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
 * The call screen (UI-SPEC section 2, Mode A): who you are talking to, the status line and the
 * control pill. Open while a call rings out, connects, runs, or shows its end text. Minimizing
 * arrives in 03-03, so close requests are ignored for now.
 */
export function CallScreen() {
  const call = useCall()
  const elapsed = useElapsed(call.phase === "live" ? call.mediaStartedAt : null)
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
        {failed ? (
          <CouldntConnect />
        ) : (
          <>
            <CallIdentity name={call.peerName} status={statusText(call, elapsed)} />
            <div className="flex-1" />
          </>
        )}
        {showPill && (
          <div className="mx-auto mb-[max(24px,env(safe-area-inset-bottom))] flex items-center gap-4 rounded-4xl bg-background/60 px-4 py-4 backdrop-blur-md max-[379px]:gap-2">
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
