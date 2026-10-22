"use client"

import { useEffect, useRef, useState } from "react"
import {
  CROP_MIN_SIDE,
  centredSquare,
  cropToPixels,
  fullCrop,
  moveCrop,
  resizeCrop,
  scaleCrop,
  squareAround,
  type CropBounds,
  type CropCorner,
  type CropRect,
} from "@duet/shared"
import { FULL_SCREEN_DIALOG } from "@/components/app/call-screen"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog"
import { Spinner } from "@/components/ui/spinner"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import { useBackClose } from "@/lib/back-close"
import { cn } from "@/lib/utils"

/** Smallest crop side on screen, in CSS pixels, so the corner handles never overlap into nothing. */
const MIN_BOX_PX = 48
/** Long edge of the local cropped preview (display only, never uploaded). */
const PREVIEW_EDGE = 1280

type Aspect = "free" | "square"

const CORNERS: Array<{ corner: CropCorner; className: string }> = [
  { corner: "nw", className: "top-0 left-0 -translate-x-1/2 -translate-y-1/2" },
  { corner: "ne", className: "top-0 right-0 translate-x-1/2 -translate-y-1/2" },
  { corner: "sw", className: "bottom-0 left-0 -translate-x-1/2 translate-y-1/2" },
  { corner: "se", className: "right-0 bottom-0 translate-x-1/2 translate-y-1/2" },
]

type Gesture =
  | { kind: "move"; start: CropRect; x: number; y: number }
  | { kind: "resize"; corner: CropCorner; start: CropRect; x: number; y: number }
  | { kind: "pinch"; start: CropRect; distance: number }

interface Size {
  width: number
  height: number
}

/**
 * Full-screen photo cropper (QT-m25-cropper, N-02). Hand-written with pointer events: one finger on
 * the box moves it, one finger on a corner handle resizes it, two fingers anywhere pinch it.
 * "profile" mode is the fixed 1:1 circle frame of a profile photo (N-03); "photo" mode offers Free
 * and Square per photo in the send preview (N-04). The phone only picks the rect: Save hands back a
 * normalised rect relative to the upright image, and the untouched original is what gets uploaded
 * (N-05). Open while src is non-null. Render it inside the parent drawer's content, so the drawer
 * treats it as a nested popup and never takes a crop drag as a swipe.
 */
export function CropDialog({
  src,
  mode,
  initial,
  onSave,
  onCancel,
  onUnrenderable,
}: {
  /** Object URL of the original photo. */
  src: string | null
  mode: "profile" | "photo"
  initial: CropRect | null
  onSave: (rect: CropRect) => void | Promise<void>
  onCancel: () => void
  /** The browser could not draw the photo (HEIC in Chrome). */
  onUnrenderable: () => void
}) {
  const open = src !== null
  // The last photo stays drawn while the dialog animates closed.
  const [shown, setShown] = useState(src)
  if (src !== null && src !== shown) setShown(src)
  useBackClose(open, onCancel)

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onCancel()
      }}
    >
      <DialogContent showCloseButton={false} className={FULL_SCREEN_DIALOG} data-testid="cropper">
        {shown !== null && (
          <CropBody
            key={shown}
            src={shown}
            mode={mode}
            initial={initial}
            onSave={onSave}
            onCancel={onCancel}
            onUnrenderable={onUnrenderable}
          />
        )}
      </DialogContent>
    </Dialog>
  )
}

