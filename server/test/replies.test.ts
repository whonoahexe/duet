import { randomUUID } from "node:crypto"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { eq } from "drizzle-orm"
import { attachments, messages, users } from "../src/db/schema"
import { nextUpdatedSeq } from "../src/chat/service"
import { loginCookie, makeTestApp, TEST_ORIGIN, type TestApp } from "./helpers"

let t: TestApp
let aliceCookie: string
let bobCookie: string
let aliceId: string

function userId(username: string): string {
  const row = t.app.db.select({ id: users.id }).from(users).where(eq(users.username, username)).get()
  if (!row) throw new Error(`no user ${username}`)
  return row.id
}

function send(cookie: string, payload: Record<string, unknown>) {
  return t.app.inject({
    method: "POST",
    url: "/api/messages",
    headers: { cookie, origin: TEST_ORIGIN },
    payload: { id: randomUUID(), ...payload },
  })
}

async function sendOk(cookie: string, payload: Record<string, unknown>) {
  const res = await send(cookie, payload)
  expect(res.statusCode, res.body).toBe(200)
  return res.json().message
}

/** A 22-character base64url attachment id (fixture). */
function attId(n: number): string {
  return `att${n}`.padEnd(22, "A")
}

/** A media message with `count` image attachments and no caption, written straight to the DB. */
function insertPhotoAlbum(count: number, positions: number[]): number {
  return t.app.db.transaction((tx) => {
    const row = tx
      .insert(messages)
      .values({
        id: randomUUID(),
        senderId: aliceId,
        kind: "media",
        body: null,
        replyToSeq: null,
        createdAt: new Date(),
        updatedSeq: nextUpdatedSeq(tx),
      })
      .returning()
      .get()
    for (let i = 0; i < count; i++) {
      tx.insert(attachments)
        .values({
          id: attId(positions[i]),
          uploaderId: aliceId,
          messageSeq: row.seq,
          position: positions[i],
          kind: "image",
          status: "ready",
          declaredSize: 1000,
          width: 100,
          height: 100,
          createdAt: new Date(),
        })
        .run()
    }
    return row.seq
  })
}

beforeAll(async () => {
  t = await makeTestApp({ seed: true })
  aliceCookie = await loginCookie(t.app, "alice")
  bobCookie = await loginCookie(t.app, "bob")
  aliceId = userId("alice")
})
afterAll(async () => {
  await t.close()
})

describe("replies (CHAT-09, D-02)", () => {
  it("builds a ReplyPreview for a text parent", async () => {
    const original = await sendOk(aliceCookie, { body: "original" })
    expect(original.seq).toBe(1)
    const answer = await sendOk(bobCookie, { body: "answer", replyToSeq: 1 })
    expect(answer.replyTo).toEqual({
      seq: 1,
      senderId: aliceId,
      kind: "text",
      snippet: "original",
      attachmentCount: 0,
      thumb: null,
    })
  })

  it("rejects a missing parent with 400 bad_reply and a malformed replyToSeq with 400 invalid_body", async () => {
    const missing = await send(bobCookie, { body: "to nothing", replyToSeq: 999 })
    expect(missing.statusCode).toBe(400)
    expect(missing.json()).toEqual({ error: "bad_reply" })
    for (const replyToSeq of [0, "1", -3, 1.5]) {
      const res = await send(bobCookie, { body: "bad", replyToSeq })
      expect(res.statusCode, String(replyToSeq)).toBe(400)
      expect(res.json()).toEqual({ error: "invalid_body" })
    }
  })

  it("cuts the snippet to 120 graphemes with an ellipsis, never splitting a ZWJ family emoji", async () => {
    const long = await sendOk(aliceCookie, { body: "a".repeat(300) })
    const r1 = await sendOk(bobCookie, { body: "long one", replyToSeq: long.seq })
    expect(r1.replyTo.snippet).toBe(`${"a".repeat(120)}…`)

    const family = "👨‍👩‍👧‍👦"
    const fam = await sendOk(aliceCookie, { body: family.repeat(130) })
    const r2 = await sendOk(bobCookie, { body: "families", replyToSeq: fam.seq })
    expect(r2.replyTo.snippet).toBe(`${family.repeat(120)}…`)
  })

  it("quotes only the direct parent when replying to a reply (no nested replyTo)", async () => {
    const first = await sendOk(aliceCookie, { body: "first" })
    const second = await sendOk(bobCookie, { body: "second", replyToSeq: first.seq })
    const third = await sendOk(aliceCookie, { body: "third", replyToSeq: second.seq })
    expect(third.replyTo.seq).toBe(second.seq)
    expect(third.replyTo.snippet).toBe("second")
    expect(third.replyTo).not.toHaveProperty("replyTo")
  })

  it("returns the same replyTo from GET /api/messages and /api/sync as from the POST", async () => {
    const parent = await sendOk(aliceCookie, { body: "parent for paging" })
    const reply = await sendOk(bobCookie, { body: "child", replyToSeq: parent.seq })

    const page = await t.app.inject({ method: "GET", url: "/api/messages?limit=200", headers: { cookie: aliceCookie } })
    const fromPage = (page.json().messages as { seq: number; replyTo: unknown }[]).find((m) => m.seq === reply.seq)
    expect(fromPage?.replyTo).toEqual(reply.replyTo)

    const sync = await t.app.inject({
      method: "GET",
      url: `/api/sync?since=${reply.updatedSeq - 1}`,
      headers: { cookie: aliceCookie },
    })
    const fromSync = (sync.json().messages as { seq: number; replyTo: unknown }[]).find((m) => m.seq === reply.seq)
    expect(fromSync?.replyTo).toEqual(reply.replyTo)
  })

  it("labels a captionless photo album parent '3 photos' with its position-0 attachment as the thumb", async () => {
    const albumSeq = insertPhotoAlbum(3, [2, 0, 1])
    const reply = await sendOk(bobCookie, { body: "nice photos", replyToSeq: albumSeq })
    expect(reply.replyTo).toEqual({
      seq: albumSeq,
      senderId: aliceId,
      kind: "media",
      snippet: "3 photos",
      attachmentCount: 3,
      thumb: { id: attId(0), kind: "image" },
    })
  })
})
