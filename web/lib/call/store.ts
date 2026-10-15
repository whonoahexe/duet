"use client"

import { useSyncExternalStore } from "react"
import { toast } from "sonner"
import { formatCallDuration, type CallKind, type MeResponse, type ServerFrame, type UserSummary } from "@duet/shared"
import { sendFrame } from "@/lib/chat/realtime"
import { fetchIceServers } from "@/lib/rtc/ice"
import type { CallSample } from "@/lib/rtc/stats"
import { getMic } from "./media"
import { CallSession, forceRelayFlag } from "./session"
import { startRingback, startRingtone, stopTones, unlockAudio, type Tone } from "./tones"

export type CallPhase = "idle" | "ringing-out" | "ringing-in" | "connecting" | "live" | "ended"

export interface CallState {
  phase: CallPhase
  callId: string | null
  kind: CallKind
  role: "caller" | "callee" | null
  peerId: string | null
  peerName: string
  /** The Accept tap is setting the call up (mic, ICE servers). */
  accepting: boolean
  /** When media first flowed (epoch ms): the timer counts from here (UI-SPEC "Status line"). */
  mediaStartedAt: number | null
  /** Terminal status line text while phase is "ended" ("Declined", "No answer", "Call ended · 2:14"). */
  endText: string | null
  /** A terminal state with actions (D-19): stays until Retry or Close. */
  endState: "couldnt-connect" | null
  /** The remote audio, played by the always-mounted <audio> in CallProvider. */
  remoteAudio: MediaStream | null
  /** Diagnostics only (call-diag): selected local candidate type and inbound bytes. */
  localType: string | null
  inboundBytes: number
  /** The tone looping right now (D-08). */
  tone: Tone
}

/** How long each terminal text stays before the call screen closes (UI-SPEC section 5). */
const ENDED_SHOW_MS = 1500
const DECLINED_SHOW_MS = 2000
/**
 * Client guards behind the server's 45 s timer (research A6/A7, tunable): a caller that never hears
 * back shows "No answer", an incoming screen whose end never arrives closes, and an accepted call
 * without media gives up with "Couldn't connect".
 */
export const CALLER_RING_GUARD_MS = 55_000
export const INCOMING_GUARD_MS = 50_000
export const CONNECT_TIMEOUT_MS = 20_000

const EMPTY: CallState = {
  phase: "idle",
  callId: null,
  kind: "voice",
  role: null,
  peerId: null,
  peerName: "",
  accepting: false,
  mediaStartedAt: null,
  endText: null,
  endState: null,
  remoteAudio: null,
  localType: null,
  inboundBytes: 0,
  tone: "none",
}

let state: CallState = EMPTY
const listeners = new Set<() => void>()
let peer: UserSummary | null = null
let session: CallSession | null = null
/** The microphone of the call being set up, before a session owns it. */
let pendingMic: MediaStreamTrack | null = null
let pendingIce: RTCIceServer[] | null = null
let closeTimer: ReturnType<typeof setTimeout> | null = null
let guardTimer: ReturnType<typeof setTimeout> | null = null
/** A Start tap is waiting for the microphone (a second tap must not start a second call). */
let starting = false

/** The current phase, read fresh (TypeScript would otherwise keep a narrowing across awaits). */
function phaseNow(): CallPhase {
  return state.phase
}

function desiredTone(s: CallState): Tone {
  if (s.phase === "ringing-out") return "ringback"
  if (s.phase === "ringing-in" && !s.accepting) return "ringtone"
  return "none"
}

/** Every state change goes through here: tones follow the phase, and so does the phase's guard timer. */
function commit(next: CallState): void {
  const prev = state
  const tone = desiredTone(next)
  if (tone !== prev.tone) {
    if (tone === "ringback") startRingback()
    else if (tone === "ringtone") startRingtone()
    else stopTones()
  }
  state = { ...next, tone }
  if (state.phase !== prev.phase || state.callId !== prev.callId) armGuard()
  for (const l of listeners) l()
}

function set(patch: Partial<CallState>): void {
  commit({ ...state, ...patch })
}

function idleState(): CallState {
  return { ...EMPTY, peerId: peer?.id ?? null, peerName: peer?.displayName ?? "" }
}

function clearCloseTimer(): void {
  if (closeTimer !== null) clearTimeout(closeTimer)
  closeTimer = null
}

function armGuard(): void {
  if (guardTimer !== null) clearTimeout(guardTimer)
  guardTimer = null
  const { phase, callId } = state
  const ms =
    phase === "ringing-out" ? CALLER_RING_GUARD_MS : phase === "ringing-in" ? INCOMING_GUARD_MS : phase === "connecting" ? CONNECT_TIMEOUT_MS : 0
  if (!ms || !callId) return
  guardTimer = setTimeout(() => {
    guardTimer = null
    if (state.callId !== callId || state.phase !== phase) return
    if (phase === "ringing-out") {
      sendFrame({ t: "call.end", callId })
      showEnded("No answer", DECLINED_SHOW_MS)
    } else if (phase === "ringing-in") {
      closeNow()
    } else {
      sendFrame({ t: "call.end", callId })
      showFailure()
    }
  }, ms)
}

