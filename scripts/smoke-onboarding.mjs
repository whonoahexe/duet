// Headless onboarding e2e (SHEL-03, D-16): the iOS Add to Home Screen guide and the Notifications
// drawer from the header menu.
// Usage: SMOKE_SCRIPT=scripts/smoke-onboarding.mjs bash scripts/smoke-chat.sh [scenario ...]
// No scenario names runs every scenario in registry order. Prints only scenario names and verdicts.
import { dumpErrors, fixtureIds, launchBrowser, loggedInPage } from "./lib/e2e.mjs"

const BASE = process.argv[2]
if (!BASE) {
  console.error("usage: node scripts/smoke-onboarding.mjs <base-url> [scenario ...]")
  process.exit(2)
}

const ADA = { username: "smoke-ada", displayName: "Ada Smoke", password: "smoke-test-pass-0001" }
const BOB = { username: "smoke-bob", displayName: "Bob Smoke", password: "smoke-test-pass-0002" }

const IPHONE_UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Mobile/15E148 Safari/604.1"

const GUIDE_HEADING = "Add duet to your Home Screen"

/** Track console errors of an extra page the same way loggedInPage does. */
function watch(page, name) {
  page.__errors = []
  page.__name = name
  page.on("console", (msg) => {
    if (msg.type() === "error") page.__errors.push(msg.text().slice(0, 300))
  })
  page.on("pageerror", (err) => page.__errors.push(String(err).slice(0, 300)))
  return page
}

const scenarios = {
  /** iPhone Safari sees the guide before the login tiles; Continue reaches them; desktop never sees it. */
  async a2hs({ browser, pages }) {
    const iphone = await browser.newContext({
      userAgent: IPHONE_UA,
      viewport: { width: 390, height: 844 },
      isMobile: true,
      hasTouch: true,
    })
    try {
      const page = watch(await iphone.newPage(), "iphone")
      pages.push(page)
      await page.goto(`${BASE}/`)
      await page.getByText(GUIDE_HEADING, { exact: true }).waitFor({ state: "visible", timeout: 15_000 })
      if ((await page.getByText(ADA.displayName, { exact: true }).count()) !== 0) {
        throw new Error("login tiles are shown together with the Add to Home Screen guide")
      }
      await page.getByRole("button", { name: "Continue in Safari for now" }).click()
      await page.getByText(ADA.displayName, { exact: true }).waitFor({ state: "visible", timeout: 10_000 })
      // The skip lasts for this browser session: a reload goes straight to the tiles.
      await page.reload()
      await page.getByText(ADA.displayName, { exact: true }).waitFor({ state: "visible", timeout: 10_000 })
      if ((await page.getByText(GUIDE_HEADING, { exact: true }).count()) !== 0) {
        throw new Error("the guide came back after Continue in the same session")
      }
    } finally {
      await iphone.close()
    }

    const desktop = await browser.newContext()
    try {
      const page = watch(await desktop.newPage(), "desktop")
      pages.push(page)
      await page.goto(`${BASE}/`)
      await page.getByText(ADA.displayName, { exact: true }).waitFor({ state: "visible", timeout: 15_000 })
      if ((await page.getByText(GUIDE_HEADING, { exact: true }).count()) !== 0) {
        throw new Error("a desktop browser was shown the Add to Home Screen guide")
      }
    } finally {
      await desktop.close()
    }
  },

  /** Header menu -> Notifications opens the drawer with exactly one state-appropriate action. */
  async drawer({ ada }) {
    await ada.goto(`${BASE}/`)
    await ada.getByPlaceholder(`Message ${BOB.displayName}`).waitFor({ state: "visible", timeout: 15_000 })
    await ada.getByRole("button", { name: "Menu" }).click()
    await ada.getByRole("menuitem", { name: "Notifications" }).click()
    const drawer = ada.getByTestId("notifications-drawer")
    await drawer.getByText("Notifications", { exact: true }).waitFor({ state: "visible", timeout: 10_000 })

    const enable = drawer.getByRole("button", { name: "Enable notifications" })
    const blocked = drawer.getByText("Notifications are blocked", { exact: true })
    const deadline = Date.now() + 10_000
    for (;;) {
      const shown = (await enable.count()) + (await blocked.count())
      if (shown === 1) break
      if (shown > 1) throw new Error("the drawer shows both Enable notifications and Notifications are blocked")
      if (Date.now() > deadline) throw new Error("the drawer shows neither Enable notifications nor Notifications are blocked")
      await ada.waitForTimeout(100)
    }
    await ada.keyboard.press("Escape")
  },
}

const requested = process.argv.slice(3)
const names = requested.length > 0 ? requested : Object.keys(scenarios)
for (const name of names) {
  if (!scenarios[name]) {
    console.error(`smoke-onboarding: unknown scenario "${name}" (known: ${Object.keys(scenarios).join(", ")})`)
    process.exit(2)
  }
}

const browser = await launchBrowser()
let exitCode = 0
const pages = []
try {
  const [adaId] = await fixtureIds(BASE, [ADA.username, BOB.username])
  const ada = await loggedInPage(browser, BASE, ADA, adaId)
  pages.push(ada)
  const ctx = { browser, ada, adaId, pages, base: BASE }
  for (const name of names) {
    await scenarios[name](ctx)
    console.log(`scenario ${name} ok`)
  }
} catch (err) {
  console.error(`smoke-onboarding: ${err instanceof Error ? err.message : String(err)}`)
  dumpErrors(pages)
  exitCode = 1
} finally {
  await browser.close()
}
process.exit(exitCode)
