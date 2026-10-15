import { callRoom, CALL_RING_TIMEOUT_MS, type CallClientFrame, type CallEndReason, type CallKind, type ServerFrame } from "@duet/shared"

/** Ended calls kept for answering late frames (a stale accept, a repeated end) with their real reason. */
export const RECENT_CALL_MAX = 50
export const RECENT_CALL_TTL_MS = 24 * 60 * 60 * 1000
/** A caller whose connection closed while ringing has this long to come back before the call is cancelled. */
export const CALLER_ABSENT_MS = 10_000
/** A bound party whose connection closed during an active call has this long before it ends as dropped. */
export const ABSENT_GRACE_MS = 35_000

/** What the registry needs from the /ws hub. Connections are addressed by connId (one per device). */
export interface CallTransport {
  sendToConn(connId: string, frame: ServerFrame): void
  /** Every open connection of this person, except `exceptConnId` when given. */
  sendToUser(userId: string, frame: ServerFrame, exceptConnId?: string): void
  /** Join a connection to a room server-side (call rooms are never joined by clients, T-03-02). */
  serverJoin(connId: string, room: string): void
  serverLeave(connId: string, room: string): void
  /** The session behind an open connection (undefined once it closed). */
  sessionOf(connId: string): string | undefined
}

export interface CallRegistry {
  /** One call.* frame from an authenticated connection. */
  onFrame(connId: string, userId: string, frame: CallClientFrame): void
  /** A connection said hello (ring-on-attach arrives in 03-02). */
  onAttach(connId: string, userId: string): void
  /**
   * A connection closed. A party's socket blinking never ends a call at once (Pitfall 3): the caller
   * gone while ringing cancels after CALLER_ABSENT_MS, a bound party gone while active drops after
   * ABSENT_GRACE_MS.
   */
  onClose(connId: string, userId: string): void
  /** Clear every timer (app shutdown). */
  close(): void
}

export interface CallRegistryOptions {
  log: { info: (obj: object) => void }
  transport: CallTransport
  /** The other account (there are exactly two). undefined while the second account does not exist. */
  otherUser: (userId: string) => string | undefined
  /** Clock, injectable for tests. */
  now?: () => number
  /** D-07: the server-owned ring timeout. Default CALL_RING_TIMEOUT_MS (45 s). */
  ringTimeoutMs?: number
  callerAbsentMs?: number
  absentGraceMs?: number
}

interface Call {
  id: string
  kind: CallKind
  callerId: string
  calleeId: string
  status: "ringing" | "active"
  callerConn: string
  callerSession: string | undefined
  calleeConn?: string
  calleeSession?: string
  startedAt: number
  activeAt?: number
  ringTimer?: ReturnType<typeof setTimeout>
  absentTimer?: ReturnType<typeof setTimeout>
}

interface RecentCall {
  reason: CallEndReason
  kind: CallKind
  callerId: string
  calleeId: string
  endedAt: number
}

/**
 * The single-call state machine (RESEARCH Pattern 1). With exactly two people there is at most one
 * call in the whole system, so it holds one `current` call and no database table. It decides who may
 * accept, decline and end, joins exactly the two bound connections to the call room and tells every
 * device of both people how the call ended. Logs carry evt keys, ids, reasons and durations only.
 */
