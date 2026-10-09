"use client"

import { useState, type FormEvent } from "react"
import { ArrowLeftIcon } from "@phosphor-icons/react"
import { OkResponse, type UserSummary } from "@duet/shared"
import { initials } from "@/components/app/login-tiles"
import { Avatar, AvatarFallback } from "@/components/ui/avatar"
import { Button } from "@/components/ui/button"
import { Field, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Spinner } from "@/components/ui/spinner"
import { apiPost } from "@/lib/api"

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

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (pending || password.length === 0) return
    setPending(true)
    try {
      await apiPost("/api/login", { userId: user.id, password }, OkResponse)
      onSuccess()
    } finally {
      setPending(false)
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
        <Field>
          <FieldLabel htmlFor="password">Password</FieldLabel>
          <Input
            id="password"
            name="password"
            type="password"
            autoComplete="current-password"
            autoFocus
            required
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            disabled={pending}
          />
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
