"use client"

import { PhoneDisconnectIcon, PhoneIcon, VideoCameraIcon } from "@phosphor-icons/react"
import { CallIdentity, FULL_SCREEN_DIALOG, SOLID_DESTRUCTIVE } from "@/components/app/call-screen"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog"
import { Spinner } from "@/components/ui/spinner"
import { callStore, useCall } from "@/lib/call/store"
import { usePeer } from "@/lib/chat/store"

/**
 * Incoming-call screen (UI-SPEC section 3): Mode A identity with Decline and Accept. There is no
 * Escape / Back dismissal; only Decline, Accept, the caller cancelling, the timeout or another device
 * answering close it.
 */
export function IncomingCall() {
  const call = useCall()
  // The caller's shared photo (QT-5zd-photo-calls), through the narrow hook (no re-render per message).
  const peerPhotoId = usePeer()?.photoId ?? null
  const open = call.phase === "ringing-in"
  const AcceptIcon = call.kind === "video" ? VideoCameraIcon : PhoneIcon

  return (
    <Dialog open={open} disablePointerDismissal>
      <DialogContent showCloseButton={false} className={FULL_SCREEN_DIALOG}>
        <DialogTitle className="sr-only">Incoming call from {call.peerName}</DialogTitle>
        <CallIdentity
          name={call.peerName}
          photoId={peerPhotoId}
          status={call.kind === "video" ? "Incoming video call" : "Incoming voice call"}
        />
        <div className="flex-1" />
        <div className="mx-auto mb-[max(24px,env(safe-area-inset-bottom))] flex items-start gap-12 py-4">
          <div className="flex flex-col items-center gap-2">
            <Button
              size="icon"
              variant="destructive"
              className={`size-16 rounded-full ${SOLID_DESTRUCTIVE}`}
              aria-label="Decline"
              onClick={() => callStore.declineCall()}
            >
              <PhoneDisconnectIcon weight="fill" className="size-6" />
            </Button>
            <span className="text-sm font-medium" aria-hidden="true">
              Decline
            </span>
          </div>
          <div className="flex flex-col items-center gap-2">
            <Button
              size="icon"
              variant="default"
              className="size-16 rounded-full"
              aria-label="Accept"
              disabled={call.accepting}
              onClick={() => void callStore.acceptCall()}
            >
              {call.accepting ? <Spinner className="size-6" /> : <AcceptIcon weight="fill" className="size-6" />}
            </Button>
            <span className="text-sm font-medium" aria-hidden="true">
              Accept
            </span>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
