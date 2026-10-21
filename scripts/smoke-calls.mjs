// Headless two-browser E2E of the real call flow (CALL-01, CALL-04): Chrome contexts with fake mic and
// camera, two fixture accounts, real Cloudflare TURN credentials from the local duet server.
// Usage: node scripts/smoke-calls.mjs <base-url> [scenario ...]   (driven by scripts/smoke-calls.sh)
// No scenario names runs every scenario in registry order. Every scenario opens its own logged-in pages
// and closes them when done. Prints only scenario names and verdicts: never cookies, passwords, ICE
// server entries or credentials.
import { dumpErrors, fixtureIds, launchBrowser } from "./lib/e2e.mjs"

const BASE = process.argv[2]
if (!BASE) {
  console.error("usage: node scripts/smoke-calls.mjs <base-url> [scenario ...]")
  process.exit(2)
}

const ADA = { username: "smoke-ada", displayName: "Ada Smoke", password: "smoke-test-pass-0001" }
const BOB = { username: "smoke-bob", displayName: "Bob Smoke", password: "smoke-test-pass-0002" }

/** Poll `fn` until it returns true; throws `message` after `timeout` ms. */
async function until(fn, timeout, message) {
  const deadline = Date.now() + timeout
  for (;;) {
    if (await fn()) return
    if (Date.now() > deadline) throw new Error(typeof message === "function" ? message() : message)
    await new Promise((r) => setTimeout(r, 100))
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** Records every track getUserMedia hands out, so a scenario can prove each one was stopped. */
function recordTracks() {
  window.__duetTracks = []
  const md = navigator.mediaDevices
  if (!md || !md.getUserMedia) return
  const original = md.getUserMedia.bind(md)
  md.getUserMedia = async (constraints) => {
    const stream = await original(constraints)
    for (const track of stream.getTracks()) window.__duetTracks.push(track)
    return stream
  }
}

/** getUserMedia rejects like a person who tapped "Don't Allow" (NotAllowedError). */
function denyMedia() {
  const md = navigator.mediaDevices
  if (!md) return
  md.getUserMedia = async () => {
    throw new DOMException("Permission denied", "NotAllowedError")
  }
}

/**
 * navigator.wakeLock replaced by a stub that counts active sentinels on window.__duetWakeLocks: request
 * adds one, release subtracts one and fires "release" (headless Chrome has no real screen to keep on).
 */
function stubWakeLock() {
  window.__duetWakeLocks = 0
  const wakeLock = {
    async request(type) {
      window.__duetWakeLocks += 1
      const sentinel = new EventTarget()
      let released = false
      Object.defineProperties(sentinel, {
        type: { value: type },
        released: { get: () => released },
        release: {
          value: async () => {
            if (released) return
            released = true
            window.__duetWakeLocks -= 1
            sentinel.dispatchEvent(new Event("release"))
          },
        },
      })
      return sentinel
    },
  }
  Object.defineProperty(navigator, "wakeLock", { value: wakeLock, configurable: true })
}

/** getUserMedia rejects every request that asks for a camera (NotAllowedError); audio still works. */
function denyVideo() {
  const md = navigator.mediaDevices
  if (!md || !md.getUserMedia) return
  const original = md.getUserMedia.bind(md)
  md.getUserMedia = async (constraints) => {
    if (constraints && constraints.video) throw new DOMException("Permission denied", "NotAllowedError")
    return original(constraints)
  }
}

/**
 * The session cookie value of `fixture`'s login number `slot`. Logins are pooled across scenarios
 * (POST /api/login allows 5 per 5 minutes per account and IP): a scenario that needs two devices of the
 * same person uses slots 0 and 1, which are two different sessions.
 */
async function sessionCookie(ctx, fixture, slot) {
  const key = `${fixture.username}#${slot}`
  const cached = ctx.cookies.get(key)
  if (cached) return cached
  const res = await fetch(`${BASE}/api/login`, {
    method: "POST",
    headers: { "content-type": "application/json", Origin: BASE },
    body: JSON.stringify({ userId: ctx.ids[fixture.username], password: fixture.password }),
  })
  if (res.status !== 200) throw new Error(`login as ${fixture.username} returned ${res.status}`)
  const m = /duet_session=([^;]+)/.exec(res.headers.get("set-cookie") ?? "")
  if (!m) throw new Error(`login as ${fixture.username} set no duet_session cookie`)
  ctx.cookies.set(key, m[1])
  return m[1]
}

/**
 * Open the app at "/" as `fixture` (the chat composer must be visible), in a fresh browser context
 * (like a separate phone) on session `slot`. Registered for closing in `opened`.
 */
async function openApp(
  ctx,
  fixture,
  peer,
  opened,
  { denyMic = false, denyCamera = false, wakeLock = false, slot = 0, routeWs = false, init = null } = {},
) {
  const context = await loggedInContext(ctx, fixture, slot)
  const page = await newAppPage(context, fixture, opened, { denyMic, denyCamera, slot })
  if (wakeLock) await page.addInitScript(stubWakeLock)
  if (init) await page.addInitScript(init)
  if (routeWs) await routeSockets(page)
  await page.goto(`${BASE}/`)
  await page.getByPlaceholder(`Message ${peer.displayName}`).waitFor({ state: "visible", timeout: 15_000 })
  return page
}

/** A fresh browser context (a phone) logged in as `fixture` on session `slot`, with no page open yet. */
async function loggedInContext(ctx, fixture, slot = 0) {
  const context = await ctx.browser.newContext()
  await context.addCookies([{ name: "duet_session", value: await sessionCookie(ctx, fixture, slot), url: BASE }])
  return context
}

/** A new page in `context` with error capture and getUserMedia recording; not navigated yet. */
async function newAppPage(context, fixture, opened, { denyMic = false, denyCamera = false, slot = 0 } = {}) {
  const page = await context.newPage()
  const errors = []
  page.__errors = errors
  page.__name = slot === 0 ? fixture.username : `${fixture.username}-${slot + 1}`
  page.on("console", (msg) => {
    if (msg.type() === "error") errors.push(msg.text().slice(0, 300))
  })
  page.on("pageerror", (err) => errors.push(String(err).slice(0, 300)))
  opened.push(page)
  await page.addInitScript(recordTracks)
  if (denyMic) await page.addInitScript(denyMedia)
  if (denyCamera) await page.addInitScript(denyVideo)
  return page
}

/**
 * Every /ws socket of `page` goes through Playwright and on to the real server; page.__ws keeps the latest
 * pair, so dropSocket() can cut it from both ends like a network loss (CALL-07).
 */
async function routeSockets(page) {
  await page.routeWebSocket(/\/ws$/, (ws) => {
    const server = ws.connectToServer()
    page.__ws = { ws, server }
  })
}

/** Close the page's current /ws socket on both sides (never with the logged-out code 4401). */
async function dropSocket(page) {
  const current = page.__ws
  if (!current) throw new Error(`${page.__name} has no routed socket`)
  page.__ws = null
  await Promise.all([
    current.server.close({ code: 1001, reason: "smoke drop" }).catch(() => {}),
    current.ws.close({ code: 4000, reason: "smoke drop" }).catch(() => {}),
  ])
}

/**
 * Record, inside the page, every value the call status line and call-diag data-reconnecting take from
 * now on (a reconnect can recover faster than a poll would see it). Read back with seenStates().
 */
async function watchStates(page) {
  await page.evaluate(() => {
    const seen = { status: new Set(), reconnecting: new Set() }
    window.__duetSeen = seen
    const record = () => {
      const status = document.querySelector('[data-testid="call-status"]')?.textContent?.trim()
      if (status) seen.status.add(status.replace(/^\d+:\d{2}$/, "<timer>"))
      const r = document.querySelector('[data-testid="call-diag"]')?.getAttribute("data-reconnecting")
      if (r) seen.reconnecting.add(r)
    }
    record()
    new MutationObserver(record).observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true })
  })
}

