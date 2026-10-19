---
phase: quick-261015-vkv
plan: 01
type: execute
wave: 1
depends_on: []
files_modified:
  - shared/src/chat-logic.ts
  - server/src/push/sender.ts
  - server/test/chat-logic.test.ts
  - server/test/push.test.ts
  - web/public/icons/badge-96.png
  - web/public/sw.js
  - server/test/sw.test.ts
  - server/test/static.test.ts
autonomous: true
requirements: [NOTF-01]

estimate:
  tokens: 45000
  raw_tokens: 45000
  tasks: 2
  confidence: low

must_haves:
  truths:
    - "A push for a text message has the body 'Message'. The message text never appears anywhere in the JSON payload handed to web-push, so Apple and Google never receive it."
    - "A push for a photo, video, mixed album or voice note has a type-only body ('Photo', '3 photos', 'Video', '2 videos', '4 items', 'Voice note'). A caption never appears in the payload."
    - "The title stays the sender's name, and becomes '{name} · {n} new messages' once 2 or more are unread (D-13 unchanged)."
    - "Every notification the service worker shows passes badge '/icons/badge-96.png', a 96x96 white-on-transparent duet heart. On the Pixel the status bar shows the duet glyph instead of Chrome's generic icon."
    - "The test push (sendTest) keeps its current text: 'Test notification. You're all set.'"
  artifacts:
    - path: shared/src/chat-logic.ts
      provides: "messageTypeLabel(m: Pick<MessageDto, 'kind' | 'attachments'>): a type-only label. The signature cannot see the body."
      exports: ["messageTypeLabel"]
    - path: server/src/push/sender.ts
      provides: "notifyMessage builds the chat payload body from messageTypeLabel only"
    - path: web/public/icons/badge-96.png
      provides: "Android notification badge: 96x96 RGBA, white RGB, the heart's shape in alpha"
    - path: web/public/sw.js
      provides: "showNotification options include the badge"
  key_links:
    - from: server/src/push/sender.ts
      to: shared/src/chat-logic.ts
      via: "import { messageTypeLabel } from '@duet/shared' -> buildPayload('chat', title, messageTypeLabel(message))"
      pattern: "buildPayload\\(\"chat\", title, messageTypeLabel\\("
    - from: web/public/sw.js
      to: web/public/icons/badge-96.png
      via: "showNotification(title, { ..., badge: '/icons/badge-96.png' })"
      pattern: "badge: \"/icons/badge-96.png\""
---

<objective>
Three push notification tweaks from 261015-vkv-CONTEXT.md (locked decisions):
1. **Privacy (CONTEXT "Notification content"):** a push never carries message text or captions. The body is the message type only, decided on the server so the text never leaves the box.
2. **Badge (CONTEXT "Badge"):** a monochrome duet heart badge for the Android status bar, passed through `showNotification`.
3. **Sound (CONTEXT "Sound"):** no code change. The SUMMARY documents the Android per-app sound steps.

Purpose: lock-screen previews and Apple's and Google's push services must not see what the two of us write. The Pixel status bar should show duet's own glyph, as WhatsApp does.
Output: a type-only label helper plus a server change and updated tests; badge-96.png; the badge option in sw.js and its tests; a SUMMARY with the sound steps.

Out of scope (CONTEXT, user declined or no work): iOS home-screen unread count (setAppBadge), any iOS badge work, custom sound code, changing the sendTest text, changing the in-app aria-live announcement in web/components/app/chat-view.tsx (it never leaves the device).
</objective>

<execution_context>
@~/.claude/gsd-core/workflows/execute-plan.md
@~/.claude/gsd-core/templates/summary.md
</execution_context>

<context>
@.planning/STATE.md
@.claude/CLAUDE.md
@.planning/quick/261015-vkv-push-notification-tweaks-hide-message-pr/261015-vkv-CONTEXT.md
@shared/src/chat-logic.ts
@server/src/push/sender.ts
@server/test/push.test.ts
@server/test/chat-logic.test.ts
@web/public/sw.js
@server/test/sw.test.ts

<interfaces>
<!-- Extracted from the codebase so the executor doesn't need to explore. -->

shared/src/chat.ts:
  MessageKind = z.enum(["text", "media", "voice"])
  AttachmentKind = z.enum(["image", "video", "audio"])

