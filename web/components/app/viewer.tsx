"use client"

import { useEffect, useState } from "react"
import { ImageBrokenIcon, XIcon } from "@phosphor-icons/react"
import { Button } from "@/components/ui/button"
import { Carousel, CarouselContent, CarouselItem, type CarouselApi } from "@/components/ui/carousel"
import { Dialog, DialogClose, DialogContent, DialogTitle } from "@/components/ui/dialog"
import { Spinner } from "@/components/ui/spinner"
import type { AlbumTile } from "@/components/app/album"

/** The display copy (long edge 2048, D-09), never the original (assumption: one album at a time). */
function displaySrc(tile: AlbumTile, attempt: number): string | null {
  if (tile.status !== "ready" || !tile.attachmentId) return tile.localUrl
  const base = `/media/${encodeURIComponent(tile.attachmentId)}/display`
  return attempt > 0 ? `${base}?r=${attempt}` : base
}

/** One slide: the photo, object-contain; a failed load shows "Couldn't load" and a tap retries. */
function Slide({ tile }: { tile: AlbumTile }) {
  const [attempt, setAttempt] = useState(0)
  const [failed, setFailed] = useState(false)
  const src = displaySrc(tile, attempt)
  if (failed || tile.status === "failed") {
    return (
      <button
        type="button"
        className="flex flex-col items-center justify-center gap-2 text-sm text-muted-foreground"
        onClick={() => {
          setFailed(false)
          setAttempt((a) => a + 1)
        }}
      >
        <ImageBrokenIcon className="size-8" />
        Couldn&apos;t load
      </button>
    )
  }
  if (!src) return <Spinner className="size-8 text-muted-foreground" />
  return (
    // eslint-disable-next-line @next/next/no-img-element -- static export; media is auth-gated
    <img
      src={src}
      alt=""
      draggable={false}
      data-testid="viewer-image"
      className="size-full object-contain select-none"
      onError={() => setFailed(true)}
    />
  )
}

/**
 * Full-screen viewer (MDIA-02, UI-SPEC): a full-screen Dialog with a Carousel over one album's items,
 * opened at the tapped item. Swipe, Escape and the arrow keys work; the counter hides for one item;
 * the caption sits at the bottom.
 */
export function Viewer({
  tiles,
  index,
  caption,
  onClose,
}: {
  tiles: AlbumTile[]
  /** The item to open at, or null when closed. */
  index: number | null
  caption: string | null
  onClose: () => void
}) {
  const open = index !== null
  const [api, setApi] = useState<CarouselApi>()
  const [current, setCurrent] = useState(index ?? 0)

  useEffect(() => {
    if (!api) return
    const onSelect = () => setCurrent(api.selectedScrollSnap())
    onSelect()
    api.on("select", onSelect)
    api.on("reInit", onSelect)
    return () => {
      api.off("select", onSelect)
      api.off("reInit", onSelect)
    }
  }, [api])

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose()
      }}
    >
      <DialogContent
        showCloseButton={false}
        className="top-0 left-0 flex h-dvh w-full max-w-none translate-x-0 translate-y-0 flex-col gap-0 rounded-none bg-background p-0 ring-0 sm:max-w-none data-open:zoom-in-100 data-closed:zoom-out-100"
        onKeyDown={(e) => {
          if (e.key === "ArrowLeft") {
            e.preventDefault()
            api?.scrollPrev()
          } else if (e.key === "ArrowRight") {
            e.preventDefault()
            api?.scrollNext()
          }
        }}
      >
        <DialogTitle className="sr-only">Photo viewer</DialogTitle>
        <div className="relative flex h-14 shrink-0 items-center px-2 pt-[env(safe-area-inset-top)] box-content">
          <DialogClose render={<Button variant="ghost" size="icon" aria-label="Close viewer" />}>
            <XIcon />
          </DialogClose>
          {tiles.length > 1 && (
            <span
              data-testid="viewer-counter"
              className="pointer-events-none absolute inset-x-0 text-center text-xs font-medium tabular-nums"
            >
              {current + 1} / {tiles.length}
            </span>
          )}
        </div>
        {open && (
          <Carousel
            setApi={setApi}
            opts={{ startIndex: index ?? 0 }}
            className="min-h-0 flex-1 *:data-[slot=carousel-content]:h-full"
          >
            <CarouselContent className="ml-0 h-full">
              {tiles.map((tile) => (
                <CarouselItem key={tile.key} className="flex h-full items-center justify-center pl-0">
                  <Slide tile={tile} />
                </CarouselItem>
              ))}
            </CarouselContent>
          </Carousel>
        )}
        {caption && (
          <p
            data-testid="viewer-caption"
            className="line-clamp-3 shrink-0 bg-background/60 px-4 pt-3 pb-[max(12px,env(safe-area-inset-bottom))] text-base whitespace-pre-wrap text-foreground"
          >
            {caption}
          </p>
        )}
      </DialogContent>
    </Dialog>
  )
}
