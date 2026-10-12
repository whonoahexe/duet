"use client"

import { useEffect, useMemo, useState } from "react"
import { ImageIcon, VideoCameraIcon, XIcon } from "@phosphor-icons/react"
import { selectionSendLabel, selectionTitle, type AttachmentKind } from "@duet/shared"
import {
  Attachment,
  AttachmentAction,
  AttachmentActions,
  AttachmentContent,
  AttachmentGroup,
  AttachmentMedia,
  AttachmentTitle,
} from "@/components/ui/attachment"
import { Button } from "@/components/ui/button"
import { Drawer, DrawerContent, DrawerFooter, DrawerHeader, DrawerTitle } from "@/components/ui/drawer"
import { Textarea } from "@/components/ui/textarea"

function kindOf(file: File): AttachmentKind {
  return file.type.startsWith("video/") ? "video" : "image"
}

/** A picked file the browser cannot draw (HEIC in Chrome): an icon and the file name instead. */
function FallbackMedia({ file }: { file: File }) {
  return (
    <AttachmentMedia variant="icon" data-testid="preview-fallback">
      {kindOf(file) === "video" ? <VideoCameraIcon /> : <ImageIcon />}
    </AttachmentMedia>
  )
}

/**
 * Media preview sheet (D-06, UI-SPEC "Preview drawer"), about 85dvh: one item shows large; several
 * show a strip of thumbnails, each removable. Title and send label count the items live; removing the
 * last one closes the drawer. Nothing is sent until the send button is pressed; swiping it down or
 * "Discard selection" drops the selection with no confirmation.
 */
export function PreviewDrawer({
  files,
  onSend,
  onRemove,
  onDiscard,
}: {
  /** The picked files; the drawer is open while this is non-empty. */
  files: File[]
  onSend: (files: File[], caption: string) => void
  onRemove: (index: number) => void
  onDiscard: () => void
}) {
  const [caption, setCaption] = useState("")
  /** Object URLs that failed to render (keyed by URL, so a new selection starts clean). */
  const [unrenderable, setUnrenderable] = useState<ReadonlySet<string>>(new Set())
  const open = files.length > 0
  const kinds = files.map(kindOf)
  const urls = useMemo(() => files.map((f) => URL.createObjectURL(f)), [files])
  useEffect(() => () => urls.forEach((u) => URL.revokeObjectURL(u)), [urls])

  const markUnrenderable = (url: string) => setUnrenderable((prev) => new Set(prev).add(url))

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
        <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-4 pt-4">
          {files.length === 1 &&
            (unrenderable.has(urls[0]) ? (
              <Attachment orientation="vertical" className="mx-auto w-40">
                <FallbackMedia file={files[0]} />
                <AttachmentContent>
                  <AttachmentTitle>{files[0].name}</AttachmentTitle>
                </AttachmentContent>
              </Attachment>
            ) : (
              // eslint-disable-next-line @next/next/no-img-element -- local object URL preview
              <img
                src={urls[0]}
                alt=""
                data-testid="preview-single"
                className="max-h-[60dvh] min-h-0 w-full rounded-3xl object-contain"
                onError={() => markUnrenderable(urls[0])}
              />
            ))}
          {files.length > 1 && (
            <AttachmentGroup data-testid="preview-strip">
              {files.map((file, i) => (
                <Attachment key={urls[i]} orientation="vertical" data-testid="preview-item">
                  {unrenderable.has(urls[i]) ? (
                    <FallbackMedia file={file} />
                  ) : (
                    <AttachmentMedia variant="image">
                      {/* eslint-disable-next-line @next/next/no-img-element -- local object URL preview */}
                      <img src={urls[i]} alt="" onError={() => markUnrenderable(urls[i])} />
                    </AttachmentMedia>
                  )}
                  {unrenderable.has(urls[i]) && (
                    <AttachmentContent>
                      <AttachmentTitle>{file.name}</AttachmentTitle>
                    </AttachmentContent>
                  )}
                  <AttachmentActions>
                    <AttachmentAction aria-label="Remove item" onClick={() => onRemove(i)}>
                      <XIcon />
                    </AttachmentAction>
                  </AttachmentActions>
                </Attachment>
              ))}
            </AttachmentGroup>
          )}
        </div>
        <div className="shrink-0 p-4">
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
