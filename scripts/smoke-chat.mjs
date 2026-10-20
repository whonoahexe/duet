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

/** A 1280x720 H.264/AAC test clip generated with ffmpeg (lavfi testsrc + sine) in SMOKE_TMP. */
function makeMp4(name, seconds) {
  const dir = process.env.SMOKE_TMP
  if (!dir) throw new Error("SMOKE_TMP is not set (run through scripts/smoke-chat.sh)")
  const file = path.join(dir, name)
  execFileSync(
    "ffmpeg",
    [
      "-nostdin", "-hide_banner", "-loglevel", "error", "-y",
      "-f", "lavfi", "-i", "testsrc=size=1280x720:rate=25", "-f", "lavfi", "-i", "sine=frequency=440",
      "-t", String(seconds), "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-c:a", "aac", file,
    ],
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

  /**
   * MDIA-02 / D-06 / D-07: Ada picks 3 photos ("3 photos", "Send 3 photos"), removes one ("2 photos"),
   * adds a caption and sends; Bob sees a 2-tile album, opens the second tile in the full-screen viewer
   * ("2 / 2"), goes back with ArrowLeft ("1 / 2") and closes it with Escape.
   */
  async album({ ada, bob }) {
    await Promise.all([openChat(ada, BOB.displayName), openChat(bob, ADA.displayName)])
    const run = randomUUID().slice(0, 8)
    const files = [makeJpeg(`a-${run}.jpg`, 800, 600), makeJpeg(`b-${run}.jpg`, 600, 800), makeJpeg(`c-${run}.jpg`, 700, 700)]
    const caption = uniqueText("album")

    await pickFiles(ada, files)
    const drawer = previewDrawer(ada)
    await drawer.getByText("3 photos", { exact: true }).waitFor({ state: "visible", timeout: 3_000 })
    await drawer.getByRole("button", { name: "Send 3 photos", exact: true }).waitFor({ state: "visible", timeout: 3_000 })
    if ((await drawer.getByTestId("preview-item").count()) !== 3) throw new Error("the drawer does not show 3 items")
    await drawer.getByRole("button", { name: "Remove item" }).nth(1).click()
    await drawer.getByText("2 photos", { exact: true }).waitFor({ state: "visible", timeout: 3_000 })
    await drawer.getByPlaceholder("Add a caption…").fill(caption)
    await drawer.getByRole("button", { name: "Send 2 photos", exact: true }).click()
    await drawer.waitFor({ state: "hidden", timeout: 5_000 })

    const onBob = albumWithCaption(bob, caption)
    await onBob.waitFor({ state: "visible", timeout: 20_000 })
    await until(() => mediaImagesLoaded(onBob, 2), 20_000, "Bob's album thumbnails never loaded from /media/")
    if ((await onBob.getByTestId("album-tile").count()) !== 2) throw new Error("Bob's album does not have 2 tiles")

    await onBob.getByRole("button", { name: "Open photo 2 of 2" }).click()
    const counter = bob.getByTestId("viewer-counter")
    await until(async () => (await counter.textContent())?.trim() === "2 / 2", 5_000, "the viewer did not open at 2 / 2")
    const caps = bob.getByTestId("viewer-caption")
    if ((await caps.textContent())?.trim() !== caption) throw new Error("the viewer does not show the caption")
    await until(
      async () =>
        (await bob.getByTestId("viewer-image").evaluateAll((imgs) => imgs.every((i) => i.complete && i.naturalWidth > 0 && i.src.includes("/display")))) &&
        (await bob.getByTestId("viewer-image").count()) === 2,
      10_000,
      "the viewer's display copies did not load",
    )
    await bob.keyboard.press("ArrowLeft")
    await until(async () => (await counter.textContent())?.trim() === "1 / 2", 5_000, "ArrowLeft did not move to 1 / 2")
    await bob.keyboard.press("Escape")
    await counter.waitFor({ state: "hidden", timeout: 3_000 })
  },

  /**
   * MDIA-03 / D-05 / D-08: Ada picks a 4 s clip ("1 video", "Send video"); Bob sees the processing
   * tile or the poster, then within 60 s the poster frame from /media/ with its duration; tapping it
   * opens the viewer, whose native video (never autoplaying) loads its metadata from /media/.
   */
  async video({ ada, bob }) {
    await Promise.all([openChat(ada, BOB.displayName), openChat(bob, ADA.displayName)])
    const file = makeMp4(`clip-${randomUUID().slice(0, 8)}.mp4`, 4)
    const caption = uniqueText("clip")

    await pickFiles(ada, [file])
    const drawer = previewDrawer(ada)
    await drawer.getByText("1 video", { exact: true }).waitFor({ state: "visible", timeout: 5_000 })
    await drawer.getByPlaceholder("Add a caption…").fill(caption)
    await drawer.getByRole("button", { name: "Send video", exact: true }).click()
    await drawer.waitFor({ state: "hidden", timeout: 5_000 })

    const onBob = albumWithCaption(bob, caption)
    await onBob.waitFor({ state: "visible", timeout: 20_000 })
    await until(
      async () => (await onBob.getByTestId("video-processing").count()) > 0 || (await mediaImagesLoaded(onBob, 1)),
      20_000,
      "Bob never saw the processing tile or the poster",
    )
    await until(() => mediaImagesLoaded(onBob, 1), 60_000, "Bob's video poster never loaded from /media/")
    const src = await onBob.locator("img").getAttribute("src")
    if (!src?.includes("/poster")) throw new Error(`the video tile shows ${src}, not the poster`)
    const duration = (await onBob.getByTestId("video-duration").textContent())?.trim()
    if (duration !== "0:04" && duration !== "0:03") throw new Error(`the video tile shows duration "${duration}"`)

    await onBob.getByRole("button", { name: "Open video 1 of 1" }).click()
    const player = bob.getByTestId("viewer-video")
    await player.waitFor({ state: "visible", timeout: 5_000 })
    await until(
      () => player.evaluate((v) => v.currentSrc.includes("/media/") && v.readyState >= 1),
      15_000,
      "the viewer's video never loaded its metadata from /media/",
    )
    if (!(await player.evaluate((v) => v.paused && v.controls && v.playsInline && !v.autoplay))) {
      throw new Error("the viewer's video autoplays or lacks controls/playsInline")
    }
    await bob.keyboard.press("Escape")
    await player.waitFor({ state: "hidden", timeout: 3_000 })
    await waitForStatus(ada, DELIVERED, 10_000)
  },

  /**
   * MDIA-04 / D-10 / D-12: Ada holds the mic ("Record voice note") for 2.5 s with Chrome's fake
   * microphone and releases; Bob gets a voice note whose waveform slider ("Seek voice note") carries
   * the server's 1..4 s duration and plays from /media/; Ada's composer is back to idle (the
   * recording row is gone, the mic is offered again). T-02-32: after the send, a slide-left cancel
   * and a too-short hold, every microphone track Ada's page ever opened has ended.
   */
  async voice({ ada, bob }) {
    // Count every MediaStream the page opens, so the test can prove the mic is always released.
    await ada.addInitScript(() => {
      const md = navigator.mediaDevices
      if (!md?.getUserMedia || window.__duetStreams) return
      window.__duetStreams = []
      const original = md.getUserMedia.bind(md)
      md.getUserMedia = async (constraints) => {
        const stream = await original(constraints)
        window.__duetStreams.push(stream)
        return stream
      }
    })
    const micReleased = () =>
      ada.evaluate(() => (window.__duetStreams ?? []).every((s) => s.getTracks().every((t) => t.readyState === "ended")))
    const streamCount = () => ada.evaluate(() => (window.__duetStreams ?? []).length)
    await Promise.all([openChat(ada, BOB.displayName), openChat(bob, ADA.displayName)])
    const sliders = bob.getByRole("slider", { name: "Seek voice note" })
    const before = await sliders.count()

    const mic = ada.getByRole("button", { name: "Record voice note" })
    await mic.waitFor({ state: "visible", timeout: 5_000 })
    const box = await mic.boundingBox()
    if (!box) throw new Error("the mic button has no box")
    await ada.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
    await ada.mouse.down()
    await ada.getByTestId("recording-row").waitFor({ state: "visible", timeout: 5_000 })
    await new Promise((r) => setTimeout(r, 2_500))
    await ada.mouse.up()

    await until(async () => (await sliders.count()) > before, 30_000, "Bob never received the voice note")
    const slider = sliders.last()
    await until(
      async () => {
        const max = Number(await slider.getAttribute("aria-valuemax"))
        return max >= 1 && max <= 4
      },
      30_000,
      "the voice note never got a 1..4 s server duration",
    )
    const note = bob.getByTestId("voice-note").last()
    await note.getByRole("button", { name: "Play voice note" }).click()
    await until(
      async () => Number(await slider.getAttribute("aria-valuenow")) > 0 || (await note.getByRole("button", { name: "Pause voice note" }).count()) > 0,
      10_000,
      "Bob's voice note did not start playing",
    )

    await ada.getByTestId("recording-row").waitFor({ state: "hidden", timeout: 5_000 })
    await mic.waitFor({ state: "visible", timeout: 5_000 })
    await waitForStatus(ada, DELIVERED, 15_000)
    if ((await streamCount()) !== 1) throw new Error("the send did not go through exactly one getUserMedia stream")
    await until(micReleased, 5_000, "the microphone stayed open after sending")

    // Slide left more than 96 px: cancelled, nothing sent, mic released.
    const sent = await sliders.count()
    await ada.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
    await ada.mouse.down()
    await ada.getByTestId("recording-row").waitFor({ state: "visible", timeout: 5_000 })
    for (let dx = 10; dx <= 130; dx += 10) await ada.mouse.move(box.x + box.width / 2 - dx, box.y + box.height / 2)
    await ada.getByTestId("recording-row").waitFor({ state: "hidden", timeout: 5_000 })
    await ada.mouse.up()
    await until(micReleased, 5_000, "the microphone stayed open after slide-to-cancel")

    // A hold released between 300 ms and 1 s: discarded with the toast, mic released.
    await ada.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
    await ada.mouse.down()
    await ada.getByTestId("recording-row").waitFor({ state: "visible", timeout: 5_000 })
    await new Promise((r) => setTimeout(r, 500))
    await ada.mouse.up()
    await ada.getByText("Too short. Hold to record, or tap the mic for hands-free.").waitFor({ state: "visible", timeout: 5_000 })
    await until(micReleased, 5_000, "the microphone stayed open after a too-short hold")
    if ((await streamCount()) !== 3) throw new Error("expected three recordings to have opened the microphone")
    await new Promise((r) => setTimeout(r, 1_500))
    if ((await sliders.count()) !== sent) throw new Error("a cancelled or too-short recording was sent")

    // Tap to lock, then discard: nothing sent, mic released.
    await mic.click()
    await ada.getByRole("button", { name: "Discard recording" }).click()
    await ada.getByTestId("recording-row").waitFor({ state: "hidden", timeout: 5_000 })
    await until(micReleased, 5_000, "the microphone stayed open after discarding")

    // Tap to lock, record hands-free, then "Send voice note": Bob receives it.
    await mic.click()
    const sendVoice = ada.getByRole("button", { name: "Send voice note" })
    await sendVoice.waitFor({ state: "visible", timeout: 5_000 })
    await new Promise((r) => setTimeout(r, 1_500))
    await sendVoice.click()
    await ada.getByTestId("recording-row").waitFor({ state: "hidden", timeout: 5_000 })
    await until(async () => (await sliders.count()) === sent + 1, 30_000, "Bob never received the locked voice note")
    await until(micReleased, 5_000, "the microphone stayed open after a locked send")
  },

  /**
   * G-02-42 / CHAT-01: sending always jumps to the newest message. Bob scrolls up in 60 seeded
   * messages: an incoming message only bumps the badge and leaves the list where it is, but his own
   * text send lands on the new bubble at the bottom. The same holds after a wheel at the bottom that
   * cannot scroll (it switches the scroller out of follow mode) and for a photo sent while scrolled up.
   */
  async "scroll-send"({ ada, bob, base }) {
    const run = randomUUID().slice(0, 6)
    const label = (i) => `scroll ${run} ${String(i).padStart(3, "0")}`
    const post = async (body) => {
      const res = await ada.context().request.post(`${base}/api/messages`, {
        data: { id: randomUUID(), body },
        headers: { Origin: base },
      })
      if (res.status() !== 200) throw new Error(`scroll-send seed "${body}" returned ${res.status()}`)
    }
    for (let i = 1; i <= 60; i++) await post(label(i))
    await openChat(bob, ADA.displayName)
    await expectExactlyOnce(bob, label(60), 10_000)
    await new Promise((r) => setTimeout(r, 800))

    const fromBottom = () => viewport(bob).evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight)
    const scrollTop = () => viewport(bob).evaluate((el) => el.scrollTop)
    const badge = bob.getByTestId("new-count")
    const overList = async () => {
      const vp = await viewport(bob).boundingBox()
      if (!vp) throw new Error("Bob's message list has no box")
      await bob.mouse.move(vp.x + vp.width / 2, vp.y + vp.height / 2)
    }
    const scrollUp = async () => {
      await overList()
      await bob.mouse.wheel(0, -1200)
      await new Promise((r) => setTimeout(r, 800))
      if ((await fromBottom()) <= 600) throw new Error("Bob is not scrolled up")
    }
    const landsOnLatest = (locator, timeout) =>
      until(
        async () => (await inListView(bob, locator)) && (await fromBottom()) <= 8 && (await badge.count()) === 0,
        timeout,
        "a send while scrolled up did not jump to the latest message",
      )

    // Scrolled up, an incoming message only bumps the badge; the list stays put.
    await scrollUp()
    const before = await scrollTop()
    await post(uniqueText("while away"))
    await until(async () => (await badge.count()) === 1 && (await badge.textContent())?.trim() === "1", 5_000,
      "the incoming message did not bump Bob's badge to 1")
    if (Math.abs((await scrollTop()) - before) > 2) throw new Error("an incoming message moved Bob's scrolled-up list")

    // Scrolled up, own text: jumps to the new bubble at the bottom and clears the badge.
    const text = uniqueText("sent while scrolled up")
    await sendFromComposer(bob, ADA.displayName, text)
    await landsOnLatest(bubbleOf(bob, text), 3_000)

    // At the bottom, a wheel that cannot scroll (follow mode off), then a send: still followed.
    await overList()
    await bob.mouse.wheel(0, 200)
    await new Promise((r) => setTimeout(r, 600))
    const again = uniqueText("sent after a wheel at the bottom")
    await sendFromComposer(bob, ADA.displayName, again)
    await landsOnLatest(bubbleOf(bob, again), 3_000)

    // Scrolled up, a photo: lands on the album at the bottom.
    await scrollUp()
    const caption = uniqueText("photo while scrolled up")
    await pickFiles(bob, [makeJpeg(`scroll-${randomUUID().slice(0, 8)}.jpg`, 800, 600)])
    const drawer = previewDrawer(bob)
    await drawer.getByPlaceholder("Add a caption…").fill(caption)
    await drawer.getByRole("button", { name: "Send photo", exact: true }).click()
    await drawer.waitFor({ state: "hidden", timeout: 5_000 })
    await landsOnLatest(albumWithCaption(bob, caption), 10_000)
  },

  /**
   * QT-lzx-back: Android's system back closes the top overlay instead of leaving the app. A history
   * back step closes the viewer without a reload; open/Escape cycles leave no stray entries; header
   * menu -> Notifications keeps the drawer open and back closes it; back closes the menu itself, Ada's
   * preview drawer (nothing sent) and Bob's long-press message menu; the Call test item still leaves
   * for /debug/call/.
   */
  async back({ ada, bob }) {
    // A fresh URL, not openChat's "/": a same-URL goto replaces the current entry and keeps the forward
    // entries an earlier scenario's closed overlays left behind, which would skew history.length.
    const fresh = async (page, peerName) => {
      await page.goto(`${BASE}/?back=${randomUUID().slice(0, 8)}`)
      await page.getByPlaceholder(`Message ${peerName}`).waitFor({ state: "visible", timeout: 15_000 })
    }
    await Promise.all([fresh(ada, BOB.displayName), fresh(bob, ADA.displayName)])
    const mark = (page) => page.evaluate(() => {
      window.__duetNoReload = true
      return history.length
    })
    const intact = async (page, step) => {
      if (!(await page.evaluate(() => window.__duetNoReload === true))) throw new Error(`${step}: ${page.__name}'s page reloaded or left`)
    }
    const historyLength = (page) => page.evaluate(() => history.length)
    const backStep = (page) => page.evaluate(() => history.back())
    const adaBase = await mark(ada)
    const caption = uniqueText("back")
    await pickFiles(ada, [makeJpeg(`back-${randomUUID().slice(0, 8)}.jpg`, 800, 600)])
    const drawer = previewDrawer(ada)
    await drawer.getByPlaceholder("Add a caption…").fill(caption)
    await drawer.getByRole("button", { name: "Send photo", exact: true }).click()
    await drawer.waitFor({ state: "hidden", timeout: 5_000 })
    const onBob = albumWithCaption(bob, caption)
    await onBob.waitFor({ state: "visible", timeout: 20_000 })
    await until(() => mediaImagesLoaded(onBob, 1), 20_000, "Bob's photo never loaded from /media/")

    const bobBase = await mark(bob)

    const viewerImage = bob.getByTestId("viewer-image")
    const openViewer = async () => {
      await onBob.getByRole("button", { name: "Open photo 1 of 1" }).click()
      await viewerImage.waitFor({ state: "visible", timeout: 5_000 })
    }
    await openViewer()
    await until(async () => (await historyLength(bob)) === bobBase + 1, 3_000, "opening the viewer did not add a history entry")
    await backStep(bob)
    await viewerImage.waitFor({ state: "hidden", timeout: 3_000 }).catch(() => {
      throw new Error("a history back step did not close the viewer")
    })
    await intact(bob, "back from the viewer")
    if (!(await bob.getByPlaceholder(`Message ${ADA.displayName}`).isVisible())) throw new Error("back from the viewer left the chat")

    for (let i = 0; i < 3; i++) {
      await openViewer()
      await bob.keyboard.press("Escape")
      await viewerImage.waitFor({ state: "hidden", timeout: 3_000 })
    }
    await new Promise((r) => setTimeout(r, 300))
    if ((await historyLength(bob)) !== bobBase + 1) {
      throw new Error(`history grew to ${await historyLength(bob)} after open/Escape cycles (expected ${bobBase + 1})`)
    }
    await intact(bob, "open/Escape cycles")

    const menuButton = bob.getByRole("button", { name: "Menu", exact: true })
    const notifications = bob.getByTestId("notifications-drawer")
    await menuButton.click()
    await bob.getByRole("menuitem", { name: "Notifications" }).click()
    await notifications.waitFor({ state: "visible", timeout: 3_000 })
    await new Promise((r) => setTimeout(r, 500))
    if (!(await notifications.isVisible())) throw new Error("the Notifications drawer closed along with the menu")
    await backStep(bob)
    await notifications.waitFor({ state: "hidden", timeout: 3_000 }).catch(() => {
      throw new Error("a history back step did not close the Notifications drawer")
    })
    await intact(bob, "back from the Notifications drawer")

    const menu = bob.getByRole("menu")
    await menuButton.click()
    await menu.waitFor({ state: "visible", timeout: 3_000 })
    await backStep(bob)
    await menu.waitFor({ state: "hidden", timeout: 3_000 }).catch(() => {
      throw new Error("a history back step did not close the header menu")
    })
    await intact(bob, "back from the header menu")

    // Back drops a picked selection: the preview drawer closes and nothing is sent.
    await pickFiles(ada, [makeJpeg(`back-drop-${randomUUID().slice(0, 8)}.jpg`, 640, 480)])
    await backStep(ada)
    await previewDrawer(ada).waitFor({ state: "hidden", timeout: 3_000 }).catch(() => {
      throw new Error("a history back step did not close the preview drawer")
    })
    await intact(ada, "back from the preview drawer")

    // Back closes the long-press message menu.
    const text = uniqueText("long press")
    await sendFromComposer(ada, BOB.displayName, text)
    await expectExactlyOnce(bob, text, 5_000)
    await bubbleOf(bob, text).click({ button: "right" })
    const reactions = bob.getByRole("group", { name: "Reactions" })
    await reactions.waitFor({ state: "visible", timeout: 3_000 })
    await backStep(bob)
    await reactions.waitFor({ state: "hidden", timeout: 3_000 }).catch(() => {
      throw new Error("a history back step did not close the message menu")
    })
    await intact(bob, "back from the message menu")

    await until(async () => (await historyLength(bob)) === bobBase + 1, 3_000, `history did not settle at base + 1 for Bob (base ${bobBase})`)
    await until(async () => (await historyLength(ada)) === adaBase + 1, 3_000, `history did not settle at base + 1 for Ada (base ${adaBase})`)

    await menuButton.click()
    await bob.getByRole("menuitem", { name: "Call test" }).click()
    await until(() => bob.url().includes("/debug/call/"), 10_000, "Call test did not reach /debug/call/")
    await openChat(bob, ADA.displayName)
  },

  /**
   * QT-lzx-camera / QT-lzx-save: the camera button's Video and Photo items open single-file choosers
   * that ask for the rear camera (capture=environment); a captured photo goes through the preview
   * drawer to Bob, whose viewer Save downloads the display copy as duet-<id>.webp.
   */
  async camera({ ada, bob }) {
    await Promise.all([openChat(ada, BOB.displayName), openChat(bob, ADA.displayName)])
    const cameraButton = ada.getByRole("button", { name: "Take photo or video" })
    const chooserFor = async (item) => {
      await cameraButton.click()
      const [chooser] = await Promise.all([
        ada.waitForEvent("filechooser", { timeout: 5_000 }),
        ada.getByRole("menuitem", { name: item, exact: true }).click(),
      ])
      return chooser
    }
    const expectCapture = async (chooser, accept, item) => {
      const attrs = await chooser.element().evaluate((el) => ({ accept: el.getAttribute("accept"), capture: el.getAttribute("capture") }))
      if (attrs.accept !== accept || attrs.capture !== "environment" || chooser.isMultiple()) {
        throw new Error(`the ${item} item opened accept=${attrs.accept} capture=${attrs.capture} multiple=${chooser.isMultiple()}`)
      }
    }

    await expectCapture(await chooserFor("Video"), "video/*", "Video")
    const photoChooser = await chooserFor("Photo")
    await expectCapture(photoChooser, "image/*", "Photo")
    await photoChooser.setFiles(makeJpeg(`camera-${randomUUID().slice(0, 8)}.jpg`, 1200, 900))
    const drawer = previewDrawer(ada)
    await drawer.getByText("1 photo", { exact: true }).waitFor({ state: "visible", timeout: 5_000 })
    const caption = uniqueText("captured")
    await drawer.getByPlaceholder("Add a caption…").fill(caption)
    await drawer.getByRole("button", { name: "Send photo", exact: true }).click()
    await drawer.waitFor({ state: "hidden", timeout: 5_000 })

    const onBob = albumWithCaption(bob, caption)
    await onBob.waitFor({ state: "visible", timeout: 20_000 })
    await until(() => mediaImagesLoaded(onBob, 1), 20_000, "Bob's captured photo never loaded from /media/")
    await onBob.getByRole("button", { name: "Open photo 1 of 1" }).click()
    const viewer = bob.getByRole("dialog")
    await bob.getByTestId("viewer-image").waitFor({ state: "visible", timeout: 5_000 })
    const save = viewer.getByRole("button", { name: "Save", exact: true })
    await until(() => save.isEnabled(), 5_000, "the viewer's Save button stayed disabled")
    const [download] = await Promise.all([bob.waitForEvent("download", { timeout: 15_000 }), save.click()])
    if (!/^duet-[^/]+\.webp$/.test(download.suggestedFilename())) {
      throw new Error(`Save downloaded "${download.suggestedFilename()}", expected duet-<id>.webp`)
    }
    await bob.keyboard.press("Escape")
    await bob.getByTestId("viewer-image").waitFor({ state: "hidden", timeout: 3_000 })
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
