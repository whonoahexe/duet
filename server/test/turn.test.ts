import { Writable } from "node:stream"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { IceServersResponse } from "@duet/shared"
import { ConfigError } from "../src/config"
import { mintIceServers, TurnError, type TurnDeps } from "../src/rtc/turn"
import { loginCookie, makeDataDir, makeTestApp, testConfig, TEST_ORIGIN, TURN_TEST_ENV, type TestApp } from "./helpers"

const FIXTURE_USERNAME = "fixture-turn-username-1234"
const FIXTURE_CREDENTIAL = "fixture-turn-credential-5678"

/** Cloudflare's documented generate-ice-servers response plus one port-53 URL (filtered). */
const CF_FIXTURE = {
  iceServers: [
    { urls: ["stun:stun.cloudflare.com:3478"] },
    {
      urls: [
        "turn:turn.cloudflare.com:3478?transport=udp",
        "turn:turn.cloudflare.com:53?transport=udp",
        "turn:turn.cloudflare.com:443?transport=udp",
        "turn:turn.cloudflare.com:3478?transport=tcp",
        "turn:turn.cloudflare.com:80?transport=tcp",
        "turns:turn.cloudflare.com:5349?transport=tcp",
        "turns:turn.cloudflare.com:443?transport=tcp",
      ],
      username: FIXTURE_USERNAME,
      credential: FIXTURE_CREDENTIAL,
    },
  ],
}

interface Call {
  url: string
  init: RequestInit | undefined
}

function fakeFetch(body: unknown, status = 201): { fetch: typeof fetch; calls: Call[] } {
  const calls: Call[] = []
  const f = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), init })
    return new Response(typeof body === "string" ? body : JSON.stringify(body), { status })
  }) as typeof fetch
  return { fetch: f, calls }
}

function deps(over: Partial<TurnDeps>): TurnDeps {
  return {
    fetch: fakeFetch(CF_FIXTURE).fetch,
    apiBase: "https://rtc.example.test",
    keyId: "key-123",
    apiToken: "bearer-abc",
    ttlSeconds: 86400,
    timeoutMs: 1000,
    ...over,
  }
}

async function expectTurnError(p: Promise<unknown>, code: "turn_unconfigured" | "turn_unavailable") {
  await expect(p).rejects.toBeInstanceOf(TurnError)
  await expect(p).rejects.toMatchObject({ code })
}

describe("mintIceServers", () => {
  it("POSTs {ttl} to generate-ice-servers with the TURN bearer", async () => {
    const ff = fakeFetch(CF_FIXTURE)
    await mintIceServers(deps({ fetch: ff.fetch, keyId: "key/123", ttlSeconds: 3600 }))
    expect(ff.calls).toHaveLength(1)
    const call = ff.calls[0]!
    expect(call.url).toBe("https://rtc.example.test/v1/turn/keys/key%2F123/credentials/generate-ice-servers")
    expect(call.init?.method).toBe("POST")
    const headers = new Headers(call.init?.headers)
    expect(headers.get("authorization")).toBe("Bearer bearer-abc")
    expect(headers.get("content-type")).toBe("application/json")
    expect(JSON.parse(String(call.init?.body))).toEqual({ ttl: 3600 })
    expect(call.init?.signal).toBeInstanceOf(AbortSignal)
  })

  it("accepts 201 and 200, and returns urls as arrays", async () => {
    for (const status of [201, 200]) {
      const single = { iceServers: [{ urls: "turn:turn.cloudflare.com:3478?transport=udp", username: "u", credential: "c" }] }
      const res = await mintIceServers(deps({ fetch: fakeFetch(single, status).fetch }))
      expect(res.iceServers).toEqual([
        { urls: ["turn:turn.cloudflare.com:3478?transport=udp"], username: "u", credential: "c" },
      ])
      expect(res.ttlSeconds).toBe(86400)
    }
  })

  it("drops :53 URLs but keeps :5349 and :443, and drops entries left without URLs", async () => {
    const body = {
      iceServers: [...CF_FIXTURE.iceServers, { urls: ["turn:turn.cloudflare.com:53"], username: "x", credential: "y" }],
    }
    const res = await mintIceServers(deps({ fetch: fakeFetch(body).fetch }))
    const all = res.iceServers.flatMap((s) => s.urls)
    expect(all.some((u) => /:53(\?|$)/.test(u))).toBe(false)
    expect(all).toContain("turns:turn.cloudflare.com:5349?transport=tcp")
    expect(all).toContain("turn:turn.cloudflare.com:443?transport=udp")
    expect(all).toContain("turns:turn.cloudflare.com:443?transport=tcp")
    expect(res.iceServers).toHaveLength(2)
    expect(res.iceServers[1]!.urls).toHaveLength(6)
  })

  it("is turn_unconfigured without a key id or token, and never calls fetch", async () => {
    const ff = fakeFetch(CF_FIXTURE)
    await expectTurnError(mintIceServers(deps({ fetch: ff.fetch, keyId: undefined })), "turn_unconfigured")
    await expectTurnError(mintIceServers(deps({ fetch: ff.fetch, apiToken: undefined })), "turn_unconfigured")
    expect(ff.calls).toHaveLength(0)
  })

  it("is turn_unavailable on 404 unknown key", async () => {
    const ff = fakeFetch({ error: "cannot find specified key" }, 404)
    await expectTurnError(mintIceServers(deps({ fetch: ff.fetch })), "turn_unavailable")
  })

  it("is turn_unavailable on a 500", async () => {
    await expectTurnError(mintIceServers(deps({ fetch: fakeFetch("oops", 500).fetch })), "turn_unavailable")
  })

  it("is turn_unavailable when fetch rejects", async () => {
    const f = (async () => {
      throw new TypeError("fetch failed")
    }) as typeof fetch
    await expectTurnError(mintIceServers(deps({ fetch: f })), "turn_unavailable")
  })

  it("is turn_unavailable when Cloudflare never answers (timeout honoured through the signal)", async () => {
    const f = ((_url: string, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal!.reason))
      })) as typeof fetch
    const started = Date.now()
    await expectTurnError(mintIceServers(deps({ fetch: f, timeoutMs: 50 })), "turn_unavailable")
    expect(Date.now() - started).toBeLessThan(1000)
  })

  it("is turn_unavailable for a body without iceServers, an empty list, or STUN only", async () => {
    for (const body of [
      { foo: 1 },
      { iceServers: [] },
      { iceServers: [{ urls: ["stun:stun.cloudflare.com:3478"] }, { urls: "stun:stun.l.example:19302" }] },
      "not json",
    ]) {
      await expectTurnError(mintIceServers(deps({ fetch: fakeFetch(body).fetch })), "turn_unavailable")
    }
  })
})

