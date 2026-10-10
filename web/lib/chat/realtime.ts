"use client"

import { WS_CLOSE_LOGGED_OUT, type ServerFrame } from "@duet/shared"
import { SignalingClient } from "@/lib/ws"
import { chatStore } from "./store"

const BACKOFF_MIN_MS = 500
const BACKOFF_MAX_MS = 8000

interface RealtimeOptions {
  /** The session is gone (close code 4401): show the login tiles. */
  onLoggedOut: () => void
}

/**
 * The one reconnecting /ws connection of this tab (Pitfall 16: StrictMode double mounts must never
 * leave two sockets open). Frames land in chatStore.
 */
class Realtime {
  private client: SignalingClient | null = null
  private attempt = 0
  private timer: ReturnType<typeof setTimeout> | null = null
  private stopped = false

  constructor(private opts: RealtimeOptions) {}

  setOptions(opts: RealtimeOptions): void {
    this.opts = opts
  }

  start(): void {
    this.stopped = false
    this.open()
  }

  stop(): void {
    this.stopped = true
    this.clearTimer()
    this.dropClient()
  }

  private clearTimer(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer)
      this.timer = null
    }
  }

  /** Close and forget the current socket (its close handler then ignores it). */
  private dropClient(): void {
    const old = this.client
    this.client = null
    old?.close()
  }

  private open(): void {
    if (this.stopped) return
    this.clearTimer()
    this.dropClient()
    chatStore.setConnection(navigator.onLine ? "connecting" : "offline")

    const client = new SignalingClient()
    this.client = client
    client.onFrame((frame) => {
      if (this.client === client) this.onFrame(frame)
    })
    client.onClose((code) => {
      if (this.client !== client) return
      this.client = null
      this.onClosed(code)
    })
    client
      .connect()
      .then(() => {
        if (this.client !== client) return
        this.attempt = 0
        chatStore.setConnection("live")
      })
      .catch(() => {
        // Surfaced through onClose.
      })
  }

  private onFrame(frame: ServerFrame): void {
    switch (frame.t) {
      case "msg":
        chatStore.applyMessage(frame.message)
        return
      default:
        return
    }
  }

  private onClosed(code: number): void {
    if (this.stopped) return
    if (code === WS_CLOSE_LOGGED_OUT) {
      this.stop()
      this.opts.onLoggedOut()
      return
    }
    chatStore.setConnection(navigator.onLine ? "connecting" : "offline")
    this.scheduleReconnect()
  }

  private scheduleReconnect(): void {
    this.clearTimer()
    const base = Math.min(BACKOFF_MAX_MS, BACKOFF_MIN_MS * 2 ** this.attempt)
    this.attempt += 1
    const delay = base + Math.floor(Math.random() * 250)
    this.timer = setTimeout(() => {
      this.timer = null
      this.open()
    }, delay)
  }
}

let current: Realtime | null = null

/** Open (or keep) the tab's realtime connection. Safe to call twice. */
export function startRealtime(opts: RealtimeOptions): void {
  if (current) {
    current.setOptions(opts)
    return
  }
  current = new Realtime(opts)
  current.start()
}

/** Close the realtime connection and stop reconnecting. */
export function stopRealtime(): void {
  current?.stop()
  current = null
}
