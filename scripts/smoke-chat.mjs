// Headless two-browser chat e2e (CHAT-01..09): two Chrome contexts, two fixture accounts.
// Usage: node scripts/smoke-chat.mjs <base-url> [scenario ...]   (driven by scripts/smoke-chat.sh)
// No scenario names runs every scenario in registry order. Prints only scenario names and verdicts.
import { execFileSync } from "node:child_process"
import { randomUUID } from "node:crypto"
import path from "node:path"
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

/**
 * Message texts that are exactly `text`: the body span of a bubble, never a quote snippet of a reply
 * and never the aria-live announcement (which carries a prefix).
 */
function bubbles(page, text) {
  return page.locator('[data-testid="message-text"]').getByText(text, { exact: true })
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

/** `expected` is an exact text, or DELIVERED ("Sent", or "Read {time}" once the other page saw it, D-03). */
const DELIVERED = Symbol("delivered")

async function waitForStatus(page, expected, timeout) {
  const deadline = Date.now() + timeout
  for (;;) {
    const texts = await statusTexts(page)
    const ok = expected === DELIVERED ? (t) => t === "Sent" || /^Read \S/.test(t) : (t) => t === expected
    if (texts.length === 1 && ok(texts[0])) return
    if (Date.now() > deadline) throw new Error(`${page.__name}'s status is [${texts.join(" | ")}], expected "${String(expected)}"`)
    await new Promise((r) => setTimeout(r, 100))
  }
}

function viewport(page) {
  return page.locator('[data-slot="message-scroller-viewport"]')
}

/** The bubble (data-slot="bubble") whose content is exactly `text`. */
function bubbleOf(page, text) {
  return page.locator('[data-slot="bubble"]').filter({ has: bubbles(page, text) })
}

/** Poll `fn` until it returns true; throws `message` after `timeout` ms. */
async function until(fn, timeout, message) {
  const deadline = Date.now() + timeout
  for (;;) {
    if (await fn()) return
    if (Date.now() > deadline) throw new Error(message)
    await new Promise((r) => setTimeout(r, 100))
  }
}

/** Open the long-press menu on a bubble with a right-click (contextmenu) and pick a reaction. */
async function reactTo(page, text, emoji) {
  await bubbleOf(page, text).click({ button: "right" })
  const option = page.getByRole("button", { name: `React ${emoji}` })
  await option.waitFor({ state: "visible", timeout: 3_000 })
  await option.click()
  await option.waitFor({ state: "hidden", timeout: 3_000 })
}

/** Drag a bubble `dx` px to the right with the mouse (pointer events), in 10 px steps. */
async function swipeRight(page, locator, dx) {
  await locator.scrollIntoViewIfNeeded()
  const box = await locator.boundingBox()
  if (!box) throw new Error("bubble has no box to swipe")
  const x = box.x + Math.min(24, box.width / 2)
  const y = box.y + box.height / 2
  await page.mouse.move(x, y)
  await page.mouse.down()
  for (let moved = 10; moved <= dx; moved += 10) await page.mouse.move(x + moved, y)
  await page.mouse.up()
}

/** The element is fully inside the message list's visible area. */
async function inListView(page, locator) {
  const [box, vp] = await Promise.all([locator.boundingBox(), viewport(page).boundingBox()])
  return Boolean(box && vp && box.y >= vp.y - 1 && box.y + box.height <= vp.y + vp.height + 1)
}

/** A test-pattern JPEG generated with ffmpeg (lavfi testsrc) in SMOKE_TMP. */
function makeJpeg(name, width, height) {
  const dir = process.env.SMOKE_TMP
  if (!dir) throw new Error("SMOKE_TMP is not set (run through scripts/smoke-chat.sh)")
  const file = path.join(dir, name)
  execFileSync(
    "ffmpeg",
    ["-nostdin", "-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", `testsrc=size=${width}x${height}`, "-frames:v", "1", file],
    { stdio: ["ignore", "ignore", "inherit"] },
  )
  return file
}

/** The preview drawer (D-06) once it is open. */
function previewDrawer(page) {
  return page.locator('[data-slot="drawer-popup"]')
}

/** Pick files through the composer's hidden input (the "+" button opens it on a phone). */
async function pickFiles(page, files) {
  await page.getByTestId("attach-input").setInputFiles(files)
  await previewDrawer(page).waitFor({ state: "visible", timeout: 5_000 })
}

/** The album bubble whose caption is exactly `caption`. */
function albumWithCaption(page, caption) {
  return page.locator('[data-slot="bubble"]').filter({ has: page.locator('[data-testid="album"]') }).filter({ has: bubbles(page, caption) })
}

/** Every img in the locator has decoded (naturalWidth > 0) and comes from /media/. */
async function mediaImagesLoaded(locator, expected) {
  const info = await locator.locator("img").evaluateAll((imgs) =>
    imgs.map((img) => ({ src: img.getAttribute("src") ?? "", w: img.naturalWidth, done: img.complete })),
  )
  return info.length === expected && info.every((i) => i.src.includes("/media/") && i.done && i.w > 0)
}

/** name -> async ({ ada, bob }) => void. Each prints "scenario <name> ok" on success. */
const scenarios = {
  /** CHAT-01/02: a message typed by Ada appears on Bob's open chat within 5 s and survives a reload. */
  async send({ ada, bob }) {
    await Promise.all([openChat(ada, BOB.displayName), openChat(bob, ADA.displayName)])
    const text = uniqueText("hello from ada")
    await sendFromComposer(ada, BOB.displayName, text)
    await expectExactlyOnce(bob, text, 5_000)
    // D-03: exactly one status line on Ada's side, under her latest message, reading "Sent" (or already
    // "Read {time}", because Bob's open, focused page has it on screen).
    await waitForStatus(ada, DELIVERED, 5_000)
    const sentBubble = ada.locator('[data-slot="bubble"]').filter({ has: bubbles(ada, text) })
    const footer = sentBubble.locator("xpath=following-sibling::*[1]")
    const footerText = (await footer.textContent())?.trim() ?? ""
    if ((await footer.getAttribute("data-testid")) !== "message-status" || !(footerText === "Sent" || footerText.startsWith("Read "))) {
      throw new Error("Ada's status line is not directly under her latest bubble")
    }
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
    await waitForStatus(ada, DELIVERED, 10_000)
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
    await waitForStatus(ada, DELIVERED, 10_000)
    await new Promise((r) => setTimeout(r, 3_000))
    for (const text of texts) {
      if ((await bubbles(bob, text).count()) !== 0) throw new Error("Bob got a message while his socket was down")
    }
    blocked = false
    for (const text of texts) await expectExactlyOnce(bob, text, 10_000)
    await bob.unrouteAll({ behavior: "ignoreErrors" }).catch(() => {})
  },

  /** CHAT-08 / D-04: Bob reacts 💕 to Ada's message from the menu; Ada sees the chip; picking it again removes it. */
  async react({ ada, bob }) {
    await Promise.all([openChat(ada, BOB.displayName), openChat(bob, ADA.displayName)])
    const text = uniqueText("react to this")
    await sendFromComposer(ada, BOB.displayName, text)
    await expectExactlyOnce(bob, text, 5_000)

    const chip = bubbleOf(ada, text).getByTestId("reaction-chip")
    await reactTo(bob, text, "💕")
    await until(async () => (await chip.count()) === 1 && (await chip.textContent())?.includes("💕"), 5_000,
      "Ada never saw Bob's 💕 chip")
    // Bob's own row marks his current reaction.
    await bubbleOf(bob, text).click({ button: "right" })
    const current = bob.getByRole("button", { name: "React 💕" })
    await current.waitFor({ state: "visible", timeout: 3_000 })
    if ((await current.getAttribute("aria-pressed")) !== "true") throw new Error("Bob's current reaction is not highlighted")
    await current.click()
    await until(async () => (await chip.count()) === 0, 5_000, "Ada's chip did not disappear after Bob removed his reaction")
  },

  /**
   * CHAT-09 / D-01 / D-02: Bob swipes Ada's message right and answers it; Ada sees the quote with the
   * answer. After 150 newer messages and a reload, tapping a quote of that (now unloaded) original pages
   * back ("Finding message…"), scrolls it into view and rings it.
   */
  async reply({ ada, bob, base }) {
    await Promise.all([openChat(ada, BOB.displayName), openChat(bob, ADA.displayName)])
    const run = randomUUID().slice(0, 8)
    const original = `quote me ${run}`
    const answer = `my answer ${run}`
    await sendFromComposer(ada, BOB.displayName, original)
    await expectExactlyOnce(bob, original, 5_000)

    await swipeRight(bob, bubbleOf(bob, original), 80)
    await bob.getByText(`Replying to ${ADA.displayName}`, { exact: true }).waitFor({ state: "visible", timeout: 3_000 })
    const focused = await bob.evaluate(() => document.activeElement?.getAttribute("placeholder"))
    if (focused !== `Message ${ADA.displayName}`) throw new Error("the composer was not focused after the swipe")
    await sendFromComposer(bob, ADA.displayName, answer)
    await bob.getByTestId("reply-chip").waitFor({ state: "hidden", timeout: 3_000 })

    const replyOnAda = bubbleOf(ada, answer)
    await replyOnAda.waitFor({ state: "visible", timeout: 5_000 })
    const quoteText = (await replyOnAda.getByTestId("quote-block").textContent()) ?? ""
    if (!quoteText.includes(original) || !quoteText.includes("You")) {
      throw new Error(`Ada's copy of the reply does not quote her message (quote reads "${quoteText}")`)
    }

    // Push the original out of the newest page, then quote it again from the newest message.
    const originalSeq = Number(await bubbleOf(ada, original).getAttribute("data-seq"))
    if (!Number.isInteger(originalSeq) || originalSeq < 1) throw new Error("original bubble has no data-seq")
    // 150, not 60: the first screen loads two pages of 50, and the original must be beyond both.
    for (let i = 1; i <= 150; i++) {
      const res = await ada.context().request.post(`${base}/api/messages`, {
        data: { id: randomUUID(), body: `filler ${run} ${i}` },
        headers: { Origin: base },
      })
      if (res.status() !== 200) throw new Error(`filler ${i} returned ${res.status()}`)
    }
    const again = `again ${run}`
    const res = await bob.context().request.post(`${base}/api/messages`, {
      data: { id: randomUUID(), body: again, replyToSeq: originalSeq },
      headers: { Origin: base },
    })
    if (res.status() !== 200) throw new Error(`second reply returned ${res.status()}`)

    await ada.reload()
    await ada.getByPlaceholder(`Message ${BOB.displayName}`).waitFor({ state: "visible", timeout: 15_000 })
    const latest = bubbleOf(ada, again)
    await latest.waitFor({ state: "visible", timeout: 10_000 })
    if ((await bubbles(ada, original).count()) !== 0) throw new Error("the original is still loaded; the jump would not page back")
    await latest.getByTestId("quote-block").click()

    const target = bubbleOf(ada, original)
    let ringed = false
    await until(
      async () => {
        if ((await target.count()) !== 1) return false
        const cls = (await target.locator('[data-slot="bubble-content"]').getAttribute("class")) ?? ""
        if (cls.includes("ring-primary")) ringed = true
        return ringed && (await inListView(ada, target))
      },
      10_000,
      "tapping the quote did not bring the highlighted original into view",
    )
  },

  /**
   * CHAT-06 / CHAT-07 / D-03: Ada typing shows Bob the three dots, which go away after she stops (5 s
   * TTL) or as soon as her message arrives; once Bob's page is in front with her message on screen,
   * Ada's status line reads "Read {time}".
   */
  async "typing-read"({ ada, bob }) {
    await Promise.all([openChat(ada, BOB.displayName), openChat(bob, ADA.displayName)])
    const box = ada.getByPlaceholder(`Message ${BOB.displayName}`)
    const dots = bob.getByLabel(`${ADA.displayName} is typing`, { exact: true })

    await box.fill("still thinking about it")
    await dots.waitFor({ state: "visible", timeout: 3_000 })
    await box.fill("")
    await dots.waitFor({ state: "hidden", timeout: 8_000 })

    // Typing again, then sending: the dots leave with the message, well before their TTL.
    await box.fill("one more")
    await dots.waitFor({ state: "visible", timeout: 3_000 })
    const text = uniqueText("read me")
    await box.fill(text)
    await ada.getByRole("button", { name: "Send message" }).click()
    await expectExactlyOnce(bob, text, 5_000)
    await dots.waitFor({ state: "hidden", timeout: 2_000 })

    await bob.bringToFront()
    await until(
      async () => {
        const texts = await statusTexts(ada)
        return texts.length === 1 && /^Read \S/.test(texts[0])
      },
      5_000,
      "Ada's status line never turned into Read {time}",
    )
  },
}

Object.assign(scenarios, {
  /**
   * MDIA-01 / D-05 / D-06 / D-09: Ada picks one photo, sees the "1 photo" drawer, adds a caption and
   * presses "Send photo"; Bob sees the caption and the processed thumbnail served from /media/.
   */
  async photo({ ada, bob }) {
    await Promise.all([openChat(ada, BOB.displayName), openChat(bob, ADA.displayName)])
    const file = makeJpeg(`photo-${randomUUID().slice(0, 8)}.jpg`, 1600, 1200)
    const caption = uniqueText("look")

    await pickFiles(ada, [file])
    const drawer = previewDrawer(ada)
    await drawer.getByText("1 photo", { exact: true }).waitFor({ state: "visible", timeout: 3_000 })
    await drawer.getByPlaceholder("Add a caption…").fill(caption)
    await drawer.getByRole("button", { name: "Send photo", exact: true }).click()
    await drawer.waitFor({ state: "hidden", timeout: 5_000 })

    const onBob = albumWithCaption(bob, caption)
    await onBob.waitFor({ state: "visible", timeout: 20_000 })
    await until(() => mediaImagesLoaded(onBob, 1), 20_000, "Bob's photo never loaded from /media/")
    await waitForStatus(ada, DELIVERED, 10_000)
  },
})

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
