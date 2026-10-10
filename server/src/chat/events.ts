import type { FastifyBaseLogger } from "fastify"
import type { MessageDto } from "@duet/shared"

export interface MessageCreatedEvent {
  message: MessageDto
  senderId: string
}

export type MessageCreatedListener = (event: MessageCreatedEvent) => void | Promise<void>

/**
 * In-process seam for "a new message was stored" (push in plan 02-03 subscribes here). Emitted once
 * per created message, never for an idempotent replay.
 */
export interface ChatEvents {
  /** Register a listener. Returns an unsubscribe function. */
  onMessageCreated(listener: MessageCreatedListener): () => void
  /**
   * Run every listener synchronously in registration order. A listener that throws or rejects is
   * logged (evt chat_listener_failed, error name only) and never reaches the request.
   */
  emitMessageCreated(event: MessageCreatedEvent): void
}

export function createChatEvents(log: FastifyBaseLogger): ChatEvents {
  const listeners: MessageCreatedListener[] = []

  function failed(err: unknown): void {
    log.warn({ evt: "chat_listener_failed", err: err instanceof Error ? err.name : typeof err })
  }

  return {
    onMessageCreated(listener) {
      listeners.push(listener)
      return () => {
        const i = listeners.indexOf(listener)
        if (i >= 0) listeners.splice(i, 1)
      }
    },

    emitMessageCreated(event) {
      for (const listener of [...listeners]) {
        try {
          const result = listener(event)
          if (result && typeof (result as Promise<void>).catch === "function") {
            ;(result as Promise<void>).catch(failed)
          }
        } catch (err) {
          failed(err)
        }
      }
    },
  }
}
