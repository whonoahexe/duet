"use client"

import { useId, useState } from "react"
import { toast } from "sonner"
import { TrashIcon } from "@phosphor-icons/react"
import {
  IST_OFFSET_MS,
  OkResponse,
  ReminderBody,
  ReminderResponse,
  REMINDER_TITLE_MAX,
  istParts,
  type Profile,
  type ReminderDto,
} from "@duet/shared"
import { Button } from "@/components/ui/button"
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Spinner } from "@/components/ui/spinner"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import { ApiError, apiDelete, apiPost, apiPut } from "@/lib/api"

type ForWho = "me" | "peer" | "both"
type Kind = "recurring" | "once"
type Unit = "minutes" | "hours"
type Lead = "none" | "15" | "60"
type Repeat = "none" | "daily" | "weekly"

interface FormState {
  title: string
  forWho: ForWho
  kind: Kind
  every: string
  unit: Unit
  from: string
  until: string
  days: string[]
  date: string
  time: string
  lead: Lead
  repeat: Repeat
}

type Errors = Partial<Record<"title" | "every" | "until" | "days" | "date" | "time" | "when", string>>

const ALL_DAYS = ["0", "1", "2", "3", "4", "5", "6"]
const DAY_LABELS = ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"]
const HOUR_MS = 60 * 60 * 1000

/** Today in IST and the next full IST hour (IST is UTC+05:30, so this is not the next UTC hour). */
function nextFullHour(): { date: string; time: string } {
  const now = Date.now()
  const at = Math.ceil((now + IST_OFFSET_MS + 1) / HOUR_MS) * HOUR_MS - IST_OFFSET_MS
  const p = istParts(at)
  return { date: p.date, time: p.time }
}

function initialState(initial: ReminderDto | null, me: Profile, peer: Profile): FormState {
  const next = nextFullHour()
  const base: FormState = {
    title: "",
    forWho: "me",
    kind: "recurring",
    every: "1",
    unit: "hours",
    from: "09:00",
    until: "22:00",
    days: ALL_DAYS,
    date: next.date,
    time: next.time,
    lead: "none",
    repeat: "none",
  }
  if (!initial) return base
  const forWho: ForWho = initial.forUserId === null ? "both" : initial.forUserId === me.id ? "me" : initial.forUserId === peer.id ? "peer" : "both"
  const rule = initial.rule
  if (rule.kind === "recurring") {
    const hours = rule.everyMinutes % 60 === 0
    return {
      ...base,
      title: initial.title,
      forWho,
      kind: "recurring",
      every: String(hours ? rule.everyMinutes / 60 : rule.everyMinutes),
      unit: hours ? "hours" : "minutes",
      from: rule.from,
      until: rule.until,
      days: rule.days.map(String),
    }
  }
  return {
    ...base,
    title: initial.title,
    forWho,
    kind: "once",
    date: rule.date,
    time: rule.time,
    lead: rule.leadMinutes === null ? "none" : (String(rule.leadMinutes) as Lead),
    repeat: rule.repeat,
  }
}

/** The request body for the form (validated by the caller with ReminderBody). */
function toBody(s: FormState, me: Profile, peer: Profile): unknown {
  const forUserId = s.forWho === "me" ? me.id : s.forWho === "peer" ? peer.id : null
  const n = Number(s.every)
  const rule =
    s.kind === "recurring"
      ? {
          kind: "recurring" as const,
          everyMinutes: s.every.trim() === "" ? 0 : s.unit === "hours" ? n * 60 : n,
          from: s.from,
          until: s.until,
          days: s.days.map(Number).sort((a, b) => a - b),
        }
      : {
          kind: "once" as const,
          date: s.date,
          time: s.time,
          leadMinutes: s.lead === "none" ? null : Number(s.lead),
          repeat: s.repeat,
        }
  return { title: s.title, forUserId, rule }
}

/** Inline messages for the issues ReminderBody reports. */
function errorsOf(issues: ReadonlyArray<{ path: PropertyKey[]; message: string }>): Errors {
  const out: Errors = {}
  for (const issue of issues) {
    const [head, field] = issue.path
    if (head === "title") out.title ??= issue.message === "too_long" ? `Keep it under ${REMINDER_TITLE_MAX} characters.` : "Enter a reminder."
    else if (head === "rule" && field === "everyMinutes") out.every ??= "Pick an interval from 5 minutes to 24 hours."
    else if (head === "rule" && (field === "until" || field === "from")) out.until ??= "Until must be after From."
    else if (head === "rule" && field === "days") out.days ??= "Pick at least one day."
    else if (head === "rule" && field === "date") out.date ??= "Pick a date."
    else if (head === "rule" && field === "time") out.time ??= "Pick a time."
  }
  return out
}