export function createCallRegistry({
  log,
  transport,
  otherUser,
  now = Date.now,
  ringTimeoutMs = CALL_RING_TIMEOUT_MS,
  callerAbsentMs = CALLER_ABSENT_MS,
  absentGraceMs = ABSENT_GRACE_MS,
}: CallRegistryOptions): CallRegistry {
  let current: Call | null = null
  const recent = new Map<string, RecentCall>()

  function remember(call: Call, reason: CallEndReason): void {
    const at = now()
    for (const [id, r] of recent) if (at - r.endedAt > RECENT_CALL_TTL_MS) recent.delete(id)
    recent.set(call.id, { reason, kind: call.kind, callerId: call.callerId, calleeId: call.calleeId, endedAt: at })
    while (recent.size > RECENT_CALL_MAX) {
      const oldest = recent.keys().next().value
      if (oldest === undefined) break
      recent.delete(oldest)
    }
  }

  /** Every registry timer is unref'd (it never keeps the process alive) and cleared in end()/close(). */
  function timer(fn: () => void, ms: number): ReturnType<typeof setTimeout> {
    const t = setTimeout(fn, ms)
    t.unref?.()
    return t
  }

  function clearTimers(call: Call): void {
    if (call.ringTimer !== undefined) clearTimeout(call.ringTimer)
    if (call.absentTimer !== undefined) clearTimeout(call.absentTimer)
    call.ringTimer = undefined
    call.absentTimer = undefined
  }

  function notAllowed(connId: string): void {
    transport.sendToConn(connId, { t: "error", code: "not_allowed" })
  }

  /** A frame about a call that is not the current one: its stored reason, or failed when unknown. */
  function answerStale(connId: string, callId: string): void {
    const r = recent.get(callId)
    transport.sendToConn(connId, { t: "call.ended", callId, reason: r?.reason ?? "failed" })
  }

  function end(call: Call, reason: CallEndReason): void {
    if (current !== call) return
    current = null
    clearTimers(call)
    const at = now()
    const frame: ServerFrame = { t: "call.ended", callId: call.id, reason }
    transport.sendToUser(call.callerId, frame)
    transport.sendToUser(call.calleeId, frame)
    const room = callRoom(call.id)
    transport.serverLeave(call.callerConn, room)
    if (call.calleeConn) transport.serverLeave(call.calleeConn, room)
    remember(call, reason)
    log.info({
      evt: "call_end",
      callId: call.id,
      callerId: call.callerId,
      calleeId: call.calleeId,
      reason,
      durationMs: call.activeAt !== undefined ? at - call.activeAt : 0,
    })
  }

  function invite(connId: string, userId: string, callId: string, kind: CallKind): void {
    if (current) {
      // Busy: one call at a time (glare merging arrives with plan task 3).
      if (current.id === callId) return
      transport.sendToConn(connId, { t: "call.ended", callId, reason: "busy" })
      return
    }
    const calleeId = otherUser(userId)
    if (!calleeId || recent.has(callId)) {
      transport.sendToConn(connId, { t: "call.ended", callId, reason: "failed" })
      return
    }
    const call: Call = {
      id: callId,
      kind,
      callerId: userId,
      calleeId,
      status: "ringing",
      callerConn: connId,
      callerSession: transport.sessionOf(connId),
      startedAt: now(),
    }
    current = call
    // D-07 / D-16: the call rings for the full timeout even when the callee has no open device.
    call.ringTimer = timer(() => end(call, "no-answer"), ringTimeoutMs)
    log.info({ evt: "call_invite", callId, callerId: userId, calleeId, kind })
    transport.sendToUser(calleeId, { t: "call.ring", callId, kind, from: userId })
  }

  function accept(connId: string, userId: string, call: Call): void {
    if (userId !== call.calleeId) {
      notAllowed(connId)
      return
    }
    if (call.status === "active") {
      if (call.calleeConn !== connId) notAllowed(connId)
      return
    }
    call.status = "active"
    if (call.ringTimer !== undefined) clearTimeout(call.ringTimer)
    call.ringTimer = undefined
    call.calleeConn = connId
    call.calleeSession = transport.sessionOf(connId)
    call.activeAt = now()
    const room = callRoom(call.id)
    transport.serverJoin(call.callerConn, room)
    transport.serverJoin(connId, room)
    transport.sendToConn(call.callerConn, { t: "call.accepted", callId: call.id })
    transport.sendToConn(connId, { t: "call.accepted", callId: call.id })
    log.info({ evt: "call_accept", callId: call.id, callerId: call.callerId, calleeId: call.calleeId })
  }

  function decline(connId: string, userId: string, call: Call): void {
    if (userId !== call.calleeId || call.status !== "ringing") {
      notAllowed(connId)
      return
    }
    end(call, "declined")
  }

  function hangUp(connId: string, call: Call): void {
    if (call.status === "ringing") {
      if (connId !== call.callerConn) {
        notAllowed(connId)
        return
      }
      end(call, "cancelled")
      return
    }
    if (connId !== call.callerConn && connId !== call.calleeConn) {
      notAllowed(connId)
      return
    }
    end(call, "hangup")
  }

  return {
    onFrame(connId, userId, frame) {
      if (frame.t === "call.invite") {
        invite(connId, userId, frame.callId, frame.kind)
        return
      }
      const call = current
      if (!call || call.id !== frame.callId) {
        answerStale(connId, frame.callId)
        return
      }
      if (userId !== call.callerId && userId !== call.calleeId) {
        notAllowed(connId)
        return
      }
      switch (frame.t) {
        case "call.accept":
          accept(connId, userId, call)
          return
        case "call.decline":
          decline(connId, userId, call)
          return
        case "call.end":
          hangUp(connId, call)
          return
      }
    },

    onAttach() {},

    onClose(connId) {
      const call = current
      if (!call || call.absentTimer !== undefined) return
      if (call.status === "ringing") {
        if (connId === call.callerConn) call.absentTimer = timer(() => end(call, "cancelled"), callerAbsentMs)
        return
      }
      if (connId === call.callerConn || connId === call.calleeConn) {
        call.absentTimer = timer(() => end(call, "dropped"), absentGraceMs)
      }
    },

    close() {
      if (current) clearTimers(current)
      current = null
    },
  }
}
