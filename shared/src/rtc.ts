import { z } from "zod"
import { RoomId } from "./ws"

/** One RTCIceServer entry as handed to `new RTCPeerConnection({ iceServers })`. */
export const IceServer = z.object({
  urls: z.array(z.string()).min(1),
  username: z.string().optional(),
  credential: z.string().optional(),
})
export type IceServer = z.infer<typeof IceServer>

/**
 * POST /api/rtc/ice-servers: Cloudflare TURN credentials minted for the logged-in user (INFR-03).
 * Always holds at least one turn:/turns: entry; the server never answers with a STUN-only list.
 */
export const IceServersResponse = z.object({
  iceServers: z.array(IceServer).min(1),
  ttlSeconds: z.number().int().positive(),
})
export type IceServersResponse = z.infer<typeof IceServersResponse>

/** RTCIceCandidateStats.candidateType */
export const CandidateType = z.enum(["host", "srflx", "prflx", "relay"])
export type CandidateType = z.infer<typeof CandidateType>

/** Client -> TURN leg of a relay candidate (RTCIceCandidateStats.relayProtocol). */
export const RelayProtocol = z.enum(["udp", "tcp", "tls"])
export type RelayProtocol = z.infer<typeof RelayProtocol>

/** RTCPeerConnection.connectionState */
export const ConnState = z.enum(["new", "connecting", "connected", "disconnected", "failed", "closed"])
export type ConnState = z.infer<typeof ConnState>

export const CallVerdict = z.enum(["pass", "waiting", "not_relayed", "failed"])
export type CallVerdict = z.infer<typeof CallVerdict>

/**
 * The call test's verdict for one getStats() sample (INFR-04). It never claims a media path it did
 * not prove: PASS needs a connected peer whose inbound bytes are above zero AND grew since the
 * previous sample, and under forced relay a selected local candidate of type relay.
 */
export function callVerdict(
  sample: { state: string; inboundBytes: number; localType?: string },
  prevInboundBytes: number,
  forceRelay: boolean,
): CallVerdict {
  if (sample.state === "failed") return "failed"
  if (forceRelay && sample.localType !== undefined && sample.localType !== "relay") return "not_relayed"
  if (
    sample.state === "connected" &&
    sample.inboundBytes > 0 &&
    sample.inboundBytes > prevInboundBytes &&
    (!forceRelay || sample.localType === "relay")
  ) {
    return "pass"
  }
  return "waiting"
}

/** POST /api/debug/call-report body: one call-test run, written to the server log as evt call_smoke. */
export const CallReport = z.strictObject({
  clientId: z.uuid(),
  room: RoomId,
  forceRelay: z.boolean(),
  pass: z.boolean(),
  verdict: CallVerdict,
  connectionState: ConnState,
  inboundBytes: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  localType: CandidateType.optional(),
  remoteType: CandidateType.optional(),
  relayProtocol: RelayProtocol.optional(),
  /** Whole milliseconds (the client rounds getStats seconds). */
  rttMs: z.number().int().nonnegative().max(600000).optional(),
  ua: z.string().max(300),
})
export type CallReport = z.infer<typeof CallReport>

/** An empty 204 body, for apiPost. */
export const NoContent = z.undefined()
export type NoContent = z.infer<typeof NoContent>
