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

/**
 * GET /api/calls/:id (D-10): what a party may know about one call, so a tapped call notification can
 * tell a call that still rings from one that ended unanswered. Ended calls are kept in memory 24 h.
 */
export const CallStatusResponse = z.object({
  id: CallId,
  status: z.enum(["ringing", "active", "ended"]),
  kind: CallKind,
  callerId: z.uuid(),
  reason: CallEndReason.optional(),
})
export type CallStatusResponse = z.infer<typeof CallStatusResponse>

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

/** D-20 (UI-SPEC section 6): a 2 s sample is bad when inbound packet loss is above 5%... */
export const POOR_LOSS_FRACTION = 0.05
/** ...or the selected pair's round-trip time is above 400 ms. */
export const POOR_RTT_MS = 400
/** The Poor connection badge shows after this many consecutive bad samples... */
export const POOR_ON_SAMPLES = 2
/** ...and hides after this many consecutive good ones. */
export const POOR_OFF_SAMPLES = 3

/** The badge state carried from one sample to the next. */
export interface QualityState {
  poor: boolean
  /** Consecutive bad samples so far. */
  bad: number
  /** Consecutive good samples so far. */
  good: number
}

/** One 2 s sample: loss over the interval (0-1) and RTT; missing values count as good. */
export interface QualitySample {
  lossFraction?: number
  rttMs?: number
}

export const QUALITY_START: QualityState = { poor: false, bad: 0, good: 0 }

/**
 * The next badge state after one sample (D-20): a bad sample resets the good run and a good one the
 * bad run, so only consecutive samples count. The badge turns on at POOR_ON_SAMPLES bad samples in a
 * row and off at POOR_OFF_SAMPLES good ones in a row.
 */
export function qualityStep(prev: QualityState, sample: QualitySample): QualityState {
  const lossBad = sample.lossFraction !== undefined && sample.lossFraction > POOR_LOSS_FRACTION
  const rttBad = sample.rttMs !== undefined && sample.rttMs > POOR_RTT_MS
  if (lossBad || rttBad) {
    const bad = prev.bad + 1
    return { poor: prev.poor || bad >= POOR_ON_SAMPLES, bad, good: 0 }
  }
  const good = prev.good + 1
  return { poor: prev.poor && good < POOR_OFF_SAMPLES, bad: 0, good }
}