/** Stop every local media resource of the current call (the mic never stays on after a call). */
function releaseMedia(): void {
  session?.close()
  session = null
  pendingMic?.stop()
  pendingMic = null
  pendingIce = null
}

/** Back to the chat at once. */
function closeNow(): void {
  clearCloseTimer()
  releaseMedia()
  commit(idleState())
}

/** Show a terminal text on the call screen for `ms`, then return to the chat. */
function showEnded(text: string, ms: number): void {
  clearCloseTimer()
  releaseMedia()
  set({ phase: "ended", endText: text, endState: null, accepting: false, remoteAudio: null })
  const callId = state.callId
  closeTimer = setTimeout(() => {
    closeTimer = null
    if (state.phase === "ended" && state.callId === callId && state.endState === null) closeNow()
  }, ms)
}

/** "Couldn't connect" with Retry and Close (D-19): stays until a button is tapped. */
function showFailure(): void {
  clearCloseTimer()
  releaseMedia()
  set({ phase: "ended", endText: null, endState: "couldnt-connect", accepting: false, remoteAudio: null })
}

function callEndedText(): string {
  return `Call ended · ${formatCallDuration(state.mediaStartedAt === null ? 0 : Date.now() - state.mediaStartedAt)}`
}

function onSample(sample: CallSample): void {
  const patch: Partial<CallState> = { inboundBytes: sample.inboundBytes, localType: sample.localType ?? null }
  if (state.phase === "connecting" && sample.state === "connected" && sample.inboundBytes > 0) {
    patch.phase = "live"
    patch.mediaStartedAt = Date.now()
  }
  set(patch)
}

/** The peer connection failed before any media flowed: give up (ICE failure, D-19). */
function onPeerState(callId: string, pcState: RTCPeerConnectionState): void {
  if (pcState !== "failed" || state.callId !== callId || state.phase !== "connecting") return
  sendFrame({ t: "call.end", callId })
  showFailure()
}

/** Build the call's session from the captured mic and ICE servers. False when setup threw. */
function startSession(callId: string, role: "caller" | "callee"): boolean {
  const mic = pendingMic
  const iceServers = pendingIce
  if (!mic || !iceServers) return false
  pendingMic = null
  pendingIce = null
  try {
    session = new CallSession({
      callId,
      role,
      iceServers,
      forceRelay: forceRelayFlag(),
      mic,
      send: sendFrame,
      onRemoteAudio: (stream) => set({ remoteAudio: stream }),
      onSample,
      onState: (s) => onPeerState(callId, s),
    })
    return true
  } catch (err) {
    console.error("call: setup failed", err)
    mic.stop()
    return false
  }
}

function missedCallToast(kind: CallKind): void {
  toast(`Missed call from ${state.peerName || peer?.displayName || "your person"}`, {
    action: { label: "Call back", onClick: () => void callStore.startCall(kind) },
  })
}

function handleEnded(frame: Extract<ServerFrame, { t: "call.ended" }>): void {
  if (frame.callId !== state.callId || state.phase === "ended" || state.phase === "idle") return
  const noMedia = state.mediaStartedAt === null
  switch (frame.reason) {
    case "hangup":
    case "dropped":
    case "failed":
      if (state.phase === "ringing-in") closeNow()
      else if (!noMedia) showEnded(callEndedText(), ENDED_SHOW_MS)
      else if (state.phase === "ringing-out" && frame.reason !== "failed") closeNow()
      else showFailure()
      return
    case "declined":
      if (state.role === "caller") showEnded("Declined", DECLINED_SHOW_MS)
      else closeNow()
      return
    case "no-answer":
    case "cancelled": {
      // An Accept that reached the server after the ring ended (race kept by design): missed call.
      const tapped = state.role === "callee" && (state.accepting || state.phase === "connecting")
      if (state.role === "caller" && frame.reason === "no-answer") {
        showEnded("No answer", DECLINED_SHOW_MS)
        return
      }
      const kind = state.kind
      closeNow()
      if (tapped) missedCallToast(kind)
      return
    }
    default:
      closeNow()
  }
}

