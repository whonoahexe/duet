"use client"

import {
  REPLY_SNIPPET_MAX_GRAPHEMES,
  mediaLabel,
  truncateGraphemes,
  type MessageDto,
  type ReplyPreview,
} from "@duet/shared"
import { cn } from "@/lib/utils"

/**
 * The same preview the server embeds (D-02), built on the client from a loaded message: used for the
 * "Replying to" chip and for outbox bubbles whose reply has not been stored yet.
 */
export function localReplyPreview(m: MessageDto): ReplyPreview {
  const text = m.body ?? ""
  const visual = [...m.attachments]
    .sort((a, b) => a.position - b.position)
    .find((a) => a.kind === "image" || a.kind === "video")
  return {
    seq: m.seq,
    senderId: m.senderId,
    kind: m.kind,
    snippet:
      m.kind === "text" || text.length > 0
        ? truncateGraphemes(text, REPLY_SNIPPET_MAX_GRAPHEMES)
        : mediaLabel(
            m.attachments.map((a) => a.kind),
            { emoji: false },
          ),
    attachmentCount: m.attachments.length,
    thumb: visual ? { id: visual.id, kind: visual.kind } : null,
  }
}

/** Thumbnail URL for a quoted photo or video (served by plan 02-04 behind the auth hook). */
function thumbUrl(thumb: NonNullable<ReplyPreview["thumb"]>): string {
  return `/media/${encodeURIComponent(thumb.id)}/${thumb.kind === "video" ? "poster" : "thumb"}`
}

export interface QuoteBlockProps {
  preview: ReplyPreview
  /** The reader's id: their own messages are quoted as "You". */
  meId: string | null
  peerName: string
  /** Makes the quote a button (tap jumps to the original). */
  onClick?: () => void
  className?: string
}

/**
 * Compact quote (D-02, UI-SPEC "Quoted reply"): accent left bar, author on line 1, a 2-line snippet on
 * line 2, and a 32px thumbnail at the right for photo and video originals. Text renders only as React
 * text children (T-02-06).
 */
export function QuoteBlock({ preview, meId, peerName, onClick, className }: QuoteBlockProps) {
  const author = preview.senderId === meId ? "You" : peerName
  const body = (
    <>
      <span className="flex min-w-0 flex-1 flex-col text-left">
        <span className="text-sm font-medium text-foreground">{author}</span>
        <span className="line-clamp-2 text-sm font-normal break-words text-muted-foreground">{preview.snippet}</span>
      </span>
      {preview.thumb && (
        // eslint-disable-next-line @next/next/no-img-element -- static export; media is auth-gated
        <img src={thumbUrl(preview.thumb)} alt="" className="size-8 shrink-0 rounded-lg object-cover" />
      )}
    </>
  )
  const base = cn(
    "flex w-full min-w-0 items-center gap-2 rounded-2xl border-l-2 border-primary bg-background/40 px-2 py-1 whitespace-normal",
    className,
  )
  if (!onClick) {
    return (
      <div data-testid="quote-block" className={base}>
        {body}
      </div>
    )
  }
  return (
    <button
      type="button"
      data-testid="quote-block"
      aria-label={`Quoted message from ${author}: ${preview.snippet}. Show original`}
      className={cn(base, "cursor-pointer outline-none focus-visible:ring-3 focus-visible:ring-ring/30")}
      onClick={onClick}
    >
      {body}
    </button>
  )
}
