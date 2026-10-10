import { asc, desc, eq, gt, inArray, lt, sql } from "drizzle-orm"
import { SYNC_MAX, type AttachmentDto, type MessageDto, type ReadCursor, type SendMessageBody } from "@duet/shared"
import type { Db } from "../db/client"
import { attachments, messages, reactions, readState } from "../db/schema"

/** A synchronous better-sqlite3 transaction handle (same query API as Db). */
type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0]
type DbOrTx = Db | Tx

export type MessageRow = typeof messages.$inferSelect

/** A rejected chat write with its HTTP status and the snake_case code sent as { error }. */
export class ChatError extends Error {
  override name = "ChatError"
  constructor(
    readonly code: string,
    readonly status: number,
  ) {
    super(code)
  }
}

/** The current change cursor: max(updated_seq), 0 when there are no messages. */
export function currentCursor(db: DbOrTx): number {
  const row = db
    .select({ m: sql<number>`coalesce(max(${messages.updatedSeq}), 0)` })
    .from(messages)
    .get()
  return Number(row?.m ?? 0)
}

/**
 * The next change cursor value. Call it only inside the write transaction: better-sqlite3 is
 * synchronous and there is one process, so the transaction serializes writers (no counters table).
 */
export function nextUpdatedSeq(tx: DbOrTx): number {
  return currentCursor(tx) + 1
}

/**
 * Idempotent text send (CHAT-01, CHAT-04). One synchronous transaction: a replayed id from the same
 * sender returns the stored row unchanged (created false); an id owned by the other person is a 409
 * id_conflict and their row is untouched (T-02-02). The body is stored exactly as received.
 */
export function sendMessage(
  db: Db,
  senderId: string,
  input: Pick<SendMessageBody, "id" | "body">,
): { row: MessageRow; created: boolean } {
  return db.transaction((tx) => {
    const existing = tx.select().from(messages).where(eq(messages.id, input.id)).get()
    if (existing) {
      if (existing.senderId !== senderId) throw new ChatError("id_conflict", 409)
      return { row: existing, created: false }
    }
    const updatedSeq = nextUpdatedSeq(tx)
    const row = tx
      .insert(messages)
      .values({
        id: input.id,
        senderId,
        kind: "text",
        body: input.body,
        replyToSeq: null,
        createdAt: new Date(),
        updatedSeq,
      })
      .returning()
      .get()
    return { row, created: true }
  })
}

function parseWaveform(raw: string | null): number[] | null {
  if (!raw) return null
  try {
    const v: unknown = JSON.parse(raw)
    return Array.isArray(v) && v.every((n) => Number.isInteger(n) && n >= 0 && n <= 100) ? (v as number[]) : null
  } catch {
    return null
  }
}

/**
 * Message rows -> MessageDto[] in the same order, with explicit column projection: one query for the
 * attachments of every row (ordered by position) and one for the reactions.
 */
export function toDtos(db: DbOrTx, rows: MessageRow[]): MessageDto[] {
  if (rows.length === 0) return []
  const seqs = rows.map((r) => r.seq)

  const attRows = db
    .select({
      messageSeq: attachments.messageSeq,
      id: attachments.id,
      kind: attachments.kind,
      status: attachments.status,
      position: attachments.position,
      width: attachments.width,
      height: attachments.height,
      durationMs: attachments.durationMs,
      waveform: attachments.waveform,
      error: attachments.error,
    })
    .from(attachments)
    .where(inArray(attachments.messageSeq, seqs))
    .orderBy(asc(attachments.messageSeq), asc(attachments.position))
    .all()
  const attsBySeq = new Map<number, AttachmentDto[]>()
  for (const a of attRows) {
    if (a.messageSeq === null) continue
    const list = attsBySeq.get(a.messageSeq) ?? []
    list.push({
      id: a.id,
      kind: a.kind,
      status: a.status,
      position: a.position,
      width: a.width,
      height: a.height,
      durationMs: a.durationMs,
      waveform: parseWaveform(a.waveform),
      error: a.error,
    })
    attsBySeq.set(a.messageSeq, list)
  }

  const reactRows = db
    .select({ messageSeq: reactions.messageSeq, userId: reactions.userId, emoji: reactions.emoji })
    .from(reactions)
    .where(inArray(reactions.messageSeq, seqs))
    .orderBy(asc(reactions.createdAt))
    .all()
  const reactsBySeq = new Map<number, { userId: string; emoji: string }[]>()
  for (const r of reactRows) {
    const list = reactsBySeq.get(r.messageSeq) ?? []
    list.push({ userId: r.userId, emoji: r.emoji })
    reactsBySeq.set(r.messageSeq, list)
  }

  return rows.map((r) => ({
    seq: r.seq,
    id: r.id,
    senderId: r.senderId,
    kind: r.kind,
    body: r.body,
    createdAt: r.createdAt.getTime(),
    updatedSeq: r.updatedSeq,
    replyTo: null,
    attachments: attsBySeq.get(r.seq) ?? [],
    reactions: reactsBySeq.get(r.seq) ?? [],
  }))
}

/**
 * One history page: the newest `limit` messages with seq < before (or the newest overall), returned
 * ascending by seq. hasMore = older messages exist.
 */
export function latestPage(db: DbOrTx, { before, limit }: { before?: number; limit: number }) {
  const rows = db
    .select()
    .from(messages)
    .where(before !== undefined ? lt(messages.seq, before) : undefined)
    .orderBy(desc(messages.seq))
    .limit(limit + 1)
    .all()
  const hasMore = rows.length > limit
  return { rows: rows.slice(0, limit).reverse(), hasMore }
}

/**
 * Change feed (CHAT-05): messages with updated_seq > since, ascending by updated_seq, at most
 * SYNC_MAX. cursor = where the next sync should start: the last returned updated_seq when more
 * changes exist, otherwise the current max (which also resets a client cursor that is ahead).
 */
export function syncSince(db: DbOrTx, since: number) {
  const rows = db
    .select()
    .from(messages)
    .where(gt(messages.updatedSeq, since))
    .orderBy(asc(messages.updatedSeq))
    .limit(SYNC_MAX + 1)
    .all()
  const hasMore = rows.length > SYNC_MAX
  const page = rows.slice(0, SYNC_MAX)
  const cursor = hasMore ? page[page.length - 1].updatedSeq : currentCursor(db)
  return { rows: page, hasMore, cursor }
}

/** Every person's read cursor (empty until someone has read something). */
export function readCursors(db: DbOrTx): ReadCursor[] {
  return db
    .select({ userId: readState.userId, seq: readState.lastReadSeq, readAt: readState.readAt })
    .from(readState)
    .all()
    .map((r) => ({ userId: r.userId, seq: r.seq, at: r.readAt ? r.readAt.getTime() : null }))
}
