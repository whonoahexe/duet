"use client"

import { useCallback, useEffect, useState } from "react"
import { CloudSlashIcon, LockKeyIcon } from "@phosphor-icons/react"
import { MeResponse } from "@duet/shared"
import { CallTest } from "@/components/app/call-test"
import { Button } from "@/components/ui/button"
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty"
import { Spinner } from "@/components/ui/spinner"
import { ApiError, apiGet } from "@/lib/api"

type State = { kind: "loading" } | { kind: "unauth" } | { kind: "error" } | { kind: "ready"; me: MeResponse }

/** Hidden, login-gated call test (D-12 adapted by D-16). Reached via the header menu's "Call test". */
export default function CallTestPage() {
  const [state, setState] = useState<State>({ kind: "loading" })

  const load = useCallback(async () => {
    setState({ kind: "loading" })
    try {
      const me = await apiGet("/api/me", MeResponse)
      setState({ kind: "ready", me })
    } catch (err) {
      setState(err instanceof ApiError && err.status === 401 ? { kind: "unauth" } : { kind: "error" })
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  if (state.kind === "ready") return <CallTest me={state.me} />

  return (
    <main className="flex min-h-dvh items-center justify-center p-6">
      <div className="flex w-full max-w-sm flex-col gap-6">
        {state.kind === "loading" && (
          <div className="flex justify-center py-8">
            <Spinner className="size-6" />
          </div>
        )}

        {state.kind === "unauth" && (
          <Empty>
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <LockKeyIcon />
              </EmptyMedia>
              <EmptyTitle>Log in first</EmptyTitle>
              <EmptyDescription>The call test is only for the two of us.</EmptyDescription>
            </EmptyHeader>
            <EmptyContent>
              <Button nativeButton={false} render={<a href="/" />}>
                Go to login
              </Button>
            </EmptyContent>
          </Empty>
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
      </div>
    </main>
  )
}
