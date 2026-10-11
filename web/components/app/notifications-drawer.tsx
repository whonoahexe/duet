"use client"

import { useEffect, useState } from "react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Drawer, DrawerContent, DrawerFooter, DrawerHeader, DrawerTitle } from "@/components/ui/drawer"
import { Spinner } from "@/components/ui/spinner"
import { blockedInstructions, enablePush, getPushState, sendTestPush, type PushState } from "@/lib/chat/push"
import { isIos, isStandalone } from "@/lib/platform"

/**
 * Notifications drawer from the header menu (D-16, UI-SPEC section 6): the current state of this
 * phone with the matching action. In iOS Safari outside the installed app push cannot work, so it
 * only points at the Home Screen.
 */
export function NotificationsDrawer({
  open,
  onOpenChange,
  onStateChange,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Lets the shell's card follow a change made here. */
  onStateChange?: (state: PushState) => void
}) {
  const [state, setState] = useState<PushState | "ios-browser" | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (!open) return
    let cancelled = false
    const decide = async (): Promise<PushState | "ios-browser"> =>
      isIos() && !isStandalone() ? "ios-browser" : getPushState()
    void decide().then((s) => {
      if (!cancelled) setState(s)
    })
    return () => {
      cancelled = true
    }
  }, [open])

  async function handleEnable() {
    if (busy) return
    setBusy(true)
    try {
      const next = await enablePush()
      setState(next)
      onStateChange?.(next)
    } catch {
      toast.error("Couldn't turn on notifications. Try again.")
    } finally {
      setBusy(false)
    }
  }

  async function handleTest() {
    if (busy) return
    setBusy(true)
    try {
      await sendTestPush()
    } finally {
      setBusy(false)
    }
  }

  return (
    <Drawer open={open} onOpenChange={(next) => onOpenChange(next)}>
      <DrawerContent data-testid="notifications-drawer">
        <DrawerHeader>
          <DrawerTitle className="text-xl font-medium tracking-tight">Notifications</DrawerTitle>
        </DrawerHeader>
        <div className="flex flex-col gap-2 p-4 text-base leading-normal">
          {state === null && (
            <div className="flex justify-center py-2">
              <Spinner className="size-5" />
            </div>
          )}
          {state === "ios-browser" && <p>Add duet to your Home Screen first to get notifications.</p>}
          {state === "on" && <p>Notifications are on for this phone.</p>}
          {(state === "off" || state === "unsupported") && <p>Notifications are off for this phone.</p>}
          {state === "blocked" && (
            <>
              <p>Notifications are blocked</p>
              <p className="text-muted-foreground">{blockedInstructions()}</p>
            </>
          )}
        </div>
        {(state === "off" || state === "on") && (
          <DrawerFooter>
            {state === "off" ? (
              <Button disabled={busy} onClick={() => void handleEnable()}>
                {busy && <Spinner />}
                Enable notifications
              </Button>
            ) : (
              <Button variant="outline" disabled={busy} onClick={() => void handleTest()}>
                {busy && <Spinner />}
                Send test notification
              </Button>
            )}
          </DrawerFooter>
        )}
      </DrawerContent>
    </Drawer>
  )
}
