"use client"

import { useEffect, useEffectEvent, useRef, useState } from "react"
import { toast } from "sonner"
import { AlarmIcon, ArrowLeftIcon, PlusIcon } from "@phosphor-icons/react"
import {
  IST_TIME_ZONE,
  ReminderResponse,
  RemindersResponse,
  istToEpoch,
  leadLabel,
  reminderWho,
  type ReminderDto,
} from "@duet/shared"
import { ReminderForm } from "@/components/app/reminder-form"
import { Button } from "@/components/ui/button"
import { Dialog, DialogClose, DialogContent, DialogTitle } from "@/components/ui/dialog"
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty"
import { Item, ItemActions, ItemContent, ItemDescription, ItemGroup, ItemTitle } from "@/components/ui/item"
import { Skeleton } from "@/components/ui/skeleton"
import { Switch } from "@/components/ui/switch"
import { ApiError, apiGet, apiPatch } from "@/lib/api"
import { useBackClose } from "@/lib/back-close"
import { useMe, usePeer } from "@/lib/chat/store"

type Status = "loading" | "ready" | "error"
const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]

/** "9:00 AM" for an "HH:MM" wall-clock time (formatted as UTC, so no zone shifts it). */
function wallTime(hhmm: string): string {
  const [h, m] = hhmm.split(":").map(Number)
  return new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit", timeZone: "UTC" }).format(Date.UTC(1970, 0, 1, h, m))
}

/** "Every 2 hours · 9:00 AM–10:00 PM · Mon Tue" or "Tue, 21 Oct · 4:00 PM · 15 min heads-up · daily". */
function scheduleSummary(r: ReminderDto): string {
  const rule = r.rule
  if (rule.kind === "recurring") {
    const n = rule.everyMinutes
    const every =
      n % 60 === 0 ? (n === 60 ? "Every hour" : `Every ${n / 60} hours`) : n === 1 ? "Every minute" : `Every ${n} minutes`
    const days = rule.days.length === 7 ? "" : ` · ${[...rule.days].sort((a, b) => a - b).map((d) => DAY_NAMES[d]).join(" ")}`
    return `${every} · ${wallTime(rule.from)}–${wallTime(rule.until)}${days}`
  }
  const day = new Intl.DateTimeFormat(undefined, { weekday: "short", day: "numeric", month: "short", timeZone: IST_TIME_ZONE }).format(
    istToEpoch(rule.date, rule.time),
  )
  const lead = rule.leadMinutes !== null ? ` · ${leadLabel(rule.leadMinutes)} heads-up` : ""
  const repeat = rule.repeat === "none" ? "" : ` · ${rule.repeat}`
  return `${day} · ${wallTime(rule.time)}${lead}${repeat}`
}

function statusOf(r: ReminderDto): string {
  if (r.enabled && r.nextAt !== null) {
    const next = new Intl.DateTimeFormat(undefined, {
      weekday: "short",
      hour: "numeric",
      minute: "2-digit",
      timeZone: IST_TIME_ZONE,
    }).format(r.nextAt)
    return `Next ${next}`
  }
  if (!r.enabled && r.rule.kind === "once" && r.rule.repeat === "none") return "Done"
  return "Off"
}

function capitalise(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1)
}

/**
 * Menu > Reminders (QT-nw9-reminder-ui): a full-screen list of both people's reminders (they are
 * shared), each with an on/off switch; Add opens the form, a row opens it in edit mode. The form
 * replaces the list in the same dialog and has its own Back.
 */
