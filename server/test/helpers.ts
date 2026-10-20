import { randomUUID } from "node:crypto"
import { mkdtempSync, rmSync } from "node:fs"
import type { WebSocket } from "ws"
import { tmpdir } from "node:os"
import path from "node:path"
import type { FastifyInstance } from "fastify"
import { eq } from "drizzle-orm"
import webpush from "web-push"
import { buildApp } from "../src/app"
import type { WebPushSend } from "../src/push/sender"
import { loadConfig, type Config } from "../src/config"
import { users } from "../src/db/schema"
import { seedUsers, type SeedEntry } from "../src/db/seed"
import { decryptToFile, readMediaKey } from "../src/media/crypto"

/** Test-only accounts. Passwords are fixtures, never real credentials. */
export const TEST_USERS = {
  alice: { username: "alice", displayName: "Alice Test", password: "alice-test-password-1" },
  bob: { username: "bob", displayName: "Bob Test", password: "bob-test-password-22" },
} satisfies Record<string, SeedEntry>

export const TEST_ORIGIN = "http://localhost:3000"

/** Fixture TURN key values. Never real values. */
export const TURN_TEST_ENV = {
  CF_TURN_KEY_ID: "test-key-id-0000",
  CF_TURN_KEY_API_TOKEN: "test-turn-bearer-0000",
} as const

/**
 * A fresh VAPID pair plus an https subject (the test APP_ORIGIN is http, so the default would not
 * apply). Generated per call: never a real deployment key.
 */
export function vapidTestEnv(): { VAPID_PUBLIC_KEY: string; VAPID_PRIVATE_KEY: string; VAPID_SUBJECT: string } {
  const k = webpush.generateVAPIDKeys()
  return { VAPID_PUBLIC_KEY: k.publicKey, VAPID_PRIVATE_KEY: k.privateKey, VAPID_SUBJECT: "https://duet.test" }
}

export function testConfig(dataDir: string, extraEnv: Record<string, string | undefined> = {}): Config {
  return loadConfig({
    NODE_ENV: "test",
    DATA_DIR: dataDir,
    WEB_OUT: path.join(dataDir, "no-web-out"), // does not exist -> static serving is skipped
    APP_ORIGIN: TEST_ORIGIN,
    COOKIE_SECURE: "false",
    LOG_LEVEL: "silent",
    ...extraEnv,
  })
}

export function makeDataDir(): string {
  return mkdtempSync(path.join(tmpdir(), "duet-test-"))
}

export interface TestApp {
  app: FastifyInstance
  users: typeof TEST_USERS
  dataDir: string
  close: () => Promise<void>
}

export interface MakeTestAppOptions {
  seed?: boolean
  dataDir?: string
  env?: Record<string, string | undefined>
  fetch?: typeof fetch
  turnTimeoutMs?: number
  logStream?: NodeJS.WritableStream
  heartbeatMs?: number
  webPushSend?: WebPushSend
  callTimers?: { ringTimeoutMs?: number; callerAbsentMs?: number; absentGraceMs?: number }
}

export async function makeTestApp({
  seed = true,
  dataDir,
  env,
  fetch,
  turnTimeoutMs,
  logStream,
  heartbeatMs,
  webPushSend,
  callTimers,
}: MakeTestAppOptions = {}): Promise<TestApp> {
  const dir = dataDir ?? makeDataDir()
  const app = await buildApp(testConfig(dir, env), { fetch, turnTimeoutMs, logStream, heartbeatMs, webPushSend, callTimers })
  if (seed) {
    await seedUsers(app.db, [TEST_USERS.alice, TEST_USERS.bob])
  }
  return {
    app,
    users: TEST_USERS,
    dataDir: dir,
    close: async () => {
      await app.close()
      rmSync(dir, { recursive: true, force: true })
    },
  }
}

let loginIpCounter = 0
function loginIp(): string {
  loginIpCounter += 1
  return `10.9.${Math.floor(loginIpCounter / 250)}.${(loginIpCounter % 250) + 1}`
}

/** Log in as a seeded test user and return the "duet_session=<token>" cookie string. */
export async function loginCookie(app: FastifyInstance, username: "alice" | "bob"): Promise<string> {
  const row = app.db.select({ id: users.id }).from(users).where(eq(users.username, username)).get()
  if (!row) throw new Error(`test user ${username} is not seeded`)
  const res = await app.inject({
    method: "POST",
    url: "/api/login",
    headers: { origin: TEST_ORIGIN, "cf-connecting-ip": loginIp() },
    payload: { userId: row.id, password: TEST_USERS[username].password },
  })
  if (res.statusCode !== 200) throw new Error(`login as ${username} failed with ${res.statusCode}`)
  const raw = res.headers["set-cookie"]
  const header = Array.isArray(raw) ? raw.join("\n") : String(raw ?? "")
  const m = /duet_session=([^;]+)/.exec(header)
  if (!m) throw new Error("login set no duet_session cookie")
  return `duet_session=${m[1]}`
}

