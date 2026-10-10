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

// --- RED stubs (02-01 Task 2): signatures only, replaced by the implementation in the next commit.
import type { AttachmentKind, MessageDto } from "./chat"

export function mediaLabel(_kinds: AttachmentKind[], _opts: { emoji: boolean }): string {
  return ""
}

export function messageLabel(_m: Pick<MessageDto, "kind" | "body" | "attachments">): string {
  return ""
}

export function truncateGraphemes(s: string, _max: number): string {
  return s
}

export function mergeMessages(list: MessageDto[], _incoming: MessageDto[], _oldestSeq: number | null): MessageDto[] {
  return list
}

export interface OutboxEntryState {
  attempts: number
  state: "sending" | "failed"
}

export type OutboxOutcome =
  | { kind: "ok" }
  | { kind: "network"; connected: boolean }
  | { kind: "http"; status: number; connected: boolean }

export function nextOutboxState<T extends OutboxEntryState>(entry: T, _outcome: OutboxOutcome): T | null {
  return entry
}
