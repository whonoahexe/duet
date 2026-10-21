"use client"

import { useEffect, useEffectEvent, useMemo, useRef, useState } from "react"
import { ArrowLeftIcon, ImageBrokenIcon, ImagesIcon, PlayIcon, VideoCameraIcon } from "@phosphor-icons/react"
import { GALLERY_PAGE_DEFAULT, GalleryPage, formatDuration, type GalleryItem, type Profile } from "@duet/shared"
import type { AlbumTile } from "@/components/app/album"
import { PersonAvatar } from "@/components/app/person-avatar"
import { Viewer } from "@/components/app/viewer"
import { Button } from "@/components/ui/button"
import { Dialog, DialogClose, DialogContent, DialogTitle } from "@/components/ui/dialog"
import { Empty, EmptyContent, EmptyHeader, EmptyMedia, EmptyTitle, EmptyDescription } from "@/components/ui/empty"
import { Marker, MarkerContent } from "@/components/ui/marker"
import { Skeleton } from "@/components/ui/skeleton"
import { Spinner } from "@/components/ui/spinner"
import { apiGet } from "@/lib/api"
import { useBackClose } from "@/lib/back-close"
import { usePeer } from "@/lib/chat/store"

type Status = "loading" | "ready" | "error" | "loading-more" | "more-error"

interface GalleryData {
  items: GalleryItem[]
  next: number | null
  hasMore: boolean
  status: Status
}

const INITIAL: GalleryData = { items: [], next: null, hasMore: false, status: "loading" }

/** Merge a page into the list, newest first, skipping attachments already shown. */
function mergeItems(current: GalleryItem[], incoming: GalleryItem[]): GalleryItem[] {
  const seen = new Set(current.map((i) => i.attachment.id))
  return [...current, ...incoming.filter((i) => !seen.has(i.attachment.id))]
}

/** One square tile: the thumbnail (photo) or poster (video) with a play glyph and the duration. */
function GalleryTile({ item, onOpen }: { item: GalleryItem; onOpen: () => void }) {
  const [failed, setFailed] = useState(false)
  const { attachment } = item
  const video = attachment.kind === "video"
  const src = `/media/${encodeURIComponent(attachment.id)}/${video ? "poster" : "thumb"}`
  return (
    <button
      type="button"
      data-testid="gallery-tile"
      aria-label={video ? "Open video" : "Open photo"}
      className="relative aspect-square overflow-hidden bg-muted"
      onClick={onOpen}
    >
      {failed ? (
        <span className="absolute inset-0 flex items-center justify-center text-muted-foreground">
          {video ? <VideoCameraIcon className="size-6" /> : <ImageBrokenIcon className="size-6" />}
        </span>
      ) : (
        // eslint-disable-next-line @next/next/no-img-element -- static export; media is auth-gated
        <img
          src={src}
          alt=""
          loading="lazy"
          decoding="async"
          draggable={false}
          className="absolute inset-0 size-full object-cover"
          onError={() => setFailed(true)}
        />
      )}
      {video && !failed && (
        <>
          <span className="pointer-events-none absolute inset-0 flex items-center justify-center">
            <span className="flex size-8 items-center justify-center rounded-full bg-background/60">
              <PlayIcon weight="fill" className="size-4" />
            </span>
          </span>
          {attachment.durationMs !== null && (
            <span
              data-testid="gallery-duration"
              className="pointer-events-none absolute right-1 bottom-1 rounded-full bg-background/60 px-2 text-xs font-medium whitespace-nowrap tabular-nums"
            >
              {formatDuration(attachment.durationMs)}
            </span>
          )}
        </>
      )}
    </button>
  )
}

/**
 * Shared media gallery (QT-5zd-gallery), opened from the chat header: a full-screen grid of every
 * ready photo and video either of you shared, newest first, grouped by month, loading older pages as
 * you scroll. A tile opens the viewer, which swipes across the whole gallery (QT-5zd-viewer).
 */
