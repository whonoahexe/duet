import { randomUUID } from "node:crypto"
import type { FastifyInstance, FastifyReply } from "fastify"
import { asc, count, eq } from "drizzle-orm"
import {
  REMINDER_MAX_COUNT,
  ReminderBody,
  ReminderEnabledBody,
  ReminderRule,
  nextOccurrence,
  type OkResponse,
  type ReminderDto,
  type ReminderResponse,
  type RemindersResponse,
} from "@duet/shared"
import { requireUser } from "../auth/session"
import { reminders, users } from "../db/schema"
import type { ReminderRow } from "./scheduler"

export interface ReminderRoutesOptions {
  /** Clock (tests inject one). */
  now: () => number
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** A stored row -> ReminderDto (the rule JSON was validated on write). */
function toDto(row: ReminderRow): ReminderDto {
  return toDtoOrNull(row) ?? fail()
}

function fail(): never {
  throw new Error("stored reminder rule is invalid")
}

/** A stored row -> ReminderDto, or null when its rule JSON no longer parses (never listed). */
function toDtoOrNull(row: ReminderRow): ReminderDto | null {
  let rule: ReminderRule
  try {
    const parsed = ReminderRule.safeParse(JSON.parse(row.rule))
    if (!parsed.success) return null
    rule = parsed.data
  } catch {
    return null
  }
  return {
    id: row.id,
    creatorId: row.creatorId,
    forUserId: row.forUserId,
    title: row.title,
    rule,
    enabled: row.enabled,
    nextAt: row.nextFireAt,
    nextLeadMinutes: row.nextLeadMin,
    createdAt: row.createdAt.getTime(),
  }
}

/**
 * Reminders CRUD (QT-nw9-reminder-store). Shared like profile photos: either person may list, edit,
 * toggle or delete any reminder (T-nw9-06); the creator always comes from the session and never
 * changes (T-nw9-07). Non-GET requests are already Origin-checked by the global originGuard. Logs carry
 * ids and the rule kind only, never the title (T-nw9-03).
 */
export async function reminderRoutes(app: FastifyInstance, { now }: ReminderRoutesOptions) {
  function findRow(rawId: unknown): ReminderRow | undefined {
    if (typeof rawId !== "string" || !UUID.test(rawId)) return undefined
    return app.db.select().from(reminders).where(eq(reminders.id, rawId)).get()
  }

  /** Parse and check a body; sends the 400 and returns null when it is not acceptable. */
  function parseBody(body: unknown, reply: FastifyReply): ReminderBody | null {
    const parsed = ReminderBody.safeParse(body)
    if (!parsed.success) {
      void reply.code(400).send({ error: "invalid_body" })
      return null
    }
    const forUserId = parsed.data.forUserId
    if (forUserId !== null && !app.db.select({ id: users.id }).from(users).where(eq(users.id, forUserId)).get()) {
      void reply.code(400).send({ error: "invalid_body" })
      return null
    }
    return parsed.data
  }

  app.get("/api/reminders", { preHandler: requireUser }, async (_request, reply) => {
    reply.header("Cache-Control", "no-store")
    const rows = app.db.select().from(reminders).orderBy(asc(reminders.createdAt), asc(reminders.id)).all()
    const body: RemindersResponse = { reminders: rows.map(toDtoOrNull).filter((r): r is ReminderDto => r !== null) }
    return body
  })

  app.post("/api/reminders", { preHandler: requireUser }, async (request, reply) => {
    reply.header("Cache-Control", "no-store")
    const body = parseBody(request.body, reply)
    if (!body) return reply
    const total = app.db.select({ n: count() }).from(reminders).get()?.n ?? 0
    if (total >= REMINDER_MAX_COUNT) return reply.code(409).send({ error: "too_many" })
    const at = now()
    const next = nextOccurrence(body.rule, at)
    if (!next) return reply.code(400).send({ error: "in_past" })
    const row = app.db
      .insert(reminders)
      .values({
        id: randomUUID(),
        creatorId: request.user!.id,
        forUserId: body.forUserId,
        title: body.title.trim(),
        rule: JSON.stringify(body.rule),
        enabled: true,
        nextFireAt: next.at,
        nextLeadMin: next.leadMinutes,
        createdAt: new Date(at),
        updatedAt: new Date(at),
      })
      .returning()
      .get()
    request.log.info({ evt: "reminder_saved", id: row.id, by: request.user!.id, kind: body.rule.kind, created: true })
    const res: ReminderResponse = { reminder: toDto(row) }
    return res
  })

  app.put("/api/reminders/:id", { preHandler: requireUser }, async (request, reply) => {
    reply.header("Cache-Control", "no-store")
    const existing = findRow((request.params as { id?: unknown }).id)
    if (!existing) return reply.code(404).send({ error: "not_found" })
    const body = parseBody(request.body, reply)
    if (!body) return reply
    const at = now()
    const next = nextOccurrence(body.rule, at)
    if (!next) return reply.code(400).send({ error: "in_past" })
    const row = app.db
      .update(reminders)
      .set({
        forUserId: body.forUserId,
        title: body.title.trim(),
        rule: JSON.stringify(body.rule),
        enabled: true,
        nextFireAt: next.at,
        nextLeadMin: next.leadMinutes,
        updatedAt: new Date(at),
      })
      .where(eq(reminders.id, existing.id))
      .returning()
      .get()
    request.log.info({ evt: "reminder_saved", id: row.id, by: request.user!.id, kind: body.rule.kind, created: false })
    const res: ReminderResponse = { reminder: toDto(row) }
    return res
  })

  app.patch("/api/reminders/:id", { preHandler: requireUser }, async (request, reply) => {
    reply.header("Cache-Control", "no-store")
    const existing = findRow((request.params as { id?: unknown }).id)
    if (!existing) return reply.code(404).send({ error: "not_found" })
    const parsed = ReminderEnabledBody.safeParse(request.body)
    if (!parsed.success) return reply.code(400).send({ error: "invalid_body" })
    const at = now()
    let next: ReturnType<typeof nextOccurrence> = null
    const rule = ReminderRule.parse(JSON.parse(existing.rule))
    if (parsed.data.enabled) {
      next = nextOccurrence(rule, at)
      if (!next) return reply.code(400).send({ error: "in_past" })
    }
    const row = app.db
      .update(reminders)
      .set({
        enabled: parsed.data.enabled,
        nextFireAt: next?.at ?? null,
        nextLeadMin: next?.leadMinutes ?? null,
        updatedAt: new Date(at),
      })
      .where(eq(reminders.id, existing.id))
      .returning()
      .get()
    request.log.info({ evt: "reminder_enabled", id: row.id, by: request.user!.id, kind: rule.kind, enabled: row.enabled })
    const res: ReminderResponse = { reminder: toDto(row) }
    return res
  })

  app.delete("/api/reminders/:id", { preHandler: requireUser }, async (request, reply) => {
    reply.header("Cache-Control", "no-store")
    const existing = findRow((request.params as { id?: unknown }).id)
    if (!existing) return reply.code(404).send({ error: "not_found" })
    app.db.delete(reminders).where(eq(reminders.id, existing.id)).run()
    const kind = (JSON.parse(existing.rule) as { kind?: unknown }).kind
    request.log.info({ evt: "reminder_deleted", id: existing.id, by: request.user!.id, kind })
    return { ok: true } satisfies OkResponse
  })
}
