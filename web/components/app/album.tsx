"use client"

import { useState } from "react"
import { ImageBrokenIcon } from "@phosphor-icons/react"
import type { AttachmentKind } from "@duet/shared"
import { Viewer } from "@/components/app/viewer"
import { Spinner } from "@/components/ui/spinner"
import { cn } from "@/lib/utils"

/** One album tile, from a stored attachment or from an item still uploading. */
export interface AlbumTile {
  key: string
  kind: AttachmentKind
  /**
   * uploading = bytes still going up (progress overlay); local = uploaded or waiting to retry, shown
   * from your local preview; processing = the server is making the display copy; failed = it could not.
   */
  status: "uploading" | "local" | "processing" | "ready" | "failed"
  attachmentId: string | null
  /** Your own local preview (object URL) until the server copy is ready. */
  localUrl: string | null
  /** Upload percent while uploading. */
  progress: number | null
  width: number | null
  height: number | null
}

/** Tiles drawn in the grid: at most four; the fourth carries "+N" when there are more. */
const GRID_MAX = 4

/** Natural aspect ratio clamped between 3:4 and 4:3 (UI-SPEC, one-item album). */
function clampedRatio(w: number | null, h: number | null): number {
  if (!w || !h) return 4 / 3
  return Math.min(4 / 3, Math.max(3 / 4, w / h))
}

function thumbSrc(tile: AlbumTile, attempt: number): string | null {
  if (tile.status === "ready" && tile.attachmentId) {
    const base = `/media/${encodeURIComponent(tile.attachmentId)}/thumb`
    // A retry after a failed load bypasses the browser's memory of the failure.
    return attempt > 0 ? `${base}?r=${attempt}` : base
  }
  return tile.localUrl
}

/** "Couldn't load" tile body (UI-SPEC: ImageBrokenIcon, 12px destructive text). */
function Broken() {
  return (
    <span className="absolute inset-0 flex flex-col items-center justify-center gap-1 text-xs text-destructive">
      <ImageBrokenIcon className="size-6" />
      Couldn&apos;t load
    </span>
  )
}

function Tile({
  tile,
  index,
  total,
  more,
  className,
  style,
  onOpen,
  onNatural,
}: {
  tile: AlbumTile
  index: number
  total: number
  /** Items beyond the grid ("+N" on the fourth tile). */
  more: number
  className?: string
  style?: React.CSSProperties
  onOpen?: (index: number) => void
  /** Reports the loaded image's natural size (one-item albums take its aspect ratio). */
  onNatural?: (w: number, h: number) => void
}) {
  const [attempt, setAttempt] = useState(0)
  const [loadFailed, setLoadFailed] = useState(false)
  const src = thumbSrc(tile, attempt)
  const broken = tile.status === "failed" || (loadFailed && tile.status === "ready")

  function activate(e: React.SyntheticEvent) {
    if (broken && tile.status === "ready") {
      e.stopPropagation()
      setLoadFailed(false)
      setAttempt((a) => a + 1)
      return
    }
    if (onOpen && tile.status === "ready") {
      e.stopPropagation()
      onOpen(index)
    }
  }
  const interactive = tile.status === "ready" && (broken || !!onOpen)

  return (
    <div
      data-testid="album-tile"
      data-status={broken ? "broken" : tile.status}
      className={cn("relative overflow-hidden bg-muted", interactive && "cursor-pointer", className)}
      style={style}
      {...(interactive
        ? {
            role: "button",
            tabIndex: 0,
            "aria-label": broken ? "Couldn't load. Tap to retry" : `Open photo ${index + 1} of ${total}`,
            onClick: activate,
            onKeyDown: (e: React.KeyboardEvent) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault()
                activate(e)
              }
            },
          }
        : {})}
    >
      {src && !broken && (
        // eslint-disable-next-line @next/next/no-img-element -- static export; media is auth-gated
        <img
          src={src}
          alt=""
          draggable={false}
          className="absolute inset-0 size-full object-cover"
          onLoad={(e) => onNatural?.(e.currentTarget.naturalWidth, e.currentTarget.naturalHeight)}
          onError={() => {
            if (tile.status === "ready") setLoadFailed(true)
          }}
        />
      )}
      {broken && <Broken />}
      {tile.status === "uploading" && (
        <span className="absolute inset-0 flex flex-col items-center justify-center gap-1 bg-background/40">
          <Spinner className="size-6 text-primary" />
          <span className="text-xs font-medium tabular-nums">{tile.progress ?? 0}%</span>
        </span>
      )}
      {tile.status === "processing" && !src && (
        <span className="absolute inset-0 flex items-center justify-center">
          <Spinner className="size-6 text-muted-foreground" />
        </span>
      )}
      {more > 0 && (
        <span
          data-testid="album-more"
          className="pointer-events-none absolute inset-0 flex items-center justify-center bg-background/60 text-xl font-medium"
        >
          +{more}
        </span>
      )}
    </div>
  )
}

/**
 * Album grid (D-07, UI-SPEC "Album bubble") inside a ghost Bubble: 1 item at its natural aspect
 * (clamped 3:4..4:3), 2 squares, a 2:1 tile over 2 squares, 2x2, or 2x2 with "+N" on the fourth for
 * 5-10. 4px gaps. Tapping a ready tile opens the full-screen viewer at that item (openable albums).
 */
export function Album({
  tiles,
  caption = null,
  openable = false,
  className,
}: {
  tiles: AlbumTile[]
  caption?: string | null
  /** Stored messages open the viewer; an album still sending does not. */
  openable?: boolean
  className?: string
}) {
  const [viewerIndex, setViewerIndex] = useState<number | null>(null)
  const [natural, setNatural] = useState<{ w: number; h: number } | null>(null)
  const n = tiles.length
  const shown = tiles.slice(0, GRID_MAX)
  const onOpen = openable ? setViewerIndex : undefined

  return (
    <>
      <div
        data-testid="album"
        data-count={n}
        className={cn("grid w-full grid-cols-2 gap-1 overflow-hidden rounded-3xl", className)}
      >
        {shown.map((tile, i) => {
          let cls = "aspect-square"
          let style: React.CSSProperties | undefined
          if (n === 1) {
            cls = "col-span-2"
            style = { aspectRatio: clampedRatio(tile.width ?? natural?.w ?? null, tile.height ?? natural?.h ?? null) }
          } else if (n === 3 && i === 0) {
            cls = "col-span-2 aspect-[2/1]"
          }
          return (
            <Tile
              key={tile.key}
              tile={tile}
              index={i}
              total={n}
              more={i === GRID_MAX - 1 && n > GRID_MAX ? n - GRID_MAX : 0}
              className={cls}
              style={style}
              onOpen={onOpen}
              onNatural={n === 1 && !natural ? (w, h) => setNatural({ w, h }) : undefined}
            />
          )
        })}
      </div>
      {openable && <Viewer tiles={tiles} index={viewerIndex} caption={caption} onClose={() => setViewerIndex(null)} />}
    </>
  )
}
