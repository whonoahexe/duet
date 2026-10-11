"use client"

import { useEffect, useLayoutEffect, useRef, useState } from "react"
import { PaperPlaneRightIcon, XIcon } from "@phosphor-icons/react"
import { isBlankBody } from "@duet/shared"
import { QuoteBlock, localReplyPreview } from "@/components/app/quote-block"
import { Button } from "@/components/ui/button"
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupTextarea } from "@/components/ui/input-group"
import { chatStore, useChat } from "@/lib/chat/store"

/** Six 24px lines: the textarea grows to this, then scrolls inside. */
const MAX_TEXTAREA_PX = 144

/** Desktop-style input (mouse/trackpad): Enter sends. Phones: Enter is a newline, Send sends. */
function finePointer(): boolean {
  return typeof window !== "undefined" && window.matchMedia("(pointer: fine)").matches
}

/** Text composer pinned under the list. Send appears only once there is something to send. */
export function Composer({ peerName }: { peerName: string }) {
  const [text, setText] = useState("")
  const ref = useRef<HTMLTextAreaElement>(null)
  const canSend = !isBlankBody(text)
  const chat = useChat()
  const meId = chat.me?.id ?? null
  const replyTarget = chat.replyTarget
  const replyMessage = replyTarget !== null ? chat.messages.find((m) => m.seq === replyTarget) : undefined

  // Starting a reply (swipe or menu) focuses the field so the keyboard comes up (D-01).
  useEffect(() => {
    if (replyTarget !== null) ref.current?.focus()
  }, [replyTarget])

  // Grow from one line to six, then scroll (field-sizing is not available on every phone).
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    el.style.height = "auto"
    el.style.height = `${Math.min(el.scrollHeight, MAX_TEXTAREA_PX)}px`
    el.style.overflowY = el.scrollHeight > MAX_TEXTAREA_PX ? "auto" : "hidden"
  }, [text])

  function send() {
    if (!canSend) return
    chatStore.sendText(text, replyMessage ? replyMessage.seq : null)
    chatStore.setReplyTarget(null)
    setText("")
    // Keep the keyboard up for the next message.
    ref.current?.focus()
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key !== "Enter" || e.shiftKey || e.nativeEvent.isComposing) return
    if (!finePointer()) return
    e.preventDefault()
    send()
  }

  return (
    <div className="border-t bg-background px-4 py-2 pb-[max(8px,env(safe-area-inset-bottom))]">
      {replyMessage && (
        <div className="mb-2 flex items-start gap-2" data-testid="reply-chip">
          <div className="flex min-w-0 flex-1 flex-col gap-1">
            <span className="text-xs font-medium text-muted-foreground">
              Replying to {replyMessage.senderId === meId ? "You" : peerName}
            </span>
            <QuoteBlock preview={localReplyPreview(replyMessage)} meId={meId} peerName={peerName} />
          </div>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label="Cancel reply"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => chatStore.setReplyTarget(null)}
          >
            <XIcon />
          </Button>
        </div>
      )}
      <InputGroup>
        <InputGroupTextarea
          ref={ref}
          rows={1}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder={`Message ${peerName}`}
          aria-label={`Message ${peerName}`}
          className="max-h-36 min-h-11 text-base md:text-base"
        />
        {canSend && (
          <InputGroupAddon align="inline-end">
            <InputGroupButton
              variant="default"
              size="icon-sm"
              className="size-11 rounded-full"
              aria-label="Send message"
              // Keep focus in the textarea so the iOS keyboard does not drop between messages.
              onMouseDown={(e) => e.preventDefault()}
              onClick={send}
            >
              <PaperPlaneRightIcon weight="fill" />
            </InputGroupButton>
          </InputGroupAddon>
        )}
      </InputGroup>
    </div>
  )
}
