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
