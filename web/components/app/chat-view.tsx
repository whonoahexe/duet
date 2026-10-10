"use client"

import { useCallback, useEffect, useLayoutEffect, useRef } from "react"
import type { UserSummary } from "@duet/shared"
import { Composer } from "@/components/app/composer"
import { MessageRow, type RowStatus } from "@/components/app/message-row"
import { Marker, MarkerContent } from "@/components/ui/marker"
import {
  MessageScroller,
  MessageScrollerButton,
  MessageScrollerContent,
  MessageScrollerItem,
  MessageScrollerProvider,
  MessageScrollerViewport,
} from "@/components/ui/message-scroller"
import { Spinner } from "@/components/ui/spinner"
import { chatStore, useChat, type ChatState } from "@/lib/chat/store"

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

  // Your most recent message carries the status line (D-03): pending -> "Sending…", seq -> "Sent".
  const lastPending = chat.pending[chat.pending.length - 1]
  let lastMineConfirmed: string | null = null
  if (!lastPending) {
    for (let i = chat.messages.length - 1; i >= 0; i--) {
      if (chat.messages[i].senderId === meId) {
        lastMineConfirmed = chat.messages[i].id
        break
      }
    }
  }
  function statusFor(id: string, confirmed: boolean): RowStatus {
    if (confirmed) return id === lastMineConfirmed ? "sent" : null
    return lastPending && id === lastPending.id ? "sending" : null
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
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
              {chat.messages.map((m) => {
                const mine = m.senderId === meId
                return (
                  <MessageScrollerItem key={m.id} messageId={m.id}>
                    <MessageRow message={m} mine={mine} status={mine ? statusFor(m.id, true) : null} />
                  </MessageScrollerItem>
                )
              })}
              {chat.pending.map((p) => (
                <MessageScrollerItem key={p.id} messageId={p.id}>
                  <MessageRow
                    message={p}
                    mine
                    failed={p.state === "failed"}
                    status={p.state === "failed" ? null : statusFor(p.id, false)}
                    onRetry={() => chatStore.retry(p.id)}
                  />
                </MessageScrollerItem>
              ))}
            </MessageScrollerContent>
          </MessageScrollerViewport>
          <MessageScrollerButton direction="end" aria-label="Scroll to latest" />
        </MessageScroller>
      </MessageScrollerProvider>
      <Composer peerName={peer.displayName} />
    </div>
  )
}
