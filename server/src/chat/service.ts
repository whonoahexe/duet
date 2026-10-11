import { and, asc, desc, eq, gt, inArray, lt, sql } from "drizzle-orm"
import {
  REPLY_SNIPPET_MAX_GRAPHEMES,
  SYNC_MAX,
  mediaLabel,
  truncateGraphemes,
  type AttachmentDto,
  type AttachmentKind,
  type MessageDto,
  type ReadCursor,
  type ReplyPreview,
  type SendMessageBody,
} from "@duet/shared"
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
 * id_conflict and their row is untouched (T-02-02). The body is stored exactly as received. A
 * replyToSeq must name an existing message, checked inside the same transaction (400 bad_reply,
 * T-02-13).
 */
export function sendMessage(
  db: Db,
  senderId: string,
  input: Pick<SendMessageBody, "id" | "body" | "replyToSeq">,
): { row: MessageRow; created: boolean } {
  return db.transaction((tx) => {
    const existing = tx.select().from(messages).where(eq(messages.id, input.id)).get()
    if (existing) {
      if (existing.senderId !== senderId) throw new ChatError("id_conflict", 409)
      return { row: existing, created: false }
    }
    const replyToSeq = input.replyToSeq ?? null
    if (replyToSeq !== null) {
      const parent = tx.select({ seq: messages.seq }).from(messages).where(eq(messages.seq, replyToSeq)).get()
      if (!parent) throw new ChatError("bad_reply", 400)
    }
    const updatedSeq = nextUpdatedSeq(tx)
    const row = tx
      .insert(messages)
      .values({
        id: input.id,
        senderId,
        kind: "text",
        body: input.body,
        replyToSeq,
        createdAt: new Date(),
        updatedSeq,
      })
      .returning()
      .get()
    return { row, created: true }
  })
}

/**
 * Set, replace or remove this person's reaction on one message (D-04, CHAT-08). One synchronous
 * transaction: a missing message is a 404 not_found; emoji null deletes the (seq, user) row (a no-op
 * when there is none); otherwise the row is inserted or replaced. When anything changed the message's
 * updated_seq is bumped so offline phones receive it through /api/sync. The emoji was already checked
 * against REACTIONS by the route. Returns the fresh message row and whether it changed.
 */
export function setReaction(
  db: Db,
  userId: string,
  seq: number,
  emoji: string | null,
): { row: MessageRow; changed: boolean } {
  return db.transaction((tx) => {
    const msg = tx.select().from(messages).where(eq(messages.seq, seq)).get()
    if (!msg) throw new ChatError("not_found", 404)
    const mine = and(eq(reactions.messageSeq, seq), eq(reactions.userId, userId))
    const existing = tx.select({ emoji: reactions.emoji }).from(reactions).where(mine).get()

    let changed = false
    if (emoji === null) {
      if (existing) {
        tx.delete(reactions).where(mine).run()
        changed = true
      }
    } else if (!existing) {
      tx.insert(reactions).values({ messageSeq: seq, userId, emoji, createdAt: new Date() }).run()
      changed = true
    } else if (existing.emoji !== emoji) {
      tx.update(reactions).set({ emoji, createdAt: new Date() }).where(mine).run()
      changed = true
    }
    if (!changed) return { row: msg, changed }

    const updatedSeq = nextUpdatedSeq(tx)
    const row = tx.update(messages).set({ updatedSeq }).where(eq(messages.seq, seq)).returning().get()
    return { row, changed }
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
 * Reply previews for the given parent seqs (D-02, CHAT-09): one query for the parents and one for
 * their attachments. Parents are never expanded further (a preview has no replyTo of its own). A
 * parent that no longer exists simply has no preview.
 */
function replyPreviews(db: DbOrTx, parentSeqs: number[]): Map<number, ReplyPreview> {
  const out = new Map<number, ReplyPreview>()
  if (parentSeqs.length === 0) return out
  const parents = db
    .select({ seq: messages.seq, senderId: messages.senderId, kind: messages.kind, body: messages.body })
    .from(messages)
    .where(inArray(messages.seq, parentSeqs))
    .all()
  const atts = db
    .select({ messageSeq: attachments.messageSeq, id: attachments.id, kind: attachments.kind })
    .from(attachments)
    .where(inArray(attachments.messageSeq, parentSeqs))
    .orderBy(asc(attachments.messageSeq), asc(attachments.position))
    .all()
  const attsBySeq = new Map<number, { id: string; kind: AttachmentKind }[]>()
  for (const a of atts) {
    if (a.messageSeq === null) continue
    const list = attsBySeq.get(a.messageSeq) ?? []
    list.push({ id: a.id, kind: a.kind })
    attsBySeq.set(a.messageSeq, list)
  }
  for (const p of parents) {
    const list = attsBySeq.get(p.seq) ?? []
    const text = p.body ?? ""
    const snippet =
      p.kind === "text" || text.length > 0
        ? truncateGraphemes(text, REPLY_SNIPPET_MAX_GRAPHEMES)
        : mediaLabel(
            list.map((a) => a.kind),
            { emoji: false },
          )
    const visual = list.find((a) => a.kind === "image" || a.kind === "video")
    out.set(p.seq, {
      seq: p.seq,
      senderId: p.senderId,
      kind: p.kind,
      snippet,
      attachmentCount: list.length,
      thumb: visual ? { id: visual.id, kind: visual.kind } : null,
    })
  }
  return out
}

/**
 * Message rows -> MessageDto[] in the same order, with explicit column projection: one query for the
 * attachments of every row (ordered by position), one for the reactions, and two for reply previews.
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

  const previews = replyPreviews(db, [
    ...new Set(rows.map((r) => r.replyToSeq).filter((s): s is number => s !== null)),
  ])

  return rows.map((r) => ({
    seq: r.seq,
    id: r.id,
    senderId: r.senderId,
    kind: r.kind,
    body: r.body,
    createdAt: r.createdAt.getTime(),
    updatedSeq: r.updatedSeq,
    replyTo: r.replyToSeq !== null ? (previews.get(r.replyToSeq) ?? null) : null,
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

/**
 * Move this person's read cursor forward (CHAT-07). One transaction: the target is clamped to the
 * newest message seq and stored only when it is ahead of last_read_seq (read_at = now). A lower or
 * equal seq changes nothing. Returns the new cursor when it moved.
 */
export function markRead(
  db: Db,
  userId: string,
  seq: number,
): { changed: true; cursor: { seq: number; at: number } } | { changed: false } {
  return db.transaction((tx) => {
    const newest = Number(
      tx
        .select({ m: sql<number>`coalesce(max(${messages.seq}), 0)` })
        .from(messages)
        .get()?.m ?? 0,
    )
    const target = Math.min(seq, newest)
    const current = tx.select({ seq: readState.lastReadSeq }).from(readState).where(eq(readState.userId, userId)).get()
    if (target <= (current?.seq ?? 0)) return { changed: false as const }
    const readAt = new Date()
    tx.insert(readState)
      .values({ userId, lastReadSeq: target, readAt })
      .onConflictDoUpdate({ target: readState.userId, set: { lastReadSeq: target, readAt } })
      .run()
    return { changed: true as const, cursor: { seq: target, at: readAt.getTime() } }
  })
}

/** Every person's read cursor (empty until someone has read something). */
export function readCursors(db: DbOrTx): ReadCursor[] {
  return db
    .select({ userId: readState.userId, seq: readState.lastReadSeq, readAt: readState.readAt })
    .from(readState)
    .all()
    .map((r) => ({ userId: r.userId, seq: r.seq, at: r.readAt ? r.readAt.getTime() : null }))
}
