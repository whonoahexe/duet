"use client"

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react"
import { ArrowDownIcon, ChatCircleIcon, CloudSlashIcon } from "@phosphor-icons/react"
import { messageLabel, type MessageDto, type UserSummary } from "@duet/shared"
import { Composer } from "@/components/app/composer"
import { MessageGroupRow, type GroupItem, type RowStatus } from "@/components/app/message-row"
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
  senderId: string
  body: string | null
  createdAt: number
  /** Confirmed by the server (has a seq). */
  confirmed: boolean
  failed: boolean
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
  const [announcement, setAnnouncement] = useState("")

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
    setAnnouncement(`${peer.displayName}: ${messageLabel(fresh[fresh.length - 1])}`)
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
    <div className="sr-only" aria-live="polite" aria-atomic="true">
      {announcement}
    </div>
  )
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

  // Confirmed messages by seq, then the outbox by createdAt (CHAT-04).
  const display: DisplayMessage[] = [
    ...chat.messages.map((m) => ({
      id: m.id,
      senderId: m.senderId,
      body: m.body,
      createdAt: m.createdAt,
      confirmed: true,
      failed: false,
    })),
    ...chat.pending.map((p) => ({
      id: p.id,
      senderId: meId ?? "",
      body: p.body,
      createdAt: p.createdAt,
      confirmed: false,
      failed: p.state === "failed",
    })),
  ]

  // Your most recent message carries the status line (D-03): no seq -> "Sending…", seq -> "Sent".
  let latestMine: DisplayMessage | null = null
  for (let i = display.length - 1; i >= 0; i--) {
    if (display[i].senderId === meId) {
      latestMine = display[i]
      break
    }
  }
  function toItem(m: DisplayMessage): GroupItem {
    let status: RowStatus = null
    if (m === latestMine && !m.failed) status = m.confirmed ? "sent" : "sending"
    return {
      id: m.id,
      body: m.body,
      status,
      failed: m.failed,
      onRetry: m.failed ? () => chatStore.retry(m.id) : undefined,
    }
  }

  const items = buildItems(display, Date.now())

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
                      <MessageGroupRow mine={item.senderId === meId} items={item.messages.map(toItem)} />
                    </MessageScrollerItem>
                  ) : (
                    <MessageScrollerItem key={item.key}>
                      <Marker variant={item.kind === "day" ? "separator" : "default"} className="justify-center py-2 text-xs">
                        <MarkerContent>{item.label}</MarkerContent>
                      </Marker>
                    </MessageScrollerItem>
                  ),
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
          </MessageScroller>
        </MessageScrollerProvider>
      )}
      <Composer peerName={peer.displayName} />
    </div>
  )
}
