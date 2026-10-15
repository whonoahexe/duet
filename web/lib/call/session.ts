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
  /** Sends one frame on the tab's realtime socket (false when it is not live). */
  send: (frame: ClientFrame) => boolean
  onRemoteAudio: (stream: MediaStream) => void
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
  private sampleTimer: ReturnType<typeof setInterval> | null = null
  private sampling = false
  private closed = false

  constructor(private readonly o: CallSessionOptions) {
    this.callId = o.callId
    this.room = callRoom(o.callId)
    this.role = o.role
    this.local = new MediaStream([o.mic])
    const local = this.local
    this.peer = createPeer({
      iceServers: o.iceServers,
      forceRelay: o.forceRelay,
      role: o.role,
      setup:
        o.role === "caller"
          ? (pc) => {
              pc.addTransceiver(o.mic, { direction: "sendrecv", streams: [local] })
              pc.addTransceiver("video", { direction: "sendrecv", streams: [local] })
            }
          : () => {},
      beforeAnswer:
        o.role === "callee"
          ? async (pc) => {
              for (const t of pc.getTransceivers()) {
                t.direction = "sendrecv"
                t.sender.setStreams?.(local)
                if (t.receiver.track.kind === "audio" && !t.sender.track) await t.sender.replaceTrack(o.mic)
              }
            }
          : undefined,
      send: (data: SignalData) => {
        if (!this.closed) o.send({ t: "rtc.signal", room: this.room, data })
      },
      onTrack: (track) => {
        if (track.kind === "audio") o.onRemoteAudio(new MediaStream([track]))
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
  }
}