function CropBody({
  src,
  mode,
  initial,
  onSave,
  onCancel,
  onUnrenderable,
}: {
  src: string
  mode: "profile" | "photo"
  initial: CropRect | null
  onSave: (rect: CropRect) => void | Promise<void>
  onCancel: () => void
  onUnrenderable: () => void
}) {
  const stageRef = useRef<HTMLDivElement>(null)
  const [stage, setStage] = useState<Size | null>(null)
  /** The photo's upright size: browsers draw JPEGs EXIF-upright, like the server's rotate(). */
  const [natural, setNatural] = useState<Size | null>(null)
  const [rect, setRect] = useState<CropRect | null>(null)
  const [aspect, setAspect] = useState<Aspect>("free")
  const [saving, setSaving] = useState(false)
  const rectRef = useRef<CropRect | null>(null)
  const pointers = useRef(new Map<number, { x: number; y: number }>())
  const gesture = useRef<Gesture | null>(null)

  useEffect(() => {
    const el = stageRef.current
    if (!el) return
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setStage({ width: entry.contentRect.width, height: entry.contentRect.height })
    })
    observer.observe(el)
    return () => observer.disconnect()
  }, [])

  // The photo contain-fitted into the stage.
  const fit =
    stage && natural && stage.width > 0 && stage.height > 0
      ? (() => {
          const scale = Math.min(stage.width / natural.width, stage.height / natural.height)
          return { width: natural.width * scale, height: natural.height * scale }
        })()
      : null
  const square = mode === "profile" || aspect === "square"

  function update(next: CropRect) {
    rectRef.current = next
    setRect(next)
  }

  function bounds(): CropBounds | null {
    if (!natural || !fit) return null
    return {
      width: natural.width,
      height: natural.height,
      minW: Math.max(CROP_MIN_SIDE, MIN_BOX_PX / fit.width),
      minH: Math.max(CROP_MIN_SIDE, MIN_BOX_PX / fit.height),
      square,
    }
  }

  function onLoad(img: HTMLImageElement) {
    const size = { width: img.naturalWidth, height: img.naturalHeight }
    if (size.width === 0 || size.height === 0) {
      onUnrenderable()
      return
    }
    setNatural(size)
    update(mode === "profile" ? centredSquare(size.width, size.height) : (initial ?? fullCrop()))
  }

  function chooseAspect(next: Aspect) {
    setAspect(next)
    const current = rectRef.current
    if (next === "square" && current && natural) update(squareAround(current, natural.width, natural.height))
  }

  /** The two tracked pointers' distance (pinch). */
  function spread(): number {
    const [a, b] = [...pointers.current.values()]
    return a && b ? Math.hypot(a.x - b.x, a.y - b.y) : 0
  }

  /** A one-pointer move from the current rect (also after the second finger of a pinch lifts). */
  function startMove(x: number, y: number) {
    const current = rectRef.current
    gesture.current = current ? { kind: "move", start: current, x, y } : null
  }

  // Every handler stops propagation: the dialog is portalled, but React events still bubble through
  // the React tree to the parent drawer, which must never take a crop drag as a swipe.
  function onPointerDown(e: React.PointerEvent<HTMLDivElement>) {
    e.stopPropagation()
    const current = rectRef.current
    if (!current || !fit) return
    e.currentTarget.setPointerCapture(e.pointerId)
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY })
    if (pointers.current.size === 2) {
      gesture.current = { kind: "pinch", start: current, distance: spread() }
    } else if (pointers.current.size === 1) {
      const target = e.target as HTMLElement
      const handle = target.closest<HTMLElement>("[data-handle]")?.dataset.handle as CropCorner | undefined
      if (handle) gesture.current = { kind: "resize", corner: handle, start: current, x: e.clientX, y: e.clientY }
      else if (target.closest("[data-testid=crop-box]")) startMove(e.clientX, e.clientY)
      else gesture.current = null
    }
  }

  function onPointerMove(e: React.PointerEvent<HTMLDivElement>) {
    e.stopPropagation()
    if (!pointers.current.has(e.pointerId)) return
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY })
    const g = gesture.current
    const b = bounds()
    if (!g || !b || !fit) return
    if (g.kind === "pinch") {
      const distance = spread()
      if (g.distance > 0 && distance > 0) update(scaleCrop(g.start, distance / g.distance, b))
      return
    }
    const dx = (e.clientX - g.x) / fit.width
    const dy = (e.clientY - g.y) / fit.height
    update(g.kind === "move" ? moveCrop(g.start, dx, dy) : resizeCrop(g.start, g.corner, dx, dy, b))
  }

  function onPointerEnd(e: React.PointerEvent<HTMLDivElement>) {
    e.stopPropagation()
    if (!pointers.current.delete(e.pointerId)) return
    const rest = [...pointers.current.values()]
    if (rest.length === 1 && gesture.current?.kind === "pinch") startMove(rest[0]!.x, rest[0]!.y)
    else if (rest.length === 0) gesture.current = null
  }

  async function save() {
    const current = rectRef.current
    if (!current || saving) return
    setSaving(true)
    try {
      await onSave(current)
    } finally {
      setSaving(false)
    }
  }

  return (
    <>
      <div className="box-content flex h-14 shrink-0 items-center justify-center px-4 pt-[env(safe-area-inset-top)]">
        <DialogTitle className="text-base font-medium">Crop photo</DialogTitle>
      </div>
      <div ref={stageRef} className="relative flex min-h-0 flex-1 touch-none items-center justify-center p-4 select-none">
        {!fit && <Spinner className="size-6 text-muted-foreground" />}
        <div
          className="relative touch-none select-none"
          style={fit ? { width: fit.width, height: fit.height } : { width: 0, height: 0 }}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerEnd}
          onPointerCancel={onPointerEnd}
        >
          {/* eslint-disable-next-line @next/next/no-img-element -- local object URL of the picked photo */}
          <img
            src={src}
            alt=""
            draggable={false}
            className="pointer-events-none absolute inset-0 size-full select-none"
            onLoad={(e) => onLoad(e.currentTarget)}
            onError={onUnrenderable}
          />
          {fit && rect && (
            <>
              {/* The dimmed outside, clipped to the photo. */}
              <div className="pointer-events-none absolute inset-0 overflow-hidden">
                <div
                  className={cn(
                    "absolute shadow-[0_0_0_9999px_color-mix(in_oklab,var(--color-background)_60%,transparent)]",
                    mode === "profile" && "rounded-full",
                  )}
                  style={box(rect)}
                />
              </div>
              <div
                data-testid="crop-box"
                className={cn("absolute cursor-move ring-2 ring-foreground", mode === "profile" && "rounded-full")}
                style={box(rect)}
              >
                {CORNERS.map(({ corner, className }) => (
                  <div
                    key={corner}
                    data-handle={corner}
                    className={cn("absolute flex size-10 items-center justify-center", className)}
                  >
                    <span className="size-3 rounded-full bg-foreground" />
                  </div>
                ))}
              </div>
            </>
          )}
        </div>
      </div>
      <div className="flex shrink-0 flex-col gap-3 px-4 pt-2 pb-[max(16px,env(safe-area-inset-bottom))]">
        {mode === "photo" && (
          <ToggleGroup
            aria-label="Aspect"
            variant="outline"
            className="self-center"
            value={[aspect]}
            onValueChange={(next) => {
              const picked = next.find((v) => v !== aspect) ?? next[0]
              if (picked === "free" || picked === "square") chooseAspect(picked)
            }}
          >
            <ToggleGroupItem value="free">Free</ToggleGroupItem>
            <ToggleGroupItem value="square">Square</ToggleGroupItem>
          </ToggleGroup>
        )}
        <div className="flex gap-2">
          <Button variant="ghost" size="lg" className="flex-1" onClick={onCancel}>
            Cancel
          </Button>
          <Button size="lg" className="flex-1" disabled={!rect || saving} onClick={() => void save()}>
            {saving && <Spinner />}
            Save
          </Button>
        </div>
      </div>
    </>
  )
}

