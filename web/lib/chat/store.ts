"use client"

import { useSyncExternalStore } from "react"
import { toast } from "sonner"
import {
  MessagesPage,
  PAGE_SIZE_DEFAULT,
  PAGE_SIZE_MAX,
  ReadResponse,
  SendMessageResponse,
  SyncResponse,
  leadLabel,
  mergeMessages,
  reminderWho,
  type AttachmentKind,
  type MeResponse,
  MeResponse as MeResponseSchema,
  type MessageDto,
  type Profile,
  type ReadCursor,
  type Reaction,
} from "@duet/shared"
import { ApiError, apiGet, apiPost, apiPut } from "@/lib/api"
import { chatSoundsAllowed, playReceivedChime, playSound } from "@/lib/sounds"
import { createOutbox, type OutboxEntry } from "./outbox"
import { uploadFile } from "./upload"

export type { OutboxEntry } from "./outbox"

export type ConnectionState = "connecting" | "live" | "offline"

/** One picked file of an album being sent (kept in memory only, research A3). */
export interface MediaItem {
  key: string
  file: File
  kind: AttachmentKind
  /** Local preview shown until the server's thumbnail exists (a voice note's own recording). */
  objectUrl: string
  /** Set once the upload completed (a retry skips this item). */
  attachmentId: string | null
  /** Upload progress in whole percents. */
  progress: number
  state: "queued" | "uploading" | "done" | "failed"
}

/**
 * An album on its way (D-06/D-07): uploads in pick order, then one POST /api/messages. A voice note
 * (D-10, MDIA-04) is the same kind of entry with one audio item and `voice` set.
 */
export interface MediaEntry {
  /** Client message UUID, reused by every retry (CHAT-04). */
  id: string
  createdAt: number
  /** Optional caption (never blank). */
  caption: string | null
  replyToSeq: number | null
  items: MediaItem[]
  state: "sending" | "failed"
  /** Set for a voice note: its length as recorded (shown until the server's own duration arrives). */
  voice: { durationMs: number } | null
}

export interface ChatState {
  /** You and your person, with the shared profile photo ids (QT-5zd-photo-live). */
  me: Profile | null
  peer: Profile | null
  /** Confirmed messages, ascending by seq. */
  messages: MessageDto[]
  /** Unconfirmed text sends (the outbox), rendered after `messages` in createdAt order. */
  pending: OutboxEntry[]
  /** Albums being uploaded or sent (in memory only), rendered with the outbox. */
  media: MediaEntry[]
  /** Local object URLs of your own uploads by attachment id, shown until the server copy is ready. */
  localPreviews: Record<string, string>
  /** Change cursor for /api/sync (max updatedSeq seen). */
  cursor: number
  /** Lowest loaded seq (null before the first message). Changes to older messages are ignored. */
  oldestSeq: number | null
  /** Older messages exist on the server. */
  hasMore: boolean
  initial: "loading" | "ready" | "error"
  /** "finding" = paging back to a quoted message that is not loaded yet (D-02). */
  history: "idle" | "loading" | "error" | "done" | "finding"
  connection: ConnectionState
  /** Incoming messages that arrived while the list was scrolled away from the bottom. */
  newWhileAway: number
  /** The message the composer is replying to (D-01, D-02), or null. */
  replyTarget: number | null
  /** The message just jumped to from a quote; it is highlighted for JUMP_HIGHLIGHT_MS. */
  highlightSeq: number | null
  /** Read cursors by user id (CHAT-07): the highest seq each person has seen, and when. */
  reads: Record<string, { seq: number; at: number | null }>
  /** The other person is typing until this time (epoch ms); null when not typing (CHAT-06). */
  typingUntil: number | null
}

/** A peer typing frame keeps the indicator up this long (frames arrive at most every 3 s). */
export const TYPING_TTL_MS = 5000

/** How long a message jumped to from a quote keeps its accent ring (UI-SPEC accent item 6). */
export const JUMP_HIGHLIGHT_MS = 1200

const EMPTY: ChatState = {
  me: null,
  peer: null,
  messages: [],
  pending: [],
  media: [],
  localPreviews: {},
  cursor: 0,
  oldestSeq: null,
  hasMore: false,
  initial: "loading",
  history: "idle",
  connection: "connecting",
  newWhileAway: 0,
  replyTarget: null,
  highlightSeq: null,
  reads: {},
  typingUntil: null,
}

