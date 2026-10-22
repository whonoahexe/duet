import { z } from "zod"
import { CallEndReason, CallId, CallKind, StopRingingReason } from "./call"
import { AttachmentId, MessageDto } from "./chat"

/**
 * /ws signaling protocol (D-16: offer/answer/ICE ride duet's own WebSocket).
 * Every frame is a JSON object discriminated by "t". Client frames are strict (an unknown key is a
 * bad frame); server frames are plain objects so an older installed PWA tolerates added fields.
 */

/** Largest WebSocket message the server accepts (bytes). Above it the socket closes with 1009. */
export const WS_MAX_PAYLOAD = 131072
/** Close code sent to every socket of a session when that session logs out. */
export const WS_CLOSE_LOGGED_OUT = 4401
/** More frames than this within one second closes the socket with 1008. */
export const WS_MAX_FRAMES_PER_SECOND = 100
/** Rooms one connection may be a member of at the same time. */
export const WS_MAX_ROOMS_PER_CONN = 4

export const RoomId = z.string().regex(/^[a-z0-9-]{1,64}$/)
export type RoomId = z.infer<typeof RoomId>

/** RTCSessionDescriptionInit as produced by RTCSessionDescription.toJSON(). */
export const SignalDescription = z.strictObject({
  type: z.enum(["offer", "answer", "pranswer", "rollback"]),
  sdp: z.string().max(65536).optional(),
})
export type SignalDescription = z.infer<typeof SignalDescription>

/** RTCIceCandidateInit as produced by RTCIceCandidate.toJSON(). */
export const SignalCandidate = z.strictObject({
  candidate: z.string().max(2048),
  sdpMid: z.string().max(64).nullable().optional(),
  sdpMLineIndex: z.number().int().min(0).max(255).nullable().optional(),
  usernameFragment: z.string().max(256).nullable().optional(),
})
export type SignalCandidate = z.infer<typeof SignalCandidate>

/** Opaque to the server: relayed unchanged to the other room member. candidate null = end of candidates. */
export const SignalData = z.strictObject({
  description: SignalDescription.optional(),
  candidate: SignalCandidate.nullable().optional(),
})
export type SignalData = z.infer<typeof SignalData>

export const ClientFrame = z.discriminatedUnion("t", [
  z.strictObject({ t: z.literal("room.join"), room: RoomId }),
  z.strictObject({ t: z.literal("room.leave"), room: RoomId }),
  z.strictObject({ t: z.literal("rtc.signal"), room: RoomId, data: SignalData }),
  /** App-level liveness check after a resume (Pitfall 8). The server answers { t: "pong" }. */
  z.strictObject({ t: z.literal("ping") }),
  /** Whether this client is in the foreground (D-15: no push while viewing). */
  z.strictObject({ t: z.literal("presence"), visible: z.boolean() }),
  /** The composer is non-empty (CHAT-06); sent at most every 3 s. Ephemeral: never stored. */
  z.strictObject({ t: z.literal("typing") }),
  /** Start a call to the other person (CALL-01). The callee is derived by the server. */
  z.strictObject({ t: z.literal("call.invite"), callId: CallId, kind: CallKind }),
  /** Answer the ringing call on this device (the first device to accept wins, D-11). */
  z.strictObject({ t: z.literal("call.accept"), callId: CallId }),
  /**
   * Refuse the ringing call (D-13). WR-08: `reason: "failed"` when Accept was tapped but this device
   * could not set the call up (microphone, TURN credentials, session): the call ends as failed, so the
   * caller sees "Couldn't connect" instead of "Declined".
   */
  z.strictObject({ t: z.literal("call.decline"), callId: CallId, reason: z.literal("failed").optional() }),
  /** Hang up an active call, or cancel it while it rings (CALL-04). */
  z.strictObject({ t: z.literal("call.end"), callId: CallId }),
  /**
   * This side's camera turned on or off (D-03): only a bound party connection of an active call may send
   * it, and the server relays it to the other bound connection (the video track itself never renegotiates).
   */
  z.strictObject({ t: z.literal("call.media"), callId: CallId, camera: z.boolean() }),
  /**
   * CALL-07 / D-17: a new connection of the same session (after a WS drop or a network switch) takes
   * this party's place in the call again. The server answers call.state, or call.ended when it is over.
   */
  z.strictObject({ t: z.literal("call.rejoin"), callId: CallId }),
])
export type ClientFrame = z.infer<typeof ClientFrame>

