"use client"

import { callRoom, type ClientFrame, type ServerFrame, type SignalData } from "@duet/shared"
import { createPeer, type Peer } from "@/lib/rtc/peer"
import { sampleCall, type CallSample } from "@/lib/rtc/stats"

/** getStats cadence while a call runs (the INFR-04 sample shape, reused for the timer start). */
const SAMPLE_INTERVAL_MS = 2000

export interface CallSessionOptions {
  callId: string
  /** Fixed for the whole call (D-03): caller = impolite offerer, callee = polite answerer. */
  role: "caller" | "callee"
  iceServers: RTCIceServer[]
  forceRelay: boolean
  /** The microphone captured in the Start / Accept tap. The session owns it from here on. */
  mic: MediaStreamTrack
  /** The camera captured for a video call (null = camera off). The session owns it from here on. */
  camera: MediaStreamTrack | null
  /** Sends one frame on the tab's realtime socket (false when it is not live). */
  send: (frame: ClientFrame) => boolean
  onRemoteAudio: (stream: MediaStream) => void
  /** The remote video track (present from setup even while the peer's camera is off, Pitfall 7). */
  onRemoteVideo: (stream: MediaStream) => void
  onSample: (sample: CallSample) => void
  /** RTCPeerConnection.connectionState changes. */
  onState?: (state: RTCPeerConnectionState) => void
}

/** localStorage "duet.forceRelay" = "1" makes calls relay-only (the 03-04 cellular/relay test). */
export function forceRelayFlag(): boolean {
  try {
    return localStorage.getItem("duet.forceRelay") === "1"
  } catch {
    return false
  }
}

/**
 * One call's media and peer connection. Audio and video transceivers are negotiated once at call
 * setup (D-03, research Pattern 3): the caller adds exactly one audio transceiver (the microphone) and
 * one video transceiver (no track in a voice call) before the first offer; the callee attaches its
 * microphone with replaceTrack before it answers. A later camera change is a replaceTrack on the
 * pre-negotiated video sender and never renegotiates. Signals ride room call-<id> on the realtime socket.
 */
export class CallSession {
  readonly callId: string
  readonly room: string
  readonly role: "caller" | "callee"
  private readonly local: MediaStream
  private readonly peer: Peer
  private camera: MediaStreamTrack | null
  private sampleTimer: ReturnType<typeof setInterval> | null = null
  private sampling = false
  private closed = false

  constructor(private readonly o: CallSessionOptions) {
    this.callId = o.callId
    this.room = callRoom(o.callId)
    this.role = o.role
    this.local = new MediaStream([o.mic])
    this.camera = o.camera
    const local = this.local
    this.peer = createPeer({
      iceServers: o.iceServers,
      forceRelay: o.forceRelay,
      role: o.role,
      setup:
        o.role === "caller"
          ? (pc) => {
              pc.addTransceiver(o.mic, { direction: "sendrecv", streams: [local] })
              pc.addTransceiver(this.camera ?? "video", { direction: "sendrecv", streams: [local] })
            }
          : () => {},
      beforeAnswer:
        o.role === "callee"
          ? async (pc) => {
              for (const t of pc.getTransceivers()) {
                t.direction = "sendrecv"
                t.sender.setStreams?.(local)
                if (t.receiver.track.kind === "audio" && !t.sender.track) await t.sender.replaceTrack(o.mic)
                // Accepting a video call (or a camera turned on before the offer came) sends the camera.
                if (t.receiver.track.kind === "video" && !t.sender.track && this.camera) {
                  await t.sender.replaceTrack(this.camera)
                }
              }
            }
          : undefined,
      send: (data: SignalData) => {
        if (!this.closed) o.send({ t: "rtc.signal", room: this.room, data })
      },
      onTrack: (track) => {
        if (track.kind === "audio") o.onRemoteAudio(new MediaStream([track]))
        else if (track.kind === "video") o.onRemoteVideo(new MediaStream([track]))
      },
    })
    const pc = this.peer.pc
    pc.addEventListener("connectionstatechange", () => {
      if (this.closed) return
      o.onState?.(pc.connectionState)
      if (pc.connectionState === "connected") void this.sample()
    })
    this.sampleTimer = setInterval(() => void this.sample(), SAMPLE_INTERVAL_MS)
  }

  /** The video transceiver negotiated at call start (absent on the callee until the first offer). */
  private videoSender(): RTCRtpSender | null {
    if (this.closed) return null
    const t = this.peer.pc.getTransceivers().find((tr) => tr.receiver.track.kind === "video")
    return t?.sender ?? null
  }

  /** The camera track being sent (null while the camera is off). */
  get cameraTrack(): MediaStreamTrack | null {
    return this.camera
  }

  /**
   * Turn the camera on (a track), off (null) or swap it (a flipped track) with replaceTrack on the video
   * transceiver negotiated at call start: no renegotiation (D-03). The previous camera track is stopped
   * every time, so the camera indicator turns off (T-03-13). A track handed to a closed session is stopped.
   */
  async setCamera(track: MediaStreamTrack | null): Promise<void> {
    if (this.closed) {
      track?.stop()
      return
    }
    const previous = this.camera
    this.camera = track
    const sender = this.videoSender()
    try {
      if (sender) await sender.replaceTrack(track)
    } finally {
      if (previous && previous !== track) previous.stop()
      if (this.closed) track?.stop()
    }
  }

  /** rtc.signal frames of this call's room go to the peer connection; anything else is ignored. */
  handleRoomFrame(frame: ServerFrame): void {
    if (this.closed || frame.t !== "rtc.signal" || frame.room !== this.room) return
    this.peer.handleSignal(frame.data).catch((err: unknown) => console.error("call: signal failed", err))
  }

  private async sample(): Promise<void> {
    if (this.closed || this.sampling) return
    this.sampling = true
    try {
      const s = await sampleCall(this.peer.pc)
      if (!this.closed) this.o.onSample(s)
    } catch {
      // A closing connection can reject getStats; the next tick tries again.
    } finally {
      this.sampling = false
    }
  }

  /** Stop sampling, close the peer connection and stop every local track (the mic indicator turns off). */
  close(): void {
    if (this.closed) return
    this.closed = true
    if (this.sampleTimer !== null) clearInterval(this.sampleTimer)
    this.sampleTimer = null
    this.peer.close()
    for (const track of this.local.getTracks()) track.stop()
    this.o.mic.stop()
    this.camera?.stop()
  }
}
