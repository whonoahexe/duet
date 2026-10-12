"use client"

import { Fragment, useState } from "react"
import { ArrowBendUpLeftIcon, WarningCircleIcon } from "@phosphor-icons/react"
import { reactionSummary, type ReactionDto, type ReplyPreview } from "@duet/shared"
import { Album, type AlbumTile } from "@/components/app/album"
import { MessageActions } from "@/components/app/message-actions"
import { QuoteBlock } from "@/components/app/quote-block"
import { Bubble, BubbleContent, BubbleGroup, BubbleReactions } from "@/components/ui/bubble"
import { Message, MessageContent, MessageFooter } from "@/components/ui/message"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { chatStore } from "@/lib/chat/store"
import { mergeHandlers, useLongPress, useSwipeReply } from "@/lib/chat/gestures"
import { cn } from "@/lib/utils"

/**
 * Status line under your most recent message (D-03): "Sending…" -> "Sent" -> "Read 9:41 PM". Never
 * "Sent" without a server seq, never "Read" before the other person's cursor reached it.
 */
export type RowStatus = "sending" | "sent" | "read" | null

export interface GroupItem {
  id: string
  /** Server order; null while the message is still in the outbox (no menu, no reactions yet). */
  seq: number | null
  body: string | null
  status: RowStatus
  /** When the other person's read cursor passed this message (status "read"). */
  readAt: number | null
  failed: boolean
  onRetry?: () => void
  reactions: ReactionDto[]
  /** Quote of the message this one replies to (D-02). */
  replyTo: ReplyPreview | null
  /** Just jumped to from a quote: accent ring for a moment (UI-SPEC accent item 6). */
  highlighted: boolean
  /** Album tiles of a media message (D-07); null for text. */
  media: AlbumTile[] | null
}

interface RowContext {
  mine: boolean
  meId: string | null
  peerName: string
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
const CONTENT_CLASS =
  "flex flex-col gap-1 text-base leading-normal whitespace-pre-wrap wrap-anywhere transition-[box-shadow] duration-700 motion-reduce:transition-none"

/** A media bubble: a ghost Bubble 288px wide, capped at 80% (UI-SPEC "Album bubble"). */
const ALBUM_BUBBLE_CLASS = "w-72 max-w-[80%] data-[variant=ghost]:max-w-[80%]"

/**
 * The caption (and reply quote) of an album, under the grid in a regular tinted/muted bubble inside
 * the same ghost Bubble. Its slot is renamed so it never counts as a message bubble of its own.
 */
function AlbumCaption({
  item,
  ctx,
  onQuote,
  className,
}: {
  item: GroupItem
  ctx: RowContext
  onQuote?: () => void
  className?: string
}) {
  if (!item.body && !item.replyTo) return null
  return (
    <Bubble
      data-slot="album-caption"
      variant={ctx.mine ? "tinted" : "muted"}
      align={ctx.mine ? "end" : "start"}
      className="max-w-full"
    >
      <BubbleContent className={cn(CONTENT_CLASS, className)}>
        {item.replyTo && (
          <QuoteBlock preview={item.replyTo} meId={ctx.meId} peerName={ctx.peerName} onClick={onQuote} />
        )}
        <MessageText body={item.body} />
      </BubbleContent>
    </Bubble>
  )
}

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
  const label =
    item.status === "sending"
      ? "Sending…"
      : item.status === "read"
        ? item.readAt !== null
          ? `Read ${shortTime(item.readAt)}`
          : "Read"
        : "Sent"
  return <MessageFooter data-testid="message-status">{label}</MessageFooter>
}

/** Device-locale short time ("9:41 PM"). */
function shortTime(ts: number): string {
  return new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }).format(ts)
}

/** The message text as a React text child only (T-02-06: never HTML). */
function MessageText({ body }: { body: string | null }) {
  if (!body) return null
  return <span data-testid="message-text">{body}</span>
}

/**
 * A message still in the outbox. A failed one keeps its tinted bubble at 70% opacity; tapping the
 * bubble or its footer retries with the same client id. No menu until the server has stored it.
 */
