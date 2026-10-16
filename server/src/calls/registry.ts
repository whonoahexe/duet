import {
  callRoom,
  CALL_RING_TIMEOUT_MS,
  type CallClientFrame,
  type CallEndReason,
  type CallKind,
  type CallStatusResponse,
  type ServerFrame,
} from "@duet/shared"

/** Ended calls kept for answering late frames (a stale accept, a repeated end) with their real reason. */
export const RECENT_CALL_MAX = 50
export const RECENT_CALL_TTL_MS = 24 * 60 * 60 * 1000
/** A caller whose connection closed while ringing has this long to come back before the call is cancelled. */
export const CALLER_ABSENT_MS = 10_000
/** A bound party whose connection closed during an active call has this long before it ends as dropped. */
export const ABSENT_GRACE_MS = 35_000
/** T-03-03: at most this many invites that would ring, per person, per INVITE_WINDOW_MS (sliding). */
export const INVITE_LIMIT = 10
export const INVITE_WINDOW_MS = 60_000

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

/** The call that a push is about. */
export interface CallPushCall {
  id: string
  kind: CallKind
  callerId: string
  calleeId: string
}

/** Ringing pushes (D-09, D-12); app.ts adapts these to the push sender. Must never throw. */
export interface CallPush {
  /** An invite started ringing: push "Incoming call" to the callee's phones. */
  notifyCall(call: CallPushCall): void
  /** A ring ended cancelled or unanswered: push "Missed call", which replaces the ring (D-12). */
  notifyMissed(call: CallPushCall): void
}

export interface CallRegistry {
  /** One call.* frame from an authenticated connection. */
  onFrame(connId: string, userId: string, frame: CallClientFrame): void
  /**
   * A connection said hello. Ring-on-attach (CALL-03, Pitfall 4): a new connection of the callee while
   * the call rings gets call.ring at once, so opening duet by any route shows the incoming screen.
   */
  onAttach(connId: string, userId: string): void
  /**
   * A connection closed. A party's socket blinking never ends a call at once (Pitfall 3): the caller
   * gone while ringing cancels after CALLER_ABSENT_MS, a bound party gone while active drops after
   * ABSENT_GRACE_MS.
   */
  onClose(connId: string, userId: string): void
  /**
   * GET /api/calls/:id: the current or a recent call's status for one of its two parties; null for an
   * unknown call or anyone else (T-03-09).
   */
  statusFor(callId: string, userId: string): CallStatusResponse | null
  /** Clear every timer (app shutdown). */
  close(): void
}

