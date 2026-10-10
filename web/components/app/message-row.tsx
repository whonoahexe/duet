"use client"

import { Bubble, BubbleContent } from "@/components/ui/bubble"
import { Message, MessageContent } from "@/components/ui/message"

export interface RowMessage {
  id: string
  body: string | null
}

/**
 * One text bubble. Yours: tinted, aligned end. Theirs: muted, aligned start. The body renders only as
 * a React text child (T-02-06: never as HTML).
 */
export function MessageRow({ message, mine }: { message: RowMessage; mine: boolean }) {
  const align = mine ? "end" : "start"
  return (
    <Message align={align}>
      <MessageContent>
        <Bubble variant={mine ? "tinted" : "muted"} align={align}>
          <BubbleContent className="text-base leading-normal whitespace-pre-wrap">{message.body ?? ""}</BubbleContent>
        </Bubble>
      </MessageContent>
    </Message>
  )
}
