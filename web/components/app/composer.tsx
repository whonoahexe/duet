"use client"

import { useLayoutEffect, useRef, useState } from "react"
import { PaperPlaneRightIcon } from "@phosphor-icons/react"
import { isBlankBody } from "@duet/shared"
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupTextarea } from "@/components/ui/input-group"
import { chatStore } from "@/lib/chat/store"

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
    chatStore.sendText(text)
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
