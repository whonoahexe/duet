"use client"

import { nextOutboxState, type MessageDto, type OutboxEntryState, type OutboxOutcome } from "@duet/shared"
import { ApiError } from "@/lib/api"

/** A text message waiting for the server (CHAT-04). The id is reused for every retry (dedup key). */
export interface OutboxEntry extends OutboxEntryState {
  id: string
  body: string
  createdAt: number
}

/** localStorage key of one person's text outbox (cleared on logout). */
export function outboxKey(userId: string): string {
  return `duet.outbox.v1.${userId}`
}

const RETRY_BASE_MS = 1000
const RETRY_MAX_MS = 8000

export interface OutboxDeps {
  /** POST the entry; resolves to the stored message, rejects with ApiError or a network error. */
  send(entry: OutboxEntry): Promise<MessageDto>
  /** Browser online and the socket live: only then does a failure count toward "failed". */
  isConnected(): boolean
  onChange(entries: OutboxEntry[]): void
  onConfirmed(message: MessageDto): void
  /** A send answered 401: the session is gone. */
  onLoggedOut(): void
}

function isEntry(v: unknown): v is OutboxEntry {
  if (!v || typeof v !== "object") return false
  const e = v as Record<string, unknown>
  return (
    typeof e.id === "string" &&
    typeof e.body === "string" &&
    typeof e.createdAt === "number" &&
    typeof e.attempts === "number" &&
    (e.state === "sending" || e.state === "failed")
  )
}

function read(userId: string): OutboxEntry[] {
  try {
    const raw = localStorage.getItem(outboxKey(userId))
    if (!raw) return []
    const parsed: unknown = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed.filter(isEntry).sort((a, b) => a.createdAt - b.createdAt) : []
  } catch {
    return []
  }
}

export type Outbox = ReturnType<typeof createOutbox>

/**
 * Persisted text outbox. Entries flush one at a time in createdAt order (so they arrive in order);
 * a retryable failure stops the flush and retries later with backoff, a rejection marks just that
 * entry failed. Being offline never fails an entry (nextOutboxState).
 */
export function createOutbox(deps: OutboxDeps) {
  let userId: string | null = null
  let entries: OutboxEntry[] = []
  let flushing = false
  let again = false
  let timer: ReturnType<typeof setTimeout> | null = null

  function persist(): void {
    if (!userId) return
    try {
      if (entries.length > 0) localStorage.setItem(outboxKey(userId), JSON.stringify(entries))
      else localStorage.removeItem(outboxKey(userId))
    } catch {
      // Storage full or blocked: the entries still live in memory for this session.
    }
  }

  function commit(next: OutboxEntry[]): void {
    entries = next
    persist()
    deps.onChange(entries)
  }

  function clearTimer(): void {
    if (timer !== null) {
      clearTimeout(timer)
      timer = null
    }
  }

  function scheduleRetry(attempts: number): void {
    clearTimer()
    // Offline: the realtime manager flushes again on "online" and on every hello.
    if (!deps.isConnected()) return
    const delay = Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** Math.max(0, attempts - 1))
    timer = setTimeout(() => {
      timer = null
      void flush()
    }, delay)
  }

  async function flush(): Promise<void> {
    if (!userId) return
    if (flushing) {
      again = true
      return
    }
    flushing = true
    clearTimer()
    const owner = userId
    try {
      do {
        again = false
        const queue = entries.filter((e) => e.state === "sending").sort((a, b) => a.createdAt - b.createdAt)
        for (const entry of queue) {
          // Confirmed meanwhile (the WS echo can beat the POST response), or retried/failed elsewhere.
          if (!entries.some((e) => e.id === entry.id && e.state === "sending")) continue
          let outcome: OutboxOutcome
          try {
            const message = await deps.send(entry)
            if (userId !== owner) return
            deps.onConfirmed(message)
            confirm(entry.id)
            continue
          } catch (err) {
            if (userId !== owner) return
            if (err instanceof ApiError) {
              if (err.status === 401) {
                deps.onLoggedOut()
                return
              }
              outcome = { kind: "http", status: err.status, connected: deps.isConnected() }
            } else {
              outcome = { kind: "network", connected: deps.isConnected() }
            }
          }
          const current = entries.find((e) => e.id === entry.id)
          if (!current) continue
          const next = nextOutboxState(current, outcome)
          if (!next) continue
          commit(entries.map((e) => (e.id === entry.id ? next : e)))
          if (next.state === "sending") {
            // Keep the order: nothing after this entry goes out before it does.
            scheduleRetry(next.attempts)
            return
          }
        }
      } while (again)
    } finally {
      flushing = false
    }
  }

  function confirm(id: string): void {
    if (entries.some((e) => e.id === id)) commit(entries.filter((e) => e.id !== id))
  }

  return {
    /** Bind to a person and restore their persisted entries. */
    load(id: string): void {
      if (userId === id) return
      clearTimer()
      userId = id
      entries = read(id)
      deps.onChange(entries)
    },

    entries(): OutboxEntry[] {
      return entries
    },

    /** Queue a new text message (shown at once as "Sending…"). */
    enqueue(body: string): OutboxEntry {
      const entry: OutboxEntry = { id: crypto.randomUUID(), body, createdAt: Date.now(), attempts: 0, state: "sending" }
      commit([...entries, entry])
      return entry
    },

    /** The server echoed this id (POST response or WS msg): drop it from the outbox. */
    confirm,

    /** Tap to retry a failed message: same id, attempts reset. */
    retry(id: string): void {
      const found = entries.find((e) => e.id === id)
      if (!found || found.state !== "failed") return
      commit(entries.map((e) => (e.id === id ? { ...e, attempts: 0, state: "sending" as const } : e)))
      void flush()
    },

    flush,

    /** Logout: forget this person's entries in memory and on disk. */
    clear(): void {
      clearTimer()
      if (userId) {
        try {
          localStorage.removeItem(outboxKey(userId))
        } catch {
          // ignore
        }
      }
      userId = null
      entries = []
      deps.onChange(entries)
    },
  }
}
