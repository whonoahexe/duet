"use client"

import { useCallback, useEffect, useLayoutEffect, useRef } from "react"
import { ArrowDownIcon, ChatCircleIcon, CloudSlashIcon } from "@phosphor-icons/react"
import { messageLabel, type MessageDto, type ReactionDto, type ReplyPreview, type UserSummary } from "@duet/shared"
import type { AlbumTile } from "@/components/app/album"
import { Composer } from "@/components/app/composer"
import { MessageGroupRow, type GroupItem, type RowStatus } from "@/components/app/message-row"
import { localReplyPreview } from "@/components/app/quote-block"
import { TypingIndicator } from "@/components/app/typing-indicator"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty"
import { Marker, MarkerContent } from "@/components/ui/marker"
import {
  MessageScroller,
  MessageScrollerButton,
  MessageScrollerContent,
  MessageScrollerItem,
  MessageScrollerProvider,
  MessageScrollerViewport,
  useMessageScroller,
  useMessageScrollerScrollable,
  useMessageScrollerVisibility,
} from "@/components/ui/message-scroller"
import { Skeleton } from "@/components/ui/skeleton"
import { Spinner } from "@/components/ui/spinner"
import { OPEN_CHAT_EVENT } from "@/lib/chat/events"
import { chatStore, useChat, type ChatState } from "@/lib/chat/store"

/** Consecutive messages from one sender closer than this share one bubble group. */
const GROUP_GAP_MS = 2 * 60 * 1000
/** A same-day gap longer than this gets a time marker. */
const TIME_MARKER_GAP_MS = 15 * 60 * 1000
const DAY_MS = 24 * 60 * 60 * 1000

interface DisplayMessage {
  id: string
  /** Server order; null for an outbox entry. */
  seq: number | null
  senderId: string
  body: string | null
  createdAt: number
  /** Confirmed by the server (has a seq). */
  confirmed: boolean
  failed: boolean
  reactions: ReactionDto[]
  replyTo: ReplyPreview | null
  /** Album tiles (D-07), null for text. */
  media: AlbumTile[] | null
  /** Retry of a failed send (text outbox or album). */
  retry: (() => void) | null
}

type ListItem =
  | { kind: "day"; key: string; label: string }
  | { kind: "time"; key: string; label: string }
  | { kind: "group"; key: string; senderId: string; messages: DisplayMessage[] }

function startOfDay(ts: number): number {
  const d = new Date(ts)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

/** "Today", "Yesterday", a weekday within the last 7 days, else "Mon, 3 Oct" (+ year if not this year). */
function dayLabel(ts: number, now: number): string {
  const days = Math.round((startOfDay(now) - startOfDay(ts)) / DAY_MS)
  if (days === 0) return "Today"
  if (days === 1) return "Yesterday"
  if (days > 1 && days < 7) return new Intl.DateTimeFormat(undefined, { weekday: "long" }).format(ts)
  const sameYear = new Date(ts).getFullYear() === new Date(now).getFullYear()
  return new Intl.DateTimeFormat(undefined, {
    weekday: "short",
    day: "numeric",
    month: "short",
    ...(sameYear ? {} : { year: "numeric" }),
  }).format(ts)
}

function timeLabel(ts: number): string {
  return new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }).format(ts)
}

/** Day markers, 15-minute time markers and 2-minute sender groups, in display order. */
function buildItems(messages: DisplayMessage[], now: number): ListItem[] {
  const items: ListItem[] = []
  let prev: DisplayMessage | null = null
  let group: Extract<ListItem, { kind: "group" }> | null = null
  for (const m of messages) {
    let marker = false
    if (!prev || startOfDay(prev.createdAt) !== startOfDay(m.createdAt)) {
      items.push({ kind: "day", key: `day-${startOfDay(m.createdAt)}`, label: dayLabel(m.createdAt, now) })
      marker = true
    } else if (m.createdAt - prev.createdAt > TIME_MARKER_GAP_MS) {
      items.push({ kind: "time", key: `time-${m.id}`, label: timeLabel(m.createdAt) })
      marker = true
    }
    if (!marker && group && prev && group.senderId === m.senderId && m.createdAt - prev.createdAt < GROUP_GAP_MS) {
      group.messages.push(m)
    } else {
      group = { kind: "group", key: `group-${m.id}`, senderId: m.senderId, messages: [m] }
      items.push(group)
    }
    prev = m
  }
  return items
}