shared/src/chat-logic.ts (exported through shared/src/index.ts `export * from "./chat-logic"`):
  export function mediaLabel(kinds: AttachmentKind[], { emoji }: { emoji: boolean }): string
    // emoji:false -> "Photo" | "N photos" | "Video" | "N videos" | "N items" (mixed) | "Voice note" (audio only) | "" (no kinds)
  export function messageLabel(m: Pick<MessageDto, "kind" | "body" | "attachments">): string
    // includes the text / caption: still used by web chat-view.tsx for the local aria-live announcement. Leave it.
  export function truncateGraphemes(s: string, max: number): string

server/src/push/sender.ts:
  export const PUSH_BODY_MAX_GRAPHEMES = 120
  export const PUSH_PAYLOAD_MAX_BYTES = 3072
  export function buildPayload(t: PushPayload["t"], title: string, fullBody: string): string
  notifyMessage(recipientId, message: MessageDto, senderName): currently
    const payload = buildPayload("chat", title, <body-including label>(message))

server/test/push.test.ts helpers: subscribe(cookie), message(cookie, body), payloadOf(i), send (vi.fn mock;
  send.mock.calls[i][1] is the raw JSON payload string), aliceReadsAll() in beforeEach, t.app.media.idle().
server/test/helpers.ts: uploadBytes(app, cookie, bytes, kind = "image") -> { id, attachment }
server/test/media.test.ts pattern for a JPEG: sharp({ create: { width, height, channels: 3, background: {...} } }).jpeg().toBuffer(),
  then uploadBytes(...) and `await t.app.media.idle()`, then POST /api/messages { id, body, attachmentIds: [id] }.
</interfaces>
</context>

<tasks>

<task type="tracer" tdd="true">
  <name>Task 1: Type-only push body, end to end (send message -> server label -> push payload)</name>
  <files>shared/src/chat-logic.ts, server/src/push/sender.ts, server/test/chat-logic.test.ts, server/test/push.test.ts</files>
  <behavior>
    - messageTypeLabel({ kind: "text", body: "are you home yet?", attachments: [] }) === "Message"
    - messageTypeLabel voice note === "Voice note"
    - media ["image"] -> "Photo"; 3 images -> "3 photos"; ["video"] -> "Video"; 2 videos -> "2 videos"; mixed image/video x4 -> "4 items"
    - media ["image"] with caption "secret caption" -> "Photo" (no caption, no " · ")
    - media with zero attachments -> "Message" (fallback, never an empty body)
    - push.test: bob sends "hello alice" -> payload toEqual { t: "chat", title: "Bob Test", body: "Message" }, and the raw payload string (send.mock.calls[0][1]) does not contain "hello alice"
    - push.test: bob sends a photo with caption "secret caption" -> payload body "Photo", raw payload does not contain "secret caption"
    - push.test: 2 unread -> title "Bob Test · 2 new messages" still works, and the body is "Message"
    - push.test: buildPayload unit cases keep the truncation guarantees: buildPayload("chat", "T", "x".repeat(300)) body === "x".repeat(120) + "…"; buildPayload with a 200x family-emoji body stays under 4096 bytes and never splits the ZWJ sequence
  </behavior>
  <action>
    Per CONTEXT "Notification content" (locked): the body is the type only, decided on the server.

    1. RED first. In server/test/chat-logic.test.ts add a `describe("messageTypeLabel (push privacy)")` block covering the behavior cases above (reuse the existing `att` and `media` helpers in that file and add `messageTypeLabel` to the @duet/shared import). In server/test/push.test.ts:
       - Change the first NOTF-01 test's payload assertion to body "Message" and add a raw-payload check: `send.mock.calls[0]![1]` does not contain "hello alice".
       - Rework "titles the push with the unread count from 2 and cuts a long body…": keep both title assertions. Assert `payloadOf(1).body` is "Message" and that the raw payload does not contain the 300-x text. Rename it to say the text is never carried.
       - Rework "never splits an emoji sequence and keeps the payload under 4 KB" into direct unit tests of `buildPayload` (import it from "../src/push/sender" next to the existing imports). The message path no longer feeds text into the body, but buildPayload still guards titles and sendTest. Assert the 120-grapheme + "…" cut, the <4096-byte cap and the unsplit family emoji on buildPayload output. Optionally add one integration assertion that a family-emoji text message pushes body "Message".
       - Add a test "never puts a photo caption in the push": subscribe alice. As bob, upload a small JPEG built with sharp (`import sharp from "sharp"`, same pattern as media.test.ts) via `uploadBytes(t.app, bobCookie, …)` and `await t.app.media.idle()`. Then POST /api/messages as bob with `{ id: randomUUID(), body: "secret caption", attachmentIds: [id] }`. Wait for send. Assert body "Photo" and that the raw payload does not contain "secret caption". Import uploadBytes from ./helpers.
       Run the tests and confirm they fail (messageTypeLabel does not exist yet).

    2. GREEN. In shared/src/chat-logic.ts add an exported `messageTypeLabel(m: Pick<MessageDto, "kind" | "attachments">): string`. The Pick deliberately omits `body`, so the helper cannot leak text even by accident. Return "Message" for kind "text" and "Voice note" for kind "voice". For "media", return `mediaLabel(m.attachments.map((a) => a.kind), { emoji: false })`, falling back to "Message" when that is "". Discretion choice: no emoji. The CONTEXT examples are emoji-free ("Message", "Voice note", "Photo", "Video"), and a text message has no natural emoji, so emoji-free keeps every label consistent. Give it a JSDoc saying it is the push notification body and must never include text or captions (CONTEXT privacy decision). Update the doc comment of the existing body-including label function so it says in-app announcement only, not notifications.

    3. In server/src/push/sender.ts, replace the import of the body-including label helper with `messageTypeLabel`. Build the chat payload as `buildPayload("chat", title, messageTypeLabel(message))`. Update the PushSender interface doc comment ("Push \"{senderName}: {label}\"…") to say the body is the type-only label and never the text. Do not name the old helper anywhere in sender.ts, not even in a comment: a negative grep gates this. Leave buildPayload, PUSH_BODY_MAX_GRAPHEMES, the D-13 title logic, sendTest and its text unchanged.
  </action>
  <verify>
    <automated>npm run test -w server -- chat-logic.test push.test && npm run typecheck -w server && ! grep -q 'messageLabel' server/src/push/sender.ts && grep -q 'messageTypeLabel(message)' server/src/push/sender.ts</automated>
  </verify>
  <done>chat-logic.test and push.test pass. Text pushes carry body "Message", and photo pushes carry "Photo" with no caption in the raw payload. The unread-count title still works. buildPayload truncation and the 4 KB guarantees are still covered. server/src/push/sender.ts no longer references the body-including helper. Server typecheck is clean.</done>
