import { z } from "zod"
import { CallKind, CallOutcome } from "./call"
import { codePointLength, isBlankBody } from "./chat-logic"

/**
 * Chat REST contract (CHAT-01..05). Server-produced DTOs are plain z.object so an older installed PWA
 * tolerates fields a newer server adds; request bodies are strict (an unknown key is invalid_body,
 * so a client can never smuggle in a senderId, T-02-01).
 */

/** Longest message body, counted in Unicode code points (an astral emoji counts as one). */
export const MESSAGE_BODY_MAX_CODE_POINTS = 4000
/** UTF-16 bound checked before counting code points: 4000 astral code points are 8000 units. */
const MESSAGE_BODY_MAX_UTF16 = MESSAGE_BODY_MAX_CODE_POINTS * 2
/** Messages per history page unless the client asks otherwise. */
export const PAGE_SIZE_DEFAULT = 50
/** Largest history page (jump-to-quote pages in bigger steps). */
export const PAGE_SIZE_MAX = 200
/** Most changes one GET /api/sync returns; more sets hasMore and the client reloads instead. */
export const SYNC_MAX = 500

/**
 * "call" and "reminder" are system lines written only by the server (QT-nw9-call-lines,
 * QT-nw9-reminder-fire): a centred line in the chat, never a bubble, and never replied or reacted to.
 */
export const MessageKind = z.enum(["text", "media", "voice", "call", "reminder"])
export type MessageKind = z.infer<typeof MessageKind>

export const AttachmentKind = z.enum(["image", "video", "audio"])
export type AttachmentKind = z.infer<typeof AttachmentKind>

export const AttachmentStatus = z.enum(["uploading", "processing", "ready", "failed"])
export type AttachmentStatus = z.infer<typeof AttachmentStatus>

/** Most items in one album message (D-07). */
export const MAX_ALBUM_ITEMS = 10

/** 128-bit random id, base64url without padding. */
export const AttachmentId = z.string().regex(/^[A-Za-z0-9_-]{22}$/)
export type AttachmentId = z.infer<typeof AttachmentId>

export const AttachmentDto = z.object({
  id: AttachmentId,
  kind: AttachmentKind,
  status: AttachmentStatus,
  position: z.number().int().min(0).max(9),
  width: z.number().int().nullable(),
  height: z.number().int().nullable(),
  durationMs: z.number().int().nullable(),
  /** Voice-note bars, 0..100 each. */
  waveform: z.array(z.number().int().min(0).max(100)).nullable(),
  error: z.string().nullable(),
})
export type AttachmentDto = z.infer<typeof AttachmentDto>

/**
 * The couple's fixed reaction set (D-04), in display order. Each is one code point with no variation
 * selector, so validation is exact string equality. Stored emoji are returned as stored, so a reaction
 * stays readable if this set changes later (ReactionDto.emoji is a plain string).
 */
export const REACTIONS = ["💕", "💔", "😋", "😝", "😘", "😭"] as const
export const Reaction = z.enum(REACTIONS)
export type Reaction = z.infer<typeof Reaction>

/** PUT /api/messages/:seq/reaction body. null removes your reaction (a no-op when you have none). */
export const ReactionBody = z.strictObject({
  emoji: Reaction.nullable(),
})
export type ReactionBody = z.infer<typeof ReactionBody>

export const ReactionDto = z.object({
  userId: z.uuid(),
  emoji: z.string(),
})
export type ReactionDto = z.infer<typeof ReactionDto>

/** Longest reply snippet, in user-perceived characters (graphemes), before "…". */
export const REPLY_SNIPPET_MAX_GRAPHEMES = 120

/**
 * Server-built quote of the message being replied to, so it renders even when the original is not
 * loaded. Only the direct parent is quoted (never nested). snippet = the parent's text or caption cut
 * to REPLY_SNIPPET_MAX_GRAPHEMES, or the plain media label ("3 photos", "Voice note") without one.
 */
export const ReplyPreview = z.object({
  seq: z.number().int().positive(),
  senderId: z.uuid(),
  kind: MessageKind,
  snippet: z.string(),
  attachmentCount: z.number().int().min(0),
  thumb: z.object({ id: AttachmentId, kind: AttachmentKind }).nullable(),
})
export type ReplyPreview = z.infer<typeof ReplyPreview>

/** A call line's call (QT-nw9-call-lines). Its sender is the caller; createdAt is when it ended. */
export const CallLine = z.object({
  kind: CallKind,
  outcome: CallOutcome,
  /** Connected time; 0 when the call was never answered. */
  durationMs: z.number().int().min(0),
})
export type CallLine = z.infer<typeof CallLine>

/**
 * A reminder line (QT-nw9-reminder-fire). The title is the message's `body` and its sender is the
 * reminder's creator.
 */
