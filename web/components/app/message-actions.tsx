"use client"

import { ArrowBendUpLeftIcon, CopyIcon } from "@phosphor-icons/react"
import { toast } from "sonner"
import { REACTIONS, type Reaction } from "@duet/shared"
import { Button } from "@/components/ui/button"
import { Separator } from "@/components/ui/separator"
import { cn } from "@/lib/utils"

export interface MessageActionsProps {
  /** Your current reaction on this message, if any. */
  myReaction: string | null
  /** The text or caption Copy puts on the clipboard; null hides Copy (media without a caption). */
  copyText: string | null
  /** Pick a reaction: your current one sends null (remove), any other replaces it. */
  onReact: (emoji: Reaction | null) => void
  onReply: () => void
  /** Every choice closes the popover. */
  onClose: () => void
}

async function copy(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text)
    toast("Copied")
  } catch {
    toast.error("Couldn't copy. Try again.")
  }
}

/**
 * Long-press menu body (D-01, D-04): the six reactions as 44px round ghost buttons with your current
 * one highlighted (accent item 7), a Separator, then Reply and Copy.
 */
export function MessageActions({ myReaction, copyText, onReact, onReply, onClose }: MessageActionsProps) {
  return (
    <>
      <div className="flex items-center gap-2" role="group" aria-label="Reactions">
        {REACTIONS.map((emoji) => {
          const mine = myReaction === emoji
          return (
            <Button
              key={emoji}
              type="button"
              variant="ghost"
              size="icon"
              aria-label={`React ${emoji}`}
              aria-pressed={mine}
              className={cn("size-11 rounded-full text-xl", mine && "bg-primary/20 ring-1 ring-primary")}
              onClick={() => {
                onReact(mine ? null : emoji)
                onClose()
              }}
            >
              {emoji}
            </Button>
          )
        })}
      </div>
      <Separator />
      <div className="flex flex-col">
        <Button
          type="button"
          variant="ghost"
          className="w-full justify-start gap-2"
          onClick={() => {
            onReply()
            onClose()
          }}
        >
          <ArrowBendUpLeftIcon />
          Reply
        </Button>
        {copyText !== null && (
          <Button
            type="button"
            variant="ghost"
            className="w-full justify-start gap-2"
            onClick={() => {
              void copy(copyText)
              onClose()
            }}
          >
            <CopyIcon />
            Copy
          </Button>
        )}
      </div>
    </>
  )
}
