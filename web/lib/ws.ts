import { ServerFrame, type ClientFrame } from "@duet/shared"

/**
 * URL of duet's signaling socket. `next dev` proxies only /api, so dev connects straight to the
 * Fastify port (cookies are not port-scoped). Production is same-origin: wss on https.
 */
export function signalingUrl(): string {
  if (process.env.NODE_ENV === "development") return "ws://localhost:3100/ws"
  const scheme = window.location.protocol === "https:" ? "wss:" : "ws:"
  return `${scheme}//${window.location.host}/ws`
}

export interface Hello {
  connId: string
  userId: string
}

type FrameHandler = (frame: ServerFrame) => void
type CloseHandler = (code: number) => void

/** Typed frames over /ws (D-16). One instance = one socket; create a new one to reconnect. */
export class SignalingClient {
  private ws: WebSocket | null = null
  private readonly frameHandlers = new Set<FrameHandler>()
  private readonly closeHandlers = new Set<CloseHandler>()

  constructor(private readonly url: string = signalingUrl()) {}

  /** Opens the socket. Resolves on the server's hello frame, rejects if it closes first. */
  connect(): Promise<Hello> {
    if (this.ws) return Promise.reject(new Error("already connected"))
    return new Promise<Hello>((resolve, reject) => {
      let greeted = false
      const ws = new WebSocket(this.url)
      this.ws = ws

      ws.onmessage = (event) => {
        if (typeof event.data !== "string") {
          console.warn("signaling: dropped a non-text frame")
          return
        }
        let raw: unknown
        try {
          raw = JSON.parse(event.data)
        } catch {
          console.warn("signaling: dropped a frame that is not JSON")
          return
        }
        const parsed = ServerFrame.safeParse(raw)
        if (!parsed.success) {
          console.warn("signaling: dropped an unknown frame")
          return
        }
        const frame = parsed.data
        if (!greeted && frame.t === "hello") {
          greeted = true
          resolve({ connId: frame.connId, userId: frame.userId })
        }
        for (const handler of this.frameHandlers) handler(frame)
      }

      ws.onclose = (event) => {
        if (this.ws === ws) this.ws = null
        if (!greeted) reject(new Error(`signaling closed before hello (${event.code})`))
        for (const handler of this.closeHandlers) handler(event.code)
      }
    })
  }

  /** JSON-encodes one frame. Returns false (and sends nothing) when the socket is not open. */
  send(frame: ClientFrame): boolean {
    const ws = this.ws
    if (!ws || ws.readyState !== WebSocket.OPEN) return false
    ws.send(JSON.stringify(frame))
    return true
  }

  /** Every inbound frame that parses as a ServerFrame. Returns an unsubscribe function. */
  onFrame(handler: FrameHandler): () => void {
    this.frameHandlers.add(handler)
    return () => this.frameHandlers.delete(handler)
  }

  /** Socket closed (4401 = the session logged out). Returns an unsubscribe function. */
  onClose(handler: CloseHandler): () => void {
    this.closeHandlers.add(handler)
    return () => this.closeHandlers.delete(handler)
  }

  /** Closes the socket. Close handlers still run when the close completes. */
  close(): void {
    const ws = this.ws
    if (!ws) return
    if (ws.readyState === WebSocket.CONNECTING || ws.readyState === WebSocket.OPEN) ws.close(1000)
  }
}
