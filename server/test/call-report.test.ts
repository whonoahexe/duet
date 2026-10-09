import { randomUUID } from "node:crypto"
import { Writable } from "node:stream"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { eq } from "drizzle-orm"
import { callVerdict, CallReport } from "@duet/shared"
import { users } from "../src/db/schema"
import { loginCookie, makeTestApp, TEST_ORIGIN, type TestApp } from "./helpers"

describe("callVerdict thresholds (INFR-04: never claim a media path that was not proven)", () => {
  const cases: [string, Parameters<typeof callVerdict>, ReturnType<typeof callVerdict>][] = [
    ["connected but zero bytes", [{ state: "connected", inboundBytes: 0, localType: "host" }, 0, false], "waiting"],
    ["connected, bytes 1 after 0", [{ state: "connected", inboundBytes: 1, localType: "host" }, 0, false], "pass"],
    ["stalled bytes (500 after 500)", [{ state: "connected", inboundBytes: 500, localType: "host" }, 500, false], "waiting"],
    ["counter reset (499 after 500)", [{ state: "connected", inboundBytes: 499, localType: "host" }, 500, false], "waiting"],
    ["still connecting with bytes", [{ state: "connecting", inboundBytes: 1000 }, 0, false], "waiting"],
    ["forced relay through relay, growing", [{ state: "connected", inboundBytes: 2000, localType: "relay" }, 1000, true], "pass"],
    ["forced relay but srflx selected", [{ state: "connected", inboundBytes: 2000, localType: "srflx" }, 1000, true], "not_relayed"],
    ["forced relay, no selected pair yet", [{ state: "connected", inboundBytes: 2000 }, 1000, true], "waiting"],
    ["failed with growing bytes", [{ state: "failed", inboundBytes: 5000, localType: "relay" }, 0, true], "failed"],
    ["failed with zero bytes", [{ state: "failed", inboundBytes: 0 }, 0, false], "failed"],
  ]

  it.each(cases)("%s", (_name, args, expected) => {
    expect(callVerdict(...args)).toBe(expected)
  })

  it("CallReport accepts a well-formed report", () => {
    expect(CallReport.safeParse(validReport()).success).toBe(true)
  })
})

function validReport(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    clientId: "4b0c6f0e-5d1a-4f5e-9a51-0d5b7f0c2a11",
    room: "smoke-r-1",
    forceRelay: true,
    pass: true,
    verdict: "pass",
    connectionState: "connected",
    inboundBytes: 123456,
    localType: "relay",
    remoteType: "relay",
    relayProtocol: "udp",
    rttMs: 42,
    ua: "Mozilla/5.0 (test)",
    ...overrides,
  }
}

let ipCounter = 0
function freshIp(): string {
  ipCounter += 1
  return `10.8.${Math.floor(ipCounter / 250)}.${(ipCounter % 250) + 1}`
}

/** Fields a call_smoke line may carry: pino/fastify bookkeeping, the three server fields, the report. */
const ALLOWED_LOG_KEYS = new Set([
  "level",
  "time",
  "pid",
  "hostname",
  "reqId",
  "msg",
  "evt",
  "userId",
  "cfIp",
  ...Object.keys(validReport()),
])

