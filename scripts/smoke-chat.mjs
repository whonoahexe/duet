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
