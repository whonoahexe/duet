"use client"

import { WS_CLOSE_LOGGED_OUT, type ClientFrame, type ServerFrame } from "@duet/shared"
import { SignalingClient } from "@/lib/ws"
import { chatStore } from "./store"

const BACKOFF_MIN_MS = 500
const BACKOFF_MAX_MS = 8000
/** A resumed socket that does not answer a ping this fast is treated as frozen (Pitfall 8). */
const PONG_TIMEOUT_MS = 2000
/** Presence heartbeat while visible: the server forgets "viewing" 45 s after the last frame (D-15). */
const PRESENCE_INTERVAL_MS = 20_000

interface RealtimeOptions {
  /** The session is gone (close code 4401): show the login tiles. */
  onLoggedOut: () => void
}

type FrameListener = (frame: ServerFrame) => void
type StateListener = () => void

/**
 * Other modules' view of the socket's frames (the call store, Phase 3). Module-level, so it survives
 * stopRealtime/startRealtime: listeners registered before the first hello never miss a call.ring.
 */
const frameListeners = new Set<FrameListener>()
/** Fired on every hello (a socket became live) and whenever a live socket is lost (CALL-07 rejoin). */
const liveListeners = new Set<StateListener>()
const downListeners = new Set<StateListener>()

function emit(listeners: Set<StateListener>, what: string): void {
  for (const listener of listeners) {
    try {
      listener()
    } catch (err) {
      console.error(`realtime: ${what} listener failed`, err)
    }
  }
}

function isVisible(): boolean {
  return document.visibilityState === "visible"
}

/**
 * The one reconnecting /ws connection of this tab (Pitfall 16: StrictMode double mounts must never
 * leave two sockets open). It reconnects with backoff, checks a resumed socket with ping/pong, keeps
 * the server's presence view current, and catches up through /api/sync on every hello, resume and
 * online event (CHAT-05).
 */
class Realtime {
  private client: SignalingClient | null = null
  private live = false
  private attempt = 0
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private pongTimer: ReturnType<typeof setTimeout> | null = null
  private presenceTimer: ReturnType<typeof setInterval> | null = null
  private stopped = false
  private readonly cleanups: Array<() => void> = []

  constructor(private opts: RealtimeOptions) {}

  setOptions(opts: RealtimeOptions): void {
    this.opts = opts
  }

  start(): void {
    this.stopped = false
    this.listen(document, "visibilitychange", () => this.onVisibility())
    this.listen(window, "pagehide", () => this.sendPresence(false))
    this.listen(window, "pageshow", (e) => {
      if ((e as PageTransitionEvent).persisted) this.onResume()
    })
    this.listen(window, "online", () => this.onOnline())
    this.listen(window, "offline", () => chatStore.setConnection("offline"))
    this.open()
  }

  stop(): void {
    this.stopped = true
    for (const off of this.cleanups.splice(0)) off()
    this.clearReconnect()
    this.clearPong()
    this.stopPresenceTimer()
    this.dropClient()
  }

  private listen(target: EventTarget, type: string, fn: (e: Event) => void): void {
    target.addEventListener(type, fn)
    this.cleanups.push(() => target.removeEventListener(type, fn))
  }

  /** CHAT-06: tell the other person you are typing (dropped silently while not connected). */
  sendTyping(): void {
    this.send({ t: "typing" })
  }

  isLive(): boolean {
    return this.live && this.client !== null
  }

  /** One frame on the live socket. False (nothing sent) while the socket is not live. */
  send(frame: ClientFrame): boolean {
    return this.live && this.client !== null && this.client.send(frame)
  }

  private sendPresence(visible: boolean = isVisible()): void {
    this.send({ t: "presence", visible })
  }

  private clearReconnect(): void {
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
  }

  private clearPong(): void {
    if (this.pongTimer !== null) {
      clearTimeout(this.pongTimer)
      this.pongTimer = null
    }
  }

  private startPresenceTimer(): void {
    if (this.presenceTimer !== null) return
    this.presenceTimer = setInterval(() => {
      if (isVisible()) this.sendPresence(true)
    }, PRESENCE_INTERVAL_MS)
  }

  private stopPresenceTimer(): void {
    if (this.presenceTimer !== null) {
      clearInterval(this.presenceTimer)
      this.presenceTimer = null
    }
  }

  /** The live socket is gone (closed, frozen, or replaced): tell the down listeners once. */
  private markDown(): void {
    const was = this.live
    this.live = false
    if (was && !this.stopped) emit(downListeners, "down")
  }

