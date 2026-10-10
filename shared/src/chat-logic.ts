import type { AttachmentKind, MessageDto } from "./chat"

/**
 * Pure chat helpers shared by the server and the web client (no DOM, no I/O), unit-tested from the
 * server vitest suite.
 */

/** Number of Unicode code points (an astral emoji is one, a ZWJ sequence is several). */
export function codePointLength(s: string): number {
  let n = 0
  for (const _ of s) n += 1
  return n
}

/** True when the text has nothing but whitespace (such a message is never sent). */
export function isBlankBody(s: string): boolean {
  return s.trim().length === 0
}

/**
 * Label for a media message (D-13): "Photo", "3 photos", "Video", "2 videos", "4 items" (mixed) or
 * "Voice note" (audio only). With emoji: "📷 Photo", "🎥 2 videos", "📷 4 items", "🎤 Voice note".
 */
export function mediaLabel(kinds: AttachmentKind[], { emoji }: { emoji: boolean }): string {
  const images = kinds.filter((k) => k === "image").length
  const videos = kinds.filter((k) => k === "video").length
  if (images === 0 && videos === 0) {
    if (kinds.length === 0) return ""
    return emoji ? "🎤 Voice note" : "Voice note"
  }
  let label: string
  let icon: string
  if (videos === 0) {
    label = images === 1 ? "Photo" : `${images} photos`
    icon = "📷"
  } else if (images === 0) {
    label = videos === 1 ? "Video" : `${videos} videos`
    icon = "🎥"
  } else {
    label = `${images + videos} items`
    icon = "📷"
  }
  return emoji ? `${icon} ${label}` : label
}

/** One-line description of a message for notifications and announcements (D-13, UI-SPEC section 7). */
export function messageLabel(m: Pick<MessageDto, "kind" | "body" | "attachments">): string {
  if (m.kind === "text") return m.body ?? ""
  if (m.kind === "voice") return "🎤 Voice note"
  const label = mediaLabel(
    m.attachments.map((a) => a.kind),
    { emoji: true },
  )
  return m.body ? `${label} · ${m.body}` : label
}

let segmenter: Intl.Segmenter | null = null

/** Cut to at most `max` user-perceived characters, appending "…" only when something was cut. */
export function truncateGraphemes(s: string, max: number): string {
  segmenter ??= new Intl.Segmenter(undefined, { granularity: "grapheme" })
  let count = 0
  let end = 0
  for (const { segment } of segmenter.segment(s)) {
    if (count === max) return `${s.slice(0, end)}…`
    count += 1
    end += segment.length
  }
  return s
}

/**
 * Merge confirmed messages into an ascending-by-seq list. A message with the same seq is replaced
 * unless the incoming copy is older (lower updatedSeq). Incoming messages below the loaded window
 * (seq < oldestSeq) are dropped, because inserting them would open a hole (Pitfall 15). Pure and
 * idempotent.
 */
export function mergeMessages(list: MessageDto[], incoming: MessageDto[], oldestSeq: number | null): MessageDto[] {
  if (incoming.length === 0) return list
  const bySeq = new Map<number, MessageDto>()
  for (const m of list) bySeq.set(m.seq, m)
  let changed = false
  for (const m of incoming) {
    if (oldestSeq !== null && m.seq < oldestSeq) continue
    const existing = bySeq.get(m.seq)
    if (existing && (existing === m || existing.updatedSeq > m.updatedSeq)) continue
    bySeq.set(m.seq, m)
    changed = true
  }
  if (!changed) return list
  return [...bySeq.values()].sort((a, b) => a.seq - b.seq)
}

/** Connected send attempts before a text message is shown as failed (UI-SPEC). */
export const OUTBOX_MAX_CONNECTED_ATTEMPTS = 3

export interface OutboxEntryState {
  attempts: number
  state: "sending" | "failed"
}

export type OutboxOutcome =
  | { kind: "ok" }
  | { kind: "network"; connected: boolean }
  | { kind: "http"; status: number; connected: boolean }

/**
 * Next outbox state after one send attempt (CHAT-03, CHAT-04). null = confirmed, drop the entry.
 * A 4xx rejection fails at once (except 401, 408, 429, which are retryable). Network errors and
 * retryable statuses count an attempt only while connected and fail on the third; while offline an
 * entry stays "sending" forever.
 */
export function nextOutboxState<T extends OutboxEntryState>(entry: T, outcome: OutboxOutcome): T | null {
  if (outcome.kind === "ok") return null
  if (outcome.kind === "http") {
    const s = outcome.status
    if (s >= 400 && s < 500 && s !== 401 && s !== 408 && s !== 429) {
      return { ...entry, attempts: entry.attempts + 1, state: "failed" }
    }
  }
  if (!outcome.connected) return { ...entry, state: "sending" }
  const attempts = entry.attempts + 1
  return { ...entry, attempts, state: attempts >= OUTBOX_MAX_CONNECTED_ATTEMPTS ? "failed" : "sending" }
}