let state: ChatState = EMPTY
const listeners = new Set<() => void>()
/** Bumped by reset(): responses that belong to an older session are dropped. */
let generation = 0
let onLoggedOut: () => void = () => {}
let syncing = false
let syncAgain = false
let highlightTimer: ReturnType<typeof setTimeout> | null = null
let typingTimer: ReturnType<typeof setTimeout> | null = null
/** Highest seq already sent to POST /api/read in this session (avoids repeating a receipt). */
let lastReadSent = 0
/** Media entries whose upload/send loop is running (one loop per entry). */
const mediaRunning = new Set<string>()
/** A local preview is kept this long after the server copy became ready (the thumb is loading). */
const PREVIEW_REVOKE_DELAY_MS = 60_000

function patchMedia(id: string, fn: (e: MediaEntry) => MediaEntry): void {
  set({ media: state.media.map((e) => (e.id === id ? fn(e) : e)) })
}

function patchMediaItem(id: string, key: string, patch: Partial<MediaItem>): void {
  patchMedia(id, (e) => ({ ...e, items: e.items.map((it) => (it.key === key ? { ...it, ...patch } : it)) }))
}

/** Drop local previews of attachments the server now has ready (revoked a little later). */
function retireLocalPreviews(incoming: MessageDto[]): void {
  let next: Record<string, string> | null = null
  for (const m of incoming) {
    for (const a of m.attachments) {
      const url = state.localPreviews[a.id]
      if (!url || a.status !== "ready") continue
      next ??= { ...state.localPreviews }
      delete next[a.id]
      setTimeout(() => URL.revokeObjectURL(url), PREVIEW_REVOKE_DELAY_MS)
    }
  }
  if (next) set({ localPreviews: next })
}

/**
 * Upload every item of an album that has no attachment yet, in pick order, then send the message
 * with attachmentIds in that order (MDIA-05 ordering). Any failure marks the entry failed ("Not sent.
 * Tap to retry."); a retry re-uploads only the failed items and reuses the message id.
 */
async function runMedia(id: string): Promise<void> {
  if (mediaRunning.has(id)) return
  mediaRunning.add(id)
  const gen = generation
  try {
    const entry = state.media.find((e) => e.id === id)
    if (!entry) return
    for (const item of entry.items) {
      if (item.attachmentId) continue
      patchMediaItem(id, item.key, { state: "uploading", progress: 0 })
      const attachment = await uploadFile(item.file, item.kind, (progress) => {
        if (gen === generation) patchMediaItem(id, item.key, { progress })
      })
      if (gen !== generation) return
      patchMediaItem(id, item.key, { attachmentId: attachment.id, state: "done", progress: 100 })
      set({ localPreviews: { ...state.localPreviews, [attachment.id]: item.objectUrl } })
    }
    const ready = state.media.find((e) => e.id === id)
    if (!ready) return
    const res = await apiPost(
      "/api/messages",
      {
        id: ready.id,
        ...(ready.caption ? { body: ready.caption } : {}),
        ...(ready.replyToSeq ? { replyToSeq: ready.replyToSeq } : {}),
        attachmentIds: ready.items.map((it) => it.attachmentId),
      },
      SendMessageResponse,
    )
    if (gen !== generation) return
    set({ media: state.media.filter((e) => e.id !== id) })
    chatStore.applyMessages([res.message])
  } catch (err) {
    if (gen !== generation) return
    if (isLoggedOutError(err)) return loggedOut()
    patchMedia(id, (e) => ({
      ...e,
      state: "failed",
      items: e.items.map((it) => (it.attachmentId ? it : { ...it, state: "failed" })),
    }))
  } finally {
    mediaRunning.delete(id)
  }
}

/** Photo or video, from the picked file's type (the picker only offers those). */
function kindOf(file: File): AttachmentKind {
  return file.type.startsWith("video/") ? "video" : "image"
}

/** Merge read cursors, never moving one backwards. Returns the same object when nothing moved. */
function mergeReads(current: ChatState["reads"], incoming: ReadCursor[]): ChatState["reads"] {
  let next = current
  for (const r of incoming) {
    const have = next[r.userId]
    if (have && have.seq >= r.seq) continue
    if (next === current) next = { ...current }
    next[r.userId] = { seq: r.seq, at: r.at }
  }
  return next
}

function clearTyping(): void {
  if (typingTimer !== null) clearTimeout(typingTimer)
  typingTimer = null
  if (state.typingUntil !== null) set({ typingUntil: null })
}

