/**
 * One getStats() reading of a call (RESEARCH Pattern M5). This is the INFR-04 proof, and (261020-oj7)
 * the source of the call log's pair and stats events.
 *
 * Privacy boundary: from candidate stats this module reads only candidateType, protocol, relayProtocol
 * and networkType, never the address, ip, port, relatedAddress, relatedPort or url members, so no
 * address of either phone or of the TURN server can leave it.
 */
export interface CallSample {
  state: RTCPeerConnectionState
  /** Sum of bytesReceived over every inbound-rtp stream (audio + video). */
  inboundBytes: number
  /** Cumulative packetsLost / packetsReceived over every inbound-rtp stream (D-20 loss = their deltas). */
  packetsLost: number
  packetsReceived: number
  /** Selected pair's local candidate type: host | srflx | prflx | relay. */
  localType?: string
  remoteType?: string
  /** Client -> TURN leg of a relay candidate: udp | tcp | tls. */
  relayProtocol?: string
  /** Selected pair's current round-trip time, in whole milliseconds. */
  rttMs?: number
  /** Sum of bytesSent over every outbound-rtp stream. */
  outboundBytes?: number
  /** Inbound audio jitter, whole milliseconds (the max over streams). */
  jitterMs?: number
  /** Selected local candidate's transport: udp | tcp. */
  protocol?: string
  /** Selected local candidate's network type (wifi, cellular, ...), where the engine reports it. */
  networkType?: string
  /** Inbound / outbound video: frames per second and frame size. */
  videoIn?: VideoStat
  videoOut?: VideoStat
}

export interface VideoStat {
  fps?: number
  width?: number
  height?: number
}

type Stat = Record<string, unknown> & { type: string; id: string }

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined
}

function finite(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined
}

function video(s: Stat): VideoStat {
  return { fps: finite(s.framesPerSecond), width: finite(s.frameWidth), height: finite(s.frameHeight) }
}

export async function sampleCall(pc: RTCPeerConnection): Promise<CallSample> {
  const report = await pc.getStats()
  let inboundBytes = 0
  let packetsLost = 0
  let packetsReceived = 0
  let outboundBytes = 0
  let jitter: number | undefined
  let videoIn: VideoStat | undefined
  let videoOut: VideoStat | undefined
  let pair: Stat | undefined

  report.forEach((s: Stat) => {
    if (s.type === "inbound-rtp" && typeof s.bytesReceived === "number") inboundBytes += s.bytesReceived
    if (s.type === "inbound-rtp" && typeof s.packetsLost === "number") packetsLost += s.packetsLost
    if (s.type === "inbound-rtp" && typeof s.packetsReceived === "number") packetsReceived += s.packetsReceived
    if (s.type === "outbound-rtp" && typeof s.bytesSent === "number") outboundBytes += s.bytesSent
    if (s.type === "inbound-rtp" && s.kind === "audio") {
      const j = finite(s.jitter)
      if (j !== undefined) jitter = Math.max(jitter ?? 0, j)
    }
    if (s.type === "inbound-rtp" && s.kind === "video") videoIn ??= video(s)
    if (s.type === "outbound-rtp" && s.kind === "video") videoOut ??= video(s)
    if (s.type === "transport" && typeof s.selectedCandidatePairId === "string") {
      pair ??= report.get(s.selectedCandidatePairId) as Stat | undefined
    }
  })

  // Fallback for engines without transport.selectedCandidatePairId (Safari is unverified, MA4).
  if (!pair) {
    report.forEach((s: Stat) => {
      if (s.type === "candidate-pair" && s.state === "succeeded" && (s.nominated === true || s.selected === true)) {
        pair ??= s
      }
    })
  }

  const local = pair && typeof pair.localCandidateId === "string" ? (report.get(pair.localCandidateId) as Stat | undefined) : undefined
  const remote =
    pair && typeof pair.remoteCandidateId === "string" ? (report.get(pair.remoteCandidateId) as Stat | undefined) : undefined
  const rtt = pair?.currentRoundTripTime

  return {
    state: pc.connectionState,
    inboundBytes,
    packetsLost,
    packetsReceived,
    localType: str(local?.candidateType),
    remoteType: str(remote?.candidateType),
    relayProtocol: str(local?.relayProtocol),
    rttMs: typeof rtt === "number" && Number.isFinite(rtt) && rtt >= 0 ? Math.round(rtt * 1000) : undefined,
    outboundBytes,
    jitterMs: jitter !== undefined ? Math.round(jitter * 1000) : undefined,
    protocol: str(local?.protocol),
    networkType: str(local?.networkType),
    videoIn,
    videoOut,
  }
}
