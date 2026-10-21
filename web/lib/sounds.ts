"use client"

/**
 * Sound effects synthesised in code with WebAudio (QT-4gf-sound-engine): no asset files, no licences.
 * They play on the one AudioContext from web/lib/call/tones.ts (sharedAudioContext), never a second
 * one. Sounds are always on (locked user change U-01): there is no on/off switch anywhere and no
 * stored preference.
 *
 * Known limits, written down and not fixed: the iPhone silent switch mutes web audio; nothing plays
 * while duet is closed (push uses the OS sound); and nothing plays before the first tap of a session,
 * because browsers keep the context suspended until a gesture (installAudioUnlock handles that tap).
 */

import { sharedAudioContext, unlockAudio } from "@/lib/call/tones"

export type SoundName =
  | "sent"
  | "received"
  | "reaction"
  | "record-start"
  | "record-stop"
  | "call-connected"
  | "call-ended"
  | "call-dropped"
  | "reminder"
  | "missed-call"

interface Note {
  /** Oscillator wave (default sine). */
  type?: OscillatorType
  /** Start frequency in Hz. */
  freq: number
  /** Optional end frequency: an exponential glide over the note. */
  to?: number
  /** Offset in seconds from now. */
  at?: number
  /** Attack in seconds (gain ramps from 0.0001 up to `peak`). */
  attack: number
  /** Decay in seconds (exponential ramp back to 0.0001). */
  decay: number
  peak: number
}

const FLOOR = 0.0001

/** Schedule one oscillator through its own gain to the destination; both disconnect when it ends. */
function note(c: AudioContext, n: Note): void {
  const start = c.currentTime + (n.at ?? 0)
  const peakAt = start + n.attack
  const end = peakAt + n.decay
  const osc = c.createOscillator()
  const g = c.createGain()
  osc.type = n.type ?? "sine"
  osc.frequency.setValueAtTime(n.freq, start)
  if (n.to !== undefined) osc.frequency.exponentialRampToValueAtTime(n.to, end)
  g.gain.setValueAtTime(FLOOR, start)
  g.gain.exponentialRampToValueAtTime(n.peak, peakAt)
  g.gain.exponentialRampToValueAtTime(FLOOR, end)
  osc.connect(g)
  g.connect(c.destination)
  osc.onended = () => {
    osc.disconnect()
    g.disconnect()
  }
  osc.start(start)
  osc.stop(end + 0.02)
}

/** One recipe per sound: every effect stays under about 1 s and at or below the ringtone's 0.12. */
const RECIPES: Record<SoundName, Note[]> = {
  sent: [{ freq: 620, to: 310, attack: 0.004, decay: 0.09, peak: 0.12 }],
  received: [
    { freq: 880, attack: 0.005, decay: 0.45, peak: 0.08 },
    { freq: 1320, at: 0.09, attack: 0.005, decay: 0.45, peak: 0.08 },
  ],
  reaction: [{ type: "triangle", freq: 1800, attack: 0.002, decay: 0.04, peak: 0.06 }],
  "record-start": [{ freq: 700, to: 1100, attack: 0.004, decay: 0.07, peak: 0.09 }],
  "record-stop": [{ freq: 1100, to: 700, attack: 0.004, decay: 0.07, peak: 0.09 }],
  "call-connected": [
    { freq: 660, attack: 0.005, decay: 0.15, peak: 0.09 },
    { freq: 990, at: 0.1, attack: 0.005, decay: 0.15, peak: 0.09 },
  ],
  "call-ended": [
    { freq: 660, attack: 0.005, decay: 0.22, peak: 0.09 },
    { freq: 440, at: 0.16, attack: 0.005, decay: 0.22, peak: 0.09 },
  ],
  "call-dropped": [
    { type: "triangle", freq: 660, attack: 0.005, decay: 0.16, peak: 0.08 },
    { type: "triangle", freq: 520, at: 0.14, attack: 0.005, decay: 0.16, peak: 0.08 },
    { type: "triangle", freq: 390, at: 0.28, attack: 0.005, decay: 0.16, peak: 0.08 },
  ],
  reminder: [
    { freq: 784, attack: 0.005, decay: 0.6, peak: 0.07 },
    { freq: 988, at: 0.12, attack: 0.005, decay: 0.6, peak: 0.07 },
    { freq: 1175, at: 0.24, attack: 0.005, decay: 0.6, peak: 0.07 },
  ],
  "missed-call": [
    { freq: 740, attack: 0.005, decay: 0.35, peak: 0.09 },
    { freq: 554, at: 0.2, attack: 0.005, decay: 0.35, peak: 0.09 },
  ],
}

const MAX_MARKS = 100

/** Last chat activity (a sent or received message), for the received-chime quiet window. */
let lastChatAt = 0

/**
 * Play one effect. Nothing is scheduled unless the shared context exists and is running: scheduling on
 * a suspended context would burst later on unlock. Each play leaves a "duet-sound:<name>" performance
 * mark (the name only, never content or ids) that the smoke tests count. Never throws.
 */
export function playSound(name: SoundName): void {
  try {
    if (name === "sent") lastChatAt = Date.now()
    const c = sharedAudioContext()
    if (!c || c.state !== "running") return
    for (const n of RECIPES[name]) note(c, n)
    const mark = `duet-sound:${name}`
    performance.mark(mark)
    if (performance.getEntriesByName(mark, "mark").length > MAX_MARKS) performance.clearMarks(mark)
  } catch {
    // A sound must never break a send or call path.
  }
}

/** A message arriving within this long of the last chat activity stays silent (sliding window). */
const RECEIVE_QUIET_MS = 10_000

/** A new message from the other person: chime only after a quiet spell, so a burst chimes once. */
export function playReceivedChime(): void {
  if (!chatSoundsAllowed()) return
  const now = Date.now()
  const quiet = now - lastChatAt >= RECEIVE_QUIET_MS
  lastChatAt = now
  if (quiet) playSound("received")
}

let callActive = false

/** The call store reports whether a call is in progress (its screen covers the chat). */
export function setCallActive(active: boolean): void {
  callActive = active
}

/** Chat sounds from the other phone play only while duet is on screen and no call is in progress. */
export function chatSoundsAllowed(): boolean {
  return typeof document !== "undefined" && document.visibilityState === "visible" && !callActive
}

let unlockInstalled = false

/**
 * Resume the shared context on any tap, for the whole session. The listeners stay (not once):
 * unlockAudio is a no-op while the context runs, and iOS can leave it "interrupted" after a call or a
 * trip to the background, which the next tap must resume. WebKit grants activation on touchend /
 * pointerup for touch, Chrome on pointerdown, hence several event types.
 */
export function installAudioUnlock(): void {
  if (unlockInstalled || typeof window === "undefined") return
  unlockInstalled = true
  const opts: AddEventListenerOptions = { capture: true, passive: true }
  for (const type of ["pointerdown", "pointerup", "touchend", "click", "keydown"]) {
    window.addEventListener(type, unlockAudio, opts)
  }
}
