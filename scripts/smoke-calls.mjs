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
async function openApp(ctx, fixture, peer, opened, { denyMic = false, slot = 0 } = {}) {
  const context = await loggedInContext(ctx, fixture, slot)
  const page = await newAppPage(context, fixture, opened, { denyMic, slot })
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
async function newAppPage(context, fixture, opened, { denyMic = false, slot = 0 } = {}) {
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
  return page
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
  await ada.getByRole("button", { name: "Voice call" }).click()
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
  await ada.getByRole("button", { name: "Voice call" }).click()
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

/** No incoming dialog appears on `page` within `ms`. */
async function expectNoIncoming(page, peer, ms) {
  await sleep(ms)
  if (await incomingDialog(page, peer).isVisible()) throw new Error(`${page.__name} got an incoming call dialog`)
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
    await ada.getByRole("button", { name: "Video call" }).click()
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
    await ada.getByRole("button", { name: "Voice call" }).click()
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
    await ada.getByRole("button", { name: "Voice call" }).click()
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
    await Promise.all([
      ada.getByRole("button", { name: "Voice call" }).click(),
      bob.getByRole("button", { name: "Voice call" }).click(),
    ])
    await Promise.all([waitPhase(ada, "live", 30_000), waitPhase(bob, "live", 30_000)])
    const [a, b] = await Promise.all([diag(ada), diag(bob)])
    if (!a.callId || a.callId !== b.callId) throw new Error("glare left the two pages in different calls")
    await hangUpBoth(ada, BOB, bob)
    await expectTracksEnded(ada)
    await expectTracksEnded(bob)
  },

  /** Busy: Ada is in a call on one device; her second device's call is refused and Bob is not rung again. */
  async busy(ctx, opened) {
    const ada = await openApp(ctx, ADA, BOB, opened)
    const bob = await openApp(ctx, BOB, ADA, opened)
    const ada2 = await openApp(ctx, ADA, BOB, opened, { slot: 1 })
    await connectVoice(ada, bob)
    await ada2.getByRole("button", { name: "Voice call" }).click()
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
      await ada.getByRole("button", { name: "Voice call" }).click()
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
      await ada.getByRole("button", { name: "Voice call" }).click()
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

  /** D-19: a denied microphone starts no call and opens the "Allow the microphone" drawer. */
  async "mic-denied"(ctx, opened) {
    const ada = await openApp(ctx, ADA, BOB, opened, { denyMic: true })
    const bob = await openApp(ctx, BOB, ADA, opened)
    await ada.getByRole("button", { name: "Voice call" }).click()
    const drawer = ada.getByTestId("permission-drawer")
    await drawer.getByText("Allow the microphone", { exact: true }).waitFor({ state: "visible", timeout: 5_000 })
    await drawer.getByRole("button", { name: "Close" }).waitFor({ state: "visible", timeout: 1_000 })
    if (await callDialog(ada, BOB).isVisible()) throw new Error("a call screen opened with the microphone denied")
    await expectNoIncoming(bob, ADA, 2_000)
    await drawer.getByRole("button", { name: "Close" }).click()
    await drawer.waitFor({ state: "hidden", timeout: 3_000 })
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

const browser = await launchBrowser()
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
