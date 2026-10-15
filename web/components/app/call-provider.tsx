"use client"

import { useEffect, useRef } from "react"
import type { MeResponse } from "@duet/shared"
import { CallScreen } from "@/components/app/call-screen"
import { IncomingCall } from "@/components/app/incoming-call"
import { PermissionDrawer } from "@/components/app/permission-drawer"
import { callStore, useCall } from "@/lib/call/store"
import { onRealtimeFrame } from "@/lib/chat/realtime"

/**
 * The app-level call layer, mounted in Shell above the chat (D-06): it binds the call store to the
 * tab's realtime frames, plays the remote audio and renders the call and incoming screens.
 *
 * Its effect runs before Shell's startRealtime effect (child effects run first), so a call.ring sent
 * right after hello is never missed. The <audio> sink lives here, never inside a Dialog: DialogContent
 * portals and unmounts, which would cut the audio when the call screen closes.
 */
export function CallProvider({ me }: { me: MeResponse }) {
  const call = useCall()
  const audioRef = useRef<HTMLAudioElement>(null)

  useEffect(() => {
    callStore.init(me)
    return onRealtimeFrame((frame) => callStore.handleFrame(frame))
  }, [me])

  useEffect(() => {
    const el = audioRef.current
    if (!el) return
    if (el.srcObject !== call.remoteAudio) el.srcObject = call.remoteAudio
    if (call.remoteAudio) el.play().catch(() => {})
  }, [call.remoteAudio])

  return (
    <>
      <audio ref={audioRef} autoPlay playsInline className="hidden" />
      {/* E2E diagnostics (T-03-07): phase, call id, candidate type and byte counts only. */}
      <div
        hidden
        data-testid="call-diag"
        data-phase={call.phase}
        data-call-id={call.callId ?? ""}
        data-local-type={call.localType ?? ""}
        data-inbound-bytes={call.inboundBytes}
        data-tone={call.tone}
      />
      <CallScreen />
      <IncomingCall />
      <PermissionDrawer
        open={call.permission !== null}
        onOpenChange={(open) => {
          if (!open) callStore.clearPermission()
        }}
        device={call.permission ?? "microphone"}
      />
    </>
  )
}