/** Top-of-list row: loading / error / beginning of the conversation (CHAT-02). */
function HistoryMarker({ chat, peerName }: { chat: ChatState; peerName: string }) {
  if (chat.history === "finding") {
    return (
      <Marker className="justify-center">
        <Spinner />
        <MarkerContent>Finding message…</MarkerContent>
      </Marker>
    )
  }
  if (chat.history === "loading") {
    return (
      <Marker className="justify-center">
        <Spinner />
        <MarkerContent>Loading older messages…</MarkerContent>
      </Marker>
    )
  }
  if (chat.history === "error") {
    return (
      <Marker
        className="cursor-pointer justify-center"
        render={<button type="button" onClick={() => void chatStore.loadOlder()} />}
      >
        <MarkerContent>Couldn&apos;t load older messages. Tap to retry.</MarkerContent>
      </Marker>
    )
  }
  if (chat.history === "done" && chat.messages.length > 0) {
    return (
      <Marker className="justify-center">
        <MarkerContent>This is the beginning of your messages with {peerName}.</MarkerContent>
      </Marker>
    )
  }
  // Idle: an empty row of the same height, so the first item never changes identity.
  return <div className="min-h-4" aria-hidden="true" />
}

/** First load: 6 placeholder bubbles, alternating sides. No spinner. */
function SkeletonList() {
  const widths = ["w-[40%]", "w-[60%]", "w-[50%]"]
  return (
    <div className="flex min-h-0 flex-1 flex-col justify-end gap-4 overflow-hidden px-4 py-8" aria-hidden="true">
      {Array.from({ length: 6 }, (_, i) => (
        <Skeleton key={i} className={`h-10 rounded-3xl ${widths[i % 3]} ${i % 2 === 0 ? "self-start" : "self-end"}`} />
      ))}
    </div>
  )
}

/**
 * Lives inside the scroller provider: counts incoming messages that arrive while scrolled up (badge
 * on the scroll-to-latest button), announces them politely, and jumps to the end on OPEN_CHAT_EVENT.
 */
function ScrollFollower({ chat, peer }: { chat: ChatState; peer: UserSummary }) {
  const { scrollToEnd } = useMessageScroller()
  const scrollable = useMessageScrollerScrollable()
  const awayRef = useRef(scrollable.end)
  awayRef.current = scrollable.end
  const lastSeenRef = useRef<number | null>(null)
  // The announcement is written straight into the live region, not kept in React state: a state update
  // from this effect on every incoming message cascaded into nested sync re-renders during a burst of
  // messages (React error #185 at ~150 messages in a row).
  const liveRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (chat.initial !== "ready") return
    const incoming = chat.messages.filter((m) => m.senderId === peer.id)
    const maxSeq = incoming.length > 0 ? incoming[incoming.length - 1].seq : 0
    if (lastSeenRef.current === null) {
      lastSeenRef.current = maxSeq
      return
    }
    const fresh: MessageDto[] = incoming.filter((m) => m.seq > (lastSeenRef.current ?? 0))
    if (fresh.length === 0) return
    lastSeenRef.current = maxSeq
    if (liveRef.current) liveRef.current.textContent = `${peer.displayName}: ${messageLabel(fresh[fresh.length - 1])}`
    if (awayRef.current) chatStore.bumpNewWhileAway(fresh.length)
  }, [chat.initial, chat.messages, peer.id, peer.displayName])

  // Back at the bottom: nothing new is unseen.
  useEffect(() => {
    if (!scrollable.end) chatStore.clearNewWhileAway()
  }, [scrollable.end])

  useEffect(() => {
    const onOpen = () => {
      chatStore.clearNewWhileAway()
      scrollToEnd({ behavior: "smooth" })
    }
    window.addEventListener(OPEN_CHAT_EVENT, onOpen)
    return () => window.removeEventListener(OPEN_CHAT_EVENT, onOpen)
  }, [scrollToEnd])

  return (
    <div ref={liveRef} className="sr-only" aria-live="polite" aria-atomic="true" />
  )
}

/** Frames spent re-centering a jumped-to bubble while content-visibility lays out the items around it. */
const JUMP_SETTLE_FRAMES = 6

/**
 * Lives inside the scroller provider: when a quote jump sets highlightSeq (D-02), bring the sender
 * group that holds the message into range with scrollToMessage (an item is a whole group, keyed by its
 * first message id), then center the bubble itself. A group can be far taller than the screen, and
 * items outside the viewport only get their real height once rendered, so the bubble is re-centered
 * for a few frames until it stays put. The jump is instant: a long smooth scroll would outlast the
 * 1.2 s highlight.
 */
