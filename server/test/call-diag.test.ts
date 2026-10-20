import { randomUUID } from "node:crypto"
import { Writable } from "node:stream"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { eq } from "drizzle-orm"
import { CALL_DIAG_BODY_LIMIT, CALL_DIAG_MAX_EVENTS, CallDiagBatch } from "@duet/shared"
import { users } from "../src/db/schema"
import { loginCookie, makeTestApp, TEST_ORIGIN, type TestApp } from "./helpers"

/**
 * POST /api/calls/diag (quick task 261020-oj7): phones post what they saw during a call, the server
 * writes it as call_diag lines. The contract makes personal data unrepresentable; these tests prove
 * IPs, candidates and SDP are rejected and never reach the log.
 */

const NOW = 1_760_900_000_000

const ENV = { browser: "chrome", browserMajor: 141, os: "android", osMajor: 16, mobile: true, standalone: true }

function validBatch(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    callId: randomUUID(),
    role: "caller",
    seq: 3,
    dropped: 0,
    sentAt: Date.now(),
    env: ENV,
    events: [
      { k: "phase", at: NOW, phase: "live", ms: 2400 },
      { k: "end", at: NOW + 5000, cause: "hangup" },
    ],
    ...overrides,
  }
}

let ipCounter = 0
function freshIp(): string {
  ipCounter += 1
  return `10.9.${Math.floor(ipCounter / 250)}.${(ipCounter % 250) + 1}`
}

/** Every key a call_diag line may carry. Anything else (cfIp, ua, body, reqId) is a leak. */
const ALLOWED = new Set([
  // pino bookkeeping
  "level",
  "time",
  "pid",
  "hostname",
  // line envelope
  "evt",
  "k",
  "callId",
  "userId",
  "role",
  "seq",
  "dropped",
  "events",
  "skewMs",
  // env
  "browser",
  "browserMajor",
  "os",
  "osMajor",
  "osMinor",
  "mobile",
  "standalone",
  // event fields
  "at",
  "phase",
  "ms",
  "what",
  "state",
  "trigger",
  "local",
  "remote",
  "protocol",
  "relayProtocol",
  "networkType",
  "rttMs",
  "lossPct",
  "jitterMs",
  "inKbps",
  "outKbps",
  "videoInFps",
  "videoInWidth",
  "videoInHeight",
  "videoOutFps",
  "videoOutWidth",
  "videoOutHeight",
  "facing",
  "device",
  "context",
  "name",
  "persisted",
  "ok",
  "ttlSeconds",
  "servers",
  "cause",
  "serverReason",
])

const IP_A = "203.0.113.7"
const IP_B = "192.0.2.10"
const IP_C = "198.51.100.1"
const SDP = "v=0\r\no=- 1 2 IN IP4 198.51.100.1"

describe("CallDiagBatch", () => {
  it("accepts a batch with every event kind", () => {
    const events = [
      { k: "phase", at: NOW, phase: "connecting", ms: 0 },
      { k: "pc", at: NOW, what: "ice", state: "checking" },
      { k: "ice_restart", at: NOW, trigger: "auto_failed" },
      { k: "pair", at: NOW, local: "relay", remote: "srflx", protocol: "udp", relayProtocol: "tls", networkType: "cellular" },
      { k: "stats", at: NOW, state: "connected", rttMs: 80, lossPct: 2, jitterMs: 9, inKbps: 40, outKbps: 38, videoInFps: 30, videoInWidth: 640, videoInHeight: 480 },
      { k: "media", at: NOW, what: "camera_flip", facing: "environment" },
      { k: "gum_error", at: NOW, device: "camera", context: "flip", name: "NotReadableError" },
      { k: "page", at: NOW, what: "pagehide", persisted: false },
      { k: "ws", at: NOW, what: "down" },
      { k: "reconnect", at: NOW, what: "give_up" },
      { k: "turn", at: NOW, ok: true, ms: 120, ttlSeconds: 86400, servers: 1 },
      { k: "end", at: NOW, cause: "remote", serverReason: "dropped" },
    ]
    expect(CallDiagBatch.safeParse(validBatch({ events })).success).toBe(true)
  })
})

