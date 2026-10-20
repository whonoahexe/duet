"use client"

import { useSyncExternalStore } from "react"
import { toast } from "sonner"
import {
  callRoom,
  CallStatusResponse,
  formatCallDuration,
  QUALITY_START,
  qualityStep,
  type QualityState,
  type CallKind,
  type MeResponse,
  type ServerFrame,
  type UserSummary,
} from "@duet/shared"
import { apiGet } from "@/lib/api"
import { clearNotifications } from "@/lib/chat/push"
import { realtimeLive, sendFrame } from "@/lib/chat/realtime"
import { chatStore } from "@/lib/chat/store"
import { isIos } from "@/lib/platform"
import { fetchIceServers } from "@/lib/rtc/ice"
import type { CallSample } from "@/lib/rtc/stats"
import { flipCamera, getCallMedia, getCamera, getMic, type CallMediaResult, type Facing } from "./media"
import { callLog, endCallLog, gumName, startCallLog } from "./diag-log"
import { CallSession, forceRelayFlag } from "./session"
import { startRingback, startRingtone, stopTones, unlockAudio, type Tone } from "./tones"
import { holdWakeLock, releaseWakeLock } from "./wake-lock"

export type CallPhase = "idle" | "ringing-out" | "ringing-in" | "connecting" | "live" | "ended"

/** The corner the self-view PiP snapped to (kept for the rest of the call, D-02). */
export type PipCorner = "tl" | "tr" | "bl" | "br"

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
  /** A terminal state with actions (D-17, D-19): stays until Retry / Call back or Close. */
  endState: "couldnt-connect" | "call-dropped" | null
  /**
   * D-17: the socket or the media path dropped mid-call and recovery is running ("Reconnecting…").
   * Video freezes on its last frame, the controls stay usable and the timer never resets.
   */
  reconnecting: boolean
  /** D-20: the Poor connection badge (2 bad 2 s samples on, 3 good off); hidden while reconnecting. */
  poor: boolean
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
  /** The microphone sends silence (track.enabled = false, CALL-05). */
  muted: boolean
  /** The self-view is large and the peer small (D-02 PiP tap); reset when either video stops. */
  swapped: boolean
  pipCorner: PipCorner
  /** D-06: the call screen is showing, or minimized to the chat with the on-call bar. */
  screen: "open" | "minimized"
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
/** D-17: a reconnect that has not recovered after this long gives up with "Call dropped". */
export const CALL_GIVE_UP_MS = 30_000

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
  reconnecting: false,
  poor: false,
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
  muted: false,
  swapped: false,
  pipCorner: "br",
  screen: "open",
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
/** The call whose invite reached the socket (a rejoin before that would name a call the server never saw). */
let invitedCallId: string | null = null
/**
 * D-17: the one give-up timer shared by every drop trigger (ICE disconnected/failed, a WS loss, repeated
 * drops). Only a full recovery clears it; the call ending clears it.
 */
let giveUpTimer: ReturnType<typeof setTimeout> | null = null
/** The socket dropped during this call and its call.state has not come back on a new socket yet. */
let rejoinPending = false
/** D-20: the badge state and the previous cumulative packet counters (loss is a per-sample delta). */
let quality: QualityState = QUALITY_START
let lastPackets: { lost: number; received: number } | null = null
/** A resume is re-acquiring ended capture tracks (D-18): one at a time. */
let resuming = false
/**
 * WR-05: the other person's ring that arrived while this device was still setting up its own call
 * (ringing-out, invite not sent yet). The server only merges the two (D-14) once the invite arrives;
 * if this attempt ends first, the ring is shown then. Cleared when that call ends or is answered.
 */
let deferredRing: Extract<ServerFrame, { t: "call.ring" }> | null = null

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
  // D-02: the swap resets when either video stops (this camera off, the peer's camera off, the call over).
  if (
    next.swapped &&
    (!next.camera || (prev.peerCamera && !next.peerCamera) || next.phase === "ended" || next.phase === "idle")
  ) {
    next = { ...next, swapped: false }
  }
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
    // 261020-oj7: the call's log follows the phase (a new callId, including the D-14 glare adoption,
    // starts a new log; ended or idle ends it).
    if (state.callId) startCallLog(state.callId, state.role ?? "caller")
    callLog({ k: "phase", phase: state.phase })
    if ((state.phase === "ended" || state.phase === "idle") && prev.phase !== state.phase) endCallLog()
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

