"use client"

import { useState } from "react"
import { toast } from "sonner"
import { ChatCircleIcon, DotsThreeVerticalIcon, SignOutIcon } from "@phosphor-icons/react"
import { OkResponse, type MeResponse } from "@duet/shared"
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

/** Chat-shaped empty shell (D-11): peer header on top, the message area below. */
export function Shell({ me, onLoggedOut }: { me: MeResponse; onLoggedOut: () => void }) {
  const { peer } = me
  const [loggingOut, setLoggingOut] = useState(false)

  async function handleLogout() {
    if (loggingOut) return
    setLoggingOut(true)
    try {
      await apiPost("/api/logout", {}, OkResponse)
      onLoggedOut()
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        // The session is already gone server-side: this device is logged out either way.
        onLoggedOut()
        return
      }
      setLoggingOut(false)
      toast.error("Couldn't log out. Check your connection and try again.")
    }
  }

  return (
    <div className="flex min-h-dvh flex-col">
      <header className="sticky top-0 z-10 border-b bg-background pt-[env(safe-area-inset-top)]">
        <div className="flex h-14 items-center gap-3 px-4">
          {peer ? (
            <>
              <Avatar>
                <AvatarFallback>{initials(peer.displayName)}</AvatarFallback>
              </Avatar>
              <span className="min-w-0 flex-1 truncate font-heading font-medium">{peer.displayName}</span>
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
              <DropdownMenuItem disabled={loggingOut} onClick={() => void handleLogout()}>
                <SignOutIcon />
                Log out
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </header>

      <main className="flex flex-1 flex-col pb-[env(safe-area-inset-bottom)]">
        <Empty>
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <ChatCircleIcon />
            </EmptyMedia>
            <EmptyTitle>No messages yet</EmptyTitle>
            <EmptyDescription>
              {peer
                ? `This is where you and ${peer.displayName} will talk.`
                : "Messages will show up here once your person has an account."}
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      </main>
      {/* Always dark (D-10): the preset Toaster otherwise follows useTheme(), which can report "system". */}
      <Toaster theme="dark" position="top-center" />
    </div>
  )
}
