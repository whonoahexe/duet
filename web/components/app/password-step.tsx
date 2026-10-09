"use client"

import { useRef, useState, type FormEvent } from "react"
import { ArrowLeftIcon } from "@phosphor-icons/react"
import { OkResponse, type UserSummary } from "@duet/shared"
import { initials } from "@/components/app/login-tiles"
import { Avatar, AvatarFallback } from "@/components/ui/avatar"
import { Button } from "@/components/ui/button"
import { Field, FieldError, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Spinner } from "@/components/ui/spinner"
import { ApiError, apiPost } from "@/lib/api"

function loginErrorMessage(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.status === 401) return "Wrong password"
    if (err.status === 429) return "Too many attempts. Try again in a few minutes."
    return "Something went wrong. Try again."
  }
  // fetch() rejects (TypeError) when the network is down or the server is unreachable.
  return "Can't reach duet. Check your connection."
}

export function PasswordStep({
  user,
  onBack,
  onSuccess,
}: {
  user: UserSummary
  onBack: () => void
  onSuccess: () => void
}) {
  const [password, setPassword] = useState("")
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (pending || password.length === 0) return
    setPending(true)
    setError(null)
    try {
      await apiPost("/api/login", { userId: user.id, password }, OkResponse)
      onSuccess()
    } catch (err) {
      setError(loginErrorMessage(err))
      setPassword("")
      setPending(false)
      // The input is re-enabled on this render; focus it once it is.
      requestAnimationFrame(() => inputRef.current?.focus())
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col items-center gap-3">
        <Avatar size="lg">
          <AvatarFallback>{initials(user.displayName)}</AvatarFallback>
        </Avatar>
        <h2 className="font-heading text-xl font-medium tracking-tight">{user.displayName}</h2>
      </div>

      <form className="flex flex-col gap-4" onSubmit={(event) => void handleSubmit(event)}>
        {/* Lets iOS Keychain / password managers file the password under the right account. */}
        <input type="text" name="username" autoComplete="username" value={user.username} readOnly hidden />
        <Field data-invalid={error !== null}>
          <FieldLabel htmlFor="password">Password</FieldLabel>
          <Input
            id="password"
            name="password"
            type="password"
            autoComplete="current-password"
            autoFocus
            required
            ref={inputRef}
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            disabled={pending}
            aria-invalid={error !== null}
          />
          <FieldError>{error}</FieldError>
        </Field>
        <Button type="submit" size="lg" disabled={pending || password.length === 0}>
          {pending && <Spinner />}
          Log in
        </Button>
      </form>

      <Button variant="ghost" onClick={onBack} disabled={pending} className="self-center">
        <ArrowLeftIcon data-icon="inline-start" />
        Back
      </Button>
    </div>
  )
}