function JumpFollower({
  highlightSeq,
  itemIdBySeq,
  viewportRef,
}: {
  highlightSeq: number | null
  itemIdBySeq: Map<number, string>
  viewportRef: React.RefObject<HTMLDivElement | null>
}) {
  const { scrollToMessage } = useMessageScroller()
  const mapRef = useRef(itemIdBySeq)
  useLayoutEffect(() => {
    mapRef.current = itemIdBySeq
  })

  useEffect(() => {
    if (highlightSeq === null) return
    const itemId = mapRef.current.get(highlightSeq)
    if (!itemId) return
    let raf = 0
    let frames = 0
    const settle = () => {
      const vp = viewportRef.current
      const el = vp?.querySelector<HTMLElement>(`[data-slot="bubble"][data-seq="${highlightSeq}"]`)
      if (!vp || !el) return
      const v = vp.getBoundingClientRect()
      const r = el.getBoundingClientRect()
      const offset = r.top + r.height / 2 - (v.top + v.height / 2)
      if (Math.abs(offset) > 2) vp.scrollTop += offset
      frames += 1
      if (frames < JUMP_SETTLE_FRAMES) raf = requestAnimationFrame(settle)
    }
    // Wait one frame so a just-prepended page is laid out before measuring.
    raf = requestAnimationFrame(() => {
      scrollToMessage(itemId, { align: "start", behavior: "auto" })
      raf = requestAnimationFrame(settle)
    })
    return () => cancelAnimationFrame(raf)
  }, [highlightSeq, scrollToMessage, viewportRef])

  return null
}

/** Wait this long after the visible set settles before sending a read receipt (Pitfall 14). */
const READ_DEBOUNCE_MS = 500

/**
 * Read receipts (CHAT-07, Pitfall 14, T-02-11). Only while the page is visible AND focused: among the
 * scroller's visible items, take the peer messages whose bubble is actually inside the list viewport
 * and send the highest seq, debounced 500 ms. Re-checks on focus and visibilitychange.
 */
function ReadTracker({
  peerSeqsByItemId,
  latestPeerSeq,
  viewportRef,
}: {
  peerSeqsByItemId: Map<string, { seq: number }[]>
  latestPeerSeq: number
  viewportRef: React.RefObject<HTMLDivElement | null>
}) {
  const { visibleMessageIds } = useMessageScrollerVisibility()
  const latest = useRef({ visibleMessageIds, peerSeqsByItemId })
  useLayoutEffect(() => {
    latest.current = { visibleMessageIds, peerSeqsByItemId }
  })

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null
    const check = () => {
      if (timer !== null) clearTimeout(timer)
      timer = setTimeout(() => {
        timer = null
        if (document.visibilityState !== "visible" || !document.hasFocus()) return
        const vp = viewportRef.current
        if (!vp) return
        const box = vp.getBoundingClientRect()
        let max = 0
        for (const itemId of latest.current.visibleMessageIds) {
          for (const m of latest.current.peerSeqsByItemId.get(itemId) ?? []) {
            if (m.seq <= max) continue
            // The bubble itself (the scroller item that wraps a group also carries data-message-id).
            const el = vp.querySelector<HTMLElement>(`[data-slot="bubble"][data-seq="${m.seq}"]`)
            if (!el) continue
            const r = el.getBoundingClientRect()
            if (r.height > 0 && r.bottom > box.top && r.top < box.bottom) max = m.seq
          }
        }
        if (max > 0) chatStore.markReadUpTo(max)
      }, READ_DEBOUNCE_MS)
    }
    check()
    window.addEventListener("focus", check)
    document.addEventListener("visibilitychange", check)
    return () => {
      if (timer !== null) clearTimeout(timer)
      window.removeEventListener("focus", check)
      document.removeEventListener("visibilitychange", check)
    }
  }, [visibleMessageIds, latestPeerSeq, viewportRef])

  return null
}

