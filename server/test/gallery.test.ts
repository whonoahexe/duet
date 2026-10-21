import { randomBytes, randomUUID } from "node:crypto"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { eq } from "drizzle-orm"
import { attachments, messages, users } from "../src/db/schema"
import { loginCookie, makeTestApp, type TestApp } from "./helpers"

let t: TestApp
let cookie: string
let aliceId: string
let bobId: string
/** Every ready image/video seeded into a media message: [key, attachment id]. */
const expected: Array<{ key: number; id: string }> = []
let updatedSeq = 1

const newId = () => randomBytes(16).toString("base64url")

function insertMessage(senderId: string, kind: "media" | "voice" | "text", createdAt: Date): number {
  return t.app.db
    .insert(messages)
    .values({ id: randomUUID(), senderId, kind, body: null, createdAt, updatedSeq: updatedSeq++ })
    .returning({ seq: messages.seq })
    .get().seq
}

function insertAttachment(values: {
  uploaderId: string
  messageSeq: number | null
  position?: number
  kind: "image" | "video" | "audio"
  status: "ready" | "failed" | "processing"
  durationMs?: number
}): string {
  const id = newId()
  t.app.db
    .insert(attachments)
    .values({
      id,
      uploaderId: values.uploaderId,
      messageSeq: values.messageSeq,
      position: values.position ?? 0,
      kind: values.kind,
      status: values.status,
      declaredSize: 1000,
      width: 1280,
      height: 720,
      durationMs: values.durationMs ?? null,
      createdAt: new Date(),
    })
    .run()
  return id
}

function get(url: string, withCookie = true) {
  return t.app.inject({ method: "GET", url, headers: withCookie ? { cookie } : {} })
}

beforeAll(async () => {
  t = await makeTestApp({ seed: true })
  cookie = await loginCookie(t.app, "alice")
  aliceId = t.app.db.select({ id: users.id }).from(users).where(eq(users.username, "alice")).get()!.id
  bobId = t.app.db.select({ id: users.id }).from(users).where(eq(users.username, "bob")).get()!.id
})
afterAll(async () => {
  await t.close()
})

describe("GET /api/media (QT-5zd-gallery)", () => {
  it("returns an empty page with no media", async () => {
    const res = await get("/api/media")
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ items: [], hasMore: false, next: null })
  })

  it("401 without a cookie; 400 invalid_query for bad limit/before; never cached", async () => {
    const anon = await get("/api/media", false)
    expect(anon.statusCode).toBe(401)
    for (const q of ["limit=0", "limit=121", "before=abc", "before=-1"]) {
      const res = await get(`/api/media?${q}`)
      expect(res.statusCode).toBe(400)
      expect(res.json()).toEqual({ error: "invalid_query" })
      expect(res.headers["cache-control"]).toBe("no-store")
    }
    expect((await get("/api/media")).headers["cache-control"]).toBe("no-store")
  })

  it("pages every ready photo and video once, newest first, and never audio, failed, processing or unattached rows", async () => {
    const day = Date.UTC(2026, 9, 1)
    // Three media messages with ready images/videos at positions 0..2.
    for (let m = 0; m < 3; m++) {
      const sender = m % 2 === 0 ? aliceId : bobId
      const seq = insertMessage(sender, "media", new Date(day + m * 86_400_000))
      for (let p = 0; p < 3; p++) {
        const kind = (m + p) % 2 === 0 ? "image" : "video"
        const id = insertAttachment({
          uploaderId: sender,
          messageSeq: seq,
          position: p,
          kind,
          status: "ready",
          ...(kind === "video" ? { durationMs: 42_000 } : {}),
        })
        expected.push({ key: seq * 10 + p, id })
      }
    }
    // Noise: a ready voice note, a failed image, a processing video (in messages), an unattached image.
    const voiceSeq = insertMessage(aliceId, "voice", new Date(day + 5 * 86_400_000))
    const noise = [
      insertAttachment({ uploaderId: aliceId, messageSeq: voiceSeq, kind: "audio", status: "ready", durationMs: 3000 }),
    ]
    const failedSeq = insertMessage(bobId, "media", new Date(day + 6 * 86_400_000))
    noise.push(insertAttachment({ uploaderId: bobId, messageSeq: failedSeq, kind: "image", status: "failed" }))
    noise.push(insertAttachment({ uploaderId: bobId, messageSeq: failedSeq, position: 1, kind: "video", status: "processing" }))
    noise.push(insertAttachment({ uploaderId: aliceId, messageSeq: null, kind: "image", status: "ready" }))

    expected.sort((a, b) => b.key - a.key)

    const first = await get("/api/media?limit=2")
    expect(first.statusCode).toBe(200)
    const page1 = first.json()
    expect(page1.items.map((i: { key: number }) => i.key)).toEqual([expected[0]!.key, expected[1]!.key])
    expect(page1.hasMore).toBe(true)
    expect(page1.next).toBe(expected[1]!.key)

    const seen: Array<{ key: number; id: string }> = []
    let url = "/api/media?limit=2"
    for (let guard = 0; guard < 20; guard++) {
      const page = (await get(url)).json()
      for (const item of page.items) {
        seen.push({ key: item.key, id: item.attachment.id })
        expect(Object.keys(item).sort()).toEqual(["attachment", "createdAt", "key", "senderId", "seq"])
        expect(item.key).toBe(item.seq * 10 + item.attachment.position)
        expect([aliceId, bobId]).toContain(item.senderId)
        expect(typeof item.createdAt).toBe("number")
        if (item.attachment.kind === "video") {
          expect(item.attachment).toMatchObject({ durationMs: 42_000, width: 1280, height: 720 })
        }
      }
      if (!page.hasMore) {
        expect(page.next).toBeNull()
        break
      }
      url = `/api/media?limit=2&before=${page.next}`
    }
    expect(seen).toEqual(expected)
    for (let i = 1; i < seen.length; i++) expect(seen[i]!.key).toBeLessThan(seen[i - 1]!.key)
    for (const id of noise) expect(seen.some((s) => s.id === id)).toBe(false)

    // The default page holds everything at once.
    const all = (await get("/api/media")).json()
    expect(all.items).toHaveLength(expected.length)
    expect(all.hasMore).toBe(false)
  })
})