/** A server frame as the test sees it (loosely typed so tests can assert on any field). */
export type WsFrame = { t: string } & Record<string, any>

export interface WsTestClient {
  ws: WebSocket
  /** Resolves to the next parsed frame (queued or future); rejects after timeoutMs. */
  next(timeoutMs?: number): Promise<WsFrame>
  /** Waits ms, then resolves to every frame received and not yet consumed. */
  collect(ms: number): Promise<WsFrame[]>
  /** Resolves once the socket closes, with the close code. */
  closed: Promise<{ code: number }>
  /** JSON-encodes and sends a frame. */
  send(frame: unknown): void
}

/**
 * Open /ws through @fastify/websocket's injectWS. The message listener is attached in onInit, so the
 * hello frame (sent right after the upgrade) is never missed. cookie/origin null = header omitted.
 */
export async function openWs(
  app: FastifyInstance,
  cookie: string | null,
  origin: string | null,
): Promise<WsTestClient> {
  const headers: Record<string, string> = {}
  if (cookie !== null) headers.cookie = cookie
  if (origin !== null) headers.origin = origin

  const queue: WsFrame[] = []
  const waiters: Array<(f: WsFrame) => void> = []
  let resolveClosed!: (v: { code: number }) => void
  const closed = new Promise<{ code: number }>((r) => {
    resolveClosed = r
  })

  const ws = await app.injectWS("/ws", { headers } as never, {
    onInit(socket) {
      socket.on("message", (data) => {
        let frame: WsFrame
        try {
          frame = JSON.parse(data.toString()) as WsFrame
        } catch {
          frame = { t: "__unparseable__" }
        }
        const w = waiters.shift()
        if (w) w(frame)
        else queue.push(frame)
      })
      // Browsers answer pings at the protocol level. injectWS builds its client in server mode with
      // autoPong unset, so answer pings here to behave like a real client.
      socket.on("ping", (data) => socket.pong(data))
      socket.on("close", (code) => resolveClosed({ code }))
      socket.on("error", () => {
        /* surfaced through close */
      })
    },
  })

  return {
    ws,
    closed,
    send(frame) {
      ws.send(typeof frame === "string" ? frame : JSON.stringify(frame))
    },
    next(timeoutMs = 1000) {
      const queued = queue.shift()
      if (queued) return Promise.resolve(queued)
      return new Promise<WsFrame>((resolve, reject) => {
        const waiter = (f: WsFrame) => {
          clearTimeout(timer)
          resolve(f)
        }
        const timer = setTimeout(() => {
          const i = waiters.indexOf(waiter)
          if (i >= 0) waiters.splice(i, 1)
          reject(new Error(`no ws frame within ${timeoutMs} ms`))
        }, timeoutMs)
        waiters.push(waiter)
      })
    },
    async collect(ms) {
      await new Promise((r) => setTimeout(r, ms))
      return queue.splice(0, queue.length)
    },
  }
}

/** Run a full chunked upload of `bytes` (POST /api/uploads -> chunk PUTs -> complete). */
export async function uploadBytes(
  app: FastifyInstance,
  cookie: string,
  bytes: Buffer,
  kind: "image" | "video" | "audio" = "image",
): Promise<{ id: string; attachment: Record<string, any> }> {
  const created = await app.inject({
    method: "POST",
    url: "/api/uploads",
    headers: { cookie, origin: TEST_ORIGIN },
    payload: { kind, size: bytes.length },
  })
  if (created.statusCode !== 200) throw new Error(`create upload returned ${created.statusCode}`)
  const { id, chunkSize } = created.json() as { id: string; chunkSize: number }
  for (let i = 0; i * chunkSize < bytes.length; i++) {
    const res = await app.inject({
      method: "PUT",
      url: `/api/uploads/${id}/chunks/${i}`,
      headers: { cookie, origin: TEST_ORIGIN, "content-type": "application/octet-stream" },
      payload: bytes.subarray(i * chunkSize, (i + 1) * chunkSize),
    })
    if (res.statusCode !== 204) throw new Error(`chunk ${i} returned ${res.statusCode}`)
  }
  const done = await app.inject({
    method: "POST",
    url: `/api/uploads/${id}/complete`,
    headers: { cookie, origin: TEST_ORIGIN },
  })
  if (done.statusCode !== 200) throw new Error(`complete returned ${done.statusCode}`)
  return { id, attachment: done.json().attachment }
}

/** The app's media key (QT-4qu): tests read it to decrypt stored media. */
export function mediaKey(app: FastifyInstance): Promise<Buffer> {
  return readMediaKey(app.config.MEDIA_KEY_FILE)
}

/**
 * Decrypt a stored media file into a uniquely named plaintext copy inside t.dataDir (removed by
 * close()) and return its path, for ffprobe / sharp / byte checks on what the server stored.
 */
export async function decryptedCopy(t: TestApp, file: string): Promise<string> {
  const out = path.join(t.dataDir, `plain-${randomUUID()}-${path.basename(file)}`)
  await decryptToFile(await mediaKey(t.app), file, out)
  return out
}
