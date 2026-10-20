import { z } from "zod"
import { CallEndReason, CallId } from "./call"
import { CandidateType, ConnState, RelayProtocol } from "./rtc"

/**
 * Client call logs (quick task 261020-oj7). On 2026-10-20 three calls in eight minutes ended in a
 * hangup and an immediate redial, and the logs could not say who hung up, whether media went
 * peer-to-peer or through the relay, or when ICE failed. Each phone now posts what it saw to
 * POST /api/calls/diag, and the server writes it as `call_diag` lines next to its own call lines, so
 * one grep of the callId shows the whole call from both sides.
 *
 * Privacy is the design, not a filter: every field is an enum, a bounded integer or a boolean, every
 * object is strict, and there is deliberately no free-text field. An IP address, port, SDP, ICE
 * candidate string, TURN URL or credential, message text, name, device label or deviceId cannot be
 * expressed in this contract, so the server can log a parsed batch as is.
 */

/** Hard caps: events per batch and request body bytes. */
export const CALL_DIAG_MAX_EVENTS = 100
export const CALL_DIAG_BODY_LIMIT = 48 * 1024

const int = (min: number, max: number) => z.number().int().min(min).max(max)

/** Client epoch milliseconds. */
const Epoch = int(0, 9_999_999_999_999)

/** Coarse environment, sent on every batch: enums and small ints only, never the UA string. */
export const CallDiagEnv = z.strictObject({
  browser: z.enum(["chrome", "safari", "firefox", "edge", "samsung", "other"]),
  browserMajor: int(0, 999).optional(),
  os: z.enum(["ios", "android", "macos", "windows", "linux", "other"]),
  osMajor: int(0, 99).optional(),
  osMinor: int(0, 99).optional(),
  mobile: z.boolean(),
  standalone: z.boolean(),
})
export type CallDiagEnv = z.infer<typeof CallDiagEnv>

/** Every RTCPeerConnectionState, RTCIceConnectionState, RTCIceGatheringState and RTCSignalingState. */
export const CallDiagPcState = z.enum([
  "new",
  "connecting",
  "connected",
  "disconnected",
  "failed",
  "closed",
  "checking",
  "completed",
  "gathering",
  "complete",
  "stable",
  "have-local-offer",
  "have-remote-offer",
  "have-local-pranswer",
  "have-remote-pranswer",
])
export type CallDiagPcState = z.infer<typeof CallDiagPcState>

export const CallDiagNetworkType = z.enum(["wifi", "cellular", "ethernet", "bluetooth", "vpn", "wimax", "unknown"])
export type CallDiagNetworkType = z.infer<typeof CallDiagNetworkType>

export const CallDiagGumName = z.enum([
  "NotAllowedError",
  "NotFoundError",
  "NotReadableError",
  "OverconstrainedError",
  "SecurityError",
  "AbortError",
  "TypeError",
  "InvalidStateError",
  "unsupported",
  "other",
])
export type CallDiagGumName = z.infer<typeof CallDiagGumName>

export const CallDiagEndCause = z.enum([
  "hangup",
  "cancel",
  "decline",
  "remote",
  "give_up",
  "ice_failed",
  "setup_failed",
  "turn_failed",
  "mic_denied",
  "answered_elsewhere",
  "leave",
])
export type CallDiagEndCause = z.infer<typeof CallDiagEndCause>

const at = Epoch

/** One thing a phone saw during a call. `at` is the client's epoch ms. */
export const CallDiagEvent = z.discriminatedUnion("k", [
  /** A call-store phase change; ms since this phone's log for the call started. */
  z.strictObject({
    k: z.literal("phase"),
    at,
    phase: z.enum(["ringing-out", "ringing-in", "connecting", "live", "ended", "idle"]),
    ms: int(0, 86_400_000),
  }),
  /** An RTCPeerConnection state change. */
  z.strictObject({
    k: z.literal("pc"),
    at,
    what: z.enum(["connection", "ice", "gathering", "signaling"]),
    state: CallDiagPcState,
  }),
  z.strictObject({
    k: z.literal("ice_restart"),
    at,
    trigger: z.enum(["failed", "disconnected", "retry", "peer_back", "auto_failed"]),
  }),
  /** The selected candidate pair: types and transports only, never addresses or ports. */
  z.strictObject({
    k: z.literal("pair"),
    at,
    local: CandidateType,
    remote: CandidateType,
    protocol: z.enum(["udp", "tcp"]).optional(),
    relayProtocol: RelayProtocol.optional(),
    networkType: CallDiagNetworkType.optional(),
  }),
  z.strictObject({
    k: z.literal("stats"),
    at,
    state: ConnState,
    rttMs: int(0, 600_000).optional(),
    lossPct: int(0, 100).optional(),
    jitterMs: int(0, 60_000).optional(),
    inKbps: int(0, 1_000_000).optional(),
    outKbps: int(0, 1_000_000).optional(),
    videoInFps: int(0, 240).optional(),
    videoInWidth: int(0, 8192).optional(),
    videoInHeight: int(0, 8192).optional(),
    videoOutFps: int(0, 240).optional(),
    videoOutWidth: int(0, 8192).optional(),
    videoOutHeight: int(0, 8192).optional(),
  }),
  /** Mute and camera toggles; a flip carries the facing only (never a device label or id). */
  z.strictObject({
    k: z.literal("media"),
    at,
    what: z.enum(["mute", "unmute", "camera_on", "camera_off", "camera_flip", "mic_replaced", "camera_replaced"]),
    facing: z.enum(["user", "environment"]).optional(),
  }),
  /** A getUserMedia failure: the DOMException name only. */
  z.strictObject({
    k: z.literal("gum_error"),
    at,
    device: z.enum(["mic", "camera", "mic_camera"]),
    context: z.enum(["start", "accept", "camera_on", "flip", "resume"]),
    name: CallDiagGumName,
  }),
  z.strictObject({
    k: z.literal("page"),
    at,
    what: z.enum(["visible", "hidden", "pagehide", "pageshow", "freeze", "resume", "online", "offline"]),
    persisted: z.boolean().optional(),
  }),
  z.strictObject({
    k: z.literal("ws"),
    at,
    what: z.enum(["down", "live"]),
  }),
  z.strictObject({
    k: z.literal("reconnect"),
    at,
    what: z.enum(["start", "recovered", "give_up", "rejoin_sent", "rejoin_state"]),
  }),
  /** The TURN credential fetch: latency and TTL, never the credential. */
  z.strictObject({
    k: z.literal("turn"),
    at,
    ok: z.boolean(),
    ms: int(0, 120_000),
    ttlSeconds: int(1, 172_800).optional(),
    servers: int(0, 20).optional(),
  }),
  /** How the call ended on this phone. */
  z.strictObject({
    k: z.literal("end"),
    at,
    cause: CallDiagEndCause,
    serverReason: CallEndReason.optional(),
  }),
])
export type CallDiagEvent = z.infer<typeof CallDiagEvent>

/** POST /api/calls/diag body: one phone's events for one call. */
export const CallDiagBatch = z.strictObject({
  callId: CallId,
  role: z.enum(["caller", "callee"]),
  seq: int(0, 100_000),
  /** Events this phone dropped for the call (buffer full or invalid). */
  dropped: int(0, 1_000_000),
  sentAt: Epoch,
  env: CallDiagEnv,
  events: z.array(CallDiagEvent).min(1).max(CALL_DIAG_MAX_EVENTS),
})
export type CallDiagBatch = z.infer<typeof CallDiagBatch>
