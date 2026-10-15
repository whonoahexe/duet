"use client"

import { useSyncExternalStore } from "react"
import { formatCallDuration, type CallKind, type MeResponse, type ServerFrame, type UserSummary } from "@duet/shared"
import { sendFrame } from "@/lib/chat/realtime"
import { fetchIceServers } from "@/lib/rtc/ice"
import type { CallSample } from "@/lib/rtc/stats"
import { getMic } from "./media"
import { CallSession, forceRelayFlag } from "./session"

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
  /** Terminal status line text while phase is "ended" ("Declined", "Call ended · 2:14", …). */
  endText: string | null
  /** The remote audio, played by the always-mounted <audio> in CallProvider. */
  remoteAudio: MediaStream | null
  /** Diagnostics only (call-diag): selected local candidate type and inbound bytes. */
  localType: string | null
  inboundBytes: number
}

/** How long each terminal text stays before the call screen closes (UI-SPEC section 5). */
const ENDED_SHOW_MS = 1500
const DECLINED_SHOW_MS = 2000

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
  remoteAudio: null,
  localType: null,
  inboundBytes: 0,
}

let state: CallState = EMPTY
const listeners = new Set<() => void>()
let peer: UserSummary | null = null
let session: CallSession | null = null
/** The microphone of the call being set up, before a session owns it. */
let pendingMic: MediaStreamTrack | null = null
let pendingIce: RTCIceServer[] | null = null
let closeTimer: ReturnType<typeof setTimeout> | null = null

function set(patch: Partial<CallState>): void {
  state = { ...state, ...patch }
  for (const l of listeners) l()
}

function clearCloseTimer(): void {
  if (closeTimer !== null) clearTimeout(closeTimer)
  closeTimer = null
}

/** Stop every local media resource of the current call (T-03 privacy: the mic never stays on). */
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
  state = { ...EMPTY, peerId: peer?.id ?? null, peerName: peer?.displayName ?? "" }
  for (const l of listeners) l()
}

/** Show a terminal text on the call screen for `ms`, then return to the chat. */
function showEnded(text: string, ms: number): void {
  clearCloseTimer()
  releaseMedia()
  set({ phase: "ended", endText: text, accepting: false, remoteAudio: null })
  const callId = state.callId
  closeTimer = setTimeout(() => {
    closeTimer = null
    if (state.phase === "ended" && state.callId === callId) closeNow()
  }, ms)
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

function startSession(callId: string, role: "caller" | "callee"): void {
  const mic = pendingMic
  const iceServers = pendingIce
  if (!mic || !iceServers) return
  pendingMic = null
  pendingIce = null
  session = new CallSession({
    callId,
    role,
    iceServers,
    forceRelay: forceRelayFlag(),
    mic,
    send: sendFrame,
    onRemoteAudio: (stream) => set({ remoteAudio: stream }),
    onSample,
  })
}

function handleEnded(frame: Extract<ServerFrame, { t: "call.ended" }>): void {
  if (frame.callId !== state.callId || state.phase === "ended" || state.phase === "idle") return
  switch (frame.reason) {
    case "hangup":
    case "dropped":
      if (state.mediaStartedAt !== null) showEnded(callEndedText(), ENDED_SHOW_MS)
      else closeNow()
      return
    case "declined":
      if (state.role === "caller") showEnded("Declined", DECLINED_SHOW_MS)
      else closeNow()
      return
    case "no-answer":
      if (state.role === "caller") showEnded("No answer", DECLINED_SHOW_MS)
      else closeNow()
      return
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
    if (!peer || (state.phase !== "idle" && state.phase !== "ended")) return
    const mic = await getMic()
    if (!mic.ok) return
    if (state.phase !== "idle" && state.phase !== "ended") {
      mic.track.stop()
      return
    }
    clearCloseTimer()
    releaseMedia()
    pendingMic = mic.track
    const callId = crypto.randomUUID()
    set({
      ...EMPTY,
      phase: "ringing-out",
      callId,
      kind,
      role: "caller",
      peerId: peer.id,
      peerName: peer.displayName,
    })
    try {
      const { iceServers } = await fetchIceServers()
      if (state.callId !== callId) return
      pendingIce = iceServers
    } catch {
      if (state.callId === callId) closeNow()
      return
    }
    if (!sendFrame({ t: "call.invite", callId, kind })) closeNow()
  },

  /** Answer the ringing call on this device. */
  async acceptCall(): Promise<void> {
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
      closeNow()
      return
    }
    pendingMic = mic.track
    try {
      const { iceServers } = await fetchIceServers()
      if (state.callId !== callId || state.phase !== "ringing-in") return
      pendingIce = iceServers
    } catch {
      if (state.callId === callId) {
        sendFrame({ t: "call.decline", callId })
        closeNow()
      }
      return
    }
    startSession(callId, "callee")
    sendFrame({ t: "call.accept", callId })
    set({ phase: "connecting", accepting: false })
  },

  /** Refuse the ringing call; this device closes at once (D-13). */
  declineCall(): void {
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
        if (state.phase !== "idle" && state.phase !== "ended") return
        clearCloseTimer()
        releaseMedia()
        set({
          ...EMPTY,
          phase: "ringing-in",
          callId: frame.callId,
          kind: frame.kind,
          role: "callee",
          peerId: peer?.id ?? frame.from,
          peerName: peer?.displayName ?? "",
        })
        return
      case "call.accepted":
        if (frame.callId !== state.callId) return
        if (state.phase === "ringing-out") {
          startSession(frame.callId, "caller")
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
    state = EMPTY
    for (const l of listeners) l()
  },
}

export function useCall(): CallState {
  return useSyncExternalStore(callStore.subscribe, callStore.getSnapshot, callStore.getServerSnapshot)
}