function set(patch: Partial<ChatState>): void {
  state = { ...state, ...patch }
  for (const l of listeners) l()
}

function loggedOut(): void {
  onLoggedOut()
}

const outbox = createOutbox({
  send: async (entry) =>
    (
      await apiPost(
        "/api/messages",
        { id: entry.id, body: entry.body, ...(entry.replyToSeq ? { replyToSeq: entry.replyToSeq } : {}) },
        SendMessageResponse,
      )
    ).message,
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
    if (highlightTimer !== null) clearTimeout(highlightTimer)
    highlightTimer = null
    if (typingTimer !== null) clearTimeout(typingTimer)
    typingTimer = null
    lastReadSent = 0
    outbox.clear()
    for (const e of state.media) for (const it of e.items) URL.revokeObjectURL(it.objectUrl)
    for (const url of Object.values(state.localPreviews)) URL.revokeObjectURL(url)
    mediaRunning.clear()
    set(EMPTY)
  },

  /**
   * A person's shared profile photo changed (QT-5zd-photo-live): the WS profile frame, the drawer's own
   * PUT response, or a refetch. Replaces me/peer with a new object only when the id really changed,
   * so useMe()/usePeer() consumers re-render only then.
   */
  applyProfile(userId: string, photoId: string | null): void {
    if (state.me?.id === userId && state.me.photoId !== photoId) set({ me: { ...state.me, photoId } })
    else if (state.peer?.id === userId && state.peer.photoId !== photoId) set({ peer: { ...state.peer, photoId } })
  },

  /**
   * GET /api/me on every hello: a photo changed while the socket was down is not replayed by
   * /api/sync. Errors are ignored (the next hello tries again).
   */
  async refreshProfiles(): Promise<void> {
    if (!state.me) return
    const gen = generation
    try {
      const me = await apiGet("/api/me", MeResponseSchema)
      if (gen !== generation) return
      chatStore.applyProfile(me.user.id, me.user.photoId)
      if (me.peer) chatStore.applyProfile(me.peer.id, me.peer.photoId)
    } catch {
      // Best effort.
    }
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
        reads: mergeReads(state.reads, page.reads),
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
        reads: mergeReads(state.reads, page.reads),
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
    // Their message arrived: they are no longer typing it (CHAT-06).
    const peerId = state.peer?.id
    if (state.typingUntil !== null && peerId && incoming.some((m) => m.senderId === peerId)) {
      const known = new Set(state.messages.map((m) => m.seq))
      if (incoming.some((m) => m.senderId === peerId && !known.has(m.seq))) clearTyping()
    }
    retireLocalPreviews(incoming)
    const messages = mergeMessages(state.messages, incoming, state.oldestSeq)
    const cursor = Math.max(state.cursor, ...incoming.map((m) => m.updatedSeq))
    if (messages === state.messages && cursor === state.cursor) return
    set({ messages, cursor, oldestSeq: state.oldestSeq ?? messages[0]?.seq ?? null })
  },

  /**
   * QT-nw9-reminder-inapp: a reminder that just fired for you while duet is on screen. The server
   * skips the push exactly when you are viewing, so this toast stands in for it. Called for live WS
   * frames only, before applyMessage, so history and sync never toast and a repeat frame (already
   * loaded) does not either.
   */
  announceReminder(dto: MessageDto): void {
    if (dto.kind !== "reminder" || !dto.reminder) return
    if (state.messages.some((m) => m.seq === dto.seq)) return
    const me = state.me
    if (!me) return
    if (dto.reminder.forUserId !== null && dto.reminder.forUserId !== me.id) return
    if (typeof document === "undefined" || document.visibilityState !== "visible") return
    const names: Record<string, string> = { [me.id]: me.displayName }
    if (state.peer) names[state.peer.id] = state.peer.displayName
    const who = reminderWho(dto.senderId, dto.reminder.forUserId, me.id, names)
    const lead = dto.reminder.leadMinutes
    toast(`⏰ ${dto.body ?? ""}${lead !== null ? ` · in ${leadLabel(lead)}` : ""}`, {
      description: who.charAt(0).toUpperCase() + who.slice(1),
    })
    playSound("reminder")
  },

  /**
   * QT-4gf-chat-sounds: the sound for one live WS msg frame. Called for live frames only and before
   * applyMessage, so /api/sync catch-up and history never sound, and a message that is already loaded
   * (an update) is told apart from a new one. Your own messages, from any device, never sound.
   */
  announceSounds(dto: MessageDto): void {
    const me = state.me
    const peerId = state.peer?.id
    if (!me || !peerId) return
    // A loaded message is never a new one. The peer usually reacts to MY messages, so this runs
    // whoever sent it; your own reaction echoing back changes only your entry and never double-ticks.
    const known = state.messages.find((m) => m.seq === dto.seq)
    if (known) {
      const prev = known.reactions.find((r) => r.userId === peerId)?.emoji ?? null
      const next = dto.reactions.find((r) => r.userId === peerId)?.emoji ?? null
      if (next !== null && next !== prev && chatSoundsAllowed()) playSound("reaction")
      return
    }
    let newest = 0
    for (const m of state.messages) if (m.seq > newest) newest = m.seq
    // An update (reactions, an older message) never chimes, so a reaction on an old, unloaded
    // message cannot ring either.
    if (dto.senderId === peerId && dto.seq > newest && dto.kind !== "call" && dto.kind !== "reminder") {
      playReceivedChime()
    }
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
        const reads = mergeReads(state.reads, res.reads)
        if (reads !== state.reads) set({ reads })
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

  /** Queue a text message (optionally a reply) and start sending it. */
  sendText(body: string, replyToSeq: number | null = null): void {
    outbox.enqueue(body, replyToSeq)
    playSound("sent")
    void outbox.flush()
  },

  /**
   * Send picked photos/videos as one album with an optional caption (D-06, D-07). The bubble shows at
   * once from local object URLs; items upload in order, then the message is sent.
   */
  sendMedia(files: File[], caption: string, replyToSeq: number | null = null): void {
    if (files.length === 0) return
    playSound("sent")
    const createdAt = Date.now()
    const entry: MediaEntry = {
      id: crypto.randomUUID(),
      createdAt,
      caption: caption.trim().length > 0 ? caption : null,
      replyToSeq,
      state: "sending",
      voice: null,
      items: files.map((file, i) => ({
        key: `${createdAt}-${i}`,
        file,
        kind: kindOf(file),
        objectUrl: URL.createObjectURL(file),
        attachmentId: null,
        progress: 0,
        state: "queued",
      })),
    }
    set({ media: [...state.media, entry] })
    void runMedia(entry.id)
  },

  /**
   * Send a recorded voice note (D-10, MDIA-04): it shows at once as a voice bubble with flat
   * placeholder bars, uploads as kind audio, then POST /api/messages { id, attachmentIds: [id] }.
   * A failure is the same "Not sent. Tap to retry." path as an album (retryMedia).
   */
  sendVoice(blob: Blob, durationMs: number, replyToSeq: number | null = null): void {
    if (blob.size === 0) return
    playSound("sent")
    const createdAt = Date.now()
    const ext = blob.type.includes("webm") ? "webm" : blob.type.includes("ogg") ? "ogg" : "m4a"
    const file = new File([blob], `voice-${createdAt}.${ext}`, { type: blob.type || "audio/mp4" })
    const entry: MediaEntry = {
      id: crypto.randomUUID(),
      createdAt,
      caption: null,
      replyToSeq,
      state: "sending",
      voice: { durationMs },
      items: [
        {
          key: `${createdAt}-0`,
          file,
          kind: "audio",
          objectUrl: URL.createObjectURL(file),
          attachmentId: null,
          progress: 0,
          state: "queued",
        },
      ],
    }
    set({ media: [...state.media, entry] })
    void runMedia(entry.id)
  },

  /** Tap on a failed album: upload only what is missing, then send with the same message id. */
  retryMedia(id: string): void {
    const entry = state.media.find((e) => e.id === id)
    if (!entry || entry.state !== "failed") return
    patchMedia(id, (e) => ({
      ...e,
      state: "sending",
      items: e.items.map((it) => (it.state === "failed" ? { ...it, state: "queued", progress: 0 } : it)),
    }))
    void runMedia(id)
  },

  /** Start (seq) or cancel (null) replying to a message; the composer shows the reply chip. */
  setReplyTarget(seq: number | null): void {
    if (state.replyTarget !== seq) set({ replyTarget: seq })
  },

  /**
   * Jump to a quoted message (D-02): when it is older than the loaded window, page back in steps of
   * PAGE_SIZE_MAX (history "finding") until it is loaded or history ends, then highlight it for
   * JUMP_HIGHLIGHT_MS. The list scrolls to highlightSeq.
   */
  async jumpTo(seq: number): Promise<void> {
    if (state.initial !== "ready") return
    const gen = generation
    if (state.oldestSeq !== null && seq < state.oldestSeq && state.hasMore) {
      if (state.history === "loading" || state.history === "finding") return
      set({ history: "finding" })
      try {
        while (state.oldestSeq !== null && seq < state.oldestSeq && state.hasMore) {
          const before = state.oldestSeq
          const page = await apiGet(`/api/messages?before=${before}&limit=${PAGE_SIZE_MAX}`, MessagesPage)
          if (gen !== generation) return
          const older = page.messages.filter((m) => m.seq < before)
          set({
            messages: mergeMessages(state.messages, older, null),
            reads: mergeReads(state.reads, page.reads),
            oldestSeq: older[0]?.seq ?? state.oldestSeq,
            hasMore: page.hasMore && older.length > 0,
          })
        }
        set({ history: state.hasMore ? "idle" : "done" })
      } catch (err) {
        if (gen !== generation) return
        if (isLoggedOutError(err)) return loggedOut()
        set({ history: "error" })
        return
      }
    }
    if (!state.messages.some((m) => m.seq === seq)) return
    if (highlightTimer !== null) clearTimeout(highlightTimer)
    set({ highlightSeq: seq })
    highlightTimer = setTimeout(() => {
      highlightTimer = null
      if (gen === generation && state.highlightSeq === seq) set({ highlightSeq: null })
    }, JUMP_HIGHLIGHT_MS)
  },

  /** Send everything still queued (hello, online). */
  flushOutbox(): void {
    void outbox.flush()
  },

  /** Tap on a failed message: retry with the same client id. */
  retry(id: string): void {
    outbox.retry(id)
  },

  /**
   * Set, replace (another emoji) or remove (null) your reaction on a message (D-04). The returned
   * message is merged at once; the other phone gets it through the WS msg frame.
   */
  async react(seq: number, emoji: Reaction | null): Promise<void> {
    // Inside the tap, before the await; removing a reaction is silent.
    if (emoji !== null) playSound("reaction")
    const gen = generation
    try {
      const res = await apiPut(`/api/messages/${seq}/reaction`, { emoji }, SendMessageResponse)
      if (gen !== generation) return
      chatStore.applyMessages([res.message])
    } catch (err) {
      if (gen !== generation) return
      if (isLoggedOutError(err)) return loggedOut()
      toast.error("Couldn't react. Try again.")
    }
  },

  /** A typing frame from the other person: show the indicator for TYPING_TTL_MS more. */
  peerTyping(userId: string): void {
    if (!state.peer || userId !== state.peer.id) return
    if (typingTimer !== null) clearTimeout(typingTimer)
    const until = Date.now() + TYPING_TTL_MS
    set({ typingUntil: until })
    typingTimer = setTimeout(() => {
      typingTimer = null
      if (state.typingUntil === until) set({ typingUntil: null })
    }, TYPING_TTL_MS)
  },

  /** A read frame: someone's cursor moved forward (never backwards). */
  applyRead(read: ReadCursor): void {
    const reads = mergeReads(state.reads, [read])
    if (reads !== state.reads) set({ reads })
  },

  /**
   * Send a read receipt up to seq (CHAT-07). The caller guarantees the message was on a visible,
   * focused screen (Pitfall 14). Repeats and seqs at or below your cursor are skipped.
   */
  markReadUpTo(seq: number): void {
    const me = state.me
    if (!me) return
    if (seq <= Math.max(lastReadSent, state.reads[me.id]?.seq ?? 0)) return
    lastReadSent = seq
    const gen = generation
    apiPost("/api/read", { seq }, ReadResponse).catch((err) => {
      if (gen !== generation) return
      if (isLoggedOutError(err)) return loggedOut()
      // Let the next visible check send it again.
      if (lastReadSent === seq) lastReadSent = 0
    })
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

const getMe = () => state.me
const getPeer = () => state.peer
const getNull = () => null

/** You, with your photo id. Re-renders only on init, logout or a profile change (not on messages). */
export function useMe(): Profile | null {
  return useSyncExternalStore(chatStore.subscribe, getMe, getNull)
}

/** Your person, with their photo id. Re-renders only on init, logout or a profile change. */
export function usePeer(): Profile | null {
  return useSyncExternalStore(chatStore.subscribe, getPeer, getNull)
}