async function seenStates(page) {
  return page.evaluate(() => ({
    status: [...(window.__duetSeen?.status ?? [])],
    reconnecting: [...(window.__duetSeen?.reconnecting ?? [])],
  }))
}

function callDialog(page, peer) {
  return page.getByRole("dialog", { name: `Call with ${peer.displayName}` })
}

function incomingDialog(page, peer) {
  return page.getByRole("dialog", { name: `Incoming call from ${peer.displayName}` })
}

async function statusOf(page, peer) {
  const el = callDialog(page, peer).getByTestId("call-status")
  return ((await el.count()) > 0 ? ((await el.first().textContent()) ?? "") : "").trim()
}

async function waitStatus(page, peer, re, timeout) {
  let last = ""
  await until(
    async () => {
      last = await statusOf(page, peer)
      return re.test(last)
    },
    timeout,
    `${page.__name}'s call status is "${last}", expected ${re}`,
  ).catch((err) => {
    throw new Error(`${err.message} (last "${last}")`)
  })
}

async function diag(page) {
  const el = page.getByTestId("call-diag")
  return {
    phase: await el.getAttribute("data-phase"),
    callId: await el.getAttribute("data-call-id"),
    localType: await el.getAttribute("data-local-type"),
    inboundBytes: Number(await el.getAttribute("data-inbound-bytes")),
    tone: await el.getAttribute("data-tone"),
    camera: await el.getAttribute("data-camera"),
    peerCamera: await el.getAttribute("data-peer-camera"),
    mic: await el.getAttribute("data-mic"),
    cameraDevice: await el.getAttribute("data-camera-device"),
    swapped: await el.getAttribute("data-swapped"),
    reconnecting: await el.getAttribute("data-reconnecting"),
  }
}

/** videoWidth of the page's remote video (0 when it has no decoded frame or is not mounted). */
async function remoteVideoWidth(page) {
  return page.evaluate(() => document.querySelector('[data-testid="remote-video"]')?.videoWidth ?? 0)
}

/** readyState of every camera track getUserMedia handed out on the page. */
async function cameraTrackStates(page) {
  return page.evaluate(() => (window.__duetTracks ?? []).filter((t) => t.kind === "video").map((t) => t.readyState))
}

/** Wait until `page`'s button `name` (inside the call dialog) reports aria-pressed `value`. */
async function waitPressed(page, peer, name, value, timeout) {
  const button = callDialog(page, peer).getByRole("button", { name, exact: true })
  let last = null
  await until(
    async () => {
      last = await button.getAttribute("aria-pressed")
      return last === value
    },
    timeout,
    () => `${page.__name}'s "${name}" aria-pressed is "${last}", expected "${value}"`,
  )
}

async function waitPhase(page, phase, timeout) {
  let last = ""
  await until(
    async () => {
      last = (await diag(page)).phase
      return last === phase
    },
    timeout,
    () => `${page.__name}'s call phase stayed "${last}", expected "${phase}"`,
  )
}

/** Every getUserMedia track of the page has readyState "ended" (the microphone was released). */
async function expectTracksEnded(page) {
  const states = await page.evaluate(() => (window.__duetTracks ?? []).map((t) => t.readyState))
  if (states.length === 0) throw new Error(`${page.__name} captured no tracks`)
  if (states.some((s) => s !== "ended")) throw new Error(`${page.__name} left a track live: [${states.join(", ")}]`)
}

/** Ada calls Bob, Bob accepts, both go live with the same call id. */
async function connectVoice(ada, bob) {
  await ada.getByRole("button", { name: "Voice call", exact: true }).click()
  await waitStatus(ada, BOB, /^Ringing…$/, 10_000)
  const incoming = incomingDialog(bob, ADA)
  await incoming.waitFor({ state: "visible", timeout: 10_000 })
  await incoming.getByText("Incoming voice call", { exact: true }).waitFor({ state: "visible", timeout: 2_000 })
  await incoming.getByRole("button", { name: "Accept" }).click()
  await Promise.all([waitPhase(ada, "live", 30_000), waitPhase(bob, "live", 30_000)])
  const [a, b] = await Promise.all([diag(ada), diag(bob)])
  if (!a.callId || a.callId !== b.callId) throw new Error("the two pages are live in different calls")
}

/** Sonner toasts currently on screen. */
function toasts(page) {
  return page.locator("[data-sonner-toast]")
}

/** Ada starts a voice call and Bob's incoming dialog shows; returns Bob's incoming dialog. */
async function ringBob(ada, bob) {
  await ada.getByRole("button", { name: "Voice call", exact: true }).click()
  await waitStatus(ada, BOB, /^Ringing…$/, 10_000)
  const incoming = incomingDialog(bob, ADA)
  await incoming.waitFor({ state: "visible", timeout: 10_000 })
  return incoming
}

/** Hang up a live call from `page` and wait until both pages are idle again. */
async function hangUpBoth(page, peer, other) {
  await callDialog(page, peer).getByRole("button", { name: "Hang up" }).click()
  await Promise.all([waitPhase(page, "idle", 5_000), waitPhase(other, "idle", 5_000)])
}

/** The chat's call/reminder system lines (QT-nw9-call-lines). Lines accumulate across scenarios. */
function systemLines(page) {
  return page.locator('[data-testid="system-line"]')
}

async function systemLineCount(page) {
  return systemLines(page).count()
}

/**
 * The chat's first page is on screen (the composer shows while it is still loading): the message
 * list, or the empty state. Then a short settle so a catch-up sync has landed.
 */
async function chatLoaded(page, peer) {
  await page
    .locator(`[aria-label="Messages with ${peer.displayName}"]`)
    .or(page.getByText("No messages yet", { exact: true }))
    .first()
    .waitFor({ state: "visible", timeout: 15_000 })
  await sleep(500)
}

/** The last system line's text and data-missed. */
async function lastSystemLine(page) {
  const lines = systemLines(page)
  const n = await lines.count()
  if (n === 0) return { text: "", missed: null }
  const last = lines.nth(n - 1)
  return { text: ((await last.textContent()) ?? "").trim(), missed: await last.getAttribute("data-missed") }
}

