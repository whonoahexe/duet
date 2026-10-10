import { z } from "zod"
import { MessageDto } from "./chat"

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
])
export type ClientFrame = z.infer<typeof ClientFrame>

/** One open connection (a person may have several devices online at once). */
export const Peer = z.object({
  connId: z.uuid(),
  userId: z.uuid(),
})
export type Peer = z.infer<typeof Peer>

export const WsErrorCode = z.enum(["bad_frame", "not_in_room", "too_many_rooms"])
export type WsErrorCode = z.infer<typeof WsErrorCode>

export const ServerFrame = z.discriminatedUnion("t", [
  z.object({ t: z.literal("hello"), connId: z.uuid(), userId: z.uuid() }),
  z.object({ t: z.literal("room.joined"), room: RoomId, peers: z.array(Peer) }),
  z.object({ t: z.literal("room.peer-joined"), room: RoomId, peer: Peer }),
  z.object({ t: z.literal("room.peer-left"), room: RoomId, connId: z.uuid() }),
  z.object({ t: z.literal("room.full"), room: RoomId }),
  z.object({ t: z.literal("rtc.signal"), room: RoomId, from: z.uuid(), data: SignalData }),
  z.object({ t: z.literal("error"), code: WsErrorCode }),
  /** A new or changed message (CHAT-01): the client inserts or replaces it by seq. */
  z.object({ t: z.literal("msg"), message: MessageDto }),
])
export type ServerFrame = z.infer<typeof ServerFrame>
