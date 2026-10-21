"use client"

import { AlarmIcon, PhoneIcon, VideoCameraIcon } from "@phosphor-icons/react"
import { callLineText, reminderLineText, type MessageDto } from "@duet/shared"
import { Marker, MarkerContent, MarkerIcon } from "@/components/ui/marker"
import { callStore } from "@/lib/call/store"

function shortTime(ts: number): string {
  return new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }).format(ts)
}

/**
 * A centred system line, never a bubble (QT-nw9-call-lines, QT-nw9-reminder-fire): a call ("Voice
 * call · 3:44", a highlighted "Missed voice call", ...) or a fired reminder ("Drink water · from
 * Noah"), worded for whoever looks at it. Tapping a call line calls back with the same kind
 * (callStore.startCall ignores the tap while a call is on or the socket is down). data-seq lets the
 * read tracker mark a missed call read once it is on screen (QT-nw9-call-unread).
 */
export function SystemLine({
  message,
  meId,
  names,
}: {
  message: MessageDto
  meId: string | null
  names: Record<string, string>
}) {
  const time = shortTime(message.createdAt)
  if (message.kind === "call" && message.call) {
    const call = message.call
    const { text, missed } = callLineText(call, message.senderId, meId)
    return (
      <Marker
        data-testid="system-line"
        data-kind="call"
        data-seq={message.seq}
        data-missed={missed ? "true" : undefined}
        className={`cursor-pointer justify-center py-1 ${missed ? "text-destructive" : ""}`}
        render={<button type="button" aria-label={`Call back: ${text}`} onClick={() => void callStore.startCall(call.kind)} />}
      >
        <MarkerIcon>{call.kind === "video" ? <VideoCameraIcon /> : <PhoneIcon />}</MarkerIcon>
        <MarkerContent>
          {text} · {time}
        </MarkerContent>
      </Marker>
    )
  }
  return (
    <Marker data-testid="system-line" data-kind="reminder" data-seq={message.seq} className="justify-center py-1">
      <MarkerIcon>
        <AlarmIcon />
      </MarkerIcon>
      <MarkerContent>
        {reminderLineText(message, meId, names)} · {time}
      </MarkerContent>
    </Marker>
  )
}