describe("TURN config", () => {
  const dir = makeDataDir()

  it("accepts TURN_CREDENTIAL_TTL_SECONDS 60..172800 only", () => {
    expect(() => testConfig(dir, { TURN_CREDENTIAL_TTL_SECONDS: "59" })).toThrow(ConfigError)
    expect(() => testConfig(dir, { TURN_CREDENTIAL_TTL_SECONDS: "172801" })).toThrow(ConfigError)
    expect(testConfig(dir, { TURN_CREDENTIAL_TTL_SECONDS: "60" }).TURN_CREDENTIAL_TTL_SECONDS).toBe(60)
    expect(testConfig(dir, { TURN_CREDENTIAL_TTL_SECONDS: "172800" }).TURN_CREDENTIAL_TTL_SECONDS).toBe(172800)
    expect(testConfig(dir).TURN_CREDENTIAL_TTL_SECONDS).toBe(86400)
  })

  it("requires the key id and the token together", () => {
    expect(() => testConfig(dir, { CF_TURN_KEY_ID: "only-the-id" })).toThrow(ConfigError)
    expect(() => testConfig(dir, { CF_TURN_KEY_API_TOKEN: "only-the-token" })).toThrow(ConfigError)
    const both = testConfig(dir, { ...TURN_TEST_ENV })
    expect(both.CF_TURN_KEY_ID).toBe(TURN_TEST_ENV.CF_TURN_KEY_ID)
    expect(both.CF_TURN_API_BASE).toBe("https://rtc.live.cloudflare.com")
  })
})

let ipCounter = 0
function freshIp(): string {
  ipCounter += 1
  return `10.7.${Math.floor(ipCounter / 250)}.${(ipCounter % 250) + 1}`
}

function iceServers(t: TestApp, cookie: string | null, opts: { origin?: string | null; ip?: string } = {}) {
  const headers: Record<string, string> = { "cf-connecting-ip": opts.ip ?? freshIp() }
  if (cookie) headers.cookie = cookie
  const origin = opts.origin === undefined ? TEST_ORIGIN : opts.origin
  if (origin) headers.origin = origin
  return t.app.inject({ method: "POST", url: "/api/rtc/ice-servers", headers })
}

