import { randomUUID } from "node:crypto"
import type { FastifyBaseLogger } from "fastify"
import type { WebSocket } from "ws"
import {
  ClientFrame,
  WS_CLOSE_LOGGED_OUT,
  WS_MAX_FRAMES_PER_SECOND,
  WS_MAX_ROOMS_PER_CONN,
  type Peer,
  type ServerFrame,
} from "@duet/shared"
import type { AuthUser } from "../auth/session"

/** Members per room: a call is 1:1. */
const ROOM_CAPACITY = 2

/**
 * In-memory signaling hub (D-16). It addresses connections, not users: one person may have several
 * devices online, and two of them may share a room. Frame contents are relayed and then dropped:
 * never logged, never stored (SDP and candidates carry IP addresses). No database access here.
 */
export interface Hub {
  attach(socket: WebSocket, user: AuthUser, sessionId: string): void
  /** Close every socket of this session with WS_CLOSE_LOGGED_OUT. Returns how many were closed. */
  closeSession(sessionId: string): number
  /** Stop the heartbeat and terminate every socket (app shutdown). */
  close(): void
}

interface Conn {
  socket: WebSocket
  userId: string
  sessionId: string
  rooms: Set<string>
  alive: boolean
  closing: boolean
  windowStart: number
  frames: number
}

export interface HubOptions {
  log: FastifyBaseLogger
  /** Ping interval; a socket that missed the previous pong is terminated (Pitfall M8). */
  heartbeatMs: number
  /**
   * Re-checked for every open socket on each heartbeat (WR-02). The session is otherwise only checked
   * at upgrade, so a session revoked out of process (seed CLI password reset) or past its expiry would
   * keep its socket forever. False closes the socket with WS_CLOSE_LOGGED_OUT. Injected so the hub
   * stays DB-free.
   */
  isSessionLive: (sessionId: string) => boolean
}