export function Reminders({ open, onClose }: { open: boolean; onClose: () => void }) {
  const me = useMe()
  const peer = usePeer()
  useBackClose(open, onClose)
  const [status, setStatus] = useState<Status>("loading")
  const [items, setItems] = useState<ReminderDto[]>([])
  /** null = the list; { initial: null } = a new reminder; { initial } = editing. */
  const [form, setForm] = useState<{ initial: ReminderDto | null } | null>(null)
  useBackClose(form !== null, () => setForm(null))
  const generation = useRef(0)

  // Each opening starts from a fresh list; closing drops the form (and its back entry).
  const [wasOpen, setWasOpen] = useState(open)
  if (open !== wasOpen) {
    setWasOpen(open)
    setForm(null)
    if (open) setStatus("loading")
  }

  function load(): void {
    const gen = generation.current
    apiGet("/api/reminders", RemindersResponse).then(
      (res) => {
        if (gen !== generation.current) return
        setItems(res.reminders)
        setStatus("ready")
      },
      () => {
        if (gen !== generation.current) return
        setStatus("error")
      },
    )
  }

  const loadOnOpen = useEffectEvent(() => load())
  useEffect(() => {
    if (!open) return
    generation.current += 1
    loadOnOpen()
    return () => {
      generation.current += 1
    }
  }, [open])

  function retry() {
    setStatus("loading")
    load()
  }

  function replace(r: ReminderDto) {
    setItems((list) => (list.some((x) => x.id === r.id) ? list.map((x) => (x.id === r.id ? r : x)) : [...list, r]))
  }

  async function toggle(r: ReminderDto, enabled: boolean) {
    replace({ ...r, enabled })
    try {
      const res = await apiPatch(`/api/reminders/${r.id}`, { enabled }, ReminderResponse)
      replace(res.reminder)
    } catch (err) {
      replace(r)
      if (err instanceof ApiError && err.code === "in_past") {
        toast("That time has passed. Edit the reminder to pick a new time.")
      } else {
        toast.error("Couldn't update the reminder. Try again.")
      }
    }
  }

  const names: Record<string, string> = {}
  if (me) names[me.id] = me.displayName
  if (peer) names[peer.id] = peer.displayName

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose()
      }}
    >
      <DialogContent
        showCloseButton={false}
        className="top-0 left-0 flex h-dvh w-full max-w-none translate-x-0 translate-y-0 flex-col gap-0 rounded-none bg-background p-0 ring-0 sm:max-w-none data-open:zoom-in-100 data-closed:zoom-out-100"
      >
        {form && me && peer ? (
          <>
            <div className="box-content flex h-14 shrink-0 items-center gap-2 px-2 pt-[env(safe-area-inset-top)]">
              <Button variant="ghost" size="icon" aria-label="Back" onClick={() => setForm(null)}>
                <ArrowLeftIcon />
              </Button>
              <DialogTitle className="font-heading font-medium">{form.initial ? "Edit reminder" : "New reminder"}</DialogTitle>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto" data-testid="reminder-form">
              <ReminderForm
                key={form.initial?.id ?? "new"}
                initial={form.initial}
                me={me}
                peer={peer}
                onSaved={(r) => {
                  replace(r)
                  setForm(null)
                }}
                onDeleted={(id) => {
                  setItems((list) => list.filter((x) => x.id !== id))
                  setForm(null)
                }}
              />
            </div>
          </>
        ) : (
          <>
            <div className="box-content flex h-14 shrink-0 items-center gap-2 px-2 pt-[env(safe-area-inset-top)]">
              <DialogClose render={<Button variant="ghost" size="icon" aria-label="Back" />}>
                <ArrowLeftIcon />
              </DialogClose>
              <DialogTitle className="min-w-0 flex-1 font-heading font-medium">Reminders</DialogTitle>
              <Button variant="ghost" size="icon" aria-label="Add reminder" onClick={() => setForm({ initial: null })}>
                <PlusIcon />
              </Button>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-[env(safe-area-inset-bottom)]" data-testid="reminders">
              {status === "loading" && (
                <div className="flex flex-col gap-2 p-2" aria-hidden="true">
                  {Array.from({ length: 3 }, (_, i) => (
                    <Skeleton key={i} className="h-16 rounded-2xl" />
                  ))}
                </div>
              )}
              {status === "error" && (
                <Empty>
                  <EmptyHeader>
                    <EmptyTitle>Couldn&apos;t load your reminders</EmptyTitle>
                  </EmptyHeader>
                  <EmptyContent>
                    <Button variant="outline" onClick={retry}>
                      Retry
                    </Button>
                  </EmptyContent>
                </Empty>
              )}
              {status === "ready" && items.length === 0 && (
                <Empty>
                  <EmptyHeader>
                    <EmptyMedia variant="icon">
                      <AlarmIcon />
                    </EmptyMedia>
                    <EmptyTitle>No reminders yet</EmptyTitle>
                    <EmptyDescription>Remind yourself, {peer?.displayName ?? "each other"}, or both of you.</EmptyDescription>
                  </EmptyHeader>
                  <EmptyContent>
                    <Button onClick={() => setForm({ initial: null })}>Add reminder</Button>
                  </EmptyContent>
                </Empty>
              )}
              {status === "ready" && items.length > 0 && (
                <ItemGroup>
                  {items.map((r) => (
                    <Item key={r.id} data-testid="reminder-row">
                      <button
                        type="button"
                        className="flex min-w-0 flex-1 flex-col gap-1 text-left"
                        onClick={() => setForm({ initial: r })}
                      >
                        <ItemContent>
                          <ItemTitle className="w-full truncate">{r.title}</ItemTitle>
                          <ItemDescription data-testid="reminder-meta">
                            {scheduleSummary(r)} · {capitalise(reminderWho(r.creatorId, r.forUserId, me?.id, names))} ·{" "}
                            <span data-testid="reminder-status">{statusOf(r)}</span>
                          </ItemDescription>
                        </ItemContent>
                      </button>
                      <ItemActions>
                        <Switch
                          aria-label={`${r.title} on`}
                          checked={r.enabled}
                          onCheckedChange={(checked) => void toggle(r, checked)}
                        />
                      </ItemActions>
                    </Item>
                  ))}
                </ItemGroup>
              )}
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  )
}
