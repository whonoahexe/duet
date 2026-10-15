"use client"

import type { CallKind } from "@duet/shared"

/**
 * Microphone and camera capture for calls (CALL-01, CALL-02). Called first thing in the Start / Accept
 * tap, before any other await, so iOS keeps the user gesture (Pitfall 8). Unlike the voice recorder,
 * call tracks are never stopped on visibilitychange (D-18: a locked iPhone often keeps call audio
 * running); the call session stops them when the call ends.
 */

export type MicResult = { ok: true; track: MediaStreamTrack } | { ok: false; reason: "denied" | "unavailable" }

/** Which way the camera looks: "user" is the front camera (mirrored in the self-view), "environment" the back. */
export type Facing = "user" | "environment"

/**
 * The media a call starts with. `camera` is null for a voice call, or for a video call whose camera
 * could not be opened; `cameraDenied` says the person refused it (D-19: the call continues audio-only).
 */
export type CallMediaResult =
  | { ok: true; mic: MediaStreamTrack; camera: MediaStreamTrack | null; cameraDenied: boolean }
  | { ok: false; reason: "denied" | "unavailable" }

export type CameraResult = { ok: true; track: MediaStreamTrack } | { ok: false; reason: "denied" | "unavailable" }

const AUDIO: MediaTrackConstraints = { echoCancellation: true, noiseSuppression: true }

function videoConstraints(facing: Facing): MediaTrackConstraints {
  return { facingMode: facing, width: { ideal: 1280 }, height: { ideal: 720 } }
}

function errorName(err: unknown): string {
  return err instanceof DOMException || err instanceof Error ? err.name : ""
}

function denied(err: unknown): boolean {
  const name = errorName(err)
  return name === "NotAllowedError" || name === "SecurityError"
}

function canCapture(): boolean {
  return typeof navigator !== "undefined" && Boolean(navigator.mediaDevices?.getUserMedia)
}

export async function getMic(): Promise<MicResult> {
  if (!canCapture()) return { ok: false, reason: "unavailable" }
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: AUDIO })
    const track = stream.getAudioTracks()[0]
    if (!track) {
      for (const t of stream.getTracks()) t.stop()
      return { ok: false, reason: "unavailable" }
    }
    return { ok: true, track }
  } catch (err) {
    return { ok: false, reason: denied(err) ? "denied" : "unavailable" }
  }
}

/**
 * The media for a new call: the microphone, plus the camera for a video call in the same prompt. A
 * camera that is refused (or missing) falls back to an audio-only capture, so the call still starts.
 */
export async function getCallMedia(kind: CallKind, facing: Facing = "user"): Promise<CallMediaResult> {
  if (kind === "voice") {
    const mic = await getMic()
    return mic.ok ? { ok: true, mic: mic.track, camera: null, cameraDenied: false } : mic
  }
  if (!canCapture()) return { ok: false, reason: "unavailable" }
  let cameraDenied = false
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: AUDIO, video: videoConstraints(facing) })
    const mic = stream.getAudioTracks()[0]
    const camera = stream.getVideoTracks()[0] ?? null
    if (mic) return { ok: true, mic, camera, cameraDenied: false }
    for (const t of stream.getTracks()) t.stop()
  } catch (err) {
    cameraDenied = denied(err)
  }
  const mic = await getMic()
  return mic.ok ? { ok: true, mic: mic.track, camera: null, cameraDenied } : mic
}

/** The camera alone, for turning it on during a call (D-03). */
export async function getCamera(facing: Facing): Promise<CameraResult> {
  if (!canCapture()) return { ok: false, reason: "unavailable" }
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ video: videoConstraints(facing) })
    const track = stream.getVideoTracks()[0]
    if (!track) {
      for (const t of stream.getTracks()) t.stop()
      return { ok: false, reason: "unavailable" }
    }
    return { ok: true, track }
  } catch (err) {
    return { ok: false, reason: denied(err) ? "denied" : "unavailable" }
  }
}
