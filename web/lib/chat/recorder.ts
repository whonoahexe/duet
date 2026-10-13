"use client"

/**
 * Voice-note recording around MediaRecorder (D-10, MDIA-04, research Pattern 11).
 *
 * - The container is the first supported of audio/mp4 (iOS, AAC), audio/webm;codecs=opus and
 *   audio/webm (Chrome); the server normalizes either to AAC .m4a (D-12).
 * - Recording starts WITHOUT a timeslice: tiny timeslices give iOS empty blobs.
 * - The microphone is never left open (T-02-32): every MediaStream track is stopped on stop, cancel,
 *   a recorder error, pagehide, and the page becoming hidden while recording. That also clears the
 *   iOS microphone indicator.
 */

const CANDIDATES = ["audio/mp4", "audio/webm;codecs=opus", "audio/webm"] as const

/** If the recorder never reports onstop (a stuck MediaRecorder), stop() still settles after this. */
const STOP_TIMEOUT_MS = 3000

export interface Recording {
  /** The container actually recorded, e.g. "audio/mp4" or "audio/webm;codecs=opus". */
  readonly mimeType: string
  /** Stop and return the recording. The microphone is released. */
  stop(): Promise<Blob>
  /** Throw the recording away. The microphone is released at once. */
  cancel(): void
  /** Time since recording started, in ms (the UI timer). */
  elapsedMs(): number
}

export type StartResult =
  | { ok: true; recording: Recording }
  /** denied = the person (or the OS setting) blocked the microphone; unavailable = no mic / no API / error. */
  | { ok: false; reason: "denied" | "unavailable" }

export interface StartOptions {
  /** The recording was cut off and discarded by the app going away (pagehide, hidden). */
  onInterrupted?: () => void
}

function pickMimeType(): string | undefined {
  if (typeof MediaRecorder.isTypeSupported !== "function") return undefined
  return CANDIDATES.find((t) => MediaRecorder.isTypeSupported(t))
}

/** Ask for the microphone and start recording. The first call shows the permission prompt. */
export async function startRecording(opts: StartOptions = {}): Promise<StartResult> {
  if (typeof window === "undefined" || typeof MediaRecorder === "undefined" || !navigator.mediaDevices?.getUserMedia) {
    return { ok: false, reason: "unavailable" }
  }
  let stream: MediaStream
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true },
    })
  } catch (err) {
    const name = err instanceof DOMException ? err.name : ""
    return {
      ok: false,
      reason: name === "NotAllowedError" || name === "SecurityError" ? "denied" : "unavailable",
    }
  }

  let released = false
  /** Stop every track (clears the iOS mic indicator) and drop the page listeners. Idempotent. */
  const release = () => {
    if (released) return
    released = true
    for (const track of stream.getTracks()) track.stop()
    window.removeEventListener("pagehide", onPageHide)
    document.removeEventListener("visibilitychange", onVisibility)
  }

  let rec: MediaRecorder
  const mimeType = pickMimeType()
  try {
    rec = new MediaRecorder(stream, mimeType ? { mimeType } : undefined)
  } catch {
    release()
    return { ok: false, reason: "unavailable" }
  }

  const chunks: Blob[] = []
  let cancelled = false
  let settle: ((blob: Blob) => void) | null = null
  const blobType = () => rec.mimeType || mimeType || "application/octet-stream"
  const finish = () => {
    release()
    const done = settle
    settle = null
    done?.(new Blob(chunks, { type: blobType() }))
  }

  rec.ondataavailable = (e) => {
    if (!cancelled && e.data.size > 0) chunks.push(e.data)
  }
  rec.onstop = finish
  rec.onerror = finish

  const cancel = () => {
    cancelled = true
    chunks.length = 0
    try {
      if (rec.state !== "inactive") rec.stop()
    } catch {
      /* already stopped */
    }
    release()
  }
  const interrupt = () => {
    if (released) return
    cancel()
    opts.onInterrupted?.()
  }
  function onPageHide() {
    interrupt()
  }
  function onVisibility() {
    if (document.visibilityState === "hidden") interrupt()
  }
  window.addEventListener("pagehide", onPageHide)
  document.addEventListener("visibilitychange", onVisibility)

  try {
    rec.start() // no timeslice (Pattern 11)
  } catch {
    release()
    return { ok: false, reason: "unavailable" }
  }
  const startedAt = performance.now()

  return {
    ok: true,
    recording: {
      mimeType: blobType(),
      elapsedMs: () => performance.now() - startedAt,
      cancel,
      stop: () =>
        new Promise<Blob>((resolve) => {
          if (rec.state === "inactive" || released) {
            release()
            resolve(new Blob(chunks, { type: blobType() }))
            return
          }
          settle = resolve
          // Never wait forever on a recorder that does not report onstop; the tracks go either way.
          setTimeout(finish, STOP_TIMEOUT_MS)
          try {
            rec.stop()
          } catch {
            finish()
          }
        }),
    },
  }
}
