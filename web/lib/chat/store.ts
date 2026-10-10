"use client"

import { useSyncExternalStore } from "react"
import {
  MessagesPage,
  SendMessageResponse,
  type MeResponse,
  type MessageDto,
  type UserSummary,
} from "@duet/shared"
import { apiGet, apiPost } from "@/lib/api"

/** A text message the server has not confirmed yet (no seq). */
export interface PendingMessage {
  id: string
  body: string
  createdAt: number
  attempts: number
  state: "sending" | "failed"
}

export type ConnectionState = "connecting" | "live" | "offline"

export interface ChatState {
  me: UserSummary | null
  peer: UserSummary | null
  /** Confirmed messages, ascending by seq. */
  messages: MessageDto[]
  /** Unconfirmed sends, rendered after `messages` in createdAt order. */
  pending: PendingMessage[]
  /** Change cursor for /api/sync (max updatedSeq seen). */
  cursor: number
  /** Lowest loaded seq (null before the first page). Changes to older messages are ignored. */
  oldestSeq: number | null
  /** Older messages exist on the server. */
  hasMore: boolean
  initial: "loading" | "ready" | "error"
  history: "idle" | "loading" | "error" | "done"
  connection: ConnectionState
}

const EMPTY: ChatState = {
  me: null,
  peer: null,
  messages: [],
  pending: [],
  cursor: 0,
  oldestSeq: null,
  hasMore: false,
  initial: "loading",
  history: "idle",
  connection: "connecting",
}

let state: ChatState = EMPTY
const listeners = new Set<() => void>()
/** Bumped by reset(): responses that belong to an older session are dropped. */
let generation = 0

function set(patch: Partial<ChatState>): void {
  state = { ...state, ...patch }
  for (const l of listeners) l()
}

/** Insert or replace by seq, keeping ascending order. Pure. */
function upsert(list: MessageDto[], incoming: MessageDto): MessageDto[] {
  const i = list.findIndex((m) => m.seq === incoming.seq)
  if (i >= 0) {
    const next = list.slice()
    next[i] = incoming
    return next
  }
  const next = [...list, incoming]
  next.sort((a, b) => a.seq - b.seq)
  return next
}

/**
 * Module-level chat store (one per tab). REST pages, WS frames and send echoes all land here and
 * merge by seq, in any order.
 */
export const chatStore = {
  subscribe(listener: () => void): () => void {
    listeners.add(listener)
    return () => listeners.delete(listener)
  },
  getSnapshot(): ChatState {
    return state
  },
  getServerSnapshot(): ChatState {
    return EMPTY
  },

  /** Bind the store to the logged-in person. A different person resets everything first. */
  init(me: MeResponse): void {
    if (state.me && state.me.id !== me.user.id) chatStore.reset()
    set({ me: me.user, peer: me.peer })
  },

  /** Forget everything (logout). */
  reset(): void {
    generation += 1
    set(EMPTY)
  },

  /** GET /api/messages: replace the cache with the newest page. */
  async loadLatest(): Promise<void> {
    const gen = generation
    if (state.messages.length === 0) set({ initial: "loading" })
    try {
      const page = await apiGet("/api/messages", MessagesPage)
      if (gen !== generation) return
      const ids = new Set(page.messages.map((m) => m.id))
      set({
        messages: page.messages,
        pending: state.pending.filter((p) => !ids.has(p.id)),
        cursor: page.cursor,
        oldestSeq: page.messages[0]?.seq ?? null,
        hasMore: page.hasMore,
        initial: "ready",
        history: page.hasMore ? "idle" : "done",
      })
    } catch {
      if (gen !== generation) return
      if (state.initial !== "ready") set({ initial: "error" })
    }
  },

  /** A confirmed message from any source (POST echo, WS msg). Removes the matching pending entry. */
  applyMessage(dto: MessageDto): void {
    const pending = state.pending.some((p) => p.id === dto.id) ? state.pending.filter((p) => p.id !== dto.id) : state.pending
    // A change to a message older than the loaded window would open a hole: it arrives with that page.
    if (state.oldestSeq !== null && dto.seq < state.oldestSeq) {
      if (pending !== state.pending) set({ pending })
      return
    }
    set({
      messages: upsert(state.messages, dto),
      pending,
      cursor: Math.max(state.cursor, dto.updatedSeq),
      oldestSeq: state.oldestSeq ?? dto.seq,
    })
  },

  /** Send a text message with a fresh client id (shown at once as pending). */
  async sendText(body: string): Promise<void> {
    const gen = generation
    const entry: PendingMessage = { id: crypto.randomUUID(), body, createdAt: Date.now(), attempts: 1, state: "sending" }
    set({ pending: [...state.pending, entry] })
    try {
      const { message } = await apiPost("/api/messages", { id: entry.id, body }, SendMessageResponse)
      if (gen !== generation) return
      chatStore.applyMessage(message)
    } catch {
      if (gen !== generation) return
      set({ pending: state.pending.map((p) => (p.id === entry.id ? { ...p, state: "failed" } : p)) })
    }
  },

  setConnection(connection: ConnectionState): void {
    if (state.connection !== connection) set({ connection })
  },
}

/** React binding for the chat store. */
export function useChat(): ChatState {
  return useSyncExternalStore(chatStore.subscribe, chatStore.getSnapshot, chatStore.getServerSnapshot)
}