/** 261020-oj7: the call log's turn event for one ICE-server fetch that started at `t0` (performance.now()). */
function logTurn(t0: number, result: { iceServers: RTCIceServer[]; ttlSeconds: number } | null): void {
  const ms = Math.min(120_000, Math.max(0, Math.round(performance.now() - t0)))
  if (!result) callLog({ k: "turn", ok: false, ms })
  else {
    const ttlSeconds = Math.min(172_800, Math.max(1, Math.round(result.ttlSeconds)))
    callLog({ k: "turn", ok: true, ms, ttlSeconds, servers: Math.min(20, result.iceServers.length) })
  }
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
      callLog({ k: "end", cause: "setup_failed" })
      sendFrame({ t: "call.end", callId })
      showFailure()
    }
  }, ms)
}

/** Stop every local media resource of the current call (the mic never stays on after a call). */
function releaseMedia(): void {
  clearGiveUp()
  rejoinPending = false
  quality = QUALITY_START
  lastPackets = null
  releaseWakeLock()
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
  reconnecting: false,
  poor: false,
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
    duration: 10_000,
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
  flushDeferredRing()
}

/** WR-05: this device's own attempt ended before its invite was sent; show the ring it held back. */
function flushDeferredRing(): void {
  const ring = deferredRing
  deferredRing = null
  if (ring && (state.phase === "idle" || state.phase === "ended")) callStore.handleFrame(ring)
}

/** Show a terminal text on the call screen for `ms`, then return to the chat. */
function showEnded(text: string, ms: number): void {
  clearCloseTimer()
  releaseMedia()
  if (state.screen === "minimized") {
    // D-06 / UI-SPEC section 5: a minimized call that ends never reopens the screen; same copy as a toast.
    closeNow()
    toast(text)
    return
  }
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
  if (state.screen === "minimized") {
    const kind = state.kind
    closeNow()
    toast("Couldn't connect", { action: { label: "Retry", onClick: () => void callStore.startCall(kind) } })
    return
  }
  set({ ...NO_MEDIA, phase: "ended", endText: null, endState: "couldnt-connect", accepting: false })
  flushDeferredRing()
}

/**
 * "Call dropped" with Call back and Close (D-17, UI-SPEC section 5): stays until a button is tapped.
 * While minimized it is a toast with a Call back action instead (the call screen never reopens).
 */
function showDropped(): void {
  clearCloseTimer()
  releaseMedia()
  const kind = state.kind
  if (state.screen === "minimized") {
    closeNow()
    toast("Call dropped", { action: { label: "Call back", onClick: () => void callStore.startCall(kind) } })
    return
  }
  set({ ...NO_MEDIA, phase: "ended", endText: null, endState: "call-dropped", accepting: false })
}

function clearGiveUp(): void {
  if (giveUpTimer !== null) clearTimeout(giveUpTimer)
  giveUpTimer = null
}

/** A connected call (bound at the server) that a drop can interrupt. */
function reconnectable(phase: CallPhase): boolean {
  return phase === "connecting" || phase === "live"
}

/**
 * A drop trigger (D-17): "Reconnecting…" shows and the single 30 s give-up timer starts unless one is
 * already running (overlapping or repeated drops never restart it).
 */
function startReconnecting(): void {
  const callId = state.callId
  if (!callId || !reconnectable(state.phase)) return
  if (!state.reconnecting) {
    callLog({ k: "reconnect", what: "start" })
    set({ reconnecting: true })
  }
  if (giveUpTimer !== null) return
  giveUpTimer = setTimeout(() => {
    giveUpTimer = null
    if (state.callId !== callId || !reconnectable(state.phase) || !state.reconnecting) return
    callLog({ k: "reconnect", what: "give_up" })
    callLog({ k: "end", cause: "give_up" })
    // The server ends it too (35 s absence) when this side could not tell it.
    sendFrame({ t: "call.end", callId })
    showDropped()
  }, CALL_GIVE_UP_MS)
}

