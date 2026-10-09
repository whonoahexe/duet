// Headless two-peer call smoke (INFR-04 mechanics): two Chrome contexts, two fixture accounts,
// fake camera/mic, real Cloudflare TURN credentials from the local duet server.
// Usage: node scripts/smoke-call.mjs <base-url>   (driven by scripts/smoke-call.sh)
// Prints only verdicts and candidate types. Never prints cookies, ICE server entries or credentials.
import { chromium } from "playwright-core"

const BASE = process.argv[2]
if (!BASE) {
  console.error("usage: node scripts/smoke-call.mjs <base-url>")
  process.exit(2)
}

const FIXTURES = [
  { username: "smoke-ada", password: "smoke-test-pass-0001" },
  { username: "smoke-bob", password: "smoke-test-pass-0002" },
]
const PASS_TIMEOUT_MS = 45_000

const browser = await chromium.launch({
  executablePath: process.env.CHROME ?? "/usr/bin/google-chrome",
  headless: true,
  args: [
    "--use-fake-ui-for-media-stream",
    "--use-fake-device-for-media-stream",
    "--autoplay-policy=no-user-gesture-required",
  ],
})

/** Console errors per page, printed only when a run fails. */
const consoleErrors = new Map()

async function loggedInPage(fixture, userId) {
  const context = await browser.newContext()
  const res = await context.request.post(`${BASE}/api/login`, {
    data: { userId, password: fixture.password },
    headers: { Origin: BASE },
  })
  if (res.status() !== 200) throw new Error(`login as ${fixture.username} returned ${res.status()}`)

  // MA6: context.request should share its cookie jar with the context's pages. Fallback: copy the
  // Set-Cookie value into the context explicitly.
  let cookies = await context.cookies(BASE)
  if (!cookies.some((c) => c.name === "duet_session")) {
    const setCookie = res.headersArray().find((h) => h.name.toLowerCase() === "set-cookie")?.value ?? ""
    const m = /duet_session=([^;]+)/.exec(setCookie)
    if (!m) throw new Error(`login as ${fixture.username} set no duet_session cookie`)
    await context.addCookies([{ name: "duet_session", value: m[1], url: BASE }])
    cookies = await context.cookies(BASE)
    console.log("smoke-call: cookie fallback used (MA6)")
  }

  const page = await context.newPage()
  const errors = []
  consoleErrors.set(page, { name: fixture.username, errors })
  page.on("console", (msg) => {
    if (msg.type() === "error") errors.push(msg.text().slice(0, 300))
  })
  page.on("pageerror", (err) => errors.push(String(err).slice(0, 300)))
  return page
}

async function text(page, testId) {
  return ((await page.getByTestId(testId).textContent()) ?? "").trim()
}

async function waitForPass(page) {
  await page.waitForFunction(
    () => document.querySelector('[data-testid="call-verdict"]')?.textContent?.trim() === "PASS",
    undefined,
    { timeout: PASS_TIMEOUT_MS, polling: 250 },
  )
}

function dumpErrors(pages) {
  for (const page of pages) {
    const entry = consoleErrors.get(page)
    if (!entry) continue
    for (const line of entry.errors) console.error(`  [${entry.name}] ${line}`)
  }
}

/** One call: both pages open the same fresh room, Start, wait for PASS on both, read, Stop. */
async function run(pages, room, relayA, relayB) {
  const [a, b] = pages
  await Promise.all([
    a.goto(`${BASE}/debug/call/?room=${room}&relay=${relayA ? 1 : 0}`),
    b.goto(`${BASE}/debug/call/?room=${room}&relay=${relayB ? 1 : 0}`),
  ])
  for (const page of pages) {
    await page.getByTestId("call-start").waitFor({ state: "visible", timeout: 15_000 })
  }
  // Both click at nearly the same moment, so both negotiate at once (perfect-negotiation glare path).
  await Promise.all([a.getByTestId("call-start").click(), b.getByTestId("call-start").click()])

  try {
    await Promise.all([waitForPass(a), waitForPass(b)])
  } catch (err) {
    const states = await Promise.all(
      pages.map(async (p) => `${await text(p, "call-verdict")}/${await text(p, "call-state")}/${await text(p, "call-local-type")}`),
    )
    console.error(`smoke-call: room ${room} did not reach PASS on both (${states.join(", ")})`)
    for (const page of pages) await page.getByTestId("call-stop").click().catch(() => {})
    return { ok: false, err }
  }

  const result = {
    ok: true,
    localA: await text(a, "call-local-type"),
    localB: await text(b, "call-local-type"),
    bytesA: Number(await text(a, "call-bytes")),
    bytesB: Number(await text(b, "call-bytes")),
  }
  await Promise.all([a.getByTestId("call-stop").click(), b.getByTestId("call-stop").click()])
  // Let the Stop handlers finish (room.leave, report POST) before the pages navigate again.
  await Promise.all(pages.map((p) => p.getByTestId("call-verdict").waitFor({ state: "visible" })))
  await new Promise((r) => setTimeout(r, 750))
  return result
}

let exitCode = 0
let pages = []
try {
  const usersRes = await fetch(`${BASE}/api/users`)
  if (!usersRes.ok) throw new Error(`GET /api/users returned ${usersRes.status}`)
  const { users } = await usersRes.json()
  const ids = FIXTURES.map((f) => users.find((u) => u.username === f.username)?.id)
  if (ids.some((id) => !id)) throw new Error("fixture accounts missing from /api/users")

  pages = [await loggedInPage(FIXTURES[0], ids[0]), await loggedInPage(FIXTURES[1], ids[1])]
  const stamp = Date.now()

  // Run 1: normal ICE.
  const normal = await run(pages, `smoke-n-${stamp}`, false, false)
  if (!normal.ok) throw new Error("normal mode did not reach PASS")
  if (!(normal.bytesA > 0 && normal.bytesB > 0)) throw new Error("normal mode PASS without inbound bytes")
  console.log(`smoke-call normal ok (${normal.localA}/${normal.localB})`)

  // Run 2: forced relay on both peers (hairpins through Cloudflare relay addresses).
  const relay = await run(pages, `smoke-r-${stamp}`, true, true)
  if (relay.ok) {
    if (relay.localA !== "relay" || relay.localB !== "relay") {
      throw new Error(`forced relay PASS with local types ${relay.localA}/${relay.localB}`)
    }
    console.log("smoke-call relay ok (relay-relay)")
  } else {
    // MA5 fallback: peer A forced to relay, peer B normal. A must PASS with a relay local candidate.
    console.log("smoke-call: relay-relay did not connect, retrying relay-all (MA5)")
    const mixed = await run(pages, `smoke-m-${stamp}`, true, false)
    if (!mixed.ok) throw new Error("forced relay did not reach PASS in relay-relay or relay-all mode")
    if (mixed.localA !== "relay") throw new Error(`relay-all PASS with peer A local type ${mixed.localA}`)
    console.log("smoke-call relay ok (relay-all)")
  }
} catch (err) {
  console.error(`smoke-call: ${err instanceof Error ? err.message : String(err)}`)
  dumpErrors(pages)
  exitCode = 1
} finally {
  await browser.close()
}
process.exit(exitCode)