function PendingBubble({ item, ctx }: { item: GroupItem; ctx: RowContext }) {
  const retry = item.failed ? item.onRetry : undefined
  if (item.media) {
    return (
      <>
        <Bubble
          data-message-id={item.id}
          variant="ghost"
          align="end"
          className={cn(BUBBLE_CLASS, ALBUM_BUBBLE_CLASS, item.failed && "opacity-70")}
          {...(retry ? { role: "button", tabIndex: 0, onClick: retry, onKeyDown: onActivate(retry) } : {})}
        >
          <Album tiles={item.media} />
          <AlbumCaption item={item} ctx={ctx} />
        </Bubble>
        <StatusFooter item={item} />
      </>
    )
  }
  return (
    <>
      <Bubble data-message-id={item.id} variant="tinted" align="end" className={cn(BUBBLE_CLASS, item.failed && "opacity-70")}>
        <BubbleContent
          className={CONTENT_CLASS}
          {...(retry ? { role: "button", tabIndex: 0, onClick: retry, onKeyDown: onActivate(retry) } : {})}
        >
          {item.replyTo && <QuoteBlock preview={item.replyTo} meId={ctx.meId} peerName={ctx.peerName} />}
          <MessageText body={item.body} />
        </BubbleContent>
      </Bubble>
      <StatusFooter item={item} />
    </>
  )
}

/**
 * A stored message. The bubble is the trigger of its own controlled popover (Pitfall 12): long-press,
 * right-click or Enter opens it; a plain tap never does ('trigger-press' is ignored). Swiping it right
 * starts a reply (D-01). The reaction chip sits on the inner bottom corner and opens the same menu. A
 * reply shows its quote at the top; tapping the quote jumps to the original (D-02).
 */
function StoredBubble({ item, seq, ctx }: { item: GroupItem; seq: number; ctx: RowContext }) {
  const { mine, meId, peerName } = ctx
  const [open, setOpen] = useState(false)
  const reply = () => chatStore.setReplyTarget(seq)
  const longPress = useLongPress({ onOpen: () => setOpen(true) })
  const swipe = useSwipeReply({ onReply: reply })
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
              variant={item.media ? "ghost" : mine ? "tinted" : "muted"}
              align={align}
              className={cn(
                BUBBLE_CLASS,
                item.media && ALBUM_BUBBLE_CLASS,
                FOCUS_CLASS,
                "touch-pan-y",
                !swipe.dragging && "transition-transform duration-200 ease-out motion-reduce:transition-none",
                summary.length > 0 && "mb-4",
              )}
              style={swipe.offset > 0 ? { transform: `translateX(${swipe.offset}px)` } : undefined}
            />
          }
          {...mergeHandlers(longPress, swipe.handlers)}
        >
          {swipe.offset > 0 && (
            <ArrowBendUpLeftIcon
              size={20}
              aria-hidden="true"
              className="pointer-events-none absolute top-1/2 right-full mr-2 -translate-y-1/2 text-muted-foreground"
              style={{ opacity: swipe.progress }}
            />
          )}
          {item.media ? (
            <>
              <Album
                tiles={item.media}
                caption={item.body}
                openable
                className={cn(open && "ring-2 ring-ring/30", item.highlighted && "ring-2 ring-primary")}
              />
              <AlbumCaption
                item={item}
                ctx={ctx}
                onQuote={item.replyTo ? () => void chatStore.jumpTo(item.replyTo!.seq) : undefined}
              />
            </>
          ) : (
            <BubbleContent
              className={cn(
                CONTENT_CLASS,
                open && "ring-2 ring-ring/30",
                item.highlighted && "ring-2 ring-primary",
              )}
            >
              {item.replyTo && (
                <QuoteBlock
                  preview={item.replyTo}
                  meId={meId}
                  peerName={peerName}
                  onClick={() => void chatStore.jumpTo(item.replyTo!.seq)}
                />
              )}
              <MessageText body={item.body} />
            </BubbleContent>
          )}
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
            onReply={reply}
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
export function MessageGroupRow({
  mine,
  items,
  meId,
  peerName,
}: {
  mine: boolean
  items: GroupItem[]
  meId: string | null
  peerName: string
}) {
  const ctx: RowContext = { mine, meId, peerName }
  return (
    <Message align={mine ? "end" : "start"}>
      <MessageContent>
        <BubbleGroup className="w-full gap-1">
          {items.map((item) => (
            <Fragment key={item.id}>
              {item.seq === null ? (
                <PendingBubble item={item} ctx={ctx} />
              ) : (
                <StoredBubble item={item} seq={item.seq} ctx={ctx} />
              )}
            </Fragment>
          ))}
        </BubbleGroup>
      </MessageContent>
    </Message>
  )
}