/**
 * Full recovery ends "Reconnecting…": the media path is connected, the socket is live and, after a
 * socket drop, the server answered call.rejoin with call.state. The timer resumes from mediaStartedAt.
 */
function checkRecovered(): void {
  if (!state.reconnecting || rejoinPending) return
  if (!session || session.connectionState !== "connected" || !realtimeLive()) return
  callLog({ k: "reconnect", what: "recovered" })
  clearGiveUp()
  set({ reconnecting: false })
}

/** Whether the server knows this device's side of the current call (so call.rejoin can name it). */
function boundHere(): boolean {
  const { callId, phase, role } = state
  if (!callId) return false
  if (phase === "ringing-out") return invitedCallId === callId
  return reconnectable(phase) && (role === "callee" || invitedCallId === callId)
}

/**
 * WR-06: tell the server this device leaves its call (logout), before the socket closes: otherwise an
 * active call waits out the 35 s absence grace and the peer sees "Call dropped", and a ring this device
 * started keeps ringing. A ring this device only receives binds nothing here, so the person's other
 * devices keep ringing.
 */
function sendLeave(): void {
  const { callId, phase } = state
  if (!callId) return
  if (phase === "ringing-out" ? invitedCallId === callId : reconnectable(phase)) sendFrame({ t: "call.end", callId })
}

function callEndedText(): string {
  return `Call ended · ${formatCallDuration(state.mediaStartedAt === null ? 0 : Date.now() - state.mediaStartedAt)}`
}

/**
 * D-20: feed one 2 s sample into qualityStep. Loss is lost / (lost + received) over the interval
 * (undefined when no packet moved); RTT comes from the selected candidate pair.
 */
function sampleQuality(sample: CallSample): boolean {
  const prev = lastPackets
  lastPackets = { lost: sample.packetsLost, received: sample.packetsReceived }
  if (state.phase !== "live") return state.poor
  const lost = prev ? Math.max(0, sample.packetsLost - prev.lost) : 0
  const received = prev ? Math.max(0, sample.packetsReceived - prev.received) : 0
  const lossFraction = lost + received > 0 ? lost / (lost + received) : undefined
  quality = qualityStep(quality, { lossFraction, rttMs: sample.rttMs })
  return quality.poor
}

function onSample(sample: CallSample): void {
  const patch: Partial<CallState> = {
    inboundBytes: sample.inboundBytes,
    localType: sample.localType ?? null,
    poor: sampleQuality(sample),
  }
  const goesLive = state.phase === "connecting" && sample.state === "connected" && sample.inboundBytes > 0
  if (goesLive) {
    patch.phase = "live"
    patch.mediaStartedAt = Date.now()
  }
  set(patch)
  if (goesLive) {
    holdWakeLock()
    showIosTip()
  }
}

const IOS_TIP_KEY = "duet.callTipShown"

/** D-18: the first call that connects on an iOS device explains that video pauses in the background. */
function showIosTip(): void {
  if (!isIos()) return
  try {
    if (localStorage.getItem(IOS_TIP_KEY) === "1") return
    localStorage.setItem(IOS_TIP_KEY, "1")
  } catch {
    return
  }
  toast("Keep duet open during calls", {
    description: "On iPhone, video pauses when duet is in the background.",
    duration: 6000,
  })
}

/**
 * Peer connection state changes. Failed before any media flowed gives up (ICE failure, D-19);
 * disconnected or failed once media flowed is a drop trigger (D-17); connected may complete a recovery.
 */