describe("POST /api/rtc/ice-servers", () => {
  const logs: string[] = []
  const logStream = new Writable({
    write(chunk, _enc, cb) {
      logs.push(String(chunk))
      cb()
    },
  })
  let cf = fakeFetch(CF_FIXTURE)
  let status = 201
  const switchable = (async (input: string | URL | Request, init?: RequestInit) => {
    cf.calls.push({ url: String(input), init })
    return new Response(JSON.stringify(status === 201 ? CF_FIXTURE : { error: "boom" }), { status })
  }) as typeof fetch

  let t: TestApp
  let bare: TestApp
  let cookie: string
  beforeAll(async () => {
    t = await makeTestApp({ env: { ...TURN_TEST_ENV }, fetch: switchable, logStream })
    bare = await makeTestApp({ fetch: fakeFetch(CF_FIXTURE).fetch })
    cookie = await loginCookie(t.app, "alice")
  })
  afterAll(async () => {
    await t.close()
    await bare.close()
  })

  it("answers 401 without a session", async () => {
    const res = await iceServers(t, null)
    expect(res.statusCode).toBe(401)
    expect(res.json()).toEqual({ error: "unauthenticated" })
  })

  it("answers 403 without Origin", async () => {
    const res = await iceServers(t, cookie, { origin: null })
    expect(res.statusCode).toBe(403)
    expect(res.json()).toEqual({ error: "bad_origin" })
  })

  it("answers 503 turn_unconfigured when the TURN env is absent", async () => {
    const c = await loginCookie(bare.app, "bob")
    const res = await iceServers(bare, c)
    expect(res.statusCode).toBe(503)
    expect(res.json()).toEqual({ error: "turn_unconfigured" })
  })

  it("returns minted iceServers with no-store and leaks neither key value", async () => {
    status = 201
    cf = fakeFetch(CF_FIXTURE)
    const res = await iceServers(t, cookie)
    expect(res.statusCode).toBe(200)
    expect(String(res.headers["cache-control"])).toContain("no-store")
    const body = IceServersResponse.parse(res.json())
    expect(body.ttlSeconds).toBe(86400)
    expect(body.iceServers.flatMap((s) => s.urls).some((u) => u.startsWith("turn"))).toBe(true)
    expect(res.body).not.toContain(TURN_TEST_ENV.CF_TURN_KEY_ID)
    expect(res.body).not.toContain(TURN_TEST_ENV.CF_TURN_KEY_API_TOKEN)
    expect(cf.calls[0]!.url).toContain(`/v1/turn/keys/${TURN_TEST_ENV.CF_TURN_KEY_ID}/`)
    expect(JSON.parse(String(cf.calls[0]!.init?.body))).toEqual({ ttl: 86400 })
  })

  it("answers 502 turn_unavailable when Cloudflare fails", async () => {
    status = 500
    const res = await iceServers(t, cookie)
    status = 201
    expect(res.statusCode).toBe(502)
    expect(res.json()).toEqual({ error: "turn_unavailable" })
  })

  it("allows 30 calls a minute per client IP; the 31st is 429 rate_limited", async () => {
    const ip = "10.250.0.1"
    for (let i = 0; i < 30; i++) {
      const res = await iceServers(t, cookie, { ip })
      expect(res.statusCode).toBe(200)
    }
    const limited = await iceServers(t, cookie, { ip })
    expect(limited.statusCode).toBe(429)
    expect(limited.json()).toMatchObject({ error: "rate_limited" })
    expect(limited.json().retryAfterSeconds).toBeGreaterThan(0)
    const other = await iceServers(t, cookie, { ip: "10.250.0.2" })
    expect(other.statusCode).toBe(200)
  })

  it("logs turn_mint but never the key values or the minted credential", () => {
    const text = logs.join("")
    expect(text).toContain('"evt":"turn_mint"')
    expect(text).toContain('"evt":"turn_config"')
    expect(text).not.toContain(TURN_TEST_ENV.CF_TURN_KEY_ID)
    expect(text).not.toContain(TURN_TEST_ENV.CF_TURN_KEY_API_TOKEN)
    expect(text).not.toContain(FIXTURE_CREDENTIAL)
    expect(text).not.toContain(FIXTURE_USERNAME)
  })

  it("turn_mint lines carry the mint latency and the credential TTL (261020-oj7)", () => {
    const mints = logs
      .join("")
      .split("\n")
      .filter((l) => l.includes('"evt":"turn_mint"'))
      .map((l) => JSON.parse(l) as Record<string, unknown>)
    const ok = mints.filter((m) => m.ok === true)
    const failed = mints.filter((m) => m.ok === false)
    expect(ok.length).toBeGreaterThan(0)
    expect(failed.length).toBeGreaterThan(0)
    for (const m of ok) {
      expect(typeof m.ms).toBe("number")
      expect(m.ms as number).toBeGreaterThanOrEqual(0)
      expect(m.ttlSeconds).toBe(t.app.config.TURN_CREDENTIAL_TTL_SECONDS)
    }
    for (const m of failed) {
      expect(typeof m.ms).toBe("number")
      expect(m.ms as number).toBeGreaterThanOrEqual(0)
    }
  })
})
