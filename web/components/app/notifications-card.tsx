"use client"

import { useState } from "react"
import { toast } from "sonner"
import { BellRingingIcon } from "@phosphor-icons/react"
import { Button } from "@/components/ui/button"
import { Card, CardAction, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card"
import { Spinner } from "@/components/ui/spinner"
import { blockedInstructions, enablePush, sendTestPush, type PushState } from "@/lib/chat/push"

/**
 * "Turn on notifications" card (SHEL-03, NOTF-01, D-16): pinned between the header and the
 * messages in the installed app until push is on. It has no close control while notifications are
 * off or blocked ("stays until done"), and it never blocks reading or sending messages. After a
 * successful Enable it reads "Notifications are on" with "Send test notification" and "Hide card".
 */
export function NotificationsCard({
  peerName,
  state,
  onStateChange,
  onHide,
}: {
  peerName: string
  state: PushState
  onStateChange: (state: PushState) => void
  onHide: () => void
}) {
  const [busy, setBusy] = useState(false)

  async function handleEnable() {
    if (busy) return
    setBusy(true)
    try {
      onStateChange(await enablePush())
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

  if (state === "unsupported") return null

  const title =
    state === "on" ? "Notifications are on" : state === "blocked" ? "Notifications are blocked" : "Turn on notifications"

  return (
    <div className="shrink-0 px-4 pt-4">
      <Card size="sm" data-testid="notifications-card">
        <CardHeader>
          <CardTitle>{title}</CardTitle>
          {state === "off" && (
            <CardDescription>Get a notification when {peerName} messages you while duet is closed.</CardDescription>
          )}
          {state === "blocked" && <CardDescription>{blockedInstructions()}</CardDescription>}
          <CardAction>
            <BellRingingIcon className="size-5 text-muted-foreground" aria-hidden />
          </CardAction>
        </CardHeader>
        {state === "off" && (
          <CardFooter>
            <Button disabled={busy} onClick={() => void handleEnable()}>
              {busy && <Spinner />}
              Enable notifications
            </Button>
          </CardFooter>
        )}
        {state === "on" && (
          <CardFooter className="gap-2">
            <Button variant="outline" disabled={busy} onClick={() => void handleTest()}>
              {busy && <Spinner />}
              Send test notification
            </Button>
            <Button variant="ghost" onClick={onHide}>
              Hide card
            </Button>
          </CardFooter>
        )}
      </Card>
    </div>
  )
}
