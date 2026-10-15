"use client"

/**
 * Call tones generated with WebAudio (D-08, research Pattern 8; no asset files): the caller's ringback
 * and the callee's ringtone, plus best-effort vibration. Browsers keep an AudioContext suspended until
 * a user gesture, so unlockAudio() runs synchronously inside the Start / Accept / Decline taps. The
 * callee's ringtone starts before any tap: when audio is blocked (iOS) the incoming screen simply
 * shows silently. navigator.vibrate needs an earlier gesture in Chrome and does not exist in Safari.
 */

export type Tone = "ringback" | "ringtone" | "none"

/** Caller: 440 + 480 Hz, 2 s on / 4 s off (the classic ringback cadence), quiet. */
const RINGBACK_PERIOD_MS = 6000
const RINGBACK_ON_S = 2
const RINGBACK_GAIN = 0.06
/** Callee: two short notes (about 1 s of tone), then a 1 s pause. */
const RINGTONE_PERIOD_MS = 2000
const RINGTONE_GAIN = 0.12
const VIBRATE_PERIOD_MS = 1200

let ctx: AudioContext | null = null
let loop: ReturnType<typeof setInterval> | null = null
let vibrateLoop: ReturnType<typeof setInterval> | null = null
const playing = new Set<OscillatorNode>()
let current: Tone = "none"

function context(): AudioContext | null {
  if (ctx) return ctx
  const Ctor =
    typeof window === "undefined"
      ? undefined
      : (window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext)
  if (!Ctor) return null
  try {
    ctx = new Ctor()
  } catch {
    ctx = null
  }
  return ctx
}

/** Create (once) and resume the shared AudioContext. Call synchronously inside a user gesture. */
export function unlockAudio(): void {
  const c = context()
  if (c && c.state !== "running") c.resume().catch(() => {})
}

/** Schedule one tone of `freqs` mixed, starting `at` seconds from now for `dur` seconds. */
function tone(freqs: number[], at: number, dur: number, gain: number): void {
  const c = ctx
  if (!c) return
  const start = c.currentTime + at
  const g = c.createGain()
  g.gain.setValueAtTime(0, start)
  g.gain.linearRampToValueAtTime(gain, start + 0.02)
  g.gain.setValueAtTime(gain, start + dur - 0.03)
  g.gain.linearRampToValueAtTime(0, start + dur)
  g.connect(c.destination)
  for (const f of freqs) {
    const osc = c.createOscillator()
    osc.type = "sine"
    osc.frequency.value = f
    osc.connect(g)
    osc.onended = () => {
      playing.delete(osc)
      osc.disconnect()
    }
    playing.add(osc)
    osc.start(start)
    osc.stop(start + dur)
  }
}

function vibrate(pattern: number | number[]): void {
  try {
    navigator.vibrate?.(pattern)
  } catch {
    // Best effort only.
  }
}

/** The tone currently looping. */
export function currentTone(): Tone {
  return current
}

/** Caller side while ringing. */
export function startRingback(): void {
  stopTones()
  current = "ringback"
  if (!context()) return
  const play = () => tone([440, 480], 0, RINGBACK_ON_S, RINGBACK_GAIN)
  play()
  loop = setInterval(play, RINGBACK_PERIOD_MS)
}

/** Callee side while ringing: a looping ringtone plus vibration where it is allowed. */
export function startRingtone(): void {
  stopTones()
  current = "ringtone"
  const c = context()
  if (c && c.state !== "running") c.resume().catch(() => {})
  if (c) {
    const play = () => {
      tone([660], 0, 0.45, RINGTONE_GAIN)
      tone([880], 0.55, 0.45, RINGTONE_GAIN)
    }
    play()
    loop = setInterval(play, RINGTONE_PERIOD_MS)
  }
  vibrate([800, 400])
  vibrateLoop = setInterval(() => vibrate([800, 400]), VIBRATE_PERIOD_MS)
}

/** Stop every tone and vibration at once (accept, decline, cancel, timeout, end). */
export function stopTones(): void {
  if (loop !== null) clearInterval(loop)
  loop = null
  if (vibrateLoop !== null) {
    clearInterval(vibrateLoop)
    vibrateLoop = null
    vibrate(0)
  }
  for (const osc of playing) {
    try {
      osc.stop()
    } catch {
      // Already stopped.
    }
    osc.disconnect()
  }
  playing.clear()
  current = "none"
}
