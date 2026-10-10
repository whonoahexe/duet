// Shared helpers for the headless browser smokes (scripts/smoke-*.mjs).
// Never prints cookies or passwords.
import { chromium } from "playwright-core"

/** System Chrome, headless, with fake camera/mic so media prompts never block (CHROME overrides the path). */
export function launchBrowser() {
  return chromium.launch({
    executablePath: process.env.CHROME ?? "/usr/bin/google-chrome",
    headless: true,
    args: [
      "--use-fake-ui-for-media-stream",
      "--use-fake-device-for-media-stream",
      "--autoplay-policy=no-user-gesture-required",
    ],
  })
}

/** Look up fixture account ids by username through the public GET /api/users. */
export async function fixtureIds(base, usernames) {
  const res = await fetch(`${base}/api/users`)
  if (!res.ok) throw new Error(`GET /api/users returned ${res.status}`)
  const { users } = await res.json()
  const ids = usernames.map((name) => users.find((u) => u.username === name)?.id)
  if (ids.some((id) => !id)) throw new Error("fixture accounts missing from /api/users")
  return ids
}

/**
 * A fresh browser context logged in as `fixture` ({ username, password }) and one page in it.
 * Console errors and page errors are collected on page.__errors for failure dumps.
 */
export async function loggedInPage(browser, base, fixture, userId) {
  const context = await browser.newContext()
  const res = await context.request.post(`${base}/api/login`, {
    data: { userId, password: fixture.password },
    headers: { Origin: base },
  })
  if (res.status() !== 200) throw new Error(`login as ${fixture.username} returned ${res.status()}`)

  // context.request normally shares its cookie jar with the context's pages; fall back to copying
  // the Set-Cookie value explicitly.
  const cookies = await context.cookies(base)
  if (!cookies.some((c) => c.name === "duet_session")) {
    const setCookie = res.headersArray().find((h) => h.name.toLowerCase() === "set-cookie")?.value ?? ""
    const m = /duet_session=([^;]+)/.exec(setCookie)
    if (!m) throw new Error(`login as ${fixture.username} set no duet_session cookie`)
    await context.addCookies([{ name: "duet_session", value: m[1], url: base }])
  }

  const page = await context.newPage()
  const errors = []
  page.__errors = errors
  page.__name = fixture.username
  page.on("console", (msg) => {
    if (msg.type() === "error") errors.push(msg.text().slice(0, 300))
  })
  page.on("pageerror", (err) => errors.push(String(err).slice(0, 300)))
  return page
}

/** Print collected console errors of the given pages to stderr. */
export function dumpErrors(pages) {
  for (const page of pages) {
    for (const line of page.__errors ?? []) console.error(`  [${page.__name}] ${line}`)
  }
}
