"use client"

import { useSyncExternalStore } from "react"
import { toast } from "sonner"
import {
  callRoom,
  CallStatusResponse,
  formatCallDuration,
  type CallKind,
  type MeResponse,
  type ServerFrame,
  type UserSummary,
} from "@duet/shared"
import { apiGet } from "@/lib/api"
import { clearNotifications } from "@/lib/chat/push"
import { sendFrame } from "@/lib/chat/realtime"
import { chatStore } from "@/lib/chat/store"
import { fetchIceServers } from "@/lib/rtc/ice"
import type { CallSample } from "@/lib/rtc/stats"
import { getCallMedia, getCamera, type CallMediaResult, type Facing } from "./media"
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
  /** A denied capture device: the permission drawer shows how to allow it (D-19). */
  permission: "microphone" | "camera" | null
  /** This device's camera is on and sent to the peer (D-03). */
  camera: boolean
  /** The peer's camera flag from call.media (Pitfall 7: never inferred from the remote track). */
  peerCamera: boolean
  /** Which camera is open (or would open next): the self-view is mirrored only for "user". */
  facing: Facing
  /** The self-view stream (null while the camera is off). */
  localVideo: MediaStream | null
  /** The remote video stream (present from setup; shown only while peerCamera and a frame decoded). */
  remoteVideo: MediaStream | null
  /** The camera was refused for this call (D-19): the call runs audio-only. */
  cameraDenied: boolean
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
  permission: null,
  camera: false,
  peerCamera: false,
  facing: "user",
  localVideo: null,
  remoteVideo: null,
  cameraDenied: false,
}

let state: CallState = EMPTY
const listeners = new Set<() => void>()
let peer: UserSummary | null = null
let session: CallSession | null = null
/** The microphone of the call being set up, before a session owns it. */
let pendingMic: MediaStreamTrack | null = null
/** The camera of the call being set up (video call, or turned on while ringing), before a session owns it. */
let pendingCamera: MediaStreamTrack | null = null
/** A camera-on tap is waiting for getUserMedia (a second tap must not open a second camera). */
let cameraBusy = false
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
  if (state.phase !== prev.phase || state.callId !== prev.callId) {
    armGuard()
    // Pitfall 10: the in-app incoming screen replaces the push heads-up, and a call that ended leaves
    // no "Incoming call" behind in this phone's tray.
    const ended = (state.phase === "idle" || state.phase === "ended") && prev.phase !== "idle" && prev.phase !== "ended"
    if (state.phase === "ringing-in" || ended) void clearNotifications()
  }
  for (const l of listeners) l()
}

function set(patch: Partial<CallState>): void {
  commit({ ...state, ...patch })
}

/** Back to idle; a permission drawer that is showing stays (it is not part of a call). */
function idleState(): CallState {
  return { ...EMPTY, peerId: peer?.id ?? null, peerName: peer?.displayName ?? "", permission: state.permission }
}

const OFFLINE_TEXT = "You're offline. Calls need a connection."

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
  pendingCamera?.stop()
  pendingCamera = null
  pendingIce = null
}

/** Media fields of a call that is over: no camera, no videos (every track was stopped by releaseMedia). */
const NO_MEDIA: Partial<CallState> = {
  remoteAudio: null,
  remoteVideo: null,
  localVideo: null,
  camera: false,
  peerCamera: false,
}

/** A call this device is part of, from the first ring out to the end (camera and mute work here). */
function inCall(phase: CallPhase): boolean {
  return phase === "ringing-out" || phase === "connecting" || phase === "live"
}

/**
 * D-03: tell the peer whether this side's camera is on. Only once the server bound this connection
 * (connecting or live); resent after call.accepted, on every camera change and on room.peer-joined.
 */
function sendMedia(): void {
  const { callId, phase, camera } = state
  if (!callId || (phase !== "connecting" && phase !== "live")) return
  sendFrame({ t: "call.media", callId, camera })
}

/** D-19 (camera half): the call continues audio-only; the action opens "Allow the camera". */
function cameraDeniedToast(): void {
  toast("duet can't use the camera.", {
    id: "camera-denied",
    action: { label: "How to allow", onClick: () => set({ permission: "camera" }) },
  })
}

