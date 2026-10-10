// Headless two-browser chat e2e (CHAT-01..05): two Chrome contexts, two fixture accounts.
// Usage: node scripts/smoke-chat.mjs <base-url> [scenario ...]   (driven by scripts/smoke-chat.sh)
// No scenario names runs every scenario in registry order. Prints only scenario names and verdicts.
import { randomUUID } from "node:crypto"
import { dumpErrors, fixtureIds, launchBrowser, loggedInPage } from "./lib/e2e.mjs"

const BASE = process.argv[2]
if (!BASE) {
  console.error("usage: node scripts/smoke-chat.mjs <base-url> [scenario ...]")
  process.exit(2)
}

const ADA = { username: "smoke-ada", displayName: "Ada Smoke", password: "smoke-test-pass-0001" }
const BOB = { username: "smoke-bob", displayName: "Bob Smoke", password: "smoke-test-pass-0002" }

/** A unique, human-looking message text. */
function uniqueText(label) {
  return `${label} ${randomUUID().slice(0, 8)}`
}

/** Bubbles whose whole text is exactly `text` (the aria-live announcement carries a prefix). */
function bubbles(page, text) {
  return page.locator('[data-slot="bubble-content"]').getByText(text, { exact: true })
}

async function openChat(page, peerName) {
  await page.goto(`${BASE}/`)
  await page.getByPlaceholder(`Message ${peerName}`).waitFor({ state: "visible", timeout: 15_000 })
}

async function sendFromComposer(page, peerName, text) {
  const box = page.getByPlaceholder(`Message ${peerName}`)
  await box.fill(text)
  await page.getByRole("button", { name: "Send message" }).click()
}

async function expectExactlyOnce(page, text, timeout) {
  await bubbles(page, text).first().waitFor({ state: "visible", timeout })
  const n = await bubbles(page, text).count()
  if (n !== 1) throw new Error(`"${text}" is shown ${n} times on ${page.__name}'s page`)
}

/** The single status footer under one's latest message ("Sending…" / "Sent" / "Not sent…"). */
async function statusTexts(page) {
  return (await page.getByTestId("message-status").allTextContents()).map((t) => t.trim())
}

async function waitForStatus(page, expected, timeout) {
  const deadline = Date.now() + timeout
  for (;;) {
    const texts = await statusTexts(page)
    if (texts.length === 1 && texts[0] === expected) return
    if (Date.now() > deadline) throw new Error(`${page.__name}'s status is [${texts.join(" | ")}], expected "${expected}"`)
    await new Promise((r) => setTimeout(r, 100))
  }
}

function viewport(page) {
  return page.locator('[data-slot="message-scroller-viewport"]')
}

