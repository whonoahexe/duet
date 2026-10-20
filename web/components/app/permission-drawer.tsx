"use client"

import { MicrophoneSlashIcon, VideoCameraSlashIcon } from "@phosphor-icons/react"
import { Button } from "@/components/ui/button"
import { Drawer, DrawerContent, DrawerFooter, DrawerHeader, DrawerTitle } from "@/components/ui/drawer"
import { useBackClose } from "@/lib/back-close"
import { isIos } from "@/lib/platform"

/** UI-SPEC Copywriting: permission body per platform, {microphone / camera} filled in. */
function permissionBody(device: "microphone" | "camera"): string {
  const Device = device === "microphone" ? "Microphone" : "Camera"
  return isIos()
    ? `duet needs the ${device} for calls. Open Settings › Apps › Safari › ${Device}, choose Allow or Ask, then close duet and open it again.`
    : `duet needs the ${device} for calls. Long-press the duet icon › App info › Permissions, allow ${Device}, then try again.`
}

/**
 * How to allow the microphone or camera again (D-19, UI-SPEC section 8). Nothing to retry until the
 * setting changes, so the only action is Close (outline, no accent).
 */
export function PermissionDrawer({
  open,
  onOpenChange,
  device,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  device: "microphone" | "camera"
}) {
  useBackClose(open, () => onOpenChange(false))
  const Icon = device === "microphone" ? MicrophoneSlashIcon : VideoCameraSlashIcon
  return (
    <Drawer open={open} onOpenChange={(next) => onOpenChange(next)}>
      <DrawerContent data-testid="permission-drawer">
        <DrawerHeader>
          <Icon className="mx-auto size-6 text-muted-foreground" />
          <DrawerTitle className="text-xl font-medium tracking-tight">
            {device === "microphone" ? "Allow the microphone" : "Allow the camera"}
          </DrawerTitle>
        </DrawerHeader>
        <div className="p-4 text-base leading-normal">
          <p>{permissionBody(device)}</p>
        </div>
        <DrawerFooter>
          <Button variant="outline" className="w-full" onClick={() => onOpenChange(false)}>
            Close
          </Button>
        </DrawerFooter>
      </DrawerContent>
    </Drawer>
  )
}