describe("POST /api/debug/call-report", () => {
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

  function post(body: unknown, opts: { cookie?: string | null; origin?: string | null; ip?: string } = {}) {
    const headers: Record<string, string> = { "cf-connecting-ip": opts.ip ?? freshIp() }
    const c = opts.cookie === undefined ? cookie : opts.cookie
    if (c) headers.cookie = c
    const origin = opts.origin === undefined ? TEST_ORIGIN : opts.origin
    if (origin) headers.origin = origin
    return t.app.inject({ method: "POST", url: "/api/debug/call-report", headers, payload: body as object })
  }

  function smokeLines(): Record<string, unknown>[] {
    return logs
      .join("")
      .split("\n")
      .filter((l) => l.trim().length > 0)
      .map((l) => JSON.parse(l) as Record<string, unknown>)
      .filter((o) => o.evt === "call_smoke")
  }

  beforeAll(async () => {
    t = await makeTestApp({ logStream })
    cookie = await loginCookie(t.app, "alice")
    aliceId = t.app.db.select({ id: users.id }).from(users).where(eq(users.username, "alice")).get()!.id
  })
  afterAll(async () => {
    await t.close()
  })

  it("answers 401 without a session", async () => {
    const res = await post(validReport(), { cookie: null })
    expect(res.statusCode).toBe(401)
  })

  it("answers 403 with a session but no Origin", async () => {
    const res = await post(validReport(), { origin: null })
    expect(res.statusCode).toBe(403)
  })

  it("answers 204 to a valid report and writes exactly one call_smoke line with the report fields", async () => {
    const before = smokeLines().length
    const clientId = randomUUID()
    const ip = "198.51.100.23"
    const res = await post(validReport({ clientId, room: "smoke-n-7", forceRelay: false, localType: "host" }), { ip })
    expect(res.statusCode).toBe(204)
    expect(res.body).toBe("")

    const lines = smokeLines()
    expect(lines.length - before).toBe(1)
    const line = lines[lines.length - 1]!
    expect(line).toMatchObject({
      evt: "call_smoke",
      userId: aliceId,
      cfIp: ip,
      clientId,
      room: "smoke-n-7",
      forceRelay: false,
      pass: true,
      verdict: "pass",
      inboundBytes: 123456,
      localType: "host",
    })
    for (const key of Object.keys(line)) expect(ALLOWED_LOG_KEYS.has(key), `unexpected log key ${key}`).toBe(true)
    expect(JSON.stringify(line)).not.toContain(cookie.split("=")[1]!)
  })

  it.each([1.5, -1, 9007199254740992])("rejects inboundBytes %s with 400 invalid_body", async (inboundBytes) => {
    const before = smokeLines().length
    const res = await post(validReport({ inboundBytes }))
    expect(res.statusCode).toBe(400)
    expect(res.json()).toEqual({ error: "invalid_body" })
    expect(smokeLines().length).toBe(before)
  })

  it("accepts inboundBytes 9007199254740991 (Number.MAX_SAFE_INTEGER)", async () => {
    const res = await post(validReport({ inboundBytes: Number.MAX_SAFE_INTEGER }))
    expect(res.statusCode).toBe(204)
  })

  it("rejects a fractional rttMs and accepts rttMs 0", async () => {
    const bad = await post(validReport({ rttMs: 12.5 }))
    expect(bad.statusCode).toBe(400)
    expect(bad.json()).toEqual({ error: "invalid_body" })
    const ok = await post(validReport({ rttMs: 0 }))
    expect(ok.statusCode).toBe(204)
  })

  it("caps ua at 300 characters", async () => {
    const long = await post(validReport({ ua: "u".repeat(301) }))
    expect(long.statusCode).toBe(400)
    expect(long.json()).toEqual({ error: "invalid_body" })
    const max = await post(validReport({ ua: "u".repeat(300) }))
    expect(max.statusCode).toBe(204)
  })

  it("rejects an unknown extra key", async () => {
    const res = await post(validReport({ cookie: "x" }))
    expect(res.statusCode).toBe(400)
    expect(res.json()).toEqual({ error: "invalid_body" })
  })

  it("rejects an invalid room id", async () => {
    const res = await post(validReport({ room: "Bad Room" }))
    expect(res.statusCode).toBe(400)
    expect(res.json()).toEqual({ error: "invalid_body" })
  })

  it("allows 30 reports a minute per client IP; the 31st is 429 rate_limited", async () => {
    const ip = "10.251.0.1"
    for (let i = 0; i < 30; i++) {
      const res = await post(validReport(), { ip })
      expect(res.statusCode).toBe(204)
    }
    const limited = await post(validReport(), { ip })
    expect(limited.statusCode).toBe(429)
    expect(limited.json()).toMatchObject({ error: "rate_limited" })
  })
})
