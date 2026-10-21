import { formatCallDuration } from "./call"
import type { CallLine, MessageDto } from "./chat"

/**
 * System-line text (QT-nw9-call-lines, QT-nw9-reminder-fire): the centred call and reminder lines in
 * the chat, worded for whoever looks at them. Pure and DOM-free, shared by the server tests and the
 * web client.
 */

/**
 * A call line as `viewerId` sees it. Answered: "Voice call · 3:44"; missed: "No answer" for the
 * caller and a highlighted (missed: true) "Missed voice call" for the callee; "Declined";
 * "Call dropped · 1:20"; "Couldn't connect" (WR-08, the call screen's wording).
 */
export function callLineText(call: CallLine, callerId: string, viewerId: string | null | undefined): { text: string; missed: boolean } {
  const isCaller = viewerId === callerId
  switch (call.outcome) {
    case "completed":
      return { text: `${call.kind === "video" ? "Video" : "Voice"} call · ${formatCallDuration(call.durationMs)}`, missed: false }
    case "missed":
      return isCaller ? { text: "No answer", missed: false } : { text: `Missed ${call.kind} call`, missed: true }
    case "declined":
      return { text: "Declined", missed: false }
    case "dropped":
      return { text: `Call dropped · ${formatCallDuration(call.durationMs)}`, missed: false }
    case "failed":
      return { text: "Couldn't connect", missed: false }
  }
}

/** A heads-up lead: "15 min" under an hour, "1 hour", "2 hours". */
export function leadLabel(minutes: number): string {
  if (minutes < 60) return `${minutes} min`
  const hours = Math.round(minutes / 60)
  return hours === 1 ? "1 hour" : `${hours} hours`
}

/**
 * Who a reminder is from and for, as `viewerId` sees it (lowercase, the UI capitalises it):
 * your own: "for you", "for Bob", "for both of you"; the other person's: "from Alice",
 * "from Alice · for both of you", or "for Alice" when they set it for themselves.
 */
export function reminderWho(
  creatorId: string,
  forUserId: string | null,
  viewerId: string | null | undefined,
  names: Record<string, string>,
): string {
  const name = (id: string) => names[id] ?? "Someone"
  if (creatorId === viewerId) {
    if (forUserId === null) return "for both of you"
    if (forUserId === viewerId) return "for you"
    return `for ${name(forUserId)}`
  }
  if (forUserId === null) return `from ${name(creatorId)} · for both of you`
  if (forUserId === creatorId) return `for ${name(creatorId)}`
  return `from ${name(creatorId)}`
}

/** A reminder line: "Drink water · from Alice", "Meeting · in 15 min · for you". */
export function reminderLineText(
  message: Pick<MessageDto, "body" | "senderId" | "reminder">,
  viewerId: string | null | undefined,
  names: Record<string, string>,
): string {
  const title = message.body ?? ""
  const lead = message.reminder?.leadMinutes ?? null
  const who = reminderWho(message.senderId, message.reminder?.forUserId ?? null, viewerId, names)
  return `${title}${lead !== null ? ` · in ${leadLabel(lead)}` : ""} · ${who}`
}

/**
 * Whether a message counts as unread for `viewerId` (QT-nw9-call-unread): the other person's text,
 * media and voice, and a call they missed. Your own messages, every other call line and every
 * reminder line never do.
 */
export function countsAsUnread(m: Pick<MessageDto, "senderId" | "kind" | "call">, viewerId: string | null | undefined): boolean {
  if (m.senderId === viewerId) return false
  if (m.kind === "call") return m.call?.outcome === "missed"
  return m.kind !== "reminder"
}
