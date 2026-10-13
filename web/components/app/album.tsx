"use client"

import { useState } from "react"
import { ImageBrokenIcon, PlayIcon, VideoCameraIcon } from "@phosphor-icons/react"
import { formatDuration, type AttachmentKind } from "@duet/shared"
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
  /** Video length from the server (D-08); null for photos and items not processed yet. */
  durationMs: number | null
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
    // A video's tile is its poster frame (Pitfall 10: only requested once the attachment is ready).
    const variant = tile.kind === "video" ? "poster" : "thumb"
    const base = `/media/${encodeURIComponent(tile.attachmentId)}/${variant}`
    // A retry after a failed load bypasses the browser's memory of the failure.
    return attempt > 0 ? `${base}?r=${attempt}` : base
  }
  return tile.localUrl
}

/** "Couldn't load" tile body (UI-SPEC: ImageBrokenIcon, or VideoCameraIcon for a video; 12px destructive text). */
function Broken({ kind }: { kind: AttachmentKind }) {
  return (
    <span className="absolute inset-0 flex flex-col items-center justify-center gap-1 text-xs text-destructive">
      {kind === "video" ? <VideoCameraIcon className="size-6" /> : <ImageBrokenIcon className="size-6" />}
      Couldn&apos;t load
    </span>
  )
}

/** A transcode that failed (D-08, UI-SPEC "Failures"): shown to both people. */
function TranscodeFailed() {
  return (
    <span
      data-testid="video-failed"
      className="absolute inset-0 flex flex-col items-center justify-center gap-1 px-2 text-center text-xs text-destructive"
    >
      <VideoCameraIcon className="size-6" />
      Couldn&apos;t process this video
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
  const video = tile.kind === "video"
  const src = thumbSrc(tile, attempt)
  const broken = tile.status === "failed" || (loadFailed && tile.status === "ready")
  // Your own clip before the poster exists: the local file itself, first frame, never playing.
  const localVideo = video && tile.status !== "ready" && tile.status !== "processing" && tile.localUrl !== null

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
            "aria-label": broken
              ? "Couldn't load. Tap to retry"
              : `Open ${video ? "video" : "photo"} ${index + 1} of ${total}`,
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
      {localVideo && !broken && (
        <video
          src={`${tile.localUrl}#t=0.1`}
          muted
          playsInline
          preload="metadata"
          className="absolute inset-0 size-full object-cover"
        />
      )}
      {src && !broken && !localVideo && !(video && tile.status === "processing") && (
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
      {broken && (video && tile.status === "failed" ? <TranscodeFailed /> : <Broken kind={tile.kind} />)}
      {video && tile.status === "ready" && !broken && (
        <>
          <span className="pointer-events-none absolute inset-0 flex items-center justify-center">
            <span className="flex size-10 items-center justify-center rounded-full bg-background/60">
              <PlayIcon weight="fill" className="size-5" />
            </span>
          </span>
          {tile.durationMs !== null && more === 0 && (
            <span
              data-testid="video-duration"
              className="pointer-events-none absolute right-2 bottom-2 rounded-full bg-background/60 px-2 text-xs font-medium whitespace-nowrap tabular-nums"
            >
              {formatDuration(tile.durationMs)}
            </span>
          )}
        </>
      )}
      {video && tile.status === "processing" && (
        <span
          data-testid="video-processing"
          className="absolute inset-0 flex flex-col items-center justify-center gap-1 bg-muted text-xs font-medium"
        >
          <Spinner className="size-6 text-muted-foreground" />
          Processing…
        </span>
      )}
      {tile.status === "uploading" && (
        <span className="absolute inset-0 flex flex-col items-center justify-center gap-1 bg-background/40">
          <Spinner className="size-6 text-primary" />
          <span className="text-xs font-medium tabular-nums">{tile.progress ?? 0}%</span>
        </span>
      )}
      {!video && tile.status === "processing" && !src && (
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
