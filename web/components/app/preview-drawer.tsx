"use client"

import { useEffect, useMemo, useState } from "react"
import { CropIcon, ImageIcon, VideoCameraIcon, XIcon } from "@phosphor-icons/react"
import { formatDuration, selectionSendLabel, selectionTitle, type AttachmentKind, type CropRect } from "@duet/shared"
import { CropDialog, cropPreviewUrl } from "@/components/app/cropper"
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
import { useBackClose } from "@/lib/back-close"

export function kindOf(file: File): AttachmentKind {
  return file.type.startsWith("video/") ? "video" : "image"
}

/**
 * A picked file plus, for a video, its length read from the file's own metadata (D-08), and for a
 * photo its crop (QT-m25-send-crop): the rect the server applies to the untouched original, and a
 * local cropped preview shown instead of the full photo.
 */
export interface PickedItem {
  file: File
  /** null for photos, and for a video the browser cannot read (the server still checks it). */
  durationMs: number | null
  crop: CropRect | null
  /** Object URL of the cropped preview (owned by the composer until sent, then by the store). */
  previewUrl: string | null
}

/** How long reading one video's metadata may take before it is let through unchecked. */
const METADATA_TIMEOUT_MS = 5000

/**
 * A picked video's duration from a detached video element's loadedmetadata (D-08 pick-time check).
 * Resolves null when the browser cannot read it (for example HEVC in some desktop browsers).
 */
export function videoDurationMs(file: File): Promise<number | null> {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file)
    const el = document.createElement("video")
    let done = false
    const finish = (value: number | null) => {
      if (done) return
      done = true
      clearTimeout(timer)
      el.removeAttribute("src")
      el.load()
      URL.revokeObjectURL(url)
      resolve(value)
    }
    const timer = setTimeout(() => finish(null), METADATA_TIMEOUT_MS)
    el.preload = "metadata"
    el.muted = true
    el.onloadedmetadata = () => finish(Number.isFinite(el.duration) ? Math.round(el.duration * 1000) : null)
    el.onerror = () => finish(null)
    el.src = url
  })
}