/** The call.* members of ClientFrame (handled by the server call registry). */
export type CallClientFrame = Extract<ClientFrame, { t: `call.${string}` }>

/** One open connection (a person may have several devices online at once). */
export const Peer = z.object({
  connId: z.uuid(),
  userId: z.uuid(),
})
export type Peer = z.infer<typeof Peer>

/**
 * room_reserved: a client tried to join a server-managed call room. not_allowed: this connection may
 * not send that call frame (e.g. the caller accepting, an unbound device ending a call).
 */
export const WsErrorCode = z.enum(["bad_frame", "not_in_room", "too_many_rooms", "room_reserved", "not_allowed"])
export type WsErrorCode = z.infer<typeof WsErrorCode>

export const ServerFrame = z.discriminatedUnion("t", [
  z.object({ t: z.literal("hello"), connId: z.uuid(), userId: z.uuid() }),
  z.object({ t: z.literal("room.joined"), room: RoomId, peers: z.array(Peer) }),
  z.object({ t: z.literal("room.peer-joined"), room: RoomId, peer: Peer }),
  z.object({ t: z.literal("room.peer-left"), room: RoomId, connId: z.uuid() }),
  z.object({ t: z.literal("room.full"), room: RoomId }),
  z.object({ t: z.literal("rtc.signal"), room: RoomId, from: z.uuid(), data: SignalData }),
  z.object({ t: z.literal("error"), code: WsErrorCode }),
  z.object({ t: z.literal("pong") }),
  /** A new or changed message (CHAT-01): the client inserts or replaces it by seq. */
  z.object({ t: z.literal("msg"), message: MessageDto }),
  /**
   * A repeating reminder just fired (QT-fast-recurring-quiet). It leaves no chat line, so this
   * live-only frame carries what the in-app toast needs; a one-time reminder is a `msg` line instead.
   */
  z.object({
    t: z.literal("reminder"),
    senderId: z.uuid(),
    title: z.string(),
    forUserId: z.uuid().nullable(),
    leadMinutes: z.number().int().nullable(),
  }),
  /** The other person is typing (CHAT-06). Relayed only to the other person's connections. */
  z.object({ t: z.literal("typing"), userId: z.uuid() }),
  /** A person's read cursor moved forward to seq at `at` (epoch ms) (CHAT-07). */
  z.object({ t: z.literal("read"), userId: z.uuid(), seq: z.number().int().nonnegative(), at: z.number().int() }),
  /**
   * A person's shared profile photo changed (QT-5zd-photo-live): photoId is the new attachment, or
   * null when it was removed. Sent to every connection of both people.
   */
  z.object({ t: z.literal("profile"), userId: z.uuid(), photoId: AttachmentId.nullable() }),
  /** A call to this person is ringing (sent to every open connection of the callee). */
  z.object({ t: z.literal("call.ring"), callId: CallId, kind: CallKind, from: z.uuid() }),
  /**
   * The call is connected at the server: this connection is in room call-<callId>. `replaces` is the
   * id of this side's own invite when two invites were merged (D-14 glare).
   */
  z.object({ t: z.literal("call.accepted"), callId: CallId, replaces: CallId.optional() }),
  /** This device must stop ringing: another device of the same person answered (D-11). */
  z.object({ t: z.literal("call.stop-ringing"), callId: CallId, reason: StopRingingReason }),
  /** The call is over (or never started) for this reason. */
  z.object({ t: z.literal("call.ended"), callId: CallId, reason: CallEndReason }),
  /** The other party's camera is on or off (D-03, Pitfall 7: the remote track alone never says so). */
  z.object({ t: z.literal("call.media"), callId: CallId, camera: z.boolean() }),
  /** Answer to call.rejoin: the call this connection is bound to again, and the other party's camera flag. */
  z.object({ t: z.literal("call.state"), callId: CallId, status: z.enum(["ringing", "active"]), peerCamera: z.boolean() }),
])
export type ServerFrame = z.infer<typeof ServerFrame>
