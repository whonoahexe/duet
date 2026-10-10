"use client"

import { WarningCircleIcon } from "@phosphor-icons/react"
import { Bubble, BubbleContent } from "@/components/ui/bubble"
import { Message, MessageContent, MessageFooter } from "@/components/ui/message"
import { cn } from "@/lib/utils"

export interface RowMessage {
  id: string
  body: string | null
}

/** Status line under your most recent message (D-03). Never "Sent" without a server seq. */
export type RowStatus = "sending" | "sent" | null

/**
 * One text bubble. Yours: tinted, aligned end. Theirs: muted, aligned start. The body renders only as
 * a React text child (T-02-06: never as HTML). A failed message keeps its tinted bubble at 70%
 * opacity with a destructive "Not sent. Tap to retry." footer; tapping either retries.
 */
export function MessageRow({
  message,
  mine,
  status = null,
  failed = false,
  onRetry,
}: {
  message: RowMessage
  mine: boolean
  status?: RowStatus
  failed?: boolean
  onRetry?: () => void
}) {
  const align = mine ? "end" : "start"
  const retry = failed ? onRetry : undefined
  return (
    <Message align={align}>
      <MessageContent className="gap-1">
        <Bubble variant={mine ? "tinted" : "muted"} align={align} className={cn(failed && "opacity-70")}>
          <BubbleContent
            className="text-base leading-normal whitespace-pre-wrap"
            {...(retry
              ? {
                  role: "button",
                  tabIndex: 0,
                  onClick: retry,
                  onKeyDown: (e: React.KeyboardEvent) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault()
                      retry()
                    }
                  },
                }
              : {})}
          >
            {message.body ?? ""}
          </BubbleContent>
        </Bubble>
        {failed ? (
          <MessageFooter
            data-testid="message-status"
            className="cursor-pointer gap-1 text-destructive"
            role="button"
            tabIndex={0}
            onClick={retry}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault()
                retry?.()
              }
            }}
          >
            <WarningCircleIcon weight="fill" className="size-4 shrink-0" />
            Not sent. Tap to retry.
          </MessageFooter>
        ) : status ? (
          <MessageFooter data-testid="message-status">{status === "sending" ? "Sending…" : "Sent"}</MessageFooter>
        ) : null}
      </MessageContent>
    </Message>
  )
}