/** The conversation: a bottom-anchored message list (the only scroller) above the composer. */
export function ChatView({ peer }: { peer: UserSummary }) {
  const chat = useChat()
  const meId = chat.me?.id
  const viewportRef = useRef<HTMLDivElement | null>(null)
  /** Distance from the bottom, kept so a prepended page leaves the visible messages in place. */
  const fromBottomRef = useRef<number | null>(null)
  const oldestRef = useRef<number | null>(chat.oldestSeq)

  const maybeLoadOlder = useCallback(() => {
    const el = viewportRef.current
    if (!el) return
    // Within one viewport of the top: fetch the next older page.
    if (el.scrollTop < el.clientHeight) {
      const s = chatStore.getSnapshot()
      // While a quote jump is settling (D-02), a prepend would restore the old scroll position and cut
      // the jump short; the next scroll after the highlight loads the page instead.
      if (s.highlightSeq !== null) return
      if (s.hasMore && s.history === "idle") {
        fromBottomRef.current = el.scrollHeight - el.scrollTop
        void chatStore.loadOlder()
      }
    }
  }, [])

  // Older page prepended: restore the same distance from the bottom so nothing visible moves.
  useLayoutEffect(() => {
    const el = viewportRef.current
    const prev = oldestRef.current
    oldestRef.current = chat.oldestSeq
    if (!el || prev === null || chat.oldestSeq === null || chat.oldestSeq >= prev) return
    const fromBottom = fromBottomRef.current
    fromBottomRef.current = null
    if (fromBottom !== null) el.scrollTop = el.scrollHeight - fromBottom
  }, [chat.oldestSeq])

  // A short first page may not fill the viewport: keep loading until it scrolls or history ends.
  useEffect(() => {
    if (chat.initial === "ready" && chat.history === "idle") maybeLoadOlder()
  }, [chat.initial, chat.history, chat.messages.length, maybeLoadOlder])

  if (chat.initial === "loading") {
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        <SkeletonList />
        <Composer peerName={peer.displayName} />
      </div>
    )
  }

  if (chat.initial === "error") {
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        <div className="flex min-h-0 flex-1 flex-col justify-center">
          <Empty>
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <CloudSlashIcon />
              </EmptyMedia>
              <EmptyTitle>Can&apos;t reach duet</EmptyTitle>
              <EmptyDescription>Check your connection and try again.</EmptyDescription>
            </EmptyHeader>
            <EmptyContent>
              <Button onClick={() => void chatStore.loadLatest()}>Retry</Button>
            </EmptyContent>
          </Empty>
        </div>
        <Composer peerName={peer.displayName} />
      </div>
    )
  }

  /** Outbox replies are quoted from the loaded original until the server's own preview arrives. */
  function replyPreviewFor(seq: number | null): ReplyPreview | null {
    if (seq === null) return null
    const original = chat.messages.find((m) => m.seq === seq)
    return original ? localReplyPreview(original) : null
  }

  // Confirmed messages by seq, then the outbox (text and albums) by createdAt (CHAT-04).
  const pendingDisplay: DisplayMessage[] = [
    ...chat.pending.map((p) => ({
      id: p.id,
      seq: null,
      senderId: meId ?? "",
      body: p.body,
      createdAt: p.createdAt,
      confirmed: false,
      failed: p.state === "failed",
      reactions: [],
      replyTo: replyPreviewFor(p.replyToSeq ?? null),
      media: null,
      retry: () => chatStore.retry(p.id),
    })),
    ...chat.media.map((e) => ({
      id: e.id,
      seq: null,
      senderId: meId ?? "",
      body: e.caption,
      createdAt: e.createdAt,
      confirmed: false,
      failed: e.state === "failed",
      reactions: [],
      replyTo: replyPreviewFor(e.replyToSeq),
      media: e.items.map(
        (it): AlbumTile => ({
          key: it.key,
          kind: it.kind,
          status: it.state === "queued" || it.state === "uploading" ? (e.state === "failed" ? "local" : "uploading") : "local",
          attachmentId: it.attachmentId,
          localUrl: it.objectUrl,
          progress: it.progress,
          width: null,
          height: null,
          durationMs: null,
        }),
      ),
      retry: () => chatStore.retryMedia(e.id),
    })),
  ].sort((a, b) => a.createdAt - b.createdAt)
  const display: DisplayMessage[] = [
    ...chat.messages.map((m) => ({
      id: m.id,
      seq: m.seq,
      senderId: m.senderId,
      body: m.body,
      createdAt: m.createdAt,
      confirmed: true,
      failed: false,
      reactions: m.reactions,
      replyTo: m.replyTo,
      media:
        m.kind === "media"
          ? m.attachments.map(
              (a): AlbumTile => ({
                key: a.id,
                kind: a.kind,
                status: a.status === "uploading" ? "processing" : a.status,
                attachmentId: a.id,
                localUrl: chat.localPreviews[a.id] ?? null,
                progress: null,
                width: a.width,
                height: a.height,
                durationMs: a.durationMs,
              }),
            )
          : null,
      retry: null,
    })),
    ...pendingDisplay,
  ]

  // Your most recent message carries the status line (D-03): no seq -> "Sending…", seq -> "Sent".
  let latestMine: DisplayMessage | null = null
  for (let i = display.length - 1; i >= 0; i--) {
    if (display[i].senderId === meId) {
      latestMine = display[i]
      break
    }
  }
  // D-03: "Read" once the other person's cursor reached your latest message.
  const peerRead = chat.reads[peer.id]
  function toItem(m: DisplayMessage): GroupItem {
    let status: RowStatus = null
    let readAt: number | null = null
    if (m === latestMine && !m.failed) {
      if (!m.confirmed) status = "sending"
      else if (m.seq !== null && peerRead && peerRead.seq >= m.seq) {
        status = "read"
        readAt = peerRead.at
      } else status = "sent"
    }
    return {
      id: m.id,
      seq: m.seq,
      body: m.body,
      status,
      readAt,
      failed: m.failed,
      onRetry: m.failed && m.retry ? m.retry : undefined,
      reactions: m.reactions,
      replyTo: m.replyTo,
      highlighted: m.seq !== null && m.seq === chat.highlightSeq,
      media: m.media,
    }
  }

  const items = buildItems(display, Date.now())
  const itemIdBySeq = new Map<number, string>()
  const peerSeqsByItemId = new Map<string, { seq: number }[]>()
  let latestPeerSeq = 0
  for (const item of items) {
    if (item.kind !== "group") continue
    const itemId = item.messages[0].id
    for (const m of item.messages) {
      if (m.seq === null) continue
      itemIdBySeq.set(m.seq, itemId)
      if (m.senderId === peer.id) {
        const list = peerSeqsByItemId.get(itemId) ?? []
        list.push({ seq: m.seq })
        peerSeqsByItemId.set(itemId, list)
        latestPeerSeq = Math.max(latestPeerSeq, m.seq)
      }
    }
  }
  const typing = chat.typingUntil !== null

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {display.length === 0 ? (
        <div className="flex min-h-0 flex-1 flex-col justify-center">
          <Empty>
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <ChatCircleIcon />
              </EmptyMedia>
              <EmptyTitle>No messages yet</EmptyTitle>
              <EmptyDescription>
                Say hi to {peer.displayName}. Everything you send stays on your own server.
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
          {typing && (
            <div className="px-4">
              <TypingIndicator peerName={peer.displayName} />
            </div>
          )}
        </div>
      ) : (
        <MessageScrollerProvider autoScroll>
          <MessageScroller className="min-h-0 flex-1">
            <MessageScrollerViewport
              ref={viewportRef}
              aria-label={`Messages with ${peer.displayName}`}
              onScroll={maybeLoadOlder}
            >
              <MessageScrollerContent className="gap-4 px-4 py-8">
                <MessageScrollerItem key="history">
                  <HistoryMarker chat={chat} peerName={peer.displayName} />
                </MessageScrollerItem>
                {items.map((item) =>
                  item.kind === "group" ? (
                    <MessageScrollerItem key={item.key} messageId={item.messages[0].id}>
                      <MessageGroupRow
                        mine={item.senderId === meId}
                        items={item.messages.map(toItem)}
                        meId={meId ?? null}
                        peerName={peer.displayName}
                      />
                    </MessageScrollerItem>
                  ) : (
                    <MessageScrollerItem key={item.key}>
                      <Marker variant={item.kind === "day" ? "separator" : "default"} className="justify-center py-2 text-xs">
                        <MarkerContent>{item.label}</MarkerContent>
                      </Marker>
                    </MessageScrollerItem>
                  ),
                )}
                {typing && (
                  <MessageScrollerItem key="typing">
                    <TypingIndicator peerName={peer.displayName} />
                  </MessageScrollerItem>
                )}
              </MessageScrollerContent>
            </MessageScrollerViewport>
            <MessageScrollerButton
              direction="end"
              aria-label="Scroll to latest"
              onClick={() => chatStore.clearNewWhileAway()}
            >
              <ArrowDownIcon />
              <span className="sr-only">Scroll to latest</span>
              {chat.newWhileAway > 0 && (
                <Badge className="absolute -top-2 -right-2 h-5 min-w-5 px-1 tabular-nums" data-testid="new-count">
                  {chat.newWhileAway}
                </Badge>
              )}
            </MessageScrollerButton>
            <ScrollFollower chat={chat} peer={peer} />
            <JumpFollower highlightSeq={chat.highlightSeq} itemIdBySeq={itemIdBySeq} viewportRef={viewportRef} />
            <ReadTracker peerSeqsByItemId={peerSeqsByItemId} latestPeerSeq={latestPeerSeq} viewportRef={viewportRef} />
          </MessageScroller>
        </MessageScrollerProvider>
      )}
      <Composer peerName={peer.displayName} />
    </div>
  )
}
