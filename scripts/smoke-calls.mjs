// Headless two-browser E2E of the real call flow (CALL-01, CALL-04): Chrome contexts with fake mic and
// camera, two fixture accounts, real Cloudflare TURN credentials from the local duet server.
// Usage: node scripts/smoke-calls.mjs <base-url> [scenario ...]   (driven by scripts/smoke-calls.sh)
// No scenario names runs every scenario in registry order. Every scenario opens its own logged-in pages
// and closes them when done. Prints only scenario names and verdicts: never cookies, passwords, ICE
// server entries or credentials.
import { dumpErrors, fixtureIds, launchBrowser, loggedInPage } from "./lib/e2e.mjs"

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
    if (Date.now() > deadline) throw new Error(message)
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

/**
 * Open logged-in pages at "/" for each fixture (the chat composer must be visible). Each page lives in
 * its own browser context (its own session, like a separate phone). Registered for closing in `opened`.
 */
async function openApp(ctx, fixture, peer, opened) {
  const page = await loggedInPage(ctx.browser, BASE, fixture, ctx.ids[fixture.username])
  opened.push(page)
  await page.addInitScript(recordTracks)
  await page.goto(`${BASE}/`)
  await page.getByPlaceholder(`Message ${peer.displayName}`).waitFor({ state: "visible", timeout: 15_000 })
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
  }
}

async function waitPhase(page, phase, timeout) {
  let last = ""
  await until(
    async () => {
      last = (await diag(page)).phase
      return last === phase
    },
    timeout,
    `${page.__name}'s call phase stayed "${last}", expected "${phase}"`,
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

/** name -> async (ctx, opened) => void. Each prints "scenario <name> ok" on success. */
const scenarios = {
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
  const ctx = { browser, ids: { [ADA.username]: adaId, [BOB.username]: bobId } }
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