export const callStore = {
  subscribe(listener: () => void): () => void {
    listeners.add(listener)
    return () => listeners.delete(listener)
  },
  getSnapshot(): CallState {
    return state
  },
  getServerSnapshot(): CallState {
    return EMPTY
  },

  /** Bind the store to the logged-in person's peer (the callee of every call from here). */
  init(me: MeResponse): void {
    peer = me.peer
    if (state.phase === "idle") set({ peerId: peer?.id ?? null, peerName: peer?.displayName ?? "" })
  },

  /** Start a call (CALL-01). The microphone is requested first, inside the tap (Pitfall 8). */
  async startCall(kind: CallKind): Promise<void> {
    unlockAudio()
    if (!peer || starting || (state.phase !== "idle" && state.phase !== "ended")) return
    starting = true
    let mic: Awaited<ReturnType<typeof getMic>>
    try {
      mic = await getMic()
    } finally {
      starting = false
    }
    if (!peer || (state.phase !== "idle" && state.phase !== "ended")) {
      if (mic.ok) mic.track.stop()
      return
    }
    clearCloseTimer()
    releaseMedia()
    const callId = crypto.randomUUID()
    const base = { ...idleState(), callId, kind, role: "caller" as const, peerId: peer.id, peerName: peer.displayName }
    if (!mic.ok) {
      commit({ ...base, phase: "ended", endState: "couldnt-connect" })
      return
    }
    commit({ ...base, phase: "ringing-out" })
    pendingMic = mic.track
    try {
      const { iceServers } = await fetchIceServers()
      if (state.callId !== callId || phaseNow() !== "ringing-out") return
      pendingIce = iceServers
    } catch {
      if (state.callId === callId && phaseNow() === "ringing-out") showFailure()
      return
    }
    if (!sendFrame({ t: "call.invite", callId, kind })) showFailure()
  },

  /** Retry from "Couldn't connect": a new call of the same kind (D-19). */
  retry(): void {
    if (state.phase !== "ended" || state.endState === null) return
    const kind = state.kind
    void callStore.startCall(kind)
  },

  /** Close a terminal state that waits for a tap. */
  dismiss(): void {
    if (state.phase === "ended") closeNow()
  },

  /** Answer the ringing call on this device. */
  async acceptCall(): Promise<void> {
    unlockAudio()
    const callId = state.callId
    if (state.phase !== "ringing-in" || state.accepting || !callId) return
    set({ accepting: true })
    const mic = await getMic()
    if (state.callId !== callId || state.phase !== "ringing-in") {
      if (mic.ok) mic.track.stop()
      return
    }
    if (!mic.ok) {
      sendFrame({ t: "call.decline", callId })
      showFailure()
      return
    }
    pendingMic = mic.track
    try {
      const { iceServers } = await fetchIceServers()
      if (state.callId !== callId || state.phase !== "ringing-in") {
        releaseMedia()
        return
      }
      pendingIce = iceServers
    } catch {
      if (state.callId === callId && state.phase === "ringing-in") {
        sendFrame({ t: "call.decline", callId })
        showFailure()
      }
      return
    }
    if (!startSession(callId, "callee")) {
      sendFrame({ t: "call.decline", callId })
      showFailure()
      return
    }
    sendFrame({ t: "call.accept", callId })
    set({ phase: "connecting", accepting: false })
  },

  /** Refuse the ringing call; this device closes at once (D-13). */
  declineCall(): void {
    unlockAudio()
    const callId = state.callId
    if (state.phase !== "ringing-in" || !callId) return
    sendFrame({ t: "call.decline", callId })
    closeNow()
  },

  /** Hang up (or cancel while ringing). */
  hangUp(): void {
    const callId = state.callId
    if (!callId) return
    if (state.phase === "ringing-out") {
      sendFrame({ t: "call.end", callId })
      closeNow()
      return
    }
    if (state.phase !== "connecting" && state.phase !== "live") return
    sendFrame({ t: "call.end", callId })
    if (state.mediaStartedAt !== null) showEnded(callEndedText(), ENDED_SHOW_MS)
    else closeNow()
  },

  /** Every frame of the realtime socket (registered by CallProvider). */
  handleFrame(frame: ServerFrame): void {
    switch (frame.t) {
      case "call.ring":
        // A ring replaces a terminal text that is still showing.
        if (state.phase !== "idle" && state.phase !== "ended") return
        clearCloseTimer()
        releaseMedia()
        commit({
          ...idleState(),
          phase: "ringing-in",
          callId: frame.callId,
          kind: frame.kind,
          role: "callee",
          peerId: peer?.id ?? frame.from,
        })
        return
      case "call.accepted":
        if (frame.callId !== state.callId) return
        if (state.phase === "ringing-out") {
          if (!startSession(frame.callId, "caller")) {
            sendFrame({ t: "call.end", callId: frame.callId })
            showFailure()
            return
          }
          set({ phase: "connecting" })
        }
        return
      case "call.ended":
        handleEnded(frame)
        return
      case "rtc.signal":
        session?.handleRoomFrame(frame)
        return
      default:
        return
    }
  },

  /** Forget the call and release every media resource (logout, session gone). */
  reset(): void {
    clearCloseTimer()
    releaseMedia()
    peer = null
    commit(EMPTY)
  },
}

export function useCall(): CallState {
  return useSyncExternalStore(callStore.subscribe, callStore.getSnapshot, callStore.getServerSnapshot)
}
