"use client"

import { Fragment, useState } from "react"
import { WarningCircleIcon } from "@phosphor-icons/react"
import { reactionSummary, type ReactionDto } from "@duet/shared"
import { MessageActions } from "@/components/app/message-actions"
import { Bubble, BubbleContent, BubbleGroup, BubbleReactions } from "@/components/ui/bubble"
import { Message, MessageContent, MessageFooter } from "@/components/ui/message"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { chatStore } from "@/lib/chat/store"
import { useLongPress } from "@/lib/chat/gestures"
import { cn } from "@/lib/utils"

/** Status line under your most recent message (D-03). Never "Sent" without a server seq. */
export type RowStatus = "sending" | "sent" | null

export interface GroupItem {
  id: string
  /** Server order; null while the message is still in the outbox (no menu, no reactions yet). */
  seq: number | null
  body: string | null
  status: RowStatus
  failed: boolean
  onRetry?: () => void
  reactions: ReactionDto[]
}

function onActivate(fn: () => void) {
  return (e: React.KeyboardEvent) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault()
      fn()
    }
  }
}

const BUBBLE_CLASS = "select-none [-webkit-touch-callout:none]"
/** The focusable bubble shows the preset focus ring on its visible surface (keyboard path to the menu). */
const FOCUS_CLASS =
  "outline-none focus-visible:*:data-[slot=bubble-content]:ring-3 focus-visible:*:data-[slot=bubble-content]:ring-ring/30"
const CONTENT_CLASS = "text-base leading-normal whitespace-pre-wrap wrap-anywhere"

/** Footer under a bubble: the failed row (every failed message) or the status line (latest only). */
function StatusFooter({ item }: { item: GroupItem }) {
  const retry = item.failed ? item.onRetry : undefined
  if (item.failed) {
    return (
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
    )
  }
  if (!item.status) return null
  return <MessageFooter data-testid="message-status">{item.status === "sending" ? "Sending…" : "Sent"}</MessageFooter>
}

/**
 * A message still in the outbox. A failed one keeps its tinted bubble at 70% opacity; tapping the
 * bubble or its footer retries with the same client id. No menu until the server has stored it.
 */
function PendingBubble({ item }: { item: GroupItem }) {
  const retry = item.failed ? item.onRetry : undefined
  return (
    <>
      <Bubble data-message-id={item.id} variant="tinted" align="end" className={cn(BUBBLE_CLASS, item.failed && "opacity-70")}>
        <BubbleContent
          className={CONTENT_CLASS}
          {...(retry ? { role: "button", tabIndex: 0, onClick: retry, onKeyDown: onActivate(retry) } : {})}
        >
          {item.body ?? ""}
        </BubbleContent>
      </Bubble>
      <StatusFooter item={item} />
    </>
  )
}

/**
 * A stored message. The bubble is the trigger of its own controlled popover (Pitfall 12): long-press,
 * right-click or Enter opens it; a plain tap never does ('trigger-press' is ignored). The reaction
 * chip sits on the inner bottom corner and opens the same menu. The body renders only as a React text
 * child (T-02-06).
 */
function StoredBubble({ item, mine, seq, meId }: { item: GroupItem; mine: boolean; seq: number; meId: string | null }) {
  const [open, setOpen] = useState(false)
  const longPress = useLongPress({ onOpen: () => setOpen(true) })
  const summary = reactionSummary(item.reactions, meId)
  const myReaction = item.reactions.find((r) => r.userId === meId)?.emoji ?? null
  const align = mine ? "end" : "start"

  return (
    <>
      <Popover
        open={open}
        onOpenChange={(next, details) => {
          if (details.reason === "trigger-press") return
          setOpen(next)
        }}
      >
        <PopoverTrigger
          // The wrapper sets data-slot="popover-trigger"; keep the bubble's own slot for styling and tests.
          data-slot="bubble"
          nativeButton={false}
          tabIndex={0}
          render={
            <Bubble
              data-message-id={item.id}
              data-seq={seq}
              variant={mine ? "tinted" : "muted"}
              align={align}
              className={cn(BUBBLE_CLASS, FOCUS_CLASS, summary.length > 0 && "mb-4")}
            />
          }
          {...longPress}
        >
          <BubbleContent className={cn(CONTENT_CLASS, open && "ring-2 ring-ring/30")}>{item.body ?? ""}</BubbleContent>
          {summary.length > 0 && (
            <BubbleReactions side="bottom" align={mine ? "start" : "end"} data-testid="reaction-chip">
              <button
                type="button"
                aria-label="Reactions"
                className="flex items-center gap-1 rounded-full px-1.5 py-0.5 text-sm font-medium"
                onClick={() => setOpen(true)}
              >
                {summary.map((r) => (
                  <span key={r.emoji} className="tabular-nums">
                    {r.emoji}
                    {r.count > 1 ? ` ${r.count}` : ""}
                  </span>
                ))}
              </button>
            </BubbleReactions>
          )}
        </PopoverTrigger>
        <PopoverContent side="top" align={align} className="w-auto gap-2 p-2">
          <MessageActions
            myReaction={myReaction}
            copyText={item.body && item.body.length > 0 ? item.body : null}
            onReact={(emoji) => void chatStore.react(seq, emoji)}
            onReply={() => {}}
            onClose={() => setOpen(false)}
          />
        </PopoverContent>
      </Popover>
      <StatusFooter item={item} />
    </>
  )
}

/**
 * Consecutive messages from one sender less than 2 minutes apart: one Message with a BubbleGroup
 * (4px between bubbles). No per-bubble time: day and time markers sit between groups.
 */
export function MessageGroupRow({ mine, items, meId }: { mine: boolean; items: GroupItem[]; meId: string | null }) {
  return (
    <Message align={mine ? "end" : "start"}>
      <MessageContent>
        <BubbleGroup className="w-full gap-1">
          {items.map((item) => (
            <Fragment key={item.id}>
              {item.seq === null ? (
                <PendingBubble item={item} />
              ) : (
                <StoredBubble item={item} mine={mine} seq={item.seq} meId={meId} />
              )}
            </Fragment>
          ))}
        </BubbleGroup>
      </MessageContent>
    </Message>
  )
}
