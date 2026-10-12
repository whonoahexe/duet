"use client"

import { useState } from "react"
import type { AttachmentKind } from "@duet/shared"
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

/** Natural aspect ratio clamped between 3:4 and 4:3 (UI-SPEC, one-item album). */
function clampedRatio(w: number | null, h: number | null): number {
  if (!w || !h) return 4 / 3
  return Math.min(4 / 3, Math.max(3 / 4, w / h))
}

function thumbSrc(tile: AlbumTile): string | null {
  if (tile.status === "ready" && tile.attachmentId) return `/media/${encodeURIComponent(tile.attachmentId)}/thumb`
  return tile.localUrl
}

function Tile({ tile, className, style }: { tile: AlbumTile; className?: string; style?: React.CSSProperties }) {
  const [natural, setNatural] = useState<{ w: number; h: number } | null>(null)
  const src = thumbSrc(tile)
  return (
    <div
      data-testid="album-tile"
      data-status={tile.status}
      className={cn("relative overflow-hidden bg-muted", className)}
      style={style ?? { aspectRatio: clampedRatio(tile.width ?? natural?.w ?? null, tile.height ?? natural?.h ?? null) }}
    >
      {src && (
        // eslint-disable-next-line @next/next/no-img-element -- static export; media is auth-gated
        <img
          src={src}
          alt=""
          draggable={false}
          className="absolute inset-0 size-full object-cover"
          onLoad={(e) => {
            const img = e.currentTarget
            if (!natural) setNatural({ w: img.naturalWidth, h: img.naturalHeight })
          }}
        />
      )}
      {tile.status === "uploading" && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-1 bg-background/40">
          <Spinner className="size-6 text-primary" />
          <span className="text-xs font-medium tabular-nums">{tile.progress ?? 0}%</span>
        </div>
      )}
      {tile.status === "processing" && !src && (
        <div className="absolute inset-0 flex items-center justify-center">
          <Spinner className="size-6 text-muted-foreground" />
        </div>
      )}
    </div>
  )
}

/**
 * Album grid (D-07, UI-SPEC "Album bubble"): server thumbnails, or your local previews while sending.
 * Lives inside a ghost Bubble (w-72, rounded-3xl, overflow hidden).
 */
export function Album({ tiles, className }: { tiles: AlbumTile[]; className?: string }) {
  return (
    <div data-testid="album" className={cn("grid w-full gap-1 overflow-hidden rounded-3xl", className)}>
      {tiles.slice(0, 1).map((tile) => (
        <Tile key={tile.key} tile={tile} className="w-full" />
      ))}
    </div>
  )
}
