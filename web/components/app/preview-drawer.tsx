"use client"

import { useEffect, useMemo, useState } from "react"
import { selectionSendLabel, selectionTitle, type AttachmentKind } from "@duet/shared"
import { Button } from "@/components/ui/button"
import { Drawer, DrawerContent, DrawerFooter, DrawerHeader, DrawerTitle } from "@/components/ui/drawer"
import { Textarea } from "@/components/ui/textarea"

function kindOf(file: File): AttachmentKind {
  return file.type.startsWith("video/") ? "video" : "image"
}

/**
 * Media preview sheet (D-06, UI-SPEC "Preview drawer"): nothing is sent until the count-aware send
 * button is pressed; swiping it down or "Discard selection" drops the selection with no confirmation.
 */
export function PreviewDrawer({
  files,
  onSend,
  onDiscard,
}: {
  /** The picked files; the drawer is open while this is non-empty. */
  files: File[]
  onSend: (files: File[], caption: string) => void
  onDiscard: () => void
}) {
  const [caption, setCaption] = useState("")
  const open = files.length > 0
  const kinds = files.map(kindOf)
  const urls = useMemo(() => files.map((f) => URL.createObjectURL(f)), [files])
  useEffect(() => () => urls.forEach((u) => URL.revokeObjectURL(u)), [urls])

  // Sending or discarding clears the caption, so the next selection starts empty.
  function send() {
    onSend(files, caption)
    setCaption("")
  }
  function discard() {
    onDiscard()
    setCaption("")
  }

  return (
    <Drawer
      open={open}
      onOpenChange={(next) => {
        if (!next) discard()
      }}
      showSwipeHandle
    >
      <DrawerContent className="[--drawer-height:85dvh]">
        <DrawerHeader>
          <DrawerTitle className="text-sm">{open ? selectionTitle(kinds) : ""}</DrawerTitle>
        </DrawerHeader>
        <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-4">
          {files.length === 1 && (
            // eslint-disable-next-line @next/next/no-img-element -- local object URL preview
            <img
              src={urls[0]}
              alt=""
              data-testid="preview-single"
              className="max-h-[60dvh] w-full rounded-3xl object-contain"
            />
          )}
          {files.length > 1 && (
            <div className="flex gap-2 overflow-x-auto">
              {urls.map((u, i) => (
                // eslint-disable-next-line @next/next/no-img-element -- local object URL preview
                <img key={u} src={u} alt="" className="size-24 shrink-0 rounded-2xl object-cover" data-index={i} />
              ))}
            </div>
          )}
          <Textarea
            value={caption}
            onChange={(e) => setCaption(e.target.value)}
            placeholder="Add a caption…"
            aria-label="Caption"
            rows={1}
            className="max-h-28 min-h-11 text-base md:text-base"
          />
        </div>
        <DrawerFooter>
          <Button size="lg" className="w-full" onClick={send}>
            {open ? selectionSendLabel(kinds) : ""}
          </Button>
          <Button variant="ghost" className="w-full" onClick={discard}>
            Discard selection
          </Button>
        </DrawerFooter>
      </DrawerContent>
    </Drawer>
  )
}
