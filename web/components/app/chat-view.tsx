"use client"

import type { UserSummary } from "@duet/shared"
import { Composer } from "@/components/app/composer"
import { MessageRow } from "@/components/app/message-row"
import {
  MessageScroller,
  MessageScrollerButton,
  MessageScrollerContent,
  MessageScrollerItem,
  MessageScrollerProvider,
  MessageScrollerViewport,
} from "@/components/ui/message-scroller"
import { useChat } from "@/lib/chat/store"

/** The conversation: a bottom-anchored message list (the only scroller) above the composer. */
export function ChatView({ peer }: { peer: UserSummary }) {
  const chat = useChat()
  const meId = chat.me?.id

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <MessageScrollerProvider autoScroll>
        <MessageScroller className="min-h-0 flex-1">
          <MessageScrollerViewport aria-label={`Messages with ${peer.displayName}`}>
            <MessageScrollerContent className="gap-4 px-4 py-8">
              {chat.messages.map((m) => (
                <MessageScrollerItem key={m.id} messageId={m.id}>
                  <MessageRow message={m} mine={m.senderId === meId} />
                </MessageScrollerItem>
              ))}
              {chat.pending.map((p) => (
                <MessageScrollerItem key={p.id} messageId={p.id}>
                  <MessageRow message={p} mine />
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
