"use client"

import { useRef, useState } from "react"
import { PaperPlaneRightIcon } from "@phosphor-icons/react"
import { isBlankBody } from "@duet/shared"
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupTextarea } from "@/components/ui/input-group"
import { chatStore } from "@/lib/chat/store"

/** Text composer pinned under the list. Send appears only once there is something to send. */
export function Composer({ peerName }: { peerName: string }) {
  const [text, setText] = useState("")
  const ref = useRef<HTMLTextAreaElement>(null)
  const canSend = !isBlankBody(text)

  function send() {
    if (!canSend) return
    void chatStore.sendText(text)
    setText("")
    // Keep the keyboard up for the next message.
    ref.current?.focus()
  }

  return (
    <div className="border-t bg-background px-4 pt-2 pb-[max(8px,env(safe-area-inset-bottom))]">
      <InputGroup>
        <InputGroupTextarea
          ref={ref}
          rows={1}
          value={text}
          onChange={(e) => setText(e.target.value)}
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
