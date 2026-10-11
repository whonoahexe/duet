"use client"

import { useCallback, useEffect, useState } from "react"
import { CloudSlashIcon, UsersIcon } from "@phosphor-icons/react"
import { MeResponse, UsersResponse, type UserSummary } from "@duet/shared"
import { A2HS_SKIPPED_KEY, A2hsGuide } from "@/components/app/a2hs-guide"
import { LoginTiles } from "@/components/app/login-tiles"
import { PasswordStep } from "@/components/app/password-step"
import { Shell } from "@/components/app/shell"
import { Button } from "@/components/ui/button"
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty"
import { Spinner } from "@/components/ui/spinner"
import { ApiError, apiGet } from "@/lib/api"
import { isIos, isStandalone } from "@/lib/platform"

type State =
  | { kind: "loading" }
  | { kind: "a2hs" }
  | { kind: "error" }
  | { kind: "tiles"; users: UserSummary[] }
  | { kind: "password"; users: UserSummary[]; user: UserSummary }
  | { kind: "shell"; me: MeResponse }

/**
 * D-16: iOS Safari outside the installed app shows the Add to Home Screen guide before anything
 * else (logging in there would be wasted: the Home Screen app has its own storage), unless it was
 * skipped in this browser session.
 */
function needsA2hsGuide(): boolean {
  if (!isIos() || isStandalone()) return false
  try {
    return sessionStorage.getItem(A2HS_SKIPPED_KEY) !== "1"
  } catch {
    return true
  }
}

export default function Page() {
  const [state, setState] = useState<State>({ kind: "loading" })

  const loadTiles = useCallback(async () => {
    setState({ kind: "loading" })
    try {
      const { users } = await apiGet("/api/users", UsersResponse)
      setState({ kind: "tiles", users })
    } catch {
      setState({ kind: "error" })
    }
  }, [])

  /** GET /api/me decides between the shell (logged in) and the name tiles (401). */
  const load = useCallback(async () => {
    setState({ kind: "loading" })
    try {
      const me = await apiGet("/api/me", MeResponse)
      setState({ kind: "shell", me })
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        await loadTiles()
      } else {
        setState({ kind: "error" })
      }
    }
  }, [loadTiles])

  /** Decided after mount: the guide needs the user agent and sessionStorage. */
  const start = useCallback(async () => {
    if (needsA2hsGuide()) {
      setState({ kind: "a2hs" })
      return
    }
    await load()
  }, [load])

  useEffect(() => {
    void start()
  }, [start])

  if (state.kind === "a2hs") {
    return <A2hsGuide onContinue={() => void load()} />
  }

  if (state.kind === "shell") {
    return <Shell me={state.me} onLoggedOut={() => void loadTiles()} />
  }

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

        {state.kind === "tiles" && state.users.length === 0 && (
          <Empty>
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <UsersIcon />
              </EmptyMedia>
              <EmptyTitle>No accounts yet</EmptyTitle>
            </EmptyHeader>
          </Empty>
        )}

        {state.kind === "tiles" && state.users.length > 0 && (
          <LoginTiles
            users={state.users}
            onSelect={(user) => setState({ kind: "password", users: state.users, user })}
          />
        )}

        {state.kind === "password" && (
          <PasswordStep
            user={state.user}
            onBack={() => setState({ kind: "tiles", users: state.users })}
            onSuccess={() => void load()}
          />
        )}
      </div>
    </main>
  )
}
