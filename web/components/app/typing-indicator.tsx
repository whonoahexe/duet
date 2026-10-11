"use client"

import { Bubble, BubbleContent } from "@/components/ui/bubble"
import { Message, MessageContent } from "@/components/ui/message"

/**
 * The other person is typing (CHAT-06, UI-SPEC "Typing indicator"): a muted bubble on their side with
 * three 8px dots and a staggered opacity pulse (static under prefers-reduced-motion).
 */
export function TypingIndicator({ peerName }: { peerName: string }) {
  return (
    <Message align="start">
      <MessageContent>
        <Bubble variant="muted" align="start">
          <BubbleContent role="status" aria-label={`${peerName} is typing`} className="flex items-center gap-1 py-4">
            {[0, 1, 2].map((i) => (
              <span
                key={i}
                aria-hidden="true"
                className="size-2 animate-pulse rounded-full bg-muted-foreground motion-reduce:animate-none"
                style={{ animationDelay: `${i * 200}ms` }}
              />
            ))}
          </BubbleContent>
        </Bubble>
      </MessageContent>
    </Message>
  )
}