/** Wait until `page`'s last system line text matches `re` (and data-missed, when given). */
async function waitLastLine(page, re, timeout, missed) {
  let last = { text: "", missed: null }
  await until(
    async () => {
      last = await lastSystemLine(page)
      return re.test(last.text) && (missed === undefined || last.missed === missed)
    },
    timeout,
    () => `${page.__name}'s last system line is "${last.text}" (missed ${last.missed}), expected ${re}`,
  )
}

/** No incoming dialog appears on `page` within `ms`. */
async function expectNoIncoming(page, peer, ms) {
  await sleep(ms)
  if (await incomingDialog(page, peer).isVisible()) throw new Error(`${page.__name} got an incoming call dialog`)
}

/** The server's log lines (parsed JSON) that carry `callId`; unparseable lines are skipped. */
async function serverLines(callId) {
  const file = process.env.SMOKE_SERVER_LOG
  if (!file) throw new Error("SMOKE_SERVER_LOG is not set (run through scripts/smoke-calls.sh)")
  const { readFile } = await import("node:fs/promises")
  const text = await readFile(file, "utf8")
  const raw = []
  const parsed = []
  for (const line of text.split("\n")) {
    if (!line.includes(callId)) continue
    raw.push(line)
    try {
      const obj = JSON.parse(line)
      if (obj && obj.callId === callId) parsed.push(obj)
    } catch {
      // not a JSON line
    }
  }
  return { raw, parsed }
}

/**
 * Nothing private in any log line of a call (261020-oj7): no IP, candidate, SDP, ICE server URL,
 * credential, device id or label, and no display name. A failure names the line's evt/k and the
 * pattern, never the line itself.
 */
const PRIVATE_PATTERNS = [
  ["IPv4 address", /\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/],
  ["IPv6 address", /\b[0-9a-f]{1,4}(?::[0-9a-f]{0,4}){2,}/i],
  ["candidate", /candidate/i],
  ["sdp", /sdp/i],
  ["v=0", /v=0/],
  ["turn:", /turn:/i],
  ["turns:", /turns:/i],
  ["stun:", /stun:/i],
  ["username", /username/i],
  ["credential", /credential/i],
  ["deviceId", /deviceid/i],
  ["label", /label/i],
  ["Ada Smoke", /Ada Smoke/],
  ["Bob Smoke", /Bob Smoke/],
]

function privacyScan(raw) {
  for (const line of raw) {
    for (const [name, re] of PRIVATE_PATTERNS) {
      if (!re.test(line)) continue
      let tag = "?"
      try {
        const o = JSON.parse(line)
        tag = `${o.evt ?? "?"}${o.k ? `/${o.k}` : ""}`
      } catch {
        // not JSON
      }
      throw new Error(`a log line of the call (${tag}) matches the private pattern "${name}"`)
    }
  }
}