/** Video thumbnail overlay (UI-SPEC): VideoCameraIcon + the duration. */
function VideoBadge({ durationMs }: { durationMs: number | null }) {
  return (
    <span className="pointer-events-none absolute right-1 bottom-1 flex items-center gap-1 rounded-full bg-background/60 px-1.5 text-xs font-medium tabular-nums">
      <VideoCameraIcon className="size-3.5" />
      {durationMs !== null && formatDuration(durationMs)}
    </span>
  )
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
 * "Discard selection" drops the selection with no confirmation. Every photo the browser can draw
 * has a Crop action (QT-m25-send-crop, N-04): the cropper opens over the drawer, and Save shows the
 * cropped preview with the drawer still open. Each photo of an album is cropped on its own.
 */
export function PreviewDrawer({
  items,
  onSend,
  onCrop,
  onRemove,
  onDiscard,
}: {
  /** The picked files; the drawer is open while this is non-empty. */
  items: PickedItem[]
  onSend: (items: PickedItem[], caption: string) => void
  onCrop: (index: number, crop: CropRect, previewUrl: string | null) => void
  onRemove: (index: number) => void
  onDiscard: () => void
}) {
  const [caption, setCaption] = useState("")
  /** Object URLs that failed to render (keyed by URL, so a new selection starts clean). */
  const [unrenderable, setUnrenderable] = useState<ReadonlySet<string>>(new Set())
  /** The original's URL of the photo being cropped (closes by itself when that item is removed). */
  const [cropping, setCropping] = useState<string | null>(null)
  // The file list keeps its identity while only crops change, so the object URLs are not remade.
  const [files, setFiles] = useState<File[]>(() => items.map((it) => it.file))
  if (files.length !== items.length || items.some((it, i) => it.file !== files[i])) setFiles(items.map((it) => it.file))
  const open = files.length > 0
  const kinds = files.map(kindOf)
  const urls = useMemo(() => files.map((f) => URL.createObjectURL(f)), [files])
  useEffect(() => () => urls.forEach((u) => URL.revokeObjectURL(u)), [urls])

  const markUnrenderable = (url: string) => setUnrenderable((prev) => new Set(prev).add(url))

  // Sending or discarding clears the caption, so the next selection starts empty.
  function send() {
    onSend(items, caption)
    setCaption("")
  }
  function discard() {
    onDiscard()
    setCaption("")
  }
  // Back drops the selection, like swiping the drawer down.
  useBackClose(open, discard)

  const croppingIndex = cropping === null ? -1 : urls.indexOf(cropping)
  /** What a photo tile shows: its cropped preview, else the original. */
  const shownUrl = (i: number) => items[i]?.previewUrl ?? urls[i]
  const canCrop = (i: number) => kinds[i] === "image" && !unrenderable.has(urls[i])

  async function saveCrop(rect: CropRect) {
    const index = croppingIndex
    const src = cropping
    if (index === -1 || src === null) return
    const preview = await cropPreviewUrl(src, rect)
    onCrop(index, rect, preview)
    setCropping(null)
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
            ) : kinds[0] === "video" ? (
              <video
                src={urls[0]}
                controls
                playsInline
                muted
                preload="metadata"
                data-testid="preview-single"
                className="max-h-[60dvh] min-h-0 w-full rounded-3xl object-contain"
                onError={() => markUnrenderable(urls[0])}
              />
            ) : (
              <>
                {/* eslint-disable-next-line @next/next/no-img-element -- local object URL preview */}
                <img
                  src={shownUrl(0)}
                  alt=""
                  data-testid="preview-single"
                  className="max-h-[60dvh] min-h-0 w-full rounded-3xl object-contain"
                  onError={() => markUnrenderable(urls[0])}
                />
                {canCrop(0) && (
                  <Button
                    variant="secondary"
                    size="sm"
                    className="self-center"
                    aria-label="Crop photo"
                    onClick={() => setCropping(urls[0])}
                  >
                    <CropIcon />
                    Crop
                  </Button>
                )}
              </>
            ))}
          {files.length > 1 && (
            <AttachmentGroup data-testid="preview-strip">
              {files.map((file, i) => (
                <Attachment key={urls[i]} orientation="vertical" data-testid="preview-item">
                  {unrenderable.has(urls[i]) ? (
                    <FallbackMedia file={file} />
                  ) : kinds[i] === "video" ? (
                    <AttachmentMedia variant="image">
                      <video
                        src={`${urls[i]}#t=0.1`}
                        muted
                        playsInline
                        preload="metadata"
                        className="aspect-square w-full object-cover"
                        onError={() => markUnrenderable(urls[i])}
                      />
                      <VideoBadge durationMs={items[i]?.durationMs ?? null} />
                    </AttachmentMedia>
                  ) : (
                    <AttachmentMedia variant="image">
                      {/* eslint-disable-next-line @next/next/no-img-element -- local object URL preview */}
                      <img src={shownUrl(i)} alt="" onError={() => markUnrenderable(urls[i])} />
                    </AttachmentMedia>
                  )}
                  {unrenderable.has(urls[i]) && (
                    <AttachmentContent>
                      <AttachmentTitle>{file.name}</AttachmentTitle>
                    </AttachmentContent>
                  )}
                  <AttachmentActions>
                    {canCrop(i) && (
                      <AttachmentAction aria-label="Crop photo" onClick={() => setCropping(urls[i])}>
                        <CropIcon />
                      </AttachmentAction>
                    )}
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
        {/* Inside DrawerContent, so the drawer treats the cropper as a nested popup. */}
        <CropDialog
          src={croppingIndex === -1 ? null : urls[croppingIndex]}
          mode="photo"
          initial={croppingIndex === -1 ? null : (items[croppingIndex]?.crop ?? null)}
          onSave={saveCrop}
          onCancel={() => setCropping(null)}
          onUnrenderable={() => {
            if (cropping !== null) markUnrenderable(cropping)
            setCropping(null)
          }}
        />
      </DrawerContent>
    </Drawer>
  )
}