export interface CallRegistryOptions {
  log: { info: (obj: object) => void }
  transport: CallTransport
  /** The other account (there are exactly two). undefined while the second account does not exist. */
  otherUser: (userId: string) => string | undefined
  /** Ringing pushes. Default: none. */
  push?: CallPush
  /** Clock, injectable for tests. */
  now?: () => number
  /** D-07: the server-owned ring timeout. Default CALL_RING_TIMEOUT_MS (45 s). */
  ringTimeoutMs?: number
  callerAbsentMs?: number
  absentGraceMs?: number
  /** T-03-03: ringing invites per person per INVITE_WINDOW_MS. Default INVITE_LIMIT. */
  inviteLimit?: number
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
  /** D-03: each party's last call.media camera flag (resent in call.state on a rejoin). */
  callerCamera: boolean
  calleeCamera: boolean
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
  push,
  now = Date.now,
  ringTimeoutMs = CALL_RING_TIMEOUT_MS,
  callerAbsentMs = CALLER_ABSENT_MS,
  absentGraceMs = ABSENT_GRACE_MS,
  inviteLimit = INVITE_LIMIT,
}: CallRegistryOptions): CallRegistry {
  let current: Call | null = null
  const recent = new Map<string, RecentCall>()
  /** Invite timestamps per user inside the sliding window (the flood guard). */
  const invites = new Map<string, number[]>()

  /** Count one ringing invite; false when this person is over INVITE_LIMIT in the window. */
  function underInviteLimit(userId: string): boolean {
    const at = now()
    const recentInvites = (invites.get(userId) ?? []).filter((t) => at - t < INVITE_WINDOW_MS)
    if (recentInvites.length >= inviteLimit) {
      invites.set(userId, recentInvites)
      return false
    }
    recentInvites.push(at)
    invites.set(userId, recentInvites)
    return true
  }

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
    // D-12: only a ring nobody answered leaves a missed call (never declined, busy, failed or answered).
    if (call.status === "ringing" && (reason === "cancelled" || reason === "no-answer")) {
      push?.notifyMissed({ id: call.id, kind: call.kind, callerId: call.callerId, calleeId: call.calleeId })
    }
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
      const call = current
      // A repeated invite (a resend of the same call) changes nothing.
      if (call.id === callId) return
      // D-14 glare: the person being rung called back at the same moment. Merge: their invite is an
      // accept of the ringing call from this device, and each side keeps its own camera choice.
      if (call.status === "ringing" && userId === call.calleeId) {
        log.info({ evt: "call_glare", callId: call.id, replaces: callId, callerId: call.callerId, calleeId: call.calleeId })
        bind(connId, call, callId)
        return
      }
      // Busy: one call at a time; a person already in a call gets no second ring.
      log.info({ evt: "call_busy", callId, userId, currentCallId: call.id })
      transport.sendToConn(connId, { t: "call.ended", callId, reason: "busy" })
      return
    }
    const calleeId = otherUser(userId)
    if (!calleeId || recent.has(callId)) {
      transport.sendToConn(connId, { t: "call.ended", callId, reason: "failed" })
      return
    }
    if (!underInviteLimit(userId)) {
      log.info({ evt: "call_rate_limited", callId, userId })
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
      callerCamera: false,
      calleeCamera: false,
      startedAt: now(),
    }
    current = call
    // D-07 / D-16: the call rings for the full timeout even when the callee has no open device.
    call.ringTimer = timer(() => end(call, "no-answer"), ringTimeoutMs)
    log.info({ evt: "call_invite", callId, callerId: userId, calleeId, kind })
    transport.sendToUser(calleeId, { t: "call.ring", callId, kind, from: userId })
    push?.notifyCall({ id: callId, kind, callerId: userId, calleeId })
  }

  function accept(connId: string, userId: string, call: Call): void {
    if (userId !== call.calleeId) {
      notAllowed(connId)
      return
    }
    if (call.status === "active") {
      // D-11: another device answered first; this one just stops ringing.
      if (call.calleeConn !== connId) {
        transport.sendToConn(connId, { t: "call.stop-ringing", callId: call.id, reason: "answered-elsewhere" })
      }
      return
    }
    bind(connId, call)
  }

  /**
   * The callee's device `connId` answers: the call becomes active, exactly the two bound connections
   * join call-<id>, both hear call.accepted, and the callee's other devices stop ringing (D-11).
   * `replaces` is the callee's own merged invite (D-14).
   */
  function bind(connId: string, call: Call, replaces?: string): void {
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
    transport.sendToConn(connId, replaces ? { t: "call.accepted", callId: call.id, replaces } : { t: "call.accepted", callId: call.id })
    transport.sendToUser(call.calleeId, { t: "call.stop-ringing", callId: call.id, reason: "answered-elsewhere" }, connId)
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

  /**
   * call.media (D-03, T-03-14): only a bound connection of an active call may change its camera flag, and
   * only the other bound connection hears it (never the sender's other devices).
   */
  function media(connId: string, call: Call, camera: boolean): void {
    if (call.status !== "active" || (connId !== call.callerConn && connId !== call.calleeConn)) {
      notAllowed(connId)
      return
    }
    const fromCaller = connId === call.callerConn
    if (fromCaller) call.callerCamera = camera
    else call.calleeCamera = camera
    const other = fromCaller ? call.calleeConn : call.callerConn
    if (other) transport.sendToConn(other, { t: "call.media", callId: call.id, camera })
  }

  /**
   * call.rejoin (CALL-07, D-17, T-03-17/18): a new connection of the session that was bound at invite
   * (caller) or accept (callee) takes that party's place again. The stale connection leaves call-<id>
   * before the new one joins (Pitfall 1: a half-open socket would otherwise fill the room), the absence
   * timer stops, and the new connection hears call.state. Any other session, even the same person's
   * other phone, gets not_allowed; a call that is over answers call.ended.
   */
  function rejoin(connId: string, userId: string, callId: string): void {
    const call = current
    if (!call || call.id !== callId) {
      const r = recent.get(callId)
      const party = r !== undefined && (userId === r.callerId || userId === r.calleeId)
      transport.sendToConn(connId, { t: "call.ended", callId, reason: party ? r.reason : "dropped" })
      return
    }
    const session = transport.sessionOf(connId)
    const asCaller = userId === call.callerId && session !== undefined && session === call.callerSession
    const asCallee =
      !asCaller && call.status === "active" && userId === call.calleeId && session !== undefined && session === call.calleeSession
    if (!asCaller && !asCallee) {
      notAllowed(connId)
      return
    }
    log.info({ evt: "call_rejoin", callId: call.id, userId })
    if (call.absentTimer !== undefined) clearTimeout(call.absentTimer)
    call.absentTimer = undefined
    if (call.status === "ringing") {
      call.callerConn = connId
      transport.sendToConn(connId, { t: "call.state", callId: call.id, status: "ringing", peerCamera: false })
      return
    }
    const room = callRoom(call.id)
    const previous = asCaller ? call.callerConn : call.calleeConn
    if (previous !== undefined && previous !== connId) transport.serverLeave(previous, room)
    if (asCaller) call.callerConn = connId
    else call.calleeConn = connId
    transport.serverJoin(connId, room)
    // The absence timer is shared: the other party may still be away, so its grace starts again.
    const other = asCaller ? call.calleeConn : call.callerConn
    if (other === undefined || transport.sessionOf(other) === undefined) {
      call.absentTimer = timer(() => end(call, "dropped"), absentGraceMs)
    }
    transport.sendToConn(connId, {
      t: "call.state",
      callId: call.id,
      status: "active",
      peerCamera: asCaller ? call.calleeCamera : call.callerCamera,
    })
  }

  return {
    onFrame(connId, userId, frame) {
      if (frame.t === "call.invite") {
        invite(connId, userId, frame.callId, frame.kind)
        return
      }
      if (frame.t === "call.rejoin") {
        rejoin(connId, userId, frame.callId)
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
        case "call.media":
          media(connId, call, frame.camera)
          return
      }
    },

    onAttach(connId, userId) {
      const call = current
      if (!call || call.status !== "ringing" || userId !== call.calleeId) return
      log.info({ evt: "call_ring_attach", callId: call.id, connId })
      transport.sendToConn(connId, { t: "call.ring", callId: call.id, kind: call.kind, from: call.callerId })
    },

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

    statusFor(callId, userId) {
      const call = current
      if (call && call.id === callId) {
        if (userId !== call.callerId && userId !== call.calleeId) return null
        return { id: call.id, status: call.status, kind: call.kind, callerId: call.callerId }
      }
      const r = recent.get(callId)
      if (!r || now() - r.endedAt > RECENT_CALL_TTL_MS) return null
      if (userId !== r.callerId && userId !== r.calleeId) return null
      return { id: callId, status: "ended", kind: r.kind, callerId: r.callerId, reason: r.reason }
    },

    close() {
      if (current) clearTimers(current)
      current = null
    },
  }
}
