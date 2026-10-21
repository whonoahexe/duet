"use client"

import { useRef, useState } from "react"
import { toast } from "sonner"
import { CameraIcon, ImageIcon, TrashIcon } from "@phosphor-icons/react"
import { ProfilePhotoResponse, UPLOAD_LIMITS } from "@duet/shared"
import { PersonAvatar } from "@/components/app/person-avatar"
import { Button } from "@/components/ui/button"
import { Drawer, DrawerContent, DrawerFooter, DrawerHeader, DrawerTitle } from "@/components/ui/drawer"
import { Spinner } from "@/components/ui/spinner"
import { apiPut } from "@/lib/api"
import { useBackClose } from "@/lib/back-close"
import { chatStore, useMe, usePeer } from "@/lib/chat/store"
import { uploadFile } from "@/lib/chat/upload"

type Busy = { stage: "uploading"; percent: number } | { stage: "processing" } | { stage: "removing" } | null

/**
 * Profile photo drawer from the header menu (QT-5zd-photo-ui): pick whose photo (photos are shared,
 * so either of you can change either one), then choose one from the library, take one with the front
 * camera, or remove it. The drawer stays open so the result is visible.
 */
export function ProfilePhotoDrawer({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const me = useMe()
  const peer = usePeer()
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [busy, setBusy] = useState<Busy>(null)
  const libraryRef = useRef<HTMLInputElement>(null)
  const cameraRef = useRef<HTMLInputElement>(null)
  useBackClose(open, () => onOpenChange(false))

  // The selection resets to you each time the drawer opens.
  const [wasOpen, setWasOpen] = useState(open)
  if (open !== wasOpen) {
    setWasOpen(open)
    if (open) setSelectedId(null)
  }

  const people = [me, peer].filter((p) => p !== null)
  const selected = people.find((p) => p.id === selectedId) ?? me

  async function handlePick(input: HTMLInputElement) {
    const file = input.files?.[0]
    input.value = ""
    if (!file || !selected || busy) return
    if (file.size > UPLOAD_LIMITS.image) {
      toast.error("Photos can be up to 100 MB.")
      return
    }
    const target = selected.id
    setBusy({ stage: "uploading", percent: 0 })
    try {
      const attachment = await uploadFile(file, "image", (percent) => setBusy({ stage: "uploading", percent }))
      setBusy({ stage: "processing" })
      const res = await apiPut(`/api/users/${target}/photo`, { attachmentId: attachment.id }, ProfilePhotoResponse)
      chatStore.applyProfile(res.userId, res.photoId)
    } catch {
      toast.error("Couldn't update the photo. Try again.")
    } finally {
      setBusy(null)
    }
  }

  async function handleRemove() {
    if (!selected || busy) return
    setBusy({ stage: "removing" })
    try {
      const res = await apiPut(`/api/users/${selected.id}/photo`, { attachmentId: null }, ProfilePhotoResponse)
      chatStore.applyProfile(res.userId, res.photoId)
    } catch {
      toast.error("Couldn't update the photo. Try again.")
    } finally {
      setBusy(null)
    }
  }

  const status =
    busy?.stage === "uploading" ? `Uploading ${busy.percent}%` : busy?.stage === "processing" ? "Processing…" : busy ? "Removing…" : null

  return (
    <Drawer open={open} onOpenChange={(next) => onOpenChange(next)}>
      <DrawerContent data-testid="profile-photo-drawer">
        <DrawerHeader>
          <DrawerTitle className="text-xl font-medium tracking-tight">Profile photo</DrawerTitle>
        </DrawerHeader>
        <div className="flex flex-col items-center gap-4 p-4 text-base leading-normal">
          <div className="flex w-full gap-2">
            {people.map((person) => {
              const pressed = person.id === selected?.id
              return (
                <Button
                  key={person.id}
                  className="min-w-0 flex-1"
                  variant={pressed ? "secondary" : "ghost"}
                  aria-pressed={pressed}
                  disabled={busy !== null}
                  onClick={() => setSelectedId(person.id)}
                >
                  <PersonAvatar name={person.displayName} photoId={person.photoId} className="size-6" />
                  <span className="truncate">{person.displayName}</span>
                </Button>
              )
            })}
          </div>
          <p className="text-sm text-muted-foreground">You both see the same photo.</p>
          {selected && (
            <PersonAvatar
              name={selected.displayName}
              photoId={selected.photoId}
              size="lg"
              className="size-32"
              fallbackClassName="text-3xl font-medium"
              data-testid="profile-current"
            />
          )}
          {status && (
            <div className="flex items-center gap-2 text-sm text-muted-foreground" data-testid="profile-status">
              <Spinner />
              {status}
            </div>
          )}
        </div>
        <DrawerFooter>
          <Button disabled={busy !== null || !selected} onClick={() => libraryRef.current?.click()}>
            <ImageIcon />
            Choose photo
          </Button>
          <Button variant="outline" disabled={busy !== null || !selected} onClick={() => cameraRef.current?.click()}>
            <CameraIcon />
            Take photo
          </Button>
          {selected?.photoId && (
            <Button variant="destructive" disabled={busy !== null} onClick={() => void handleRemove()}>
              <TrashIcon />
              Remove photo
            </Button>
          )}
          <input
            ref={libraryRef}
            type="file"
            accept="image/*"
            className="hidden"
            data-testid="profile-photo-input"
            onChange={(e) => void handlePick(e.currentTarget)}
          />
          <input
            ref={cameraRef}
            type="file"
            accept="image/*"
            capture="user"
            className="hidden"
            data-testid="profile-camera-input"
            onChange={(e) => void handlePick(e.currentTarget)}
          />
        </DrawerFooter>
      </DrawerContent>
    </Drawer>
  )
}
