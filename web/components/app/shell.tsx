"use client"

import { useEffect, useRef, useState } from "react"
import { toast } from "sonner"
import { ChatCircleIcon, DotsThreeVerticalIcon, PhoneCallIcon, SignOutIcon } from "@phosphor-icons/react"
import { OkResponse, type MeResponse } from "@duet/shared"
import { ChatView } from "@/components/app/chat-view"
import { initials } from "@/components/app/login-tiles"
import { Avatar, AvatarFallback } from "@/components/ui/avatar"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty"
import { Toaster } from "@/components/ui/sonner"
import { ApiError, apiPost } from "@/lib/api"
import { startRealtime, stopRealtime } from "@/lib/chat/realtime"
import { chatStore, useChat } from "@/lib/chat/store"

/** Connection subline under the peer name: hidden when live, "Offline", or "Connecting…" after 2 s. */
function ConnectionSubline() {
  const { connection } = useChat()
  const [slow, setSlow] = useState(false)
  useEffect(() => {
    if (connection !== "connecting") {
      setSlow(false)
      return
    }
    const timer = setTimeout(() => setSlow(true), 2000)
    return () => clearTimeout(timer)
  }, [connection])
  const text = connection === "offline" ? "Offline" : connection === "connecting" && slow ? "Connecting…" : null
  if (!text) return null
  return (
    <span className="truncate text-xs text-muted-foreground" data-testid="connection-subline">
      {text}
    </span>
  )
}

/**
 * Size the app to the visual viewport: in an installed iOS app the keyboard otherwise scrolls the
 * whole page and pushes the header off-screen (Pitfall 13). h-dvh stays as the fallback.
 */
function useVisualViewportHeight(ref: React.RefObject<HTMLDivElement | null>) {
  useEffect(() => {
    const vv = window.visualViewport
    const el = ref.current
    if (!vv || !el) return
    const apply = () => {
      if (Math.abs(vv.scale - 1) > 0.01) {
        el.style.height = ""
        return
      }
      el.style.height = `${vv.height}px`
      // iOS may scroll the layout viewport when the keyboard opens; keep the app pinned to the top.
      if (window.scrollY !== 0) window.scrollTo(0, 0)
    }
    apply()
    vv.addEventListener("resize", apply)
    vv.addEventListener("scroll", apply)
    return () => {
      vv.removeEventListener("resize", apply)
      vv.removeEventListener("scroll", apply)
      el.style.height = ""
    }
  }, [ref])
}

/** Chat shell (D-11): peer header on top, the conversation below. Only the message list scrolls. */
export function Shell({ me, onLoggedOut }: { me: MeResponse; onLoggedOut: () => void }) {
  const { peer } = me
  const [loggingOut, setLoggingOut] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  useVisualViewportHeight(rootRef)

  // The realtime manager outlives renders; it always calls the latest callback.
  const loggedOutRef = useRef(onLoggedOut)
  useEffect(() => {
    loggedOutRef.current = onLoggedOut
  }, [onLoggedOut])

  useEffect(() => {
    // A 401 from any chat request or a 4401 close: this device is logged out.
    const sessionGone = () => {
      stopRealtime()
      chatStore.reset()
      loggedOutRef.current()
    }
    chatStore.init(me, { onLoggedOut: sessionGone })
    if (!me.peer) return
    void chatStore.loadLatest()
    startRealtime({ onLoggedOut: sessionGone })
    return () => stopRealtime()
  }, [me])

  function finishLogout() {
    stopRealtime()
    chatStore.reset()
    onLoggedOut()
  }

  async function handleLogout() {
    if (loggingOut) return
    setLoggingOut(true)
    // Stop first: the server closes this session's sockets with 4401 as part of the logout.
    stopRealtime()
    try {
      await apiPost("/api/logout", {}, OkResponse)
      finishLogout()
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        // The session is already gone server-side: this device is logged out either way.
        finishLogout()
        return
      }
      setLoggingOut(false)
      if (me.peer) {
        startRealtime({
          onLoggedOut: () => {
            stopRealtime()
            chatStore.reset()
            loggedOutRef.current()
          },
        })
      }
      toast.error("Couldn't log out. Check your connection and try again.")
    }
  }

  return (
    <div ref={rootRef} className="flex h-dvh flex-col overflow-hidden">
      <header className="z-10 shrink-0 border-b bg-background pt-[env(safe-area-inset-top)]">
        <div className="flex h-14 items-center gap-3 px-4">
          {peer ? (
            <>
              <Avatar>
                <AvatarFallback>{initials(peer.displayName)}</AvatarFallback>
              </Avatar>
              <div className="flex min-w-0 flex-1 flex-col">
                <span className="truncate font-heading font-medium">{peer.displayName}</span>
                <ConnectionSubline />
              </div>
            </>
          ) : (
            <span className="min-w-0 flex-1 truncate font-heading font-medium text-muted-foreground">
              Waiting for your person
            </span>
          )}
          <DropdownMenu>
            <DropdownMenuTrigger render={<Button variant="ghost" size="icon" aria-label="Menu" />}>
              <DotsThreeVerticalIcon weight="bold" />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-auto">
              {/* The installed app has no URL bar, so the hidden call test is reached from here (Pitfall M6). */}
              <DropdownMenuItem onClick={() => window.location.assign("/debug/call/")}>
                <PhoneCallIcon />
                Call test
              </DropdownMenuItem>
              <DropdownMenuItem disabled={loggingOut} onClick={() => void handleLogout()}>
                <SignOutIcon />
                Log out
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </header>

      <main className="flex min-h-0 flex-1 flex-col">
        {peer ? (
          <ChatView peer={peer} />
        ) : (
          <div className="flex flex-1 flex-col pb-[env(safe-area-inset-bottom)]">
            <Empty>
              <EmptyHeader>
                <EmptyMedia variant="icon">
                  <ChatCircleIcon />
                </EmptyMedia>
                <EmptyTitle>No messages yet</EmptyTitle>
                <EmptyDescription>Messages will show up here once your person has an account.</EmptyDescription>
              </EmptyHeader>
            </Empty>
          </div>
        )}
      </main>
      {/* Always dark (D-10): the preset Toaster otherwise follows useTheme(), which can report "system". */}
      <Toaster theme="dark" position="top-center" />
    </div>
  )
}
