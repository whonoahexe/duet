import type { SignalData } from "@duet/shared"

export interface PeerOptions {
  iceServers: RTCIceServer[]
  /** true -> iceTransportPolicy "relay": only Cloudflare TURN relay candidates are used. */
  forceRelay: boolean
  /** Perfect-negotiation role. Callers pass ownConnId > peerConnId (string compare). */
  polite: boolean
  stream: MediaStream
  send: (data: SignalData) => void
  onRemoteStream: (stream: MediaStream) => void
}

export interface Peer {
  pc: RTCPeerConnection
  handleSignal: (data: SignalData) => Promise<void>
  close: () => void
}

/**
 * 1:1 RTCPeerConnection with MDN perfect negotiation (RESEARCH Pattern M4). Both sides may add
 * tracks and negotiate at the same moment; the impolite side ignores a colliding offer and the
 * polite side rolls back implicitly.
 */
export function createPeer(o: PeerOptions): Peer {
  const pc = new RTCPeerConnection({
    iceServers: o.iceServers,
    iceTransportPolicy: o.forceRelay ? "relay" : "all",
  })
  let makingOffer = false
  let ignoreOffer = false
  let isSettingRemoteAnswerPending = false
  let closed = false

  function sendDescription() {
    const d = pc.localDescription
    if (!d || closed) return
    o.send({ description: { type: d.type, sdp: d.sdp } })
  }

  pc.onnegotiationneeded = async () => {
    try {
      makingOffer = true
      await pc.setLocalDescription()
      sendDescription()
    } catch (err) {
      console.error("negotiation failed", err)
    } finally {
      makingOffer = false
    }
  }

  pc.onicecandidate = ({ candidate }) => {
    // The null end-of-candidates marker is not sent.
    if (!candidate || !candidate.candidate || closed) return
    o.send({
      candidate: {
        candidate: candidate.candidate,
        sdpMid: candidate.sdpMid,
        sdpMLineIndex: candidate.sdpMLineIndex,
        usernameFragment: candidate.usernameFragment,
      },
    })
  }

  pc.ontrack = ({ track, streams }) => {
    o.onRemoteStream(streams[0] ?? new MediaStream([track]))
  }

  pc.oniceconnectionstatechange = () => {
    if (pc.iceConnectionState === "failed") pc.restartIce()
  }

  for (const track of o.stream.getTracks()) pc.addTrack(track, o.stream)

  async function handleSignal({ description, candidate }: SignalData): Promise<void> {
    if (closed) return
    if (description) {
      const readyForOffer = !makingOffer && (pc.signalingState === "stable" || isSettingRemoteAnswerPending)
      const offerCollision = description.type === "offer" && !readyForOffer
      ignoreOffer = !o.polite && offerCollision
      if (ignoreOffer) return
      isSettingRemoteAnswerPending = description.type === "answer"
      await pc.setRemoteDescription(description)
      isSettingRemoteAnswerPending = false
      if (description.type === "offer") {
        await pc.setLocalDescription()
        sendDescription()
      }
    } else if (candidate) {
      try {
        await pc.addIceCandidate(candidate)
      } catch (err) {
        if (!ignoreOffer) throw err
      }
    }
  }

  return {
    pc,
    handleSignal,
    close: () => {
      if (closed) return
      closed = true
      pc.onnegotiationneeded = null
      pc.onicecandidate = null
      pc.ontrack = null
      pc.oniceconnectionstatechange = null
      pc.close()
    },
  }
}
