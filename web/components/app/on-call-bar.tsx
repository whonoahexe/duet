"use client"

import { CaretRightIcon, PhoneIcon } from "@phosphor-icons/react"
import { useElapsed } from "@/components/app/call-screen"
import { callStore, useCall } from "@/lib/call/store"

/**
 * The minimized call (D-06, UI-SPEC section 4): an accent bar under the chat header while the call
 * screen is closed and the call rings out, connects or runs. Tapping it reopens the call screen in the
 * same mode and swap state. Gone while the call screen is open and when the call ends.
 */
export function OnCallBar() {
  const call = useCall()
  const elapsed = useElapsed(call.phase === "live" ? call.mediaStartedAt : null)
  const active = call.phase === "ringing-out" || call.phase === "connecting" || call.phase === "live"
  if (!active || call.screen !== "minimized") return null
  const text = call.reconnecting
    ? "Reconnecting…"
    : call.phase === "ringing-out"
      ? "Ringing…"
      : call.phase === "connecting"
        ? "Connecting…"
        : `On call · ${elapsed}`
  return (
    <button
      type="button"
      aria-label="Return to call"
      onClick={() => callStore.restore()}
      className="flex h-11 w-full shrink-0 items-center gap-2 bg-primary px-4 text-sm font-medium text-primary-foreground outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
    >
      <PhoneIcon weight="fill" className="size-4" />
      <span className="tabular-nums">{text}</span>
      <span className="flex-1" />
      <CaretRightIcon className="size-4" />
    </button>
  )
}