/** A single-choice ToggleGroup: never lets the last pressed item be released. */
function Choice<T extends string>({
  label,
  value,
  onChange,
  options,
  disabled,
}: {
  label: string
  value: T
  onChange: (value: T) => void
  options: Array<{ value: T; label: string }>
  disabled: boolean
}) {
  const id = useId()
  return (
    <Field>
      <FieldLabel id={id}>{label}</FieldLabel>
      <ToggleGroup
        aria-labelledby={id}
        variant="outline"
        className="flex-wrap"
        value={[value]}
        disabled={disabled}
        onValueChange={(next) => {
          const picked = next.find((v) => v !== value) ?? next[0]
          if (picked) onChange(picked as T)
        }}
      >
        {options.map((o) => (
          <ToggleGroupItem key={o.value} value={o.value}>
            {o.label}
          </ToggleGroupItem>
        ))}
      </ToggleGroup>
    </Field>
  )
}

/**
 * Add or edit one reminder (QT-nw9-reminder-ui). Every time is India time (IST). A new reminder is
 * for you, repeating every hour 09:00-22:00 every day; the one-time fields start at the next full IST
 * hour today. Validation is the shared ReminderBody; the server's in_past shows inline.
 */
export function ReminderForm({
  initial,
  me,
  peer,
  onSaved,
  onDeleted,
}: {
  initial: ReminderDto | null
  me: Profile
  peer: Profile
  onSaved: (reminder: ReminderDto) => void
  onDeleted: (id: string) => void
}) {
  const [s, setS] = useState<FormState>(() => initialState(initial, me, peer))
  const [errors, setErrors] = useState<Errors>({})
  const [busy, setBusy] = useState(false)
  const ids = {
    title: useId(),
    every: useId(),
    from: useId(),
    until: useId(),
    days: useId(),
    date: useId(),
    time: useId(),
  }

  function update(patch: Partial<FormState>) {
    setS((prev) => ({ ...prev, ...patch }))
  }

  async function save() {
    if (busy) return
    const parsed = ReminderBody.safeParse(toBody(s, me, peer))
    if (!parsed.success) {
      setErrors(errorsOf(parsed.error.issues))
      return
    }
    setErrors({})
    setBusy(true)
    try {
      const res = initial
        ? await apiPut(`/api/reminders/${initial.id}`, parsed.data, ReminderResponse)
        : await apiPost("/api/reminders", parsed.data, ReminderResponse)
      onSaved(res.reminder)
    } catch (err) {
      if (err instanceof ApiError && err.code === "in_past") setErrors({ when: "That time has passed." })
      else toast.error("Couldn't save the reminder. Try again.")
      setBusy(false)
    }
  }

  async function remove() {
    if (!initial || busy) return
    setBusy(true)
    try {
      await apiDelete(`/api/reminders/${initial.id}`, OkResponse)
      onDeleted(initial.id)
      toast("Reminder deleted")
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) {
        onDeleted(initial.id)
        return
      }
      toast.error("Couldn't delete the reminder. Try again.")
      setBusy(false)
    }
  }

  return (
    <form
      className="flex flex-col gap-6 px-4 pt-2 pb-[calc(env(safe-area-inset-bottom)+1.5rem)]"
      onSubmit={(e) => {
        e.preventDefault()
        void save()
      }}
    >
      <FieldGroup>
        <Field data-invalid={errors.title ? true : undefined}>
          <FieldLabel htmlFor={ids.title}>Reminder</FieldLabel>
          <Input
            id={ids.title}
            value={s.title}
            maxLength={REMINDER_TITLE_MAX}
            placeholder="Drink water"
            disabled={busy}
            aria-invalid={errors.title ? true : undefined}
            onChange={(e) => update({ title: e.target.value })}
          />
          <FieldError>{errors.title}</FieldError>
        </Field>

        <Choice<ForWho>
          label="For"
          value={s.forWho}
          disabled={busy}
          onChange={(forWho) => update({ forWho })}
          options={[
            { value: "me", label: "Me" },
            { value: "peer", label: peer.displayName },
            { value: "both", label: "Both" },
          ]}
        />

        <Choice<Kind>
          label="Type"
          value={s.kind}
          disabled={busy}
          onChange={(kind) => update({ kind })}
          options={[
            { value: "recurring", label: "Repeating" },
            { value: "once", label: "One time" },
          ]}
        />

        {s.kind === "recurring" ? (
          <>
            <Field data-invalid={errors.every ? true : undefined}>
              <FieldLabel htmlFor={ids.every}>Every</FieldLabel>
              <div className="flex items-center gap-2">
                <Input
                  id={ids.every}
                  type="number"
                  inputMode="numeric"
                  min={1}
                  className="w-24"
                  value={s.every}
                  disabled={busy}
                  aria-invalid={errors.every ? true : undefined}
                  onChange={(e) => update({ every: e.target.value })}
                />
                <ToggleGroup
                  aria-label="Unit"
                  variant="outline"
                  value={[s.unit]}
                  disabled={busy}
                  onValueChange={(next) => {
                    const picked = next.find((v) => v !== s.unit) ?? next[0]
                    if (picked) update({ unit: picked as Unit })
                  }}
                >
                  <ToggleGroupItem value="minutes">Minutes</ToggleGroupItem>
                  <ToggleGroupItem value="hours">Hours</ToggleGroupItem>
                </ToggleGroup>
              </div>
              <FieldError>{errors.every}</FieldError>
            </Field>
            <div className="grid grid-cols-2 gap-4">
              <Field>
                <FieldLabel htmlFor={ids.from}>From</FieldLabel>
                <Input id={ids.from} type="time" value={s.from} disabled={busy} onChange={(e) => update({ from: e.target.value })} />
              </Field>
              <Field data-invalid={errors.until ? true : undefined}>
                <FieldLabel htmlFor={ids.until}>Until</FieldLabel>
                <Input
                  id={ids.until}
                  type="time"
                  value={s.until}
                  disabled={busy}
                  aria-invalid={errors.until ? true : undefined}
                  onChange={(e) => update({ until: e.target.value })}
                />
              </Field>
            </div>
            <FieldError>{errors.until}</FieldError>
            <Field data-invalid={errors.days ? true : undefined}>
              <FieldLabel id={ids.days}>Days</FieldLabel>
              <ToggleGroup
                aria-labelledby={ids.days}
                multiple
                variant="outline"
                spacing={1}
                className="flex-wrap"
                value={s.days}
                disabled={busy}
                onValueChange={(next) => update({ days: [...next].sort() })}
              >
                {ALL_DAYS.map((d) => (
                  <ToggleGroupItem key={d} value={d}>
                    {DAY_LABELS[Number(d)]}
                  </ToggleGroupItem>
                ))}
              </ToggleGroup>
              <FieldError>{errors.days}</FieldError>
            </Field>
          </>
        ) : (
          <>
            <div className="grid grid-cols-2 gap-4">
              <Field data-invalid={errors.date || errors.when ? true : undefined}>
                <FieldLabel htmlFor={ids.date}>Date</FieldLabel>
                <Input
                  id={ids.date}
                  type="date"
                  value={s.date}
                  disabled={busy}
                  aria-invalid={errors.date || errors.when ? true : undefined}
                  onChange={(e) => update({ date: e.target.value })}
                />
              </Field>
              <Field data-invalid={errors.time || errors.when ? true : undefined}>
                <FieldLabel htmlFor={ids.time}>Time</FieldLabel>
                <Input
                  id={ids.time}
                  type="time"
                  value={s.time}
                  disabled={busy}
                  aria-invalid={errors.time || errors.when ? true : undefined}
                  onChange={(e) => update({ time: e.target.value })}
                />
              </Field>
            </div>
            <FieldError>{errors.date ?? errors.time ?? errors.when}</FieldError>
            <Choice<Lead>
              label="Heads-up"
              value={s.lead}
              disabled={busy}
              onChange={(lead) => update({ lead })}
              options={[
                { value: "none", label: "None" },
                { value: "15", label: "15 min" },
                { value: "60", label: "1 hour" },
              ]}
            />
            <Choice<Repeat>
              label="Repeat"
              value={s.repeat}
              disabled={busy}
              onChange={(repeat) => update({ repeat })}
              options={[
                { value: "none", label: "Never" },
                { value: "daily", label: "Daily" },
                { value: "weekly", label: "Weekly" },
              ]}
            />
          </>
        )}
        <FieldDescription>Times are India time (IST).</FieldDescription>
      </FieldGroup>

      <div className="flex flex-col gap-3">
        <Button type="submit" size="lg" disabled={busy}>
          {busy && <Spinner />}
          Save
        </Button>
        {initial && (
          <Button type="button" variant="destructive" size="lg" disabled={busy} onClick={() => void remove()}>
            <TrashIcon />
            Delete reminder
          </Button>
        )}
      </div>
    </form>
  )
}
