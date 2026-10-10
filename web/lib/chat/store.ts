"use client"

import { useSyncExternalStore } from "react"
import {
  MessagesPage,
  PAGE_SIZE_DEFAULT,
  SendMessageResponse,
  SyncResponse,
  mergeMessages,
  type MeResponse,
  type MessageDto,
  type UserSummary,
} from "@duet/shared"
import { ApiError, apiGet, apiPost } from "@/lib/api"
import { createOutbox, type OutboxEntry } from "./outbox"

export type { OutboxEntry } from "./outbox"

export type ConnectionState = "connecting" | "live" | "offline"

export interface ChatState {
  me: UserSummary | null
  peer: UserSummary | null
  /** Confirmed messages, ascending by seq. */
  messages: MessageDto[]
  /** Unconfirmed text sends (the outbox), rendered after `messages` in createdAt order. */
  pending: OutboxEntry[]
  /** Change cursor for /api/sync (max updatedSeq seen). */
  cursor: number
  /** Lowest loaded seq (null before the first message). Changes to older messages are ignored. */
  oldestSeq: number | null
  /** Older messages exist on the server. */
  hasMore: boolean
  initial: "loading" | "ready" | "error"
  history: "idle" | "loading" | "error" | "done"
  connection: ConnectionState
  /** Incoming messages that arrived while the list was scrolled away from the bottom. */
  newWhileAway: number
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
  newWhileAway: 0,
}

let state: ChatState = EMPTY
const listeners = new Set<() => void>()
/** Bumped by reset(): responses that belong to an older session are dropped. */
let generation = 0
let onLoggedOut: () => void = () => {}
let syncing = false
let syncAgain = false

function set(patch: Partial<ChatState>): void {
  state = { ...state, ...patch }
  for (const l of listeners) l()
}

function loggedOut(): void {
  onLoggedOut()
}

const outbox = createOutbox({
  send: async (entry) => (await apiPost("/api/messages", { id: entry.id, body: entry.body }, SendMessageResponse)).message,
  isConnected: () => navigator.onLine && state.connection === "live",
  onChange: (entries) => set({ pending: entries }),
  onConfirmed: (message) => chatStore.applyMessages([message]),
  onLoggedOut: loggedOut,
})

/** True for a 401: the session is gone, so the app goes back to the login tiles. */
function isLoggedOutError(err: unknown): boolean {
  return err instanceof ApiError && err.status === 401
}

