"use client"

import { Fragment } from "react"
import { WarningCircleIcon } from "@phosphor-icons/react"
import { Bubble, BubbleContent, BubbleGroup } from "@/components/ui/bubble"
import { Message, MessageContent, MessageFooter } from "@/components/ui/message"
import { cn } from "@/lib/utils"

/** Status line under your most recent message (D-03). Never "Sent" without a server seq. */
export type RowStatus = "sending" | "sent" | null

export interface GroupItem {
  id: string
  body: string | null
  status: RowStatus
  failed: boolean
  onRetry?: () => void
}

function onActivate(fn: () => void) {
  return (e: React.KeyboardEvent) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault()
      fn()
    }
  }
}

/**
 * One text bubble plus its footer. Yours: tinted. Theirs: muted. The body renders only as a React
 * text child (T-02-06: never as HTML) and wraps long words and URLs. A failed message keeps its
 * tinted bubble at 70% opacity with a destructive "Not sent. Tap to retry." footer; tapping either
 * retries. Bubbles block text selection and the iOS callout (plan 02-02 adds gestures to them).
 */
function MessageBubble({ item, mine }: { item: GroupItem; mine: boolean }) {
  const align = mine ? "end" : "start"
  const retry = item.failed ? item.onRetry : undefined
  return (
    <>
      <Bubble
        data-message-id={item.id}
        variant={mine ? "tinted" : "muted"}
        align={align}
        className={cn("select-none [-webkit-touch-callout:none]", item.failed && "opacity-70")}
      >
        <BubbleContent
          className="text-base leading-normal whitespace-pre-wrap wrap-anywhere"
          {...(retry ? { role: "button", tabIndex: 0, onClick: retry, onKeyDown: onActivate(retry) } : {})}
        >
          {item.body ?? ""}
        </BubbleContent>
      </Bubble>
      {item.failed ? (
        <MessageFooter
          data-testid="message-status"
          className="cursor-pointer gap-1 text-destructive"
          role="button"
          tabIndex={0}
          onClick={retry}
          onKeyDown={retry ? onActivate(retry) : undefined}
        >
          <WarningCircleIcon weight="fill" className="size-4 shrink-0" />
          Not sent. Tap to retry.
        </MessageFooter>
      ) : item.status ? (
        <MessageFooter data-testid="message-status">{item.status === "sending" ? "Sending…" : "Sent"}</MessageFooter>
      ) : null}
    </>
  )
}

/**
 * Consecutive messages from one sender less than 2 minutes apart: one Message with a BubbleGroup
 * (4px between bubbles). No per-bubble time: day and time markers sit between groups.
 */
export function MessageGroupRow({ mine, items }: { mine: boolean; items: GroupItem[] }) {
  return (
    <Message align={mine ? "end" : "start"}>
      <MessageContent>
        <BubbleGroup className="w-full gap-1">
          {items.map((item) => (
            <Fragment key={item.id}>
              <MessageBubble item={item} mine={mine} />
            </Fragment>
          ))}
        </BubbleGroup>
      </MessageContent>
    </Message>
  )
}