  /** Close and forget the current socket before anything replaces it (its close is then ignored). */
  private dropClient(): void {
    const old = this.client
    this.client = null
    this.markDown()
    this.clearPong()
    old?.close()
  }

  private open(): void {
    if (this.stopped) return
    this.clearReconnect()
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
      this.markDown()
      this.clearPong()
      this.onClosed(code)
    })
    client
      .connect()
      .then(() => {
        if (this.client !== client) return
        this.onHello()
      })
      .catch(() => {
        // Surfaced through onClose.
      })
  }

  private onHello(): void {
    this.attempt = 0
    this.live = true
    chatStore.setConnection("live")
    this.sendPresence()
    this.startPresenceTimer()
    void chatStore.syncNow()
    // A photo changed while the socket was down is not replayed by /api/sync (QT-5zd-photo-live).
    void chatStore.refreshProfiles()
    chatStore.flushOutbox()
    emit(liveListeners, "live")
  }

  private onFrame(frame: ServerFrame): void {
    for (const listener of frameListeners) {
      try {
        listener(frame)
      } catch (err) {
        console.error("realtime: frame listener failed", err)
      }
    }
    switch (frame.t) {
      case "msg":
        chatStore.applyMessage(frame.message)
        return
      case "typing":
        chatStore.peerTyping(frame.userId)
        return
      case "read":
        chatStore.applyRead({ userId: frame.userId, seq: frame.seq, at: frame.at })
        return
      case "profile":
        chatStore.applyProfile(frame.userId, frame.photoId)
        return
      case "pong":
        this.clearPong()
        if (navigator.onLine) chatStore.setConnection("live")
        return
      default:
        return
    }
  }

  /** Ping the socket; no pong within 2 s means it is frozen: close it and open a new one. */
  private checkAlive(): void {
    if (!this.live || !this.client) {
      if (!this.client && this.reconnectTimer === null) this.open()
      return
    }
    this.clearPong()
    if (!this.send({ t: "ping" })) {
      this.open()
      return
    }
    this.pongTimer = setTimeout(() => {
      this.pongTimer = null
      this.attempt = 0
      this.open()
    }, PONG_TIMEOUT_MS)
  }

  private onVisibility(): void {
    if (isVisible()) {
      this.onResume()
    } else {
      this.sendPresence(false)
    }
  }

  /** Back in the foreground (visibilitychange or a bfcache restore). */
  private onResume(): void {
    this.sendPresence(true)
    this.checkAlive()
    void chatStore.syncNow()
  }

  private onOnline(): void {
    this.attempt = 0
    if (this.live && this.client) {
      this.checkAlive()
    } else {
      this.open()
    }
    void chatStore.syncNow()
    chatStore.flushOutbox()
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
    this.clearReconnect()
    const base = Math.min(BACKOFF_MAX_MS, BACKOFF_MIN_MS * 2 ** this.attempt)
    this.attempt += 1
    const delay = base + Math.floor(Math.random() * 250)
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
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

/** Send one typing frame on the tab's connection (the composer throttles it to one per 3 s). */
export function sendTyping(): void {
  current?.sendTyping()
}

/**
 * Send one frame on the tab's single socket (calls ride it: no second socket). Returns false when
 * there is no live connection, so the caller can tell the person they are offline.
 */
export function sendFrame(frame: ClientFrame): boolean {
  return current?.send(frame) ?? false
}

/** Every server frame of the tab's socket, before the chat handles it. Returns an unsubscribe function. */
export function onRealtimeFrame(listener: FrameListener): () => void {
  frameListeners.add(listener)
  return () => {
    frameListeners.delete(listener)
  }
}

/**
 * Called on every hello: a socket of this tab became live (the first one, or a reconnect). A call in
 * progress sends call.rejoin from here (CALL-07). Returns an unsubscribe function.
 */
export function onRealtimeLive(listener: StateListener): () => void {
  liveListeners.add(listener)
  return () => {
    liveListeners.delete(listener)
  }
}

/**
 * Called whenever a live socket is lost: it closed, a resumed socket stayed frozen and is replaced, or
 * it was dropped before a reopen. Not called by stopRealtime (logout). Returns an unsubscribe function.
 */
export function onRealtimeDown(listener: StateListener): () => void {
  downListeners.add(listener)
  return () => {
    downListeners.delete(listener)
  }
}

/** Whether the tab's socket is live right now (hello received and not lost since). */
export function realtimeLive(): boolean {
  return current?.isLive() ?? false
}

/** Close the realtime connection and stop reconnecting. */
export function stopRealtime(): void {
  current?.stop()
  current = null
}
