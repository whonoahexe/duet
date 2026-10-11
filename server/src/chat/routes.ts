import type { FastifyInstance } from "fastify"
import {
  MessagesQuery,
  ReactionBody,
  SendMessageBody,
  SyncQuery,
  type MessagesPage,
  type SendMessageResponse,
  type SyncResponse,
} from "@duet/shared"
import { requireUser } from "../auth/session"
import {
  ChatError,
  currentCursor,
  latestPage,
  readCursors,
  sendMessage,
  setReaction,
  syncSince,
  toDtos,
} from "./service"

/** A :seq path parameter: a positive decimal integer, else null. */
function parseSeq(raw: unknown): number | null {
  if (typeof raw !== "string" || !/^[1-9][0-9]{0,15}$/.test(raw)) return null
  const n = Number(raw)
  return Number.isSafeInteger(n) ? n : null
}

/**
 * Chat REST (CHAT-01, CHAT-02, CHAT-05). Durable writes go over HTTP, then fan out over /ws (Pattern 1).
 * Non-GET requests are already Origin-checked by the global originGuard. Logs carry evt names, ids,
 * seqs and counts only: never a message body (T-02-03). Reads are never cached (T-02-04).
 */
export async function chatRoutes(app: FastifyInstance) {
  app.post("/api/messages", { preHandler: requireUser }, async (request, reply) => {
    const parsed = SendMessageBody.safeParse(request.body)
    if (!parsed.success) return reply.code(400).send({ error: "invalid_body" })
    const userId = request.user!.id

    let result: ReturnType<typeof sendMessage>
    try {
      result = sendMessage(app.db, userId, parsed.data)
    } catch (err) {
      if (err instanceof ChatError) {
        request.log.warn({ evt: "msg_rejected", userId, code: err.code })
        return reply.code(err.status).send({ error: err.code })
      }
      throw err
    }

    const [message] = toDtos(app.db, [result.row])
    if (result.created) {
      app.hub.broadcast({ t: "msg", message })
      app.chatEvents.emitMessageCreated({ message, senderId: userId })
    }
    request.log.info({ evt: "msg_sent", userId, seq: message.seq, created: result.created })
    reply.header("Cache-Control", "no-store")
    const body: SendMessageResponse = { message }
    return body
  })

  /**
   * Set, replace or remove your reaction (D-04, CHAT-08). The reacting person is always the session
   * user (T-02-09); the emoji must be one of REACTIONS exactly (T-02-10). Every change is broadcast as
   * a changed message. The emoji itself is never logged.
   */
  app.put("/api/messages/:seq/reaction", { preHandler: requireUser }, async (request, reply) => {
    reply.header("Cache-Control", "no-store")
    const seq = parseSeq((request.params as { seq?: unknown }).seq)
    if (seq === null) return reply.code(400).send({ error: "invalid_body" })
    const parsed = ReactionBody.safeParse(request.body)
    if (!parsed.success) return reply.code(400).send({ error: "invalid_body" })
    const userId = request.user!.id

    let result: ReturnType<typeof setReaction>
    try {
      result = setReaction(app.db, userId, seq, parsed.data.emoji)
    } catch (err) {
      if (err instanceof ChatError) return reply.code(err.status).send({ error: err.code })
      throw err
    }

    const [message] = toDtos(app.db, [result.row])
    if (result.changed) app.hub.broadcast({ t: "msg", message })
    request.log.info({ evt: "reaction", userId, seq, changed: result.changed })
    const body: SendMessageResponse = { message }
    return body
  })

  app.get("/api/messages", { preHandler: requireUser }, async (request, reply) => {
    reply.header("Cache-Control", "no-store")
    const parsed = MessagesQuery.safeParse(request.query)
    if (!parsed.success) return reply.code(400).send({ error: "invalid_query" })
    // No await between these reads: the page, cursor and reads are one consistent snapshot.
    const { rows, hasMore } = latestPage(app.db, parsed.data)
    const page: MessagesPage = {
      messages: toDtos(app.db, rows),
      hasMore,
      cursor: currentCursor(app.db),
      reads: readCursors(app.db),
    }
    return page
  })

  /** Catch-up after a resume or reconnect: every message changed after the client's cursor. */
  app.get("/api/sync", { preHandler: requireUser }, async (request, reply) => {
    reply.header("Cache-Control", "no-store")
    const parsed = SyncQuery.safeParse(request.query)
    if (!parsed.success) return reply.code(400).send({ error: "invalid_query" })
    const { rows, hasMore, cursor } = syncSince(app.db, parsed.data.since)
    const body: SyncResponse = { messages: toDtos(app.db, rows), reads: readCursors(app.db), cursor, hasMore }
    return body
  })
}