describe("POST /api/calls/diag", () => {
  const logs: string[] = []
  const logStream = new Writable({
    write(chunk, _enc, cb) {
      logs.push(String(chunk))
      cb()
    },
  })
  let t: TestApp
  let cookie: string
  let aliceId: string

  function post(
    body: unknown,
    opts: { cookie?: string | null; origin?: string | null; ip?: string; raw?: string } = {},
  ) {
    const headers: Record<string, string> = { "cf-connecting-ip": opts.ip ?? freshIp() }
    const c = opts.cookie === undefined ? cookie : opts.cookie
    if (c) headers.cookie = c
    const origin = opts.origin === undefined ? TEST_ORIGIN : opts.origin
    if (origin) headers.origin = origin
    if (opts.raw !== undefined) {
      headers["content-type"] = "application/json"
      return t.app.inject({ method: "POST", url: "/api/calls/diag", headers, payload: opts.raw })
    }
    return t.app.inject({ method: "POST", url: "/api/calls/diag", headers, payload: body as object })
  }

  function lines(): Record<string, unknown>[] {
    return logs
      .join("")
      .split("\n")
      .filter((l) => l.trim().length > 0)
      .map((l) => JSON.parse(l) as Record<string, unknown>)
  }
  const diagLines = () => lines().filter((o) => o.evt === "call_diag")
  const rejectedLines = () => lines().filter((o) => o.evt === "call_diag_rejected")

  beforeAll(async () => {
    t = await makeTestApp({ logStream })
    cookie = await loginCookie(t.app, "alice")
    aliceId = t.app.db.select({ id: users.id }).from(users).where(eq(users.username, "alice")).get()!.id
  })
  afterAll(async () => {
    await t.close()
  })

  it("answers 401 without a session", async () => {
    const res = await post(validBatch(), { cookie: null })
    expect(res.statusCode).toBe(401)
  })

  it("answers 403 with a session but no Origin", async () => {
    const res = await post(validBatch(), { origin: null })
    expect(res.statusCode).toBe(403)
  })

  it("answers 204 to a valid batch and writes one batch line plus one line per event", async () => {
    const before = diagLines().length
    const callId = randomUUID()
    const res = await post(validBatch({ callId }), { ip: "198.51.100.77" })
    expect(res.statusCode).toBe(204)
    expect(res.body).toBe("")
    expect(res.headers["cache-control"]).toBe("no-store")

    const added = diagLines().slice(before)
    expect(added).toHaveLength(3)
    for (const line of added) {
      expect(line).toMatchObject({ evt: "call_diag", callId, role: "caller", seq: 3, userId: aliceId })
      for (const key of Object.keys(line)) expect(ALLOWED.has(key), `unexpected log key ${key}`).toBe(true)
    }
    const batch = added[0]!
    expect(batch).toMatchObject({ k: "batch", dropped: 0, events: 2, ...ENV })
    expect(typeof batch.skewMs).toBe("number")
    expect(added[1]).toMatchObject({ k: "phase", phase: "live", ms: 2400, at: NOW })
    expect(added[2]).toMatchObject({ k: "end", cause: "hangup", at: NOW + 5000 })
    expect(JSON.stringify(added)).not.toContain("198.51.100.77")
  })

  it("takes userId from the session, never from the body", async () => {
    const res = await post(validBatch({ userId: randomUUID() }))
    expect(res.statusCode).toBe(400)
  })

  const bad: [string, () => Record<string, unknown>][] = [
    ["an unknown top-level key", () => validBatch({ address: IP_A })],
    ["an unknown key inside an event", () => validBatch({ events: [{ k: "ws", at: NOW, what: "down", address: IP_A }] })],
    [
      "a candidate string inside an event",
      () => validBatch({ events: [{ k: "pair", at: NOW, local: "host", remote: "host", candidate: `candidate:1 1 udp 2122 ${IP_B} 5000 typ host` }] }),
    ],
    ["an unknown k", () => validBatch({ events: [{ k: "sdp", at: NOW }] })],
    ["a pair whose local type is an IP", () => validBatch({ events: [{ k: "pair", at: NOW, local: IP_B, remote: "relay" }] })],
    ["a pc state holding SDP", () => validBatch({ events: [{ k: "pc", at: NOW, what: "signaling", state: SDP }] })],
    ["a non-uuid callId", () => validBatch({ callId: "call-1" })],
    ["rttMs 600001", () => validBatch({ events: [{ k: "stats", at: NOW, state: "connected", rttMs: 600001 }] })],
    ["a fractional ms", () => validBatch({ events: [{ k: "phase", at: NOW, phase: "live", ms: 1.5 }] })],
    [
      `${CALL_DIAG_MAX_EVENTS + 1} events`,
      () => validBatch({ events: Array.from({ length: CALL_DIAG_MAX_EVENTS + 1 }, () => ({ k: "ws", at: NOW, what: "live" })) }),
    ],
    ["zero events", () => validBatch({ events: [] })],
    ["an env with a free-text field", () => validBatch({ env: { ...ENV, ua: "Mozilla/5.0" } })],
  ]

  it.each(bad)("rejects %s with 400 invalid_body and logs only a call_diag_rejected line", async (_name, body) => {
    const before = diagLines().length
    const rejectedBefore = rejectedLines().length
    const res = await post(body())
    expect(res.statusCode).toBe(400)
    expect(res.json()).toEqual({ error: "invalid_body" })
    expect(diagLines().length).toBe(before)
    const rejected = rejectedLines().slice(rejectedBefore)
    expect(rejected).toHaveLength(1)
    const line = rejected[0]!
    expect(line.userId).toBe(aliceId)
    expect(typeof line.issues).toBe("number")
    expect(typeof line.code).toBe("string")
    for (const key of Object.keys(line)) {
      expect(["level", "time", "pid", "hostname", "evt", "userId", "issues", "code"]).toContain(key)
    }
  })

  it("never logged the injected IPs or SDP, nor any line mentioning the route", () => {
    const text = logs.join("")
    for (const needle of [IP_A, IP_B, IP_C, "v=0", "candidate:", "/api/calls/diag"]) {
      expect(text, `log contains ${needle}`).not.toContain(needle)
    }
  })

  it(`answers 413 invalid_body to a body over ${CALL_DIAG_BODY_LIMIT} bytes`, async () => {
    const raw = JSON.stringify(validBatch({ pad: "x".repeat(CALL_DIAG_BODY_LIMIT) }))
    const res = await post(null, { raw })
    expect(res.statusCode).toBe(413)
    expect(res.json()).toEqual({ error: "invalid_body" })
  })

  it("allows 60 posts a minute per client IP; the 61st is 429 rate_limited", async () => {
    const ip = "10.252.0.1"
    for (let i = 0; i < 60; i++) {
      const res = await post(validBatch(), { ip })
      expect(res.statusCode).toBe(204)
    }
    const limited = await post(validBatch(), { ip })
    expect(limited.statusCode).toBe(429)
    expect(limited.json()).toMatchObject({ error: "rate_limited" })
  })
})