/**
 * Module-level chat store (one per tab). REST pages, WS frames, sync deltas and outbox echoes all
 * land here and merge by seq in any order (mergeMessages).
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

  /** Bind the store to the logged-in person and restore their outbox. */
  init(me: MeResponse, opts: { onLoggedOut: () => void }): void {
    onLoggedOut = opts.onLoggedOut
    if (state.me && state.me.id !== me.user.id) chatStore.reset()
    set({ me: me.user, peer: me.peer })
    outbox.load(me.user.id)
  },

  /** Forget everything, including the persisted outbox (logout). */
  reset(): void {
    generation += 1
    syncing = false
    syncAgain = false
    outbox.clear()
    set(EMPTY)
  },

  /** GET /api/messages: replace the cache with the newest page. */
  async loadLatest(): Promise<void> {
    const gen = generation
    if (state.initial !== "ready") set({ initial: "loading" })
    try {
      const page = await apiGet(`/api/messages?limit=${PAGE_SIZE_DEFAULT}`, MessagesPage)
      if (gen !== generation) return
      // Keep WS messages newer than the page that arrived while it was in flight. The cursor stays at
      // the page's (conservative) value, so the next sync replays anything in between idempotently.
      const lastSeq = page.messages[page.messages.length - 1]?.seq ?? 0
      const newer = state.messages.filter((m) => m.seq > lastSeq)
      set({
        messages: mergeMessages(page.messages, newer, null),
        cursor: page.cursor,
        oldestSeq: page.messages[0]?.seq ?? null,
        hasMore: page.hasMore,
        initial: "ready",
        history: page.hasMore ? "idle" : "done",
      })
      for (const m of page.messages) outbox.confirm(m.id)
    } catch (err) {
      if (gen !== generation) return
      if (isLoggedOutError(err)) return loggedOut()
      if (state.initial !== "ready") set({ initial: "error" })
    }
  },

  /** Next older page (scrolling up, CHAT-02). */
  async loadOlder(): Promise<void> {
    if (state.initial !== "ready" || state.oldestSeq === null || !state.hasMore) return
    if (state.history === "loading") return
    const gen = generation
    const before = state.oldestSeq
    set({ history: "loading" })
    try {
      const page = await apiGet(`/api/messages?before=${before}&limit=${PAGE_SIZE_DEFAULT}`, MessagesPage)
      if (gen !== generation) return
      const older = page.messages.filter((m) => m.seq < before)
      set({
        messages: mergeMessages(state.messages, older, null),
        oldestSeq: older[0]?.seq ?? state.oldestSeq,
        hasMore: page.hasMore,
        history: page.hasMore ? "idle" : "done",
      })
    } catch (err) {
      if (gen !== generation) return
      if (isLoggedOutError(err)) return loggedOut()
      set({ history: "error" })
    }
  },

  /** Confirmed messages from any source (POST echo, WS msg, sync). */
  applyMessages(incoming: MessageDto[]): void {
    if (incoming.length === 0) return
    for (const m of incoming) outbox.confirm(m.id)
    const messages = mergeMessages(state.messages, incoming, state.oldestSeq)
    const cursor = Math.max(state.cursor, ...incoming.map((m) => m.updatedSeq))
    if (messages === state.messages && cursor === state.cursor) return
    set({ messages, cursor, oldestSeq: state.oldestSeq ?? messages[0]?.seq ?? null })
  },

  /** One confirmed message (WS msg frame). */
  applyMessage(dto: MessageDto): void {
    chatStore.applyMessages([dto])
  },

  /**
   * Catch up after a resume or reconnect (CHAT-05): every change since the cursor is merged in place.
   * More than SYNC_MAX changes: drop the cache and reload the newest page instead.
   */
  async syncNow(): Promise<void> {
    if (!state.me) return
    if (state.initial !== "ready") return chatStore.loadLatest()
    if (syncing) {
      syncAgain = true
      return
    }
    syncing = true
    const gen = generation
    try {
      do {
        syncAgain = false
        const res = await apiGet(`/api/sync?since=${state.cursor}`, SyncResponse)
        if (gen !== generation) return
        if (res.hasMore) {
          set({ messages: [], oldestSeq: null })
          await chatStore.loadLatest()
          return
        }
        chatStore.applyMessages(res.messages)
        if (res.cursor !== state.cursor) set({ cursor: res.cursor })
      } while (syncAgain)
    } catch (err) {
      if (gen !== generation) return
      if (isLoggedOutError(err)) loggedOut()
      // Otherwise the next hello / visible / online event syncs again.
    } finally {
      if (gen === generation) syncing = false
    }
  },

  /** Queue a text message and start sending it. */
  sendText(body: string): void {
    outbox.enqueue(body)
    void outbox.flush()
  },

  /** Send everything still queued (hello, online). */
  flushOutbox(): void {
    void outbox.flush()
  },

  /** Tap on a failed message: retry with the same client id. */
  retry(id: string): void {
    outbox.retry(id)
  },

  setConnection(connection: ConnectionState): void {
    if (state.connection !== connection) set({ connection })
  },

  /** Count incoming messages that arrived while scrolled up (scroll-to-latest badge). */
  bumpNewWhileAway(n: number): void {
    if (n > 0) set({ newWhileAway: state.newWhileAway + n })
  },

  clearNewWhileAway(): void {
    if (state.newWhileAway !== 0) set({ newWhileAway: 0 })
  },
}

/** React binding for the chat store. */
export function useChat(): ChatState {
  return useSyncExternalStore(chatStore.subscribe, chatStore.getSnapshot, chatStore.getServerSnapshot)
}