function onPeerState(callId: string, pcState: RTCPeerConnectionState): void {
  if (state.callId !== callId) return
  if (pcState === "failed" && state.phase === "connecting" && state.mediaStartedAt === null && !state.reconnecting) {
    callLog({ k: "end", cause: "ice_failed" })
    sendFrame({ t: "call.end", callId })
    showFailure()
    return
  }
  if (pcState === "disconnected" || pcState === "failed") startReconnecting()
  else if (pcState === "connected") checkRecovered()
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

/** The callee accepted (call.accepted, or call.state active after a rejoin): the caller's session starts. */
function startCallerSession(callId: string): boolean {
  if (!startSession(callId, "caller")) {
    callLog({ k: "end", cause: "setup_failed" })
    sendFrame({ t: "call.end", callId })
    showFailure()
    return false
  }
  set({ phase: "connecting" })
  return true
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
  callLog({ k: "end", cause: "remote", serverReason: frame.reason })
  const noMedia = state.mediaStartedAt === null
  switch (frame.reason) {
    case "busy":
      // This person is already in a call on another device: the extra call screen closes.
      closeNow()
      toast("You're already in a call on another device.")
      return
    case "dropped":
      // The server gave up on a party that stayed away (35 s): the same state as this side giving up.
      if (state.phase === "ringing-in") closeNow()
      else if (!noMedia) showDropped()
      else if (state.phase === "ringing-out") closeNow()
      else showFailure()
      return
    case "hangup":
      // WR-03: the other side hung up on purpose, even before media flowed: "Call ended · 0:00", never
      // the network-failure screen.
      if (state.phase === "ringing-in") closeNow()
      else showEnded(callEndedText(), ENDED_SHOW_MS)
      return
    case "failed":
      if (state.phase === "ringing-in") closeNow()
      else if (!noMedia) showEnded(callEndedText(), ENDED_SHOW_MS)
      else showFailure()
      return
    case "declined":
      if (state.role === "caller") showEnded("Declined", DECLINED_SHOW_MS)
      else closeNow()
      return
    case "no-answer":
    case "cancelled": {
      if (state.role === "caller" && frame.reason === "no-answer") {
        showEnded("No answer", DECLINED_SHOW_MS)
        return
      }
      // WR-04 (D-12): a ring nobody answered for the full timeout leaves the missed-call toast: the server
      // skips the "Missed call" push for a session viewing duet, so this toast is the only trace. A ring
      // the caller cancelled closes quietly (UI-SPEC section 5: the user saw it ring), unless Accept was
      // already tapped (an Accept that reached the server after the ring ended, race kept by design).
      const kind = state.kind
      const callee = state.role === "callee"
      const tapped = callee && (state.accepting || state.phase === "connecting")
      closeNow()
      if (callee && (frame.reason === "no-answer" || tapped)) missedCallToast(kind, frame.callId)
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
  // WR-08: a technical failure after the Accept tap ends the call as failed (the caller sees "Couldn't
  // connect"). A Decline tap, and a refused microphone (UI-SPEC section 8), send a plain decline.
  if (!media.ok) {
    callLog({ k: "gum_error", device: state.kind === "video" ? "mic_camera" : "mic", context: "accept", name: gumName(media.errorName) })
    callLog({ k: "end", cause: media.reason === "denied" ? "mic_denied" : "setup_failed" })
    sendFrame(media.reason === "denied" ? { t: "call.decline", callId } : { t: "call.decline", callId, reason: "failed" })
    if (media.reason === "denied") {
      closeNow()
      set({ permission: "microphone" })
    } else {
      showFailure()
    }
    return
  }
  if (media.cameraError) callLog({ k: "gum_error", device: "camera", context: "accept", name: gumName(media.cameraError) })
  holdMedia(media)
  holdWakeLock()
  const turnStart = performance.now()
  try {
    const ice = await fetchIceServers()
    if (state.callId !== callId || state.phase !== "ringing-in") {
      releaseMedia()
      return
    }
    logTurn(turnStart, ice)
    pendingIce = ice.iceServers
  } catch {
    if (state.callId === callId && state.phase === "ringing-in") {
      logTurn(turnStart, null)
      callLog({ k: "end", cause: "turn_failed" })
      sendFrame({ t: "call.decline", callId, reason: "failed" })
      showFailure()
    }
    return
  }
  if (!startSession(callId, "callee")) {
    callLog({ k: "end", cause: "setup_failed" })
    sendFrame({ t: "call.decline", callId, reason: "failed" })
    showFailure()
    return
  }
  // WR-02: an Accept that never reached the server (the socket was down) is sent again when the server
  // re-rings this call on the next socket (ring-on-attach, see handleFrame "call.ring").
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
    // 261020-oj7: the log starts with the callId, so a refused microphone is logged too.
    startCallLog(callId, "caller")
    const base = { ...idleState(), callId, kind, role: "caller" as const, peerId: peer.id, peerName: peer.displayName }
    if (!media.ok) {
      callLog({ k: "gum_error", device: kind === "video" ? "mic_camera" : "mic", context: "start", name: gumName(media.errorName) })
      callLog({ k: "end", cause: media.reason === "denied" ? "mic_denied" : "setup_failed" })
      // Denied: the call does not start and the drawer explains how to allow it (D-19).
      if (media.reason === "denied") {
        commit({ ...idleState(), permission: "microphone" })
        endCallLog()
      } else commit({ ...base, phase: "ended", endState: "couldnt-connect" })
      return
    }
    if (media.cameraError) callLog({ k: "gum_error", device: "camera", context: "start", name: gumName(media.cameraError) })
    deferredRing = null
    commit({ ...base, phase: "ringing-out" })
    holdMedia(media)
    // CALL-08: the screen stays on from the Start tap until the call ends.
    holdWakeLock()
    const turnStart = performance.now()
    try {
      const ice = await fetchIceServers()
      if (state.callId !== callId || phaseNow() !== "ringing-out") return
      logTurn(turnStart, ice)
      pendingIce = ice.iceServers
    } catch {
      if (state.callId === callId && phaseNow() === "ringing-out") {
        logTurn(turnStart, null)
        callLog({ k: "end", cause: "turn_failed" })
        showFailure()
      }
      return
    }
    if (sendFrame({ t: "call.invite", callId, kind })) {
      invitedCallId = callId
      // A held-back ring is merged with this invite by the server now (D-14), or already over.
      deferredRing = null
    } else {
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

  /** Call back from "Call dropped": a new call of the same kind (D-17). */
  callBack(): void {
    callStore.retry()
  },

  /**
   * CALL-07: a socket of this tab became live (hello). A call this device is bound to asks the server
   * for its place back (call.rejoin); call.state or call.ended answers.
   */
  onRealtimeLive(): void {
    callLog({ k: "ws", what: "live" })
    if (!boundHere() || !state.callId) return
    sendFrame({ t: "call.rejoin", callId: state.callId })
    callLog({ k: "reconnect", what: "rejoin_sent" })
  },

  /**
   * D-18 resume: duet came back to the foreground. iOS may have ended the capture tracks while it was
   * hidden (an interruption); an ended microphone, and an ended camera while the camera is on, are
   * captured again and swapped in with replaceTrack, keeping the mute and camera state. Call tracks
   * are never stopped on hide. A capture that fails leaves the call as it is (it can still drop).
   */
  async onVisible(): Promise<void> {
    const callId = state.callId
    if (!callId || !session || !reconnectable(state.phase) || resuming) return
    const s = session
    resuming = true
    try {
      if (s.micTrack.readyState === "ended") {
        const mic = await getMic()
        if (mic.ok) {
          if (session !== s || state.callId !== callId) mic.track.stop()
          else {
            mic.track.enabled = !state.muted
            await s.setMic(mic.track)
            callLog({ k: "media", what: "mic_replaced" })
          }
        } else callLog({ k: "gum_error", device: "mic", context: "resume", name: gumName(mic.errorName) })
      }
      const cam = s.cameraTrack
      if (state.camera && cam && cam.readyState === "ended" && session === s && state.callId === callId) {
        const result = await getCamera(state.facing)
        if (result.ok) {
          if (session !== s || state.callId !== callId || !state.camera) result.track.stop()
          else {
            await s.setCamera(result.track)
            set({ localVideo: new MediaStream([result.track]) })
            callLog({ k: "media", what: "camera_replaced" })
          }
        } else callLog({ k: "gum_error", device: "camera", context: "resume", name: gumName(result.errorName) })
      }
    } finally {
      resuming = false
    }
  },

  /** CALL-07: the tab's live socket was lost. A connected call shows "Reconnecting…" (D-17). */
  onRealtimeDown(): void {
    callLog({ k: "ws", what: "down" })
    if (!boundHere()) return
    rejoinPending = true
    startReconnecting()
  },

  /** Close a terminal state that waits for a tap. */
  dismiss(): void {
    if (state.phase === "ended") closeNow()
  },

  /** Mute or unmute the microphone (CALL-05): track.enabled, no renegotiation. */
  toggleMute(): void {
    if (!inCall(state.phase)) return
    const muted = !state.muted
    const mic = session?.micTrack ?? pendingMic
    if (mic) mic.enabled = !muted
    callLog({ k: "media", what: muted ? "mute" : "unmute" })
    set({ muted })
  },

  /** Whether the live microphone track sends sound (call-diag data-mic); null without a microphone. */
  micEnabled(): boolean | null {
    const mic = session?.micTrack ?? pendingMic
    return mic && mic.readyState === "live" ? mic.enabled : null
  },

  /** The open camera's deviceId (call-diag data-camera-device, T-03-15); "" while the camera is off. */
  cameraDeviceId(): string {
    const track = session?.cameraTrack ?? pendingCamera
    return track && track.readyState === "live" ? (track.getSettings().deviceId ?? "") : ""
  },

  /**
   * Switch between the front and back camera (CALL-06): the new track replaces the old one with
   * replaceTrack and the self-view follows it (mirrored only for the front camera). A failure leaves
   * the camera off and tells the peer.
   */
  async flip(): Promise<void> {
    const callId = state.callId
    if (!callId || !inCall(state.phase) || !state.camera || cameraBusy) return
    const current = session?.cameraTrack ?? pendingCamera
    if (!current) return
    cameraBusy = true
    let result: Awaited<ReturnType<typeof flipCamera>>
    try {
      result = await flipCamera(current, state.facing)
    } finally {
      cameraBusy = false
    }
    if (state.callId !== callId || !inCall(phaseNow()) || !state.camera) {
      if (result.ok) result.track.stop()
      return
    }
    if (!result.ok) {
      callLog({ k: "gum_error", device: "camera", context: "flip", name: gumName(result.errorName) })
      // The old camera is already stopped: the call continues without video.
      set({ camera: false, localVideo: null })
      if (session) await session.setCamera(null)
      else pendingCamera = null
      sendMedia()
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
    callLog({ k: "media", what: "camera_flip", facing: result.facing })
    set({ facing: result.facing, localVideo: new MediaStream([result.track]) })
  },

  /** Swap the large and small views (a tap on the self-view, D-02). */
  swap(): void {
    if (!inCall(state.phase) || !state.camera) return
    set({ swapped: !state.swapped })
  },

  /**
   * D-06: close the call screen without hanging up (Back to chat, Escape). The call, its audio, the
   * camera and the timer continue; the on-call bar returns to it. A terminal state just closes.
   */
  minimize(): void {
    if (inCall(state.phase)) {
      if (state.screen !== "minimized") set({ screen: "minimized" })
    } else if (state.phase === "ended") {
      closeNow()
    }
  },

  /** Reopen the minimized call screen, in the same mode and swap state. */
  restore(): void {
    if (state.screen !== "open") set({ screen: "open" })
  },

  /** The self-view was dragged to `corner`; it stays there for the rest of the call. */
  setPipCorner(corner: PipCorner): void {
    if (corner !== state.pipCorner) set({ pipCorner: corner })
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
      callLog({ k: "media", what: "camera_off" })
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
      callLog({ k: "gum_error", device: "camera", context: "camera_on", name: gumName(result.errorName) })
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
    callLog({ k: "media", what: "camera_on" })
    set({ camera: true, localVideo: new MediaStream([result.track]), cameraDenied: false })
    sendMedia()
  },

  /** Refuse the ringing call; this device closes at once (D-13). */
  declineCall(): void {
    unlockAudio()
    const callId = state.callId
    if (state.phase !== "ringing-in" || !callId) return
    callLog({ k: "end", cause: "decline" })
    sendFrame({ t: "call.decline", callId })
    closeNow()
  },

  /** Hang up (or cancel while ringing). */
  hangUp(): void {
    const callId = state.callId
    if (!callId) return
    if (state.phase === "ringing-out") {
      callLog({ k: "end", cause: "cancel" })
      sendFrame({ t: "call.end", callId })
      closeNow()
      return
    }
    if (state.phase !== "connecting" && state.phase !== "live") return
    callLog({ k: "end", cause: "hangup" })
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
        // WR-02: the server re-rings only a call that still rings, so this device's Accept never reached
        // it (sent while the socket was down, or lost with it). Send the Accept again on this socket.
        if (
          frame.callId === state.callId &&
          state.role === "callee" &&
          state.phase === "connecting" &&
          state.mediaStartedAt === null &&
          session !== null
        ) {
          sendFrame({ t: "call.accept", callId: frame.callId })
          return
        }
        // WR-05: this device is setting up its own call and the server has not seen it yet: hold the
        // ring back until that attempt either reaches the server (merge) or ends here.
        if (state.phase === "ringing-out" && state.role === "caller" && invitedCallId !== state.callId) {
          deferredRing = frame
          return
        }
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
            callLog({ k: "end", cause: "setup_failed" })
            sendFrame({ t: "call.end", callId: frame.callId })
            showFailure()
            return
          }
          set({ callId: frame.callId, role: "callee", phase: "connecting" })
          sendMedia()
          return
        }
        if (frame.callId !== state.callId) return
        if (state.phase === "ringing-out" && !startCallerSession(frame.callId)) return
        // Both roles: the peer learns this side's camera state once the server bound the call (D-03).
        sendMedia()
        // WR-02: a resent Accept bound this connection, which is what the lost call.rejoin would have done.
        if (rejoinPending && reconnectable(state.phase)) {
          rejoinPending = false
          checkRecovered()
        }
        return
      case "call.state":
        // The answer to call.rejoin (CALL-07): this connection is bound to the call again.
        if (frame.callId !== state.callId) return
        callLog({ k: "reconnect", what: "rejoin_state" })
        if (state.phase === "ringing-out") {
          rejoinPending = false
          // Accepted while this socket was away: the call.accepted was lost, so this is it.
          if (frame.status === "active" && !startCallerSession(frame.callId)) return
          if (frame.status === "ringing") return
        }
        if (!reconnectable(state.phase)) return
        rejoinPending = false
        set({ peerCamera: frame.peerCamera })
        sendMedia()
        checkRecovered()
        return
      case "room.joined":
        // A rejoin put this connection back in the room with the peer: anything sent while away is lost.
        if (state.callId && frame.room === callRoom(state.callId) && frame.peers.length > 0) session?.peerPresent()
        return
      case "call.media":
        if (frame.callId === state.callId && (state.phase === "connecting" || state.phase === "live")) {
          set({ peerCamera: frame.camera })
        }
        return
      case "room.peer-joined":
        if (state.callId && frame.room === callRoom(state.callId)) {
          sendMedia()
          session?.peerPresent()
        }
        return
      case "call.ended":
        if (deferredRing?.callId === frame.callId) deferredRing = null
        handleEnded(frame)
        return
      case "call.stop-ringing":
        if (deferredRing?.callId === frame.callId) deferredRing = null
        // D-11: another of this person's devices answered first. WR-01: also after this device's own
        // Accept went out (it crossed the winning one), as long as no media flowed here: the server only
        // sends stop-ringing to a callee connection it did not bind.
        if (frame.callId !== state.callId || state.role !== "callee") return
        if (state.phase !== "ringing-in" && !(state.phase === "connecting" && state.mediaStartedAt === null)) return
        callLog({ k: "end", cause: "answered_elsewhere" })
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

  /** WR-06: logout was tapped: end this device's call on the server and close it here (the peer is kept). */
  leave(): void {
    callLog({ k: "end", cause: "leave" })
    sendLeave()
    deferredRing = null
    if (state.phase !== "idle") closeNow()
  },

  /** Forget the call and release every media resource (logout, session gone). */
  reset(): void {
    callLog({ k: "end", cause: "leave" })
    // WR-06: end the call on the server first while the socket may still be open.
    sendLeave()
    clearCloseTimer()
    releaseMedia()
    releaseWakeLock()
    peer = null
    invitedCallId = null
    deferredRing = null
    commit(EMPTY)
  },
}

export function useCall(): CallState {
  return useSyncExternalStore(callStore.subscribe, callStore.getSnapshot, callStore.getServerSnapshot)
}
