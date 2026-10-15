"use client"

/**
 * Microphone capture for calls (CALL-01). Called first thing in the Start / Accept tap, before any
 * other await, so iOS keeps the user gesture (Pitfall 8). Unlike the voice recorder, call tracks are
 * never stopped on visibilitychange (D-18: a locked iPhone often keeps call audio running); the call
 * session stops them when the call ends.
 */

export type MicResult = { ok: true; track: MediaStreamTrack } | { ok: false; reason: "denied" | "unavailable" }

export async function getMic(): Promise<MicResult> {
  if (typeof navigator === "undefined" || !navigator.mediaDevices?.getUserMedia) {
    return { ok: false, reason: "unavailable" }
  }
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true },
    })
    const track = stream.getAudioTracks()[0]
    if (!track) {
      for (const t of stream.getTracks()) t.stop()
      return { ok: false, reason: "unavailable" }
    }
    return { ok: true, track }
  } catch (err) {
    const name = err instanceof DOMException ? err.name : ""
    return { ok: false, reason: name === "NotAllowedError" || name === "SecurityError" ? "denied" : "unavailable" }
  }
}