/** name -> async (ctx, opened) => void. Each prints "scenario <name> ok" on success. */
const scenarios = {
  /**
   * CALL-02 / D-02 / D-03: Ada starts a video call, Bob accepts with his camera on, both see each other
   * full-screen; Bob turns his camera off and Ada falls back to his avatar, with his camera released.
   */
  async video(ctx, opened) {
    const ada = await openApp(ctx, ADA, BOB, opened)
    const bob = await openApp(ctx, BOB, ADA, opened)
    await ada.getByRole("button", { name: "Video call", exact: true }).click()
    const incoming = incomingDialog(bob, ADA)
    await incoming.waitFor({ state: "visible", timeout: 10_000 })
    await incoming.getByText("Incoming video call", { exact: true }).waitFor({ state: "visible", timeout: 2_000 })
    await incoming.getByRole("button", { name: "Accept" }).click()
    let last = ""
    await until(
      async () => {
        const [wa, wb, a, b] = await Promise.all([remoteVideoWidth(ada), remoteVideoWidth(bob), diag(ada), diag(bob)])
        last = `widths ${wa}/${wb}, peer-camera ${a.peerCamera}/${b.peerCamera}`
        return wa > 0 && wb > 0 && a.peerCamera === "true" && b.peerCamera === "true"
      },
      20_000,
      "the two pages never saw each other's video",
    ).catch((err) => {
      throw new Error(`${err.message} (${last})`)
    })
    await Promise.all([waitPhase(ada, "live", 10_000), waitPhase(bob, "live", 10_000)])
    // Mode B on both: the remote video fills the screen and the avatar block is gone.
    for (const [page, peer] of [
      [ada, BOB],
      [bob, ADA],
    ]) {
      await until(
        async () => (await callDialog(page, peer).getByTestId("call-avatar").count()) === 0,
        5_000,
        `${page.__name} still shows the avatar while both cameras are on`,
      )
    }
    await waitPressed(bob, ADA, "Camera", "true", 2_000)
    await callDialog(bob, ADA).getByRole("button", { name: "Camera", exact: true }).click()
    await waitPressed(bob, ADA, "Camera", "false", 2_000)
    await callDialog(ada, BOB).getByTestId("call-avatar").waitFor({ state: "visible", timeout: 5_000 })
    const a = await diag(ada)
    if (a.peerCamera !== "false") throw new Error(`Ada's data-peer-camera is "${a.peerCamera}" after Bob's camera went off`)
    const bobCams = await cameraTrackStates(bob)
    if (bobCams.length === 0) throw new Error("Bob captured no camera track")
    if (bobCams.some((s) => s !== "ended")) throw new Error(`Bob's camera is still live: [${bobCams.join(", ")}]`)
    await hangUpBoth(ada, BOB, bob)
    await expectTracksEnded(ada)
    await expectTracksEnded(bob)
  },

  /** CALL-01: a voice call from the header connects both ways, shows the timer and ends cleanly. */
  async voice(ctx, opened) {
    const ada = await openApp(ctx, ADA, BOB, opened)
    const bob = await openApp(ctx, BOB, ADA, opened)
    await connectVoice(ada, bob)
    await Promise.all([waitStatus(ada, BOB, /^\d+:\d{2}$/, 5_000), waitStatus(bob, ADA, /^\d+:\d{2}$/, 5_000)])
    const before = await Promise.all([diag(ada), diag(bob)])
    await sleep(3_000)
    const after = await Promise.all([diag(ada), diag(bob)])
    if (!(after[0].inboundBytes > before[0].inboundBytes) || !(after[1].inboundBytes > before[1].inboundBytes)) {
      throw new Error("inbound audio bytes did not grow on both pages")
    }
    await callDialog(ada, BOB).getByRole("button", { name: "Hang up" }).click()
    await Promise.all([
      waitStatus(ada, BOB, /^Call ended · \d+:\d{2}$/, 3_000),
      waitStatus(bob, ADA, /^Call ended · \d+:\d{2}$/, 3_000),
    ])
    await Promise.all([
      callDialog(ada, BOB).waitFor({ state: "hidden", timeout: 4_000 }),
      callDialog(bob, ADA).waitFor({ state: "hidden", timeout: 4_000 }),
    ])
    await Promise.all([waitPhase(ada, "idle", 2_000), waitPhase(bob, "idle", 2_000)])
    await expectTracksEnded(ada)
    await expectTracksEnded(bob)
  },

  /** D-13: Bob declines; Ada sees "Declined" for about 2 s, then the chat; Bob's screen closes at once. */
  async decline(ctx, opened) {
    const ada = await openApp(ctx, ADA, BOB, opened)
    const bob = await openApp(ctx, BOB, ADA, opened)
    const incoming = await ringBob(ada, bob)
    await incoming.getByRole("button", { name: "Decline" }).click()
    await incoming.waitFor({ state: "hidden", timeout: 1_000 })
    await waitStatus(ada, BOB, /^Declined$/, 3_000)
    await callDialog(ada, BOB).waitFor({ state: "hidden", timeout: 4_000 })
    await Promise.all([waitPhase(ada, "idle", 1_000), waitPhase(bob, "idle", 1_000)])
    await expectTracksEnded(ada)
    // QT-nw9-call-lines: both chats show the call as a centred line.
    await Promise.all([waitLastLine(ada, /^Declined/, 5_000), waitLastLine(bob, /^Declined/, 5_000)])
    // Tapping the line calls back with the same kind: Bob rings Ada, then gives up.
    await systemLines(bob).last().click()
    await waitStatus(bob, ADA, /^Ringing…$/, 10_000)
    await callDialog(bob, ADA).getByRole("button", { name: "Cancel call" }).click()
    await Promise.all([
      waitLastLine(ada, /^Missed voice call/, 5_000, "true"),
      waitLastLine(bob, /^No answer/, 5_000, null),
    ])
    await Promise.all([waitPhase(ada, "idle", 5_000), waitPhase(bob, "idle", 5_000)])
  },

  /** CALL-04: Ada cancels while ringing; every incoming screen of Bob closes, with no toast. */
  async cancel(ctx, opened) {
    const ada = await openApp(ctx, ADA, BOB, opened)
    const bob = await openApp(ctx, BOB, ADA, opened)
    const incoming = await ringBob(ada, bob)
    await callDialog(ada, BOB).getByRole("button", { name: "Cancel call" }).click()
    await incoming.waitFor({ state: "hidden", timeout: 3_000 })
    await callDialog(ada, BOB).waitFor({ state: "hidden", timeout: 1_000 })
    await sleep(500)
    if ((await toasts(bob).count()) > 0) throw new Error("Bob got a toast for a cancelled call")
    await Promise.all([waitPhase(ada, "idle", 1_000), waitPhase(bob, "idle", 1_000)])
    await expectTracksEnded(ada)
  },

  /** D-07 (10 s in the smoke): nobody answers; Ada sees "No answer", Bob's screen closes, tones stop. */
  async "no-answer"(ctx, opened) {
    const ada = await openApp(ctx, ADA, BOB, opened)
    const bob = await openApp(ctx, BOB, ADA, opened)
    const incoming = await ringBob(ada, bob)
    const [a, b] = await Promise.all([diag(ada), diag(bob)])
    if (a.tone !== "ringback") throw new Error(`Ada's tone while ringing is "${a.tone}", expected "ringback"`)
    if (b.tone !== "ringtone") throw new Error(`Bob's tone while ringing is "${b.tone}", expected "ringtone"`)
    await waitStatus(ada, BOB, /^No answer$/, 15_000)
    await incoming.waitFor({ state: "hidden", timeout: 2_000 })
    const [a2, b2] = await Promise.all([diag(ada), diag(bob)])
    if (a2.tone !== "none" || b2.tone !== "none") throw new Error(`tones still on after no answer: ${a2.tone}/${b2.tone}`)
    await callDialog(ada, BOB).waitFor({ state: "hidden", timeout: 4_000 })
    await expectTracksEnded(ada)
  },

  /** D-19: no ICE servers -> "Couldn't connect" with Retry and Close, nothing rings; Retry calls again. */
  async "couldnt-connect"(ctx, opened) {
    const ada = await openApp(ctx, ADA, BOB, opened)
    const bob = await openApp(ctx, BOB, ADA, opened)
    const route = "**/api/rtc/ice-servers"
    await ada.route(route, (r) =>
      r.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "turn_unconfigured" }) }),
    )
    await ada.getByRole("button", { name: "Voice call", exact: true }).click()
    const screen = callDialog(ada, BOB)
    // The title span (the sr-only aria-live region carries the same words).
    await screen.locator("span", { hasText: /^Couldn't connect$/ }).waitFor({ state: "visible", timeout: 5_000 })
    await screen.getByText("Check your connection and try again.", { exact: true }).waitFor({ state: "visible", timeout: 1_000 })
    await screen.getByRole("button", { name: "Close" }).waitFor({ state: "visible", timeout: 1_000 })
    await expectNoIncoming(bob, ADA, 2_000)
    await expectTracksEnded(ada)
    await ada.unroute(route)
    await screen.getByRole("button", { name: "Retry" }).click()
    await waitStatus(ada, BOB, /^Ringing…$/, 10_000)
    const incoming = incomingDialog(bob, ADA)
    await incoming.waitFor({ state: "visible", timeout: 10_000 })
    await incoming.getByRole("button", { name: "Decline" }).click()
    await waitStatus(ada, BOB, /^Declined$/, 3_000)
    await callDialog(ada, BOB).waitFor({ state: "hidden", timeout: 4_000 })
  },

  /** D-11: both of Bob's devices ring; the second answers; the first closes with a toast. */
  async "multi-device"(ctx, opened) {
    const ada = await openApp(ctx, ADA, BOB, opened)
    const bob1 = await openApp(ctx, BOB, ADA, opened)
    const bob2 = await openApp(ctx, BOB, ADA, opened, { slot: 1 })
    await ada.getByRole("button", { name: "Voice call", exact: true }).click()
    const in1 = incomingDialog(bob1, ADA)
    const in2 = incomingDialog(bob2, ADA)
    await Promise.all([in1.waitFor({ state: "visible", timeout: 10_000 }), in2.waitFor({ state: "visible", timeout: 10_000 })])
    await in2.getByRole("button", { name: "Accept" }).click()
    await in1.waitFor({ state: "hidden", timeout: 5_000 })
    await toasts(bob1).getByText("Answered on another device", { exact: true }).waitFor({ state: "visible", timeout: 3_000 })
    await Promise.all([waitPhase(ada, "live", 30_000), waitPhase(bob2, "live", 30_000)])
    const [a, b2, b1] = await Promise.all([diag(ada), diag(bob2), diag(bob1)])
    if (a.callId !== b2.callId) throw new Error("Ada and Bob's second device are in different calls")
    if (b1.phase !== "idle") throw new Error(`Bob's first device is "${b1.phase}", expected idle`)
    await hangUpBoth(ada, BOB, bob2)
    await expectTracksEnded(ada)
    await expectTracksEnded(bob2)
  },

  /** D-14: both tap Voice call at the same moment; the server merges the two into one call. */
  async glare(ctx, opened) {
    const ada = await openApp(ctx, ADA, BOB, opened)
    const bob = await openApp(ctx, BOB, ADA, opened)
    await Promise.all([chatLoaded(ada, BOB), chatLoaded(bob, ADA)])
    const [adaLines, bobLines] = await Promise.all([systemLineCount(ada), systemLineCount(bob)])
    await Promise.all([
      ada.getByRole("button", { name: "Voice call", exact: true }).click(),
      bob.getByRole("button", { name: "Voice call", exact: true }).click(),
    ])
    await Promise.all([waitPhase(ada, "live", 30_000), waitPhase(bob, "live", 30_000)])
    const [a, b] = await Promise.all([diag(ada), diag(bob)])
    if (!a.callId || a.callId !== b.callId) throw new Error("glare left the two pages in different calls")
    await hangUpBoth(ada, BOB, bob)
    await expectTracksEnded(ada)
    await expectTracksEnded(bob)
    // QT-nw9-call-lines: the merged call leaves exactly one line on each page.
    let counts = ""
    await until(
      async () => {
        const [na, nb] = await Promise.all([systemLineCount(ada), systemLineCount(bob)])
        counts = `Ada ${adaLines} -> ${na}, Bob ${bobLines} -> ${nb}`
        return na === adaLines + 1 && nb === bobLines + 1
      },
      5_000,
      () => `glare did not add exactly one system line on each page (${counts})`,
    )
    await sleep(1_000)
    const [adaAfter, bobAfter] = await Promise.all([systemLineCount(ada), systemLineCount(bob)])
    if (adaAfter !== adaLines + 1 || bobAfter !== bobLines + 1) {
      throw new Error(`glare added ${adaAfter - adaLines} / ${bobAfter - bobLines} system lines, expected 1 / 1`)
    }
    await Promise.all([waitLastLine(ada, /^Voice call · \d+:\d\d/, 1_000), waitLastLine(bob, /^Voice call · \d+:\d\d/, 1_000)])
  },

  /** Busy: Ada is in a call on one device; her second device's call is refused and Bob is not rung again. */
  async busy(ctx, opened) {
    const ada = await openApp(ctx, ADA, BOB, opened)
    const bob = await openApp(ctx, BOB, ADA, opened)
    const ada2 = await openApp(ctx, ADA, BOB, opened, { slot: 1 })
    await connectVoice(ada, bob)
    await ada2.getByRole("button", { name: "Voice call", exact: true }).click()
    await toasts(ada2)
      .getByText("You're already in a call on another device.", { exact: true })
      .waitFor({ state: "visible", timeout: 10_000 })
    await callDialog(ada2, BOB).waitFor({ state: "hidden", timeout: 2_000 })
    if (await incomingDialog(bob, ADA).isVisible()) throw new Error("Bob got a second incoming call")
    const b = await diag(bob)
    if (b.phase !== "live") throw new Error(`Bob's call is "${b.phase}" after the busy attempt, expected live`)
    await expectTracksEnded(ada2)
    await hangUpBoth(ada, BOB, bob)
  },

  /**
   * CALL-03 / Pitfall 4: Bob's app is closed while Ada calls; opening duet at "/" shows the incoming
   * screen (ring-on-attach) and he can answer. No microphone is touched before Accept.
   */
  async "ring-on-open"(ctx, opened) {
    const ada = await openApp(ctx, ADA, BOB, opened)
    const bobContext = await loggedInContext(ctx, BOB)
    try {
      await ada.getByRole("button", { name: "Voice call", exact: true }).click()
      await waitStatus(ada, BOB, /^Ringing…$/, 10_000)
      await sleep(1_000)
      const bob = await newAppPage(bobContext, BOB, opened)
      await bob.goto(`${BASE}/`)
      const incoming = incomingDialog(bob, ADA)
      await incoming.waitFor({ state: "visible", timeout: 6_000 })
      const before = await bob.evaluate(() => (window.__duetTracks ?? []).length)
      if (before !== 0) throw new Error(`Bob captured ${before} track(s) before tapping Accept`)
      await incoming.getByRole("button", { name: "Accept" }).click()
      await Promise.all([waitPhase(ada, "live", 30_000), waitPhase(bob, "live", 30_000)])
      const [a, b] = await Promise.all([diag(ada), diag(bob)])
      if (!a.callId || a.callId !== b.callId) throw new Error("the two pages are live in different calls")
      await hangUpBoth(ada, BOB, bob)
      await expectTracksEnded(bob)
    } finally {
      await bobContext.close().catch(() => {})
    }
  },

  /**
   * D-10: Bob opens duet from an incoming-call push whose call Ada already cancelled: he lands on the
   * chat with "Missed call from Ada Smoke" and Call back; the ?call= parameter is gone from the URL.
   */
  async stale(ctx, opened) {
    const ada = await openApp(ctx, ADA, BOB, opened)
    const bobContext = await loggedInContext(ctx, BOB)
    try {
      await ada.getByRole("button", { name: "Voice call", exact: true }).click()
      await waitStatus(ada, BOB, /^Ringing…$/, 10_000)
      const { callId } = await diag(ada)
      if (!callId) throw new Error("Ada's ringing call has no call id")
      // "Ringing…" shows before the invite leaves (the ICE servers come first): wait for the server.
      await until(
        async () => (await ada.evaluate(async (id) => (await fetch(`/api/calls/${id}`)).status, callId)) === 200,
        10_000,
        "the server never saw Ada's call ringing",
      )
      await callDialog(ada, BOB).getByRole("button", { name: "Cancel call" }).click()
      await waitPhase(ada, "idle", 3_000)

      const bob = await newAppPage(bobContext, BOB, opened)
      await bob.goto(`${BASE}/?call=${callId}`)
      await bob.getByPlaceholder(`Message ${ADA.displayName}`).waitFor({ state: "visible", timeout: 15_000 })
      const toast = toasts(bob).filter({ hasText: `Missed call from ${ADA.displayName}` })
      await toast.waitFor({ state: "visible", timeout: 6_000 })
      if (bob.url().includes("call=")) throw new Error(`Bob's URL still carries the call id: ${bob.url()}`)
      if (await incomingDialog(bob, ADA).isVisible()) throw new Error("Bob got an incoming screen for an ended call")
      await toast.getByRole("button", { name: "Call back" }).click()
      await waitStatus(bob, ADA, /^Ringing…$/, 10_000)
      await incomingDialog(ada, BOB).waitFor({ state: "visible", timeout: 10_000 })
      await callDialog(bob, ADA).getByRole("button", { name: "Cancel call" }).click()
      await Promise.all([waitPhase(bob, "idle", 3_000), waitPhase(ada, "idle", 5_000)])
    } finally {
      await bobContext.close().catch(() => {})
    }
  },

  /**
   * CALL-05 / CALL-06 / D-02 / D-05 dropped: in a voice call Ada mutes and unmutes, turns her camera on
   * (Bob sees it), switches camera (a different device, Bob still receives video), swaps the views and
   * hangs up. The pill has exactly four controls and no speaker control exists on either page.
   */
  async controls(ctx, opened) {
    const ada = await openApp(ctx, ADA, BOB, opened)
    const bob = await openApp(ctx, BOB, ADA, opened)
    await connectVoice(ada, bob)
    const screen = callDialog(ada, BOB)
    const button = (name) => screen.getByRole("button", { name, exact: true })
    const waitDiag = async (page, key, value, timeout) => {
      let last = null
      await until(
        async () => {
          last = (await diag(page))[key]
          return last === value
        },
        timeout,
        () => `${page.__name}'s ${key} is "${last}", expected "${value}"`,
      )
    }

    await button("Mute").click()
    await waitPressed(ada, BOB, "Mute", "true", 2_000)
    await waitDiag(ada, "mic", "off", 2_000)
    await button("Mute").click()
    await waitPressed(ada, BOB, "Mute", "false", 2_000)
    await waitDiag(ada, "mic", "on", 2_000)

    await button("Camera").click()
    await waitPressed(ada, BOB, "Camera", "true", 10_000)
    await until(
      async () => (await remoteVideoWidth(bob)) > 0 && (await diag(bob)).peerCamera === "true",
      10_000,
      "Bob never saw Ada's camera",
    )
    await button("Switch camera").waitFor({ state: "visible", timeout: 2_000 })
    const pillButtons = await screen.getByTestId("call-controls").getByRole("button").count()
    if (pillButtons !== 4) throw new Error(`Ada's control pill has ${pillButtons} buttons, expected 4`)
    for (const page of [ada, bob]) {
      if ((await page.getByRole("button", { name: /speaker/i }).count()) > 0) throw new Error(`${page.__name} shows a speaker control`)
    }

    const before = (await diag(ada)).cameraDevice
    if (!before) throw new Error("Ada's camera has no deviceId")
    await button("Switch camera").click()
    let after = ""
    await until(
      async () => {
        after = (await diag(ada)).cameraDevice
        return after !== "" && after !== before
      },
      5_000,
      () => `Ada's camera device did not change (still "${after}")`,
    )
    const bytes0 = (await diag(bob)).inboundBytes
    await until(
      async () => (await remoteVideoWidth(bob)) > 0 && (await diag(bob)).inboundBytes > bytes0,
      5_000,
      "Bob stopped receiving after the camera switch",
    )
    const adaCams = await cameraTrackStates(ada)
    if (adaCams.filter((s) => s === "live").length !== 1) throw new Error(`Ada's camera tracks after the switch: [${adaCams.join(", ")}]`)

    await screen.getByRole("button", { name: "Swap videos" }).click()
    await waitDiag(ada, "swapped", "true", 2_000)
    await screen.getByRole("button", { name: "Swap videos" }).click()
    await waitDiag(ada, "swapped", "false", 2_000)

    await hangUpBoth(ada, BOB, bob)
    await expectTracksEnded(ada)
    await expectTracksEnded(bob)
  },

  /**
   * D-19 (camera half): Ada's camera is refused when she starts a video call. The call still rings and
   * goes live audio-only with Camera unpressed; the toast offers "How to allow", which opens the drawer.
   */
  async "camera-denied"(ctx, opened) {
    const ada = await openApp(ctx, ADA, BOB, opened, { denyCamera: true })
    const bob = await openApp(ctx, BOB, ADA, opened)
    await ada.getByRole("button", { name: "Video call", exact: true }).click()
    const toast = toasts(ada).filter({ hasText: "duet can't use the camera." })
    await toast.waitFor({ state: "visible", timeout: 5_000 })
    const incoming = incomingDialog(bob, ADA)
    await incoming.waitFor({ state: "visible", timeout: 10_000 })
    await incoming.getByRole("button", { name: "Accept" }).click()
    await Promise.all([waitPhase(ada, "live", 30_000), waitPhase(bob, "live", 30_000)])
    await waitPressed(ada, BOB, "Camera", "false", 1_000)
    const a = await diag(ada)
    if (a.camera !== "false") throw new Error(`Ada's data-camera is "${a.camera}" with the camera refused`)
    await toast.getByRole("button", { name: "How to allow" }).click()
    const drawer = ada.getByTestId("permission-drawer")
    await drawer.getByText("Allow the camera", { exact: true }).waitFor({ state: "visible", timeout: 5_000 })
    await drawer.getByRole("button", { name: "Close" }).click()
    await drawer.waitFor({ state: "hidden", timeout: 3_000 })
    if ((await diag(ada)).phase !== "live") throw new Error("the call did not survive the camera help drawer")
    await hangUpBoth(ada, BOB, bob)
    await expectTracksEnded(ada)
  },

  /**
   * D-06 / CALL-08: both phones hold one screen wake lock during the call. Ada minimizes to the chat
   * (the call keeps flowing), chats with Bob, returns through the on-call bar, minimizes again; Bob
   * hangs up and Ada gets "Call ended · m:ss" as a toast, the bar goes and both wake locks are released.
   */
  async minimize(ctx, opened) {
    const ada = await openApp(ctx, ADA, BOB, opened, { wakeLock: true })
    const bob = await openApp(ctx, BOB, ADA, opened, { wakeLock: true })
    const wakeLocks = (page) => page.evaluate(() => window.__duetWakeLocks)
    const waitLocks = async (n, timeout) => {
      let last = []
      await until(
        async () => {
          last = await Promise.all([wakeLocks(ada), wakeLocks(bob)])
          return last.every((v) => v === n)
        },
        timeout,
        () => `wake locks are [${last.join(", ")}], expected ${n} on both pages`,
      )
    }
    await connectVoice(ada, bob)
    await waitLocks(1, 3_000)
    await sleep(500)
    await waitLocks(1, 100)

    await callDialog(ada, BOB).getByRole("button", { name: "Back to chat" }).click()
    await callDialog(ada, BOB).waitFor({ state: "hidden", timeout: 3_000 })
    const bar = ada.getByRole("button", { name: "Return to call" })
    await bar.waitFor({ state: "visible", timeout: 2_000 })
    const barText = ((await bar.textContent()) ?? "").trim()
    if (!/^On call · \d+:\d{2}$/.test(barText)) throw new Error(`the on-call bar reads "${barText}"`)
    const before = (await diag(ada)).inboundBytes
    await sleep(2_500)
    const after = (await diag(ada)).inboundBytes
    if (!(after > before)) throw new Error(`Ada's inbound bytes stopped while minimized (${before} -> ${after})`)
    if ((await diag(ada)).phase !== "live") throw new Error("minimizing changed the call phase")

    const text = `minimized ${Date.now()}`
    await ada.getByPlaceholder(`Message ${BOB.displayName}`).fill(text)
    await ada.getByRole("button", { name: "Send message" }).click()
    await bob.getByText(text, { exact: true }).first().waitFor({ state: "attached", timeout: 10_000 })

    await bar.click()
    await callDialog(ada, BOB).waitFor({ state: "visible", timeout: 3_000 })
    await bar.waitFor({ state: "hidden", timeout: 2_000 })
    await callDialog(ada, BOB).getByRole("button", { name: "Back to chat" }).click()
    await bar.waitFor({ state: "visible", timeout: 2_000 })
    await callDialog(ada, BOB).waitFor({ state: "hidden", timeout: 3_000 })

    await callDialog(bob, ADA).getByRole("button", { name: "Hang up" }).click()
    await toasts(ada).filter({ hasText: /^Call ended · \d+:\d{2}$/ }).first().waitFor({ state: "visible", timeout: 5_000 })
    await bar.waitFor({ state: "hidden", timeout: 2_000 })
    if (await callDialog(ada, BOB).isVisible()) throw new Error("the call screen reopened for the ending of a minimized call")
    await Promise.all([waitPhase(ada, "idle", 3_000), waitPhase(bob, "idle", 3_000)])
    await waitLocks(0, 3_000)
    await expectTracksEnded(ada)
    await expectTracksEnded(bob)
  },

  /**
   * CALL-07 / D-17: Ada's WebSocket drops mid-call. Her screen says "Reconnecting…", the socket comes
   * back, rejoins the call room (call.rejoin), and the timer returns without resetting; nobody redials.
   */
  async reconnect(ctx, opened) {
    const ada = await openApp(ctx, ADA, BOB, opened, { routeWs: true })
    const bob = await openApp(ctx, BOB, ADA, opened)
    await connectVoice(ada, bob)
    await waitStatus(ada, BOB, /^\d+:\d{2}$/, 5_000)
    const { callId } = await diag(ada)
    await sleep(2_000)
    const secs = (text) => text.split(":").reduce((acc, part) => acc * 60 + Number(part), 0)
    const before = secs(await statusOf(ada, BOB))
    await watchStates(ada)
    await watchStates(bob)
    await dropSocket(ada)
    let seen = { status: [], reconnecting: [] }
    await until(
      async () => {
        seen = await seenStates(ada)
        return seen.status.includes("Reconnecting…") && seen.reconnecting.includes("true")
      },
      5_000,
      () => `Ada never showed "Reconnecting…" (status seen: [${seen.status.join(", ")}], reconnecting: [${seen.reconnecting.join(", ")}])`,
    )
    await waitStatus(ada, BOB, /^\d+:\d{2}$/, 20_000)
    let a = await diag(ada)
    await until(
      async () => {
        a = await diag(ada)
        return a.reconnecting === "false"
      },
      20_000,
      () => `Ada's data-reconnecting stayed "${a.reconnecting}"`,
    )
    if (a.callId !== callId) throw new Error(`Ada's call id changed across the reconnect (${callId} -> ${a.callId})`)
    if (a.phase !== "live") throw new Error(`Ada's call is "${a.phase}" after the reconnect`)
    // The timer resumed where it was: it never reset to 0:00.
    const resumed = secs(await statusOf(ada, BOB))
    if (!(resumed >= before)) throw new Error(`Ada's timer went back from ${before} s to ${resumed} s`)
    const bytes0 = (await diag(ada)).inboundBytes
    await until(async () => (await diag(ada)).inboundBytes > bytes0, 6_000, "Ada's inbound bytes stopped growing after the reconnect")
    const bobSeen = await seenStates(bob)
    if (bobSeen.status.includes("Call dropped") || (await statusOf(bob, ADA)) === "Call dropped") {
      throw new Error("Bob showed Call dropped")
    }
    if ((await diag(bob)).phase !== "live") throw new Error(`Bob's call is "${(await diag(bob)).phase}"`)
    // The relay reaches Ada's new socket (the stale one left the room): Bob's camera flag comes through.
    await callDialog(bob, ADA).getByRole("button", { name: "Camera", exact: true }).click()
    await waitPressed(bob, ADA, "Camera", "true", 10_000)
    await until(async () => (await diag(ada)).peerCamera === "true", 10_000, "Ada never heard Bob's camera after the rejoin")
    await callDialog(ada, BOB).getByRole("button", { name: "Hang up" }).click()
    await Promise.all([
      waitStatus(ada, BOB, /^Call ended · \d+:\d{2}$/, 3_000),
      waitStatus(bob, ADA, /^Call ended · \d+:\d{2}$/, 3_000),
    ])
    await Promise.all([waitPhase(ada, "idle", 4_000), waitPhase(bob, "idle", 4_000)])
    await expectTracksEnded(ada)
    await expectTracksEnded(bob)
  },

  /**
   * D-17 give-up: Bob's phone vanishes mid-call (page closed). Within 50 s Ada shows "Call dropped" with
   * Call back and Close (her 30 s give-up or the server's 35 s absence end, whichever comes first), her
   * microphone is released, and Close returns to the chat.
   */
  async dropped(ctx, opened) {
    const ada = await openApp(ctx, ADA, BOB, opened)
    const bob = await openApp(ctx, BOB, ADA, opened)
    await connectVoice(ada, bob)
    await bob.context().close()
    const screen = callDialog(ada, BOB)
    await screen.locator("span", { hasText: /^Call dropped$/ }).waitFor({ state: "visible", timeout: 50_000 })
    await screen.getByRole("button", { name: "Call back" }).waitFor({ state: "visible", timeout: 1_000 })
    await screen.getByRole("button", { name: "Close" }).waitFor({ state: "visible", timeout: 1_000 })
    const a = await diag(ada)
    if (a.phase !== "ended") throw new Error(`Ada's phase is "${a.phase}" while Call dropped shows`)
    await expectTracksEnded(ada)
    await screen.getByRole("button", { name: "Close" }).click()
    await screen.waitFor({ state: "hidden", timeout: 3_000 })
    await waitPhase(ada, "idle", 2_000)
  },

  /**
   * CALL-09: relay forced on both sides (localStorage duet.forceRelay = 1): the call connects with relay
   * local candidates through Cloudflare TURN on both pages and audio flows both ways. A healthy link
   * shows no Poor connection badge (D-20: nothing shows otherwise).
   */
  async relay(ctx, opened) {
    const forceRelay = () => {
      try {
        localStorage.setItem("duet.forceRelay", "1")
      } catch {
        // about:blank has no storage; the app's own document does.
      }
    }
    const ada = await openApp(ctx, ADA, BOB, opened, { init: forceRelay })
    const bob = await openApp(ctx, BOB, ADA, opened, { init: forceRelay })
    await connectVoice(ada, bob)
    let types = []
    await until(
      async () => {
        types = [(await diag(ada)).localType, (await diag(bob)).localType]
        return types.every((t) => t === "relay")
      },
      10_000,
      () => `local candidate types are [${types.join(", ")}], expected relay on both`,
    )
    const before = await Promise.all([diag(ada), diag(bob)])
    await sleep(3_000)
    const after = await Promise.all([diag(ada), diag(bob)])
    if (!(after[0].inboundBytes > before[0].inboundBytes) || !(after[1].inboundBytes > before[1].inboundBytes)) {
      throw new Error("inbound bytes did not grow on both pages over the relay")
    }
    for (const [page, peer] of [
      [ada, BOB],
      [bob, ADA],
    ]) {
      if ((await callDialog(page, peer).getByTestId("poor-connection").count()) > 0) {
        throw new Error(`${page.__name} shows Poor connection on a healthy relay`)
      }
    }
    await hangUpBoth(ada, BOB, bob)
    await expectTracksEnded(ada)
    await expectTracksEnded(bob)
  },

  /** D-19: a denied microphone starts no call and opens the "Allow the microphone" drawer. */
  async "mic-denied"(ctx, opened) {
    const ada = await openApp(ctx, ADA, BOB, opened, { denyMic: true })
    const bob = await openApp(ctx, BOB, ADA, opened)
    await ada.getByRole("button", { name: "Voice call", exact: true }).click()
    const drawer = ada.getByTestId("permission-drawer")
    await drawer.getByText("Allow the microphone", { exact: true }).waitFor({ state: "visible", timeout: 5_000 })
    await drawer.getByRole("button", { name: "Close" }).waitFor({ state: "visible", timeout: 1_000 })
    if (await callDialog(ada, BOB).isVisible()) throw new Error("a call screen opened with the microphone denied")
    await expectNoIncoming(bob, ADA, 2_000)
    await drawer.getByRole("button", { name: "Close" }).click()
    await drawer.waitFor({ state: "hidden", timeout: 3_000 })
  },
  /**
   * 261020-oj7: one grep of a callId over the server log shows the whole call from both phones, and
   * nothing private. A real two-browser call; then the server log (SMOKE_SERVER_LOG) must hold both
   * fixture users' call_diag lines (batch, phase live, pc states, pair, stats, TURN, Ada's mute and camera
   * toggles, end) and the server's call lines (who sent each
   * frame, ringMs, who ended the call) under the callId, and no line of the call
   * may carry an IP, candidate, SDP, ICE server URL, credential, device id/label or a display name.
   */
  async "call-log"(ctx, opened) {
    const ada = await openApp(ctx, ADA, BOB, opened)
    const bob = await openApp(ctx, BOB, ADA, opened)
    await connectVoice(ada, bob)
    const liveAt = Date.now()
    const callId = (await diag(ada)).callId
    // Toggles land in Ada's log as media events.
    const button = (name) => callDialog(ada, BOB).getByRole("button", { name, exact: true })
    await button("Mute").click()
    await waitPressed(ada, BOB, "Mute", "true", 2_000)
    await button("Mute").click()
    await waitPressed(ada, BOB, "Mute", "false", 2_000)
    await button("Camera").click()
    await waitPressed(ada, BOB, "Camera", "true", 10_000)
    await button("Camera").click()
    await waitPressed(ada, BOB, "Camera", "false", 5_000)
    // Long enough live for a stats event (every 3rd 2 s sample after the first).
    await sleep(Math.max(0, 10_000 - (Date.now() - liveAt)))
    await hangUpBoth(ada, BOB, bob)

    const adaId = ctx.ids[ADA.username]
    const bobId = ctx.ids[BOB.username]
    const diagOf = (lines, userId) => lines.filter((o) => o.evt === "call_diag" && o.userId === userId)
    const checks = (lines) => {
      const missing = []
      for (const [who, userId, cause] of [
        ["Ada", adaId, "hangup"],
        ["Bob", bobId, "remote"],
      ]) {
        const mine = diagOf(lines, userId)
        const batch = mine.find((o) => o.k === "batch")
        if (!batch || typeof batch.os !== "string" || typeof batch.browser !== "string" || typeof batch.standalone !== "boolean") {
          missing.push(`${who} batch`)
        }
        if (!mine.some((o) => o.k === "phase" && o.phase === "live" && typeof o.ms === "number")) missing.push(`${who} phase live`)
        const end = mine.find((o) => o.k === "end")
        if (!end || end.cause !== cause || (who === "Bob" && end.serverReason !== "hangup")) missing.push(`${who} end ${cause}`)
        // The peer connection, the selected pair, stats and the TURN fetch.
        if (!mine.some((o) => o.k === "pc" && o.what === "connection" && o.state === "connected")) missing.push(`${who} pc connected`)
        for (const what of ["ice", "signaling"]) {
          if (!mine.some((o) => o.k === "pc" && o.what === what)) missing.push(`${who} pc ${what}`)
        }
        const types = ["host", "srflx", "prflx", "relay"]
        if (!mine.some((o) => o.k === "pair" && types.includes(o.local) && types.includes(o.remote))) missing.push(`${who} pair`)
        if (!mine.some((o) => o.k === "stats" && o.state === "connected" && typeof o.inKbps === "number")) missing.push(`${who} stats`)
        if (!mine.some((o) => o.k === "turn" && o.ok === true && typeof o.ms === "number" && typeof o.ttlSeconds === "number")) {
          missing.push(`${who} turn`)
        }
      }
      for (const what of ["mute", "unmute", "camera_on", "camera_off"]) {
        if (!diagOf(lines, adaId).some((o) => o.k === "media" && o.what === what)) missing.push(`Ada media ${what}`)
      }
      // The server's side: who sent each frame, the ring time and who ended the call.
      if (!lines.some((o) => o.evt === "call_invite" && o.callerId === adaId)) missing.push("call_invite by Ada")
      for (const [frame, who, userId] of [
        ["call.invite", "Ada", adaId],
        ["call.accept", "Bob", bobId],
        ["call.end", "Ada", adaId],
      ]) {
        if (!lines.some((o) => o.evt === "call_frame" && o.frame === frame && o.userId === userId)) missing.push(`call_frame ${frame} by ${who}`)
      }
      if (!lines.some((o) => o.evt === "call_accept" && typeof o.ringMs === "number")) missing.push("call_accept ringMs")
      const end = lines.find((o) => o.evt === "call_end")
      if (!end || end.by !== "caller" || end.byUserId !== adaId || end.cause !== "frame" || end.reason !== "hangup") {
        missing.push("call_end by Ada (caller, frame, hangup)")
      }
      return missing
    }
    let last = { raw: [], parsed: [] }
    let missing = ["nothing read yet"]
    await until(
      async () => {
        last = await serverLines(callId)
        missing = checks(last.parsed)
        return missing.length === 0
      },
      10_000,
      () => `the server log of the call lacks: ${missing.join(", ")}`,
    )
    if (last.raw.length < 6) throw new Error(`only ${last.raw.length} log lines carry the callId`)
    privacyScan(last.raw)
  },
}