export const ReminderLine = z.object({
  /** Who it was for; null means both people. */
  forUserId: z.uuid().nullable(),
  /** The heads-up minutes of this firing, null for the reminder itself. */
  leadMinutes: z.number().int().positive().nullable(),
})
export type ReminderLine = z.infer<typeof ReminderLine>

export const MessageDto = z.object({
  /** Total order and history paging key. */
  seq: z.number().int().positive(),
  /** Client-generated UUID: the dedup key for retries (CHAT-04). */
  id: z.uuid(),
  senderId: z.uuid(),
  kind: MessageKind,
  /** Text or caption exactly as sent; null for media/voice without a caption. */
  body: z.string().nullable(),
  /** Epoch milliseconds. */
  createdAt: z.number().int(),
  /** Change cursor: bumped on every write that touches this message (CHAT-05). */
  updatedSeq: z.number().int().positive(),
  replyTo: ReplyPreview.nullable(),
  attachments: z.array(AttachmentDto),
  reactions: z.array(ReactionDto),
  /** Set for kind "call" only. */
  call: CallLine.nullable(),
  /** Set for kind "reminder" only (the title is `body`, the sender is the creator). */
  reminder: ReminderLine.nullable(),
})
export type MessageDto = z.infer<typeof MessageDto>

/** How far one person has read. `at` is epoch ms of the read, null when never read. */
export const ReadCursor = z.object({
  userId: z.uuid(),
  seq: z.number().int().min(0),
  at: z.number().int().nullable(),
})
export type ReadCursor = z.infer<typeof ReadCursor>

/**
 * POST /api/messages body. The sender always comes from the session, never from the body. A text
 * message has a body; a media message (D-07) has 1..MAX_ALBUM_ITEMS attachmentIds in album order and
 * an optional caption in body. A body, when present, is never blank.
 */
export const SendMessageBody = z
  .strictObject({
    id: z.uuid(),
    body: z.string().max(MESSAGE_BODY_MAX_UTF16).optional(),
    /** The message this one answers (D-02); it must exist, else 400 bad_reply. */
    replyToSeq: z.number().int().positive().optional(),
    /** Completed uploads of the sender, in album order (position 0..n-1). */
    attachmentIds: z.array(AttachmentId).min(1).max(MAX_ALBUM_ITEMS).optional(),
  })
  .refine((b) => b.body !== undefined || b.attachmentIds !== undefined, { path: ["body"], message: "empty" })
  .refine((b) => b.body === undefined || !isBlankBody(b.body), { path: ["body"], message: "blank" })
  .refine((b) => b.body === undefined || codePointLength(b.body) <= MESSAGE_BODY_MAX_CODE_POINTS, {
    path: ["body"],
    message: "too_long",
  })
  .refine((b) => b.attachmentIds === undefined || new Set(b.attachmentIds).size === b.attachmentIds.length, {
    path: ["attachmentIds"],
    message: "duplicate",
  })
export type SendMessageBody = z.infer<typeof SendMessageBody>

export const SendMessageResponse = z.object({
  message: MessageDto,
})
export type SendMessageResponse = z.infer<typeof SendMessageResponse>

/** POST /api/read body: the highest seq on screen. The reader always comes from the session. */
export const ReadBody = z.strictObject({
  seq: z.number().int().positive(),
})
export type ReadBody = z.infer<typeof ReadBody>

export const ReadResponse = z.object({ ok: z.literal(true) })
export type ReadResponse = z.infer<typeof ReadResponse>

/** GET /api/messages query: the page of messages with seq < before (or the newest page). */
export const MessagesQuery = z.object({
  before: z.coerce.number().int().positive().optional(),
  limit: z.coerce.number().int().min(1).max(PAGE_SIZE_MAX).default(PAGE_SIZE_DEFAULT),
})
export type MessagesQuery = z.infer<typeof MessagesQuery>

/** Messages ascending by seq; cursor = the current max updated_seq (start point for /api/sync). */
export const MessagesPage = z.object({
  messages: z.array(MessageDto),
  hasMore: z.boolean(),
  cursor: z.number().int().min(0),
  reads: z.array(ReadCursor),
})
export type MessagesPage = z.infer<typeof MessagesPage>

/** GET /api/sync query: every message whose updated_seq is greater than `since`. */
export const SyncQuery = z.object({
  since: z.coerce.number().int().min(0),
})
export type SyncQuery = z.infer<typeof SyncQuery>

/** Changed messages ascending by updatedSeq (at most SYNC_MAX); hasMore = more changes exist. */
export const SyncResponse = z.object({
  messages: z.array(MessageDto),
  reads: z.array(ReadCursor),
  cursor: z.number().int().min(0),
  hasMore: z.boolean(),
})
export type SyncResponse = z.infer<typeof SyncResponse>