/** A rect as percentage CSS box. */
function box(rect: CropRect): React.CSSProperties {
  return {
    left: `${rect.x * 100}%`,
    top: `${rect.y * 100}%`,
    width: `${rect.w * 100}%`,
    height: `${rect.h * 100}%`,
  }
}

/**
 * A local preview of a crop (QT-m25-send-crop): src decoded, the rect drawn onto a canvas with the
 * long edge at most 1280 px, as a JPEG object URL. Display only, in the preview drawer and the
 * sending bubble until the server copy is ready; the upload is always the original (N-05). Null on
 * any failure.
 */
export async function cropPreviewUrl(src: string, rect: CropRect): Promise<string | null> {
  try {
    const img = new Image()
    img.src = src
    await img.decode()
    const px = cropToPixels(rect, img.naturalWidth, img.naturalHeight)
    const scale = Math.min(1, PREVIEW_EDGE / Math.max(px.width, px.height))
    const canvas = document.createElement("canvas")
    canvas.width = Math.max(1, Math.round(px.width * scale))
    canvas.height = Math.max(1, Math.round(px.height * scale))
    const ctx = canvas.getContext("2d")
    if (!ctx) return null
    ctx.drawImage(img, px.left, px.top, px.width, px.height, 0, 0, canvas.width, canvas.height)
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.85))
    return blob ? URL.createObjectURL(blob) : null
  } catch {
    return null
  }
}
