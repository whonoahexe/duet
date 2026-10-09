"use client"

import { useCallback, useEffect, useState } from "react"
import { CloudSlashIcon, UsersIcon } from "@phosphor-icons/react"
import { UsersResponse, type UserSummary } from "@duet/shared"
import { LoginTiles } from "@/components/app/login-tiles"
import { Button } from "@/components/ui/button"
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty"
import { Spinner } from "@/components/ui/spinner"
import { apiGet } from "@/lib/api"

type State = { kind: "loading" } | { kind: "error" } | { kind: "ready"; users: UserSummary[] }

export default function Page() {
  const [state, setState] = useState<State>({ kind: "loading" })

  const load = useCallback(async () => {
    setState({ kind: "loading" })
    try {
      const { users } = await apiGet("/api/users", UsersResponse)
      setState({ kind: "ready", users })
    } catch {
      setState({ kind: "error" })
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  // Plan 01-02 replaces this with the password step for the chosen person.
  const handleSelect = useCallback((_user: UserSummary) => {}, [])

  return (
    <main className="flex min-h-dvh items-center justify-center p-6">
      <div className="flex w-full max-w-sm flex-col gap-6">
        <h1 className="text-center font-heading text-2xl font-medium tracking-tight">duet</h1>

        {state.kind === "loading" && (
          <div className="flex justify-center py-8">
            <Spinner className="size-6" />
          </div>
        )}

        {state.kind === "error" && (
          <Empty>
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <CloudSlashIcon />
              </EmptyMedia>
              <EmptyTitle>Can&apos;t reach duet</EmptyTitle>
              <EmptyDescription>Check your connection and try again.</EmptyDescription>
            </EmptyHeader>
            <EmptyContent>
              <Button onClick={() => void load()}>Retry</Button>
            </EmptyContent>
          </Empty>
        )}

        {state.kind === "ready" && state.users.length === 0 && (
          <Empty>
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <UsersIcon />
              </EmptyMedia>
              <EmptyTitle>No accounts yet</EmptyTitle>
            </EmptyHeader>
          </Empty>
        )}

        {state.kind === "ready" && state.users.length > 0 && (
          <LoginTiles users={state.users} onSelect={handleSelect} />
        )}
      </div>
    </main>
  )
}