</task>

<task type="auto">
  <name>Task 2: duet heart badge for the Android status bar</name>
  <files>web/public/icons/badge-96.png, web/public/sw.js, server/test/sw.test.ts, server/test/static.test.ts</files>
  <action>
    Per CONTEXT "Badge" (locked): a monochrome white-on-transparent 96x96 PNG derived from the existing icon, passed as `badge` in showNotification. No iOS work and no setAppBadge.

    1. Generate the badge from web/public/icons/icon-512.png (a light heart on crimson #A50034) with ImageMagick, already on the host at /usr/bin/magick. Discretion choice: a one-off command; commit only the PNG and no script. The command below was verified in the planner's scratchpad and produces a centered 80px heart in a 96x96 canvas, all RGB white, shape in alpha:
       magick web/public/icons/icon-512.png -colorspace Gray -level 40%,90% -alpha copy -trim +repage -resize 80x80 -gravity center -background none -extent 96x96 -channel RGB -evaluate set 100% +channel PNG32:web/public/icons/badge-96.png
       (Luminance becomes alpha, so the crimson background goes transparent and the heart stays opaque with anti-aliased edges.) Read the resulting PNG flattened on a dark background to eyeball it before committing.

    2. In web/public/sw.js add `badge: "/icons/badge-96.png",` to the showNotification options, directly after the `icon` line. Change nothing else. Keep the four listeners and the comments. No cache-busting change is needed: the server already serves sw.js with Cache-Control no-cache (server/src/app.ts), and browsers byte-compare sw.js on navigation, so the edit alone triggers an update (CONTEXT discretion item resolved).

    3. In server/test/sw.test.ts, add `badge: "/icons/badge-96.png"` to the exact toHaveBeenCalledWith object in "closes open notifications, then shows one collapsed chat notification". Also assert that the test-push and fallback cases carry the badge (add `badge: "/icons/badge-96.png"` inside their existing expect.objectContaining).

    4. In server/test/static.test.ts, add "badge-96.png" to the icons loop array so /icons/badge-96.png is asserted to be served as image/png. This test runs against the real web/out export and needs `npm run build` first (see verification).
  </action>
  <verify>
    <automated>npm run test -w server -- sw.test && test "$(magick identify -format '%w %h %[opaque]' web/public/icons/badge-96.png)" = "96 96 False" && test "$(magick web/public/icons/badge-96.png -alpha off -format '%[fx:minima.r] %[fx:minima.g] %[fx:minima.b]' info:)" = "1 1 1" && test "$(magick web/public/icons/badge-96.png -format '%[fx:p{48,48}.a] %[fx:p{0,0}.a]' info:)" = "1 0" && grep -q 'badge: "/icons/badge-96.png"' web/public/sw.js</automated>
    <human-check>After redeploy, on the Pixel: receive a duet message while the app is closed. The status bar and notification header show the white duet heart, not Chrome's generic icon. The body reads "Message" (or "Photo"/"Voice note"), never the text. On the iPhone: the body is type-only and the icon is unchanged.</human-check>
  </verify>
  <done>web/public/icons/badge-96.png exists: 96x96, not opaque, all-white RGB, opaque center and transparent corner. sw.js passes the badge on every notification, and sw.test passes with the badge asserted. static.test lists badge-96.png.</done>
</task>

</tasks>

<threat_model>
## Trust Boundaries

| Boundary | Description |
|----------|-------------|
| duet server -> Apple/Google push services | The push payload leaves our infrastructure. It is encrypted to the device, but it is the content the OS shows on the lock screen. |
| service worker -> OS notification shade | Whatever is in the body appears on a locked phone, visible to anyone holding it |

## STRIDE Threat Register

| Threat ID | Category | Component | Severity | Disposition | Mitigation Plan |
|-----------|----------|-----------|----------|-------------|-----------------|
| T-vkv-01 | Information disclosure | server/src/push/sender.ts notifyMessage | high | mitigate | Body from messageTypeLabel, whose signature is Pick<MessageDto, "kind" \| "attachments"> (no body field). push.test asserts the raw payload string lacks the text and the caption. |
| T-vkv-02 | Information disclosure | lock-screen notification (web/public/sw.js) | medium | mitigate | The SW only renders the server's body, which is now type-only (T-vkv-01). The SW fallback stays the generic "New message". |
| T-vkv-03 | Tampering | web/public/icons/badge-96.png static asset | low | accept | A public, same-origin static file built at image build time. No user input involved. |
| T-vkv-SC | Tampering | npm/pip/cargo installs | high | accept | This plan installs no packages. ImageMagick is already on the host, and sharp is already a server dependency used by tests. |
</threat_model>

<verification>
- `npm run test -w server -- chat-logic.test push.test sw.test` passes.
- `npm run build && npm test` passes: the full server suite, including static.test against the rebuilt web/out with badge-96.png.
- `npm run typecheck` is clean across workspaces.
- `! grep -q 'messageLabel' server/src/push/sender.ts`
</verification>

<success_criteria>
- No push payload for a chat message ever contains message text or a caption. The body is one of "Message", "Voice note", "Photo", "N photos", "Video", "N videos", "N items".
- The title behavior (sender name / "{name} · {n} new messages") and sendTest text are unchanged.
- The Android notification badge is the duet heart (web/public/icons/badge-96.png), wired in sw.js.
- There is no setAppBadge and no iOS badge or sound code.
</success_criteria>

<output>
Create `.planning/quick/261015-vkv-push-notification-tweaks-hide-message-pr/261015-vkv-SUMMARY.md` when done. Besides the standard sections it MUST include:
- **Sound (no code, per CONTEXT "Sound"):** browsers do not support custom web-push notification sounds, and iOS web push always uses the default tone. To change the tone on the Pixel, either long-press a duet notification -> Settings (gear), or go to Settings -> Apps -> duet -> Notifications -> pick the notification category -> Sound, then choose a tone.
- **Deploy note:** the phones only see these changes after the duet container is rebuilt and restarted from compose.yaml, so the server sends the new body and web/out ships the new sw.js and badge. The service worker updates itself on the next app open (sw.js is served no-cache).
- The label wording chosen (emoji-free) and the badge generation command used.
</output>