/** Hold freshly captured call media until the session takes it, and show the self-view. */
function holdMedia(media: Extract<CallMediaResult, { ok: true }>): void {
  pendingMic = media.mic
  pendingCamera = media.camera
  set({
    camera: media.camera !== null,
    localVideo: media.camera ? new MediaStream([media.camera]) : null,
    cameraDenied: media.cameraDenied,
  })
  if (media.cameraDenied) cameraDeniedToast()
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
  set({ ...NO_MEDIA, phase: "ended", endText: text, endState: null, accepting: false })
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
  set({ ...NO_MEDIA, phase: "ended", endText: null, endState: "couldnt-connect", accepting: false })
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
  const camera = pendingCamera
  const iceServers = pendingIce
  if (!mic || !iceServers) return false
  pendingMic = null
  pendingCamera = null
  pendingIce = null
  try {
    session = new CallSession({
      callId,
      role,
      iceServers,
      forceRelay: forceRelayFlag(),
      mic,
      camera,
      send: sendFrame,
      onRemoteAudio: (stream) => set({ remoteAudio: stream }),
      onRemoteVideo: (stream) => set({ remoteVideo: stream }),
      onSample,
      onState: (s) => onPeerState(callId, s),
    })
    return true
  } catch (err) {
    console.error("call: setup failed", err)
    mic.stop()
    camera?.stop()
    return false
  }
}

function missedCallToast(kind: CallKind, callId?: string): void {
  toast(`Missed call from ${state.peerName || peer?.displayName || "your person"}`, {
    // One toast per call, however many routes (deep link, SW message, a lost Accept race) report it.
    id: callId ? `missed-${callId}` : undefined,
    action: { label: "Call back", onClick: () => void callStore.startCall(kind) },
  })
}