/** name -> async ({ ada, bob }) => void. Each prints "scenario <name> ok" on success. */
const scenarios = {
  /** CHAT-01/02: a message typed by Ada appears on Bob's open chat within 5 s and survives a reload. */
  async send({ ada, bob }) {
    await Promise.all([openChat(ada, BOB.displayName), openChat(bob, ADA.displayName)])
    const text = uniqueText("hello from ada")
    await sendFromComposer(ada, BOB.displayName, text)
    await expectExactlyOnce(bob, text, 5_000)
    await bob.reload()
    await bob.getByPlaceholder(`Message ${ADA.displayName}`).waitFor({ state: "visible", timeout: 15_000 })
    await expectExactlyOnce(bob, text, 10_000)
    await expectExactlyOnce(ada, text, 5_000)
  },

  /** CHAT-03/04: a message composed offline stays "Sending…" (never failed) and is delivered once on reconnect. */
  async offline({ ada, bob }) {
    await Promise.all([openChat(ada, BOB.displayName), openChat(bob, ADA.displayName)])
    const text = uniqueText("sent while offline")
    await ada.context().setOffline(true)
    try {
      await sendFromComposer(ada, BOB.displayName, text)
      await expectExactlyOnce(ada, text, 2_000)
      await waitForStatus(ada, "Sending…", 2_000)
      await new Promise((r) => setTimeout(r, 3_000))
      const texts = await statusTexts(ada)
      if (texts.some((t) => t.includes("Not sent"))) throw new Error("offline message was marked failed")
      await waitForStatus(ada, "Sending…", 500)
    } finally {
      await ada.context().setOffline(false)
    }
    await expectExactlyOnce(bob, text, 10_000)
    await waitForStatus(ada, "Sent", 10_000)
    await expectExactlyOnce(ada, text, 1_000)
  },

  /** CHAT-02: 120 messages page back to the first one, which shows exactly once. */
  async history({ ada, bob, base }) {
    const run = randomUUID().slice(0, 6)
    const label = (i) => `history ${run} ${String(i).padStart(3, "0")}`
    for (let i = 1; i <= 120; i++) {
      const res = await ada.context().request.post(`${base}/api/messages`, {
        data: { id: randomUUID(), body: label(i) },
        headers: { Origin: base },
      })
      if (res.status() !== 200) throw new Error(`history send ${i} returned ${res.status()}`)
    }
    await bob.goto(`${base}/`)
    await bob.getByPlaceholder(`Message ${ADA.displayName}`).waitFor({ state: "visible", timeout: 15_000 })
    await expectExactlyOnce(bob, label(120), 10_000)
    const beginning = bob.getByText(`This is the beginning of your messages with ${ADA.displayName}.`, { exact: true })
    const deadline = Date.now() + 30_000
    while (!(await beginning.isVisible())) {
      if (Date.now() > deadline) throw new Error("never reached the beginning of the conversation")
      await viewport(bob).evaluate((el) => {
        el.scrollTop = 0
      })
      await new Promise((r) => setTimeout(r, 300))
    }
    await expectExactlyOnce(bob, label(1), 5_000)
    for (const i of [2, 50, 51, 100, 119]) {
      const n = await bubbles(bob, label(i)).count()
      if (n !== 1) throw new Error(`history message ${i} is shown ${n} times`)
    }
  },

  /** CHAT-05: messages sent while Bob's socket is down arrive through /api/sync once it reconnects. */
  async catchup({ ada, bob, base }) {
    let blocked = false
    let pageSide = null
    let serverSide = null
    await bob.routeWebSocket(/\/ws$/, (ws) => {
      if (blocked) {
        void ws.close({ code: 1011, reason: "blocked by smoke" })
        return
      }
      pageSide = ws
      serverSide = ws.connectToServer()
    })
    await openChat(bob, ADA.displayName)
    await openChat(ada, BOB.displayName)
    if (!pageSide) throw new Error("Bob's socket did not go through the route")

    // Drop Bob's live socket and refuse reconnects for 3 s.
    blocked = true
    await Promise.all([pageSide.close({ code: 1011, reason: "dropped by smoke" }), serverSide.close()])
    const texts = [uniqueText("catchup 1"), uniqueText("catchup 2"), uniqueText("catchup 3")]
    for (const text of texts) {
      await sendFromComposer(ada, BOB.displayName, text)
      await expectExactlyOnce(ada, text, 5_000)
    }
    await waitForStatus(ada, "Sent", 10_000)
    await new Promise((r) => setTimeout(r, 3_000))
    for (const text of texts) {
      if ((await bubbles(bob, text).count()) !== 0) throw new Error("Bob got a message while his socket was down")
    }
    blocked = false
    for (const text of texts) await expectExactlyOnce(bob, text, 10_000)
    await bob.unrouteAll({ behavior: "ignoreErrors" }).catch(() => {})
  },
}

const requested = process.argv.slice(3)
const names = requested.length > 0 ? requested : Object.keys(scenarios)
for (const name of names) {
  if (!scenarios[name]) {
    console.error(`smoke-chat: unknown scenario "${name}" (known: ${Object.keys(scenarios).join(", ")})`)
    process.exit(2)
  }
}

const browser = await launchBrowser()
let exitCode = 0
let pages = []
try {
  const [adaId, bobId] = await fixtureIds(BASE, [ADA.username, BOB.username])
  const ada = await loggedInPage(browser, BASE, ADA, adaId)
  const bob = await loggedInPage(browser, BASE, BOB, bobId)
  pages = [ada, bob]
  const ctx = { ada, bob, adaId, bobId, base: BASE }
  for (const name of names) {
    await scenarios[name](ctx)
    console.log(`scenario ${name} ok`)
  }
} catch (err) {
  console.error(`smoke-chat: ${err instanceof Error ? err.message : String(err)}`)
  dumpErrors(pages)
  exitCode = 1
} finally {
  await browser.close()
}
process.exit(exitCode)
