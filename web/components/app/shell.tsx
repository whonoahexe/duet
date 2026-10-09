"use client"

import { ChatCircleIcon } from "@phosphor-icons/react"
import type { MeResponse } from "@duet/shared"
import { initials } from "@/components/app/login-tiles"
import { Avatar, AvatarFallback } from "@/components/ui/avatar"
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty"

/** Chat-shaped empty shell (D-11): peer header on top, the message area below. */
export function Shell({ me }: { me: MeResponse }) {
  const { peer } = me

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
    </div>
  )
}