function handleEnded(frame: Extract<ServerFrame, { t: "call.ended" }>): void {
  if (frame.callId !== state.callId || state.phase === "ended" || state.phase === "idle") return
  const noMedia = state.mediaStartedAt === null
  switch (frame.reason) {
    case "busy":
      // This person is already in a call on another device: the extra call screen closes.
      closeNow()
      toast("You're already in a call on another device.")
      return
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

/** Stop every track of a capture that is not going to be used. */
function dropMedia(media: CallMediaResult): void {
  if (!media.ok) return
  media.mic.stop()
  media.camera?.stop()
}

/**
 * Answer ringing call `callId` with media captured in a tap (Accept, or a Start tap that lost a glare
 * race on this device, which keeps its own camera choice, D-14): ICE servers, the callee session,
 * then call.accept.
 */
async function answer(callId: string, media: CallMediaResult): Promise<void> {
  if (state.callId !== callId || state.phase !== "ringing-in") {
    dropMedia(media)
    return
  }
  if (!media.ok) {
    sendFrame({ t: "call.decline", callId })
    if (media.reason === "denied") {
      closeNow()
      set({ permission: "microphone" })
    } else {
      showFailure()
    }
    return
  }
  holdMedia(media)
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
    // UI-SPEC section 1: no call starts while the chat connection is not live.
    if (chatStore.getSnapshot().connection !== "live") {
      toast(OFFLINE_TEXT)
      return
    }
    starting = true
    let media: CallMediaResult
    try {
      media = await getCallMedia(kind)
    } finally {
      starting = false
    }
    // D-14 on this device: the other person's ring arrived while we waited for the microphone.
    // Answer it with this microphone instead of starting a second call.
    if (phaseNow() === "ringing-in" && state.callId && !state.accepting) {
      const ringing = state.callId
      set({ accepting: true })
      await answer(ringing, media)
      return
    }
    if (!peer || (state.phase !== "idle" && state.phase !== "ended")) {
      dropMedia(media)
      return
    }
    clearCloseTimer()
    releaseMedia()
    const callId = crypto.randomUUID()
    const base = { ...idleState(), callId, kind, role: "caller" as const, peerId: peer.id, peerName: peer.displayName }
    if (!media.ok) {
      // Denied: the call does not start and the drawer explains how to allow it (D-19).
      if (media.reason === "denied") commit({ ...idleState(), permission: "microphone" })
      else commit({ ...base, phase: "ended", endState: "couldnt-connect" })
      return
    }
    commit({ ...base, phase: "ringing-out" })
    holdMedia(media)
    try {
      const { iceServers } = await fetchIceServers()
      if (state.callId !== callId || phaseNow() !== "ringing-out") return
      pendingIce = iceServers
    } catch {
      if (state.callId === callId && phaseNow() === "ringing-out") showFailure()
      return
    }
    if (!sendFrame({ t: "call.invite", callId, kind })) {
      // The socket dropped between the tap and the invite: nothing rang.
      closeNow()
      toast(OFFLINE_TEXT)
    }
  },

  /**
   * D-10: a call notification was tapped (or the app opened from one). A call that still rings shows
   * through ring-on-attach, so only a call from the peer that ended cancelled or unanswered needs
   * anything: the "Missed call from {peer}" toast with Call back. Nothing is stored; any error is quiet.
   */
  async checkCall(callId: string): Promise<void> {
    let status: CallStatusResponse
    try {
      status = await apiGet(`/api/calls/${callId}`, CallStatusResponse)
    } catch {
      return
    }
    if (status.status !== "ended" || (status.reason !== "no-answer" && status.reason !== "cancelled")) return
    if (!peer || status.callerId !== peer.id) return
    missedCallToast(status.kind, status.id)
  },

  /** The permission drawer was closed. */
  clearPermission(): void {
    if (state.permission !== null) set({ permission: null })
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
    // D-03: accepting a video call turns this side's camera on; a voice call stays camera-off.
    const media = await getCallMedia(state.kind, state.facing)
    await answer(callId, media)
  },

  /**
   * Turn this side's camera on or off in any call (D-03): replaceTrack on the video transceiver
   * negotiated at call start (no renegotiation), then call.media to the peer. A refused camera keeps
   * the call audio-only with the "How to allow" toast (D-19). Turning it off stops the track (T-03-13).
   */
  async toggleCamera(): Promise<void> {
    const callId = state.callId
    if (!callId || !inCall(state.phase) || cameraBusy) return
    if (state.camera) {
      set({ camera: false, localVideo: null })
      // The camera is released (replaceTrack(null), then stop) before the peer hears it is off.
      if (session) await session.setCamera(null)
      else {
        pendingCamera?.stop()
        pendingCamera = null
      }
      if (state.callId === callId && !state.camera) sendMedia()
      return
    }
    cameraBusy = true
    let result: Awaited<ReturnType<typeof getCamera>>
    try {
      result = await getCamera(state.facing)
    } finally {
      cameraBusy = false
    }
    if (state.callId !== callId || !inCall(phaseNow()) || state.camera) {
      if (result.ok) result.track.stop()
      return
    }
    if (!result.ok) {
      if (result.reason === "denied") cameraDeniedToast()
      else toast("duet can't use the camera.", { id: "camera-denied" })
      return
    }
    if (session) await session.setCamera(result.track)
    else {
      pendingCamera?.stop()
      pendingCamera = result.track
    }
    if (state.callId !== callId || !inCall(phaseNow())) return
    set({ camera: true, localVideo: new MediaStream([result.track]), cameraDenied: false })
    sendMedia()
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
        // Ring-on-attach re-sends the ring after a reconnect: the call already ringing here stays as is.
        // A ring replaces a terminal text that is still showing.
        if (frame.callId === state.callId && state.phase === "ringing-in") return
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
        // D-14 glare: the server merged our own invite into the call that rang us. Adopt that call as
        // its callee (polite answerer), keeping the microphone captured in our own Start tap.
        if (frame.replaces !== undefined && frame.replaces === state.callId && state.phase === "ringing-out") {
          if (!startSession(frame.callId, "callee")) {
            sendFrame({ t: "call.end", callId: frame.callId })
            showFailure()
            return
          }
          set({ callId: frame.callId, role: "callee", phase: "connecting" })
          sendMedia()
          return
        }
        if (frame.callId !== state.callId) return
        if (state.phase === "ringing-out") {
          if (!startSession(frame.callId, "caller")) {
            sendFrame({ t: "call.end", callId: frame.callId })
            showFailure()
            return
          }
          set({ phase: "connecting" })
        }
        // Both roles: the peer learns this side's camera state once the server bound the call (D-03).
        sendMedia()
        return
      case "call.media":
        if (frame.callId === state.callId && (state.phase === "connecting" || state.phase === "live")) {
          set({ peerCamera: frame.camera })
        }
        return
      case "room.peer-joined":
        if (state.callId && frame.room === callRoom(state.callId)) sendMedia()
        return
      case "call.ended":
        handleEnded(frame)
        return
      case "call.stop-ringing":
        // D-11: another of this person's devices answered first.
        if (frame.callId !== state.callId || state.phase !== "ringing-in") return
        closeNow()
        toast("Answered on another device")
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
