import type { FastifyInstance } from "fastify"
import { MessagesQuery, SendMessageBody, type MessagesPage, type SendMessageResponse } from "@duet/shared"
import { requireUser } from "../auth/session"
import { ChatError, currentCursor, latestPage, readCursors, sendMessage, toDtos } from "./service"

/**
 * Chat REST (CHAT-01, CHAT-02). Durable writes go over HTTP, then fan out over /ws (Pattern 1).
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
}