export function Gallery({ open, onClose, peer: initialPeer }: { open: boolean; onClose: () => void; peer: Profile }) {
  const peer = usePeer() ?? initialPeer
  useBackClose(open, onClose)
  const [data, setData] = useState<GalleryData>(INITIAL)
  const [viewerIndex, setViewerIndex] = useState<number | null>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const sentinelRef = useRef<HTMLDivElement>(null)
  /** Bumped on every open and close: responses of an earlier opening are dropped. */
  const generation = useRef(0)
  const inFlight = useRef(false)

  // Each opening starts from the newest page.
  const [wasOpen, setWasOpen] = useState(open)
  if (open !== wasOpen) {
    setWasOpen(open)
    if (open) {
      setData(INITIAL)
      setViewerIndex(null)
    }
  }

  /** One page request; its result lands through setData in the promise callbacks only. */
  function fetchPage(before: number | null): void {
    const gen = generation.current
    inFlight.current = true
    const query = `limit=${GALLERY_PAGE_DEFAULT}${before !== null ? `&before=${before}` : ""}`
    apiGet(`/api/media?${query}`, GalleryPage).then(
      (page) => {
        if (gen !== generation.current) return
        inFlight.current = false
        setData((d) => ({
          items: before === null ? page.items : mergeItems(d.items, page.items),
          next: page.next,
          hasMore: page.hasMore,
          status: "ready",
        }))
      },
      () => {
        if (gen !== generation.current) return
        inFlight.current = false
        setData((d) => ({ ...d, status: before === null ? "error" : "more-error" }))
      },
    )
  }

  const loadFirst = useEffectEvent(() => fetchPage(null))

  useEffect(() => {
    if (!open) return
    generation.current += 1
    inFlight.current = false
    loadFirst()
    return () => {
      generation.current += 1
      inFlight.current = false
    }
  }, [open])

  function retryFirst() {
    if (inFlight.current) return
    setData(INITIAL)
    fetchPage(null)
  }

  function loadMore() {
    if (inFlight.current || !data.hasMore || data.next === null) return
    if (data.status !== "ready" && data.status !== "more-error") return
    setData((d) => ({ ...d, status: "loading-more" }))
    fetchPage(data.next)
  }

  const onSentinel = useEffectEvent(() => {
    if (data.status === "ready") loadMore()
  })
  const canLoadMore = open && data.hasMore && data.status === "ready"

  // Infinite scroll: the sentinel after the grid, 800px early.
  useEffect(() => {
    const root = scrollRef.current
    const target = sentinelRef.current
    if (!canLoadMore || !root || !target) return
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) onSentinel()
      },
      { root, rootMargin: "800px 0px" },
    )
    observer.observe(target)
    return () => observer.disconnect()
  }, [canLoadMore, data.items.length])

  const sections = useMemo(() => {
    const fmt = new Intl.DateTimeFormat(undefined, { month: "long", year: "numeric" })
    const out: Array<{ label: string; entries: Array<{ item: GalleryItem; index: number }> }> = []
    data.items.forEach((item, index) => {
      const label = fmt.format(item.createdAt)
      const last = out[out.length - 1]
      if (last && last.label === label) last.entries.push({ item, index })
      else out.push({ label, entries: [{ item, index }] })
    })
    return out
  }, [data.items])

  const tiles = useMemo<AlbumTile[]>(
    () =>
      data.items.map(({ attachment }) => ({
        key: attachment.id,
        kind: attachment.kind,
        status: "ready",
        attachmentId: attachment.id,
        localUrl: null,
        progress: null,
        width: attachment.width,
        height: attachment.height,
        durationMs: attachment.durationMs,
      })),
    [data.items],
  )

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
      >
        <div className="box-content flex h-14 shrink-0 items-center gap-2 px-2 pt-[env(safe-area-inset-top)]">
          <DialogClose render={<Button variant="ghost" size="icon" aria-label="Back" />}>
            <ArrowLeftIcon />
          </DialogClose>
          <DialogTitle className="font-heading font-medium">Media</DialogTitle>
        </div>
        <div ref={scrollRef} data-testid="gallery" className="min-h-0 flex-1 overflow-y-auto pb-[env(safe-area-inset-bottom)]">
          <div className="flex flex-col items-center px-6 pt-4 pb-6">
            <PersonAvatar name={peer.displayName} photoId={peer.photoId} size="lg" className="size-24" fallbackClassName="text-xl font-medium" />
            <span className="mt-4 max-w-full truncate text-xl font-medium tracking-tight">{peer.displayName}</span>
          </div>

          {data.status === "loading" && (
            <div className="grid grid-cols-3 gap-0.5">
              {Array.from({ length: 12 }, (_, i) => (
                <Skeleton key={i} className="aspect-square rounded-none" />
              ))}
            </div>
          )}

          {data.status === "error" && (
            <Empty>
              <EmptyHeader>
                <EmptyTitle>Couldn&apos;t load your media</EmptyTitle>
              </EmptyHeader>
              <EmptyContent>
                <Button variant="outline" onClick={retryFirst}>
                  Retry
                </Button>
              </EmptyContent>
            </Empty>
          )}

          {data.status === "ready" && data.items.length === 0 && (
            <Empty>
              <EmptyHeader>
                <EmptyMedia variant="icon">
                  <ImagesIcon />
                </EmptyMedia>
                <EmptyTitle>No photos or videos yet</EmptyTitle>
                <EmptyDescription>Photos and videos you share show up here.</EmptyDescription>
              </EmptyHeader>
            </Empty>
          )}

          {sections.map((section) => (
            <section key={`${section.label}-${section.entries[0]!.index}`}>
              <h2 data-testid="gallery-month" className="px-4 py-2 text-sm font-medium text-muted-foreground">
                {section.label}
              </h2>
              <div className="grid grid-cols-3 gap-0.5">
                {section.entries.map(({ item, index }) => (
                  <GalleryTile key={item.attachment.id} item={item} onOpen={() => setViewerIndex(index)} />
                ))}
              </div>
            </section>
          ))}

          <div ref={sentinelRef} aria-hidden="true" className="h-px" />
          {data.status === "loading-more" && (
            <div className="flex justify-center py-4">
              <Spinner className="size-5 text-muted-foreground" />
            </div>
          )}
          {data.status === "more-error" && (
            <Marker className="cursor-pointer justify-center py-4" render={<button type="button" onClick={loadMore} />}>
              <MarkerContent>Couldn&apos;t load more. Tap to retry.</MarkerContent>
            </Marker>
          )}
        </div>
        <Viewer tiles={tiles} index={viewerIndex} caption={null} onClose={() => setViewerIndex(null)} onNearEnd={loadMore} />
      </DialogContent>
    </Dialog>
  )
}
