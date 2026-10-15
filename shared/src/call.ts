import { z } from "zod"

/**
 * 1:1 call contract (Phase 3). A call is identified by a client-generated lowercase UUID
 * (crypto.randomUUID()); its media signals ride the server-managed room "call-<id>". This module must
 * not import ws.ts: ws.ts imports it (like chat.ts).
 */

/** Lowercase only, so callRoom(id) is always a valid RoomId. */
export const CallId = z.uuid().regex(/^[0-9a-f-]+$/)
export type CallId = z.infer<typeof CallId>

/** The caller's camera choice at start (D-03: a voice call is a call that starts with the camera off). */
export const CallKind = z.enum(["voice", "video"])
export type CallKind = z.infer<typeof CallKind>

export const CallEndReason = z.enum(["declined", "no-answer", "cancelled", "hangup", "dropped", "busy", "failed"])
export type CallEndReason = z.infer<typeof CallEndReason>

/** Why one ringing device stops (D-11): another device of the same person answered first. */
export const StopRingingReason = z.enum(["answered-elsewhere"])
export type StopRingingReason = z.infer<typeof StopRingingReason>

/** Rooms with this prefix are server-managed: a client room.join of one answers room_reserved. */
export const CALL_ROOM_PREFIX = "call-"

/** The signaling room of one call. */
export function callRoom(callId: string): string {
  return CALL_ROOM_PREFIX + callId
}

/** D-07: an unanswered call stops ringing after 45 s (the server owns the timer). */
export const CALL_RING_TIMEOUT_MS = 45_000

/** Call timer text: "m:ss" under an hour, "h:mm:ss" from an hour (whole seconds, floored). */
export function formatCallDuration(ms: number): string {
  const total = Number.isFinite(ms) && ms > 0 ? Math.floor(ms / 1000) : 0
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  const ss = String(s).padStart(2, "0")
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`
}
