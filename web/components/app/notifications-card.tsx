"use client"

import { useState } from "react"
import { toast } from "sonner"
import { BellRingingIcon } from "@phosphor-icons/react"
import { Button } from "@/components/ui/button"
import { Card, CardAction, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card"
import { Spinner } from "@/components/ui/spinner"
import { enablePush, type PushState } from "@/lib/chat/push"

/**
 * "Turn on notifications" card (SHEL-03, NOTF-01, D-16): pinned between the header and the
 * messages in the installed app until push is on. It has no close control while notifications are
 * off ("stays until done"), and it never blocks reading or sending messages.
 */
export function NotificationsCard({
  peerName,
  state,
  onStateChange,
}: {
  peerName: string
  state: PushState
  onStateChange: (state: PushState) => void
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

  if (state !== "off") return null

  return (
    <div className="shrink-0 px-4 pt-4">
      <Card size="sm" data-testid="notifications-card">
        <CardHeader>
          <CardTitle>Turn on notifications</CardTitle>
          <CardDescription>Get a notification when {peerName} messages you while duet is closed.</CardDescription>
          <CardAction>
            <BellRingingIcon className="size-5 text-muted-foreground" aria-hidden />
          </CardAction>
        </CardHeader>
        <CardFooter>
          <Button disabled={busy} onClick={() => void handleEnable()}>
            {busy && <Spinner />}
            Enable notifications
          </Button>
        </CardFooter>
      </Card>
    </div>
  )
}