const requested = process.argv.slice(3)
const names = requested.length > 0 ? requested : Object.keys(scenarios)
for (const name of names) {
  if (!scenarios[name]) {
    console.error(`smoke-calls: unknown scenario "${name}" (known: ${Object.keys(scenarios).join(", ")})`)
    process.exit(2)
  }
}

// Two fake cameras, so Switch camera has another device to open (the deviceId fallback, Pattern 5).
const browser = await launchBrowser({ videoDevices: 2 })
let exitCode = 0
try {
  const [adaId, bobId] = await fixtureIds(BASE, [ADA.username, BOB.username])
  const ctx = { browser, ids: { [ADA.username]: adaId, [BOB.username]: bobId }, cookies: new Map() }
  for (const name of names) {
    const opened = []
    try {
      await scenarios[name](ctx, opened)
      console.log(`scenario ${name} ok`)
    } catch (err) {
      console.error(`smoke-calls: scenario ${name}: ${err instanceof Error ? err.message : String(err)}`)
      dumpErrors(opened)
      exitCode = 1
      break
    } finally {
      for (const page of opened) await page.context().close().catch(() => {})
      // Let the server see the closed sockets before the next scenario starts a call.
      await sleep(300)
    }
  }
} catch (err) {
  console.error(`smoke-calls: ${err instanceof Error ? err.message : String(err)}`)
  exitCode = 1
} finally {
  await browser.close()
}
process.exit(exitCode)