export function createHub({ log, heartbeatMs, isSessionLive }: HubOptions): Hub {
  const conns = new Map<string, Conn>()
  const rooms = new Map<string, Set<string>>()

  function send(conn: Conn, frame: ServerFrame): void {
    if (conn.closing || conn.socket.readyState !== conn.socket.OPEN) return
    conn.socket.send(JSON.stringify(frame))
  }

  function sendTo(connId: string, frame: ServerFrame): void {
    const c = conns.get(connId)
    if (c) send(c, frame)
  }

  /** The other member of a room, if any. */
  function otherMember(room: string, connId: string): string | undefined {
    for (const id of rooms.get(room) ?? []) if (id !== connId) return id
    return undefined
  }

  function peerOf(connId: string): Peer | undefined {
    const c = conns.get(connId)
    return c ? { connId, userId: c.userId } : undefined
  }

  function join(connId: string, conn: Conn, room: string): void {
    const members = rooms.get(room) ?? new Set<string>()
    if (members.has(connId)) {
      const other = otherMember(room, connId)
      const peer = other ? peerOf(other) : undefined
      send(conn, { t: "room.joined", room, peers: peer ? [peer] : [] })
      return
    }
    if (conn.rooms.size >= WS_MAX_ROOMS_PER_CONN) {
      send(conn, { t: "error", code: "too_many_rooms" })
      return
    }
    if (members.size >= ROOM_CAPACITY) {
      send(conn, { t: "room.full", room })
      return
    }
    const other = otherMember(room, connId)
    members.add(connId)
    rooms.set(room, members)
    conn.rooms.add(room)
    const peer = other ? peerOf(other) : undefined
    send(conn, { t: "room.joined", room, peers: peer ? [peer] : [] })
    if (other) sendTo(other, { t: "room.peer-joined", room, peer: { connId, userId: conn.userId } })
  }

  function leave(connId: string, conn: Conn, room: string): void {
    const members = rooms.get(room)
    if (!members || !members.has(connId)) return
    members.delete(connId)
    conn.rooms.delete(room)
    if (members.size === 0) rooms.delete(room)
    for (const other of members) sendTo(other, { t: "room.peer-left", room, connId })
  }

  function onMessage(connId: string, conn: Conn, raw: Buffer | ArrayBuffer | Buffer[]): void {
    if (conn.closing) return

    const now = Date.now()
    if (now - conn.windowStart >= 1000) {
      conn.windowStart = now
      conn.frames = 0
    }
    conn.frames += 1
    if (conn.frames > WS_MAX_FRAMES_PER_SECOND) {
      conn.closing = true
      conn.socket.close(1008, "rate_limited")
      return
    }

    let json: unknown
    try {
      const buf = Buffer.isBuffer(raw) ? raw : Array.isArray(raw) ? Buffer.concat(raw) : Buffer.from(raw)
      const text = buf.toString("utf8")
      json = JSON.parse(text)
    } catch {
      send(conn, { t: "error", code: "bad_frame" })
      return
    }
    const parsed = ClientFrame.safeParse(json)
    if (!parsed.success) {
      send(conn, { t: "error", code: "bad_frame" })
      return
    }

    const frame = parsed.data
    switch (frame.t) {
      case "room.join":
        join(connId, conn, frame.room)
        return
      case "room.leave":
        leave(connId, conn, frame.room)
        return
      case "rtc.signal": {
        if (!conn.rooms.has(frame.room)) {
          send(conn, { t: "error", code: "not_in_room" })
          return
        }
        const other = otherMember(frame.room, connId)
        if (other) sendTo(other, { t: "rtc.signal", room: frame.room, from: connId, data: frame.data })
        return
      }
    }
  }

  /** Whether the session behind this socket still exists and has not expired. A lookup error keeps it. */
  function sessionStillLive(conn: Conn): boolean {
    try {
      return isSessionLive(conn.sessionId)
    } catch (err) {
      log.warn({ evt: "ws_session_check_failed", err: (err as Error).name })
      return true
    }
  }

  const heartbeat = setInterval(() => {
    for (const conn of conns.values()) {
      if (conn.closing) continue
      if (!sessionStillLive(conn)) {
        conn.closing = true
        conn.socket.close(WS_CLOSE_LOGGED_OUT, "logged_out")
        continue
      }
      if (!conn.alive) {
        conn.socket.terminate()
        continue
      }
      conn.alive = false
      try {
        conn.socket.ping()
      } catch {
        conn.socket.terminate()
      }
    }
  }, heartbeatMs)
  heartbeat.unref()

  return {
    attach(socket, user, sessionId) {
      const connId = randomUUID()
      const conn: Conn = {
        socket,
        userId: user.id,
        sessionId,
        rooms: new Set(),
        alive: true,
        closing: false,
        windowStart: Date.now(),
        frames: 0,
      }
      conns.set(connId, conn)

      socket.on("pong", () => {
        conn.alive = true
      })
      // Errors after the upgrade bypass Fastify's error handler; ws closes the socket itself
      // (e.g. 1009 on an oversized message), so only the listener is needed to avoid a crash.
      socket.on("error", () => {})
      socket.on("message", (raw) => {
        try {
          onMessage(connId, conn, raw)
        } catch (err) {
          log.warn({ evt: "ws_error", connId, err: (err as Error).name })
        }
      })
      socket.on("close", (code) => {
        conn.closing = true
        for (const room of [...conn.rooms]) leave(connId, conn, room)
        conns.delete(connId)
        log.info({ evt: "ws_close", connId, code })
      })

      log.info({ evt: "ws_open", connId, userId: user.id })
      send(conn, { t: "hello", connId, userId: user.id })
    },

    closeSession(sessionId) {
      let count = 0
      for (const conn of conns.values()) {
        if (conn.sessionId !== sessionId || conn.closing) continue
        conn.closing = true
        conn.socket.close(WS_CLOSE_LOGGED_OUT, "logged_out")
        count += 1
      }
      return count
    },

    close() {
      clearInterval(heartbeat)
      for (const conn of conns.values()) conn.socket.terminate()
    },
  }
}
