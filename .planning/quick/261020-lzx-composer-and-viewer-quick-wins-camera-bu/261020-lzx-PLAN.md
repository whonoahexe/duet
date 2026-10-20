---
phase: 261020-lzx
plan: 01
type: execute
wave: 1
depends_on: []
files_modified:
  - web/lib/back-close.ts
  - web/lib/chat/save-media.ts
  - web/components/app/viewer.tsx
  - web/components/app/shell.tsx
  - web/components/app/notifications-drawer.tsx
  - web/components/app/preview-drawer.tsx
  - web/components/app/message-row.tsx
  - web/components/app/permission-drawer.tsx
  - web/components/app/call-screen.tsx
  - web/components/app/composer.tsx
  - scripts/smoke-chat.mjs
autonomous: true
requirements: [QT-lzx-back, QT-lzx-camera, QT-lzx-save]

estimate:
  tokens: 120000
  raw_tokens: 120000
  tasks: 3
  confidence: low

must_haves:
  truths:
    - "On the Pixel PWA, the system back button closes the open media viewer and leaves the user in the chat; the app does not close and the page does not reload"
    - "Back closes every dismissable overlay the same way (preview drawer, message long-press menu, header menu, Notifications drawer, permission drawer, camera Photo/Video menu); on the call screen back minimizes to the chat and the call keeps running"
    - "Closing an overlay any other way (X, swipe, Escape, picking a menu item) removes the history entry it added, so opening and closing overlays repeatedly never grows history and a later back press is never swallowed"
    - "Menu -> Notifications (one overlay closing as another opens) leaves the drawer open, and one back press closes it; the Call test menu item still opens /debug/call/"
    - "A camera button next to + opens a Photo / Video menu; each choice opens the phone's native camera (capture=environment) and the captured file goes into the existing preview/caption/send flow"
    - "A Save button in the viewer top bar saves the full-quality copy of the shown item (display variant for photos, video variant for clips): a download on Pixel/desktop, the share sheet on iPhone; a spinner shows while fetching, failures toast, and cancelling the share sheet is silent"
    - "call-provider.tsx's replaceState handling of ?call / ?missed is untouched"
  artifacts:
    - path: "web/lib/back-close.ts"
      provides: "One shared overlay/history manager: useBackClose(open, onClose) and leaveTo(url)"
      exports: ["useBackClose", "leaveTo"]
    - path: "web/lib/chat/save-media.ts"
      provides: "Fetch the best served variant of an attachment and hand it to the share sheet (iOS) or a download (others)"
      exports: ["saveMedia", "SaveResult"]
    - path: "scripts/smoke-chat.mjs"
      provides: "Headless e2e scenarios `back` and `camera`"
      contains: "async back("
  key_links:
    - from: "web/components/app/viewer.tsx"
      to: "web/lib/back-close.ts"
      via: "useBackClose(open, onClose)"
      pattern: "useBackClose\\(open, onClose\\)"
    - from: "web/components/app/shell.tsx"
      to: "web/lib/back-close.ts"
      via: "controlled header DropdownMenu + useBackClose; Call test item calls leaveTo"
      pattern: "leaveTo\\(\"/debug/call/\"\\)"
    - from: "web/components/app/composer.tsx"
      to: "onPick (existing preview flow)"
      via: "two hidden inputs with capture=\"environment\" whose onChange is onPick"
      pattern: "capture=\"environment\""
    - from: "web/components/app/viewer.tsx"
      to: "web/lib/chat/save-media.ts"
      via: "Save button calls saveMedia(tile.attachmentId, tile.kind)"
      pattern: "saveMedia\\("
---

<objective>
Three composer/viewer quick wins decided with the user (all locked):
1. QT-lzx-back (bug): pressing Android's system back while an overlay is open currently closes the whole PWA, because duet never adds history entries. Add ONE shared hook that gives each open overlay a history entry, closes the top overlay on popstate and removes the entry when the overlay closes any other way. Wire it into every dismissable overlay.
2. QT-lzx-camera: add a camera button next to + in the composer. It opens a Photo / Video DropdownMenu, each backed by a hidden file input with capture="environment" that opens the native camera. Captured files flow into the existing onPick -> PreviewDrawer -> send path.
3. QT-lzx-save: add a Save button in the viewer top bar that saves the full-quality served copy of the current item (share sheet on iPhone, download elsewhere).

Purpose: fix the "back closes the app" bug on the Pixel and remove two everyday frictions: taking a photo or clip, and keeping a received one.
Output: web/lib/back-close.ts, web/lib/chat/save-media.ts, wiring in 8 overlay components, and two new headless e2e scenarios (`back`, `camera`) in scripts/smoke-chat.mjs.

Source coverage audit (GOAL = quick description, REQ = the three locked items, CONTEXT = the locked task detail; there is no RESEARCH.md):
| Source item | Covered by |
|---|---|
| Camera button with a Phosphor icon next to + | Task 3 |
| Second hidden input with capture; Photo/Video DropdownMenu (robust on iOS Safari and Pixel Chrome) | Task 3 (menu chosen) |
| Captured file goes through the existing preview/caption/send flow | Task 3 (onChange = onPick) |
| No in-app getUserMedia camera | Respected: native file inputs only |
| ONE shared back-close hook: push on open, close on popstate, pop own entry on other closes, no double-close, no pile-up | Task 1 |
| Nested overlays handled sanely | Task 1 (stack + depth counter; menu -> drawer swap tested), Task 2 (popover -> viewer) |
| call-provider's replaceState untouched | All tasks (file not modified; gate) |
| Applied to viewer, preview drawer, message actions, notifications drawer, permission drawer | Task 1 (viewer, notifications), Task 2 (preview, message actions popover in message-row.tsx, permission) |
| Other dismissable overlays in web/components/app | Task 1 (header menu in shell.tsx), Task 2 (call screen: back = minimize, like its Escape), Task 3 (new camera menu). Excluded: a2hs-guide.tsx (a full-screen pre-login page shown only in iOS Safari, not an overlay); incoming-call.tsx (no Escape/Back dismissal by design, see its doc comment: back must never decline a ringing call); call-test.tsx (a debug page with no overlays) |
| Save in viewer top bar next to close; display variant for photos, video variant for clips | Task 3 |
| iPhone: blob -> navigator.share({ files }); others: blob -> object URL -> a[download]; isIos() picks | Task 3 |
| Spinner while fetching, sonner toast on failure, AbortError is not an error | Task 3 |
| Preset-only UI, Phosphor only, no new deps | All tasks (check-preset.sh + package.json/lockfile unchanged gate) |
| Run the web typecheck/lint/tests that exist | All tasks (typecheck, lint-no-new-findings, smoke e2e) |
| Real-device behaviour listed as manual verification | <human-check> blocks in Tasks 1-3 |
</objective>

<execution_context>
@~/.claude/gsd-core/workflows/execute-plan.md
@~/.claude/gsd-core/templates/summary.md
</execution_context>

<context>
@.planning/STATE.md
@.claude/CLAUDE.md
@web/AGENTS.md
@node_modules/next/dist/docs/01-app/01-getting-started/04-linking-and-navigating.md
@web/components/app/viewer.tsx
@web/components/app/composer.tsx
@web/components/app/shell.tsx
@web/components/app/call-provider.tsx
@web/lib/platform.ts
@scripts/smoke-chat.mjs

<interfaces>
Facts the planner verified at HEAD. Do not re-derive them.

Next.js app router (node_modules/next/dist/client/components/app-router.js, the "Native History API" section of the linked doc):
- Next patches window.history pushState/replaceState and copies its internal `__NA` and tree state into whatever state object is passed. Always call the live window.history methods and never cache the originals.
- Next's own popstate listener reloads the page when event.state is a non-null object without `__NA`. Entries pushed through the patched method with null state carry `__NA`, so traversals between them are harmless same-URL restores. Never pass a URL (the URL must not change) and never hand-build a state object that bypasses the patch.

Overlay state ownership (where each hook call goes):
- Viewer (viewer.tsx): `open = index !== null`, prop `onClose`.
- PreviewDrawer (preview-drawer.tsx): `open = files.length > 0`, local `discard()`.
- Message long-press menu: the controlled Popover in `StoredBubble` in web/components/app/message-row.tsx (`const [open, setOpen] = useState(false)`). message-actions.tsx is only the popover body and does not change.
- NotificationsDrawer / PermissionDrawer: props `open`, `onOpenChange`.
- CallScreen (call-screen.tsx, around line 371): `const open = call.screen === "open" && (...)`. Its Dialog's onOpenChange(false) already calls `callStore.minimize()`.
- Shell header menu (shell.tsx, around line 240): an uncontrolled `<DropdownMenu>`. The Notifications item calls `setDrawerOpen(true)`; the Call test item calls `window.location.assign("/debug/call/")`.
- DropdownMenu (web/components/ui/dropdown-menu.tsx) spreads `MenuPrimitive.Root.Props`, so it accepts `open` and `onOpenChange`. Items close the menu on click by default.

Media (server/src/media/routes.ts VARIANTS; the original is deliberately NOT served, T-02-22):
- `display` = display.webp (image/webp, long edge 2048), the best image variant. `video` = video.mp4 (video/mp4). URL: `/media/${encodeURIComponent(id)}/${variant}`. It is auth-gated by the session cookie, which same-origin fetch sends by default.
- AlbumTile (web/components/app/album.tsx): `{ key, kind: "image" | "video", status: "uploading" | "local" | "processing" | "ready" | "failed", attachmentId: string | null, localUrl, ... }`.

Signatures to create:
- web/lib/back-close.ts: `export function useBackClose(open: boolean, onClose: () => void): void` and `export function leaveTo(url: string): void`.
- web/lib/chat/save-media.ts: `export type SaveResult = "saved" | "cancelled" | "tap-again"` and `export function saveMedia(attachmentId: string, kind: AttachmentKind): Promise<SaveResult>` (it throws on failure). `AttachmentKind` comes from "@duet/shared".

Lint context: React 19.3 exports `useEffectEvent` (typed in @types/react). The repo's eslint (react-hooks v7) errors on setState inside effects and on reading refs during render, so avoid both.

Smoke harness (scripts/smoke-chat.mjs): the `scenarios` object is keyed by name, and each entry is `async ({ ada, bob, base }) => {}`. Helpers include openChat(page, peerName) (a goto, i.e. a new document), sendFromComposer, bubbleOf(page, text), expectExactlyOnce, until(fn, timeout, msg), uniqueText, makeJpeg(name, w, h), pickFiles(page, files) (uses testid `attach-input`, which must stay unique), previewDrawer(page), albumWithCaption(page, caption), mediaImagesLoaded(locator, n), ADA, BOB. Album tiles are buttons named "Open photo N of M". The viewer image has testid `viewer-image`, the notifications drawer `notifications-drawer`, and the header menu trigger is the button named "Menu". Right-clicking a bubble opens the long-press menu (group "Reactions"). Contexts come from browser.newContext() (downloads accepted, file choosers interceptable).
</interfaces>

Gate baselines at HEAD (recorded by the planner, 2026-10-20):
- `npm --prefix web run typecheck` exits 0.
- `npm --prefix web run lint` exits 1 at HEAD (11 errors and 2 warnings in untouched files), so it cannot be a pass/fail gate. Use the touched-file count gate in each task instead. Baseline for the existing touched files = 4 findings (call-screen.tsx: 2, shell.tsx: 1 error + 1 location-assign warning). New files must add 0.
- `bash scripts/smoke-chat.sh album video`, `SMOKE_SCRIPT=scripts/smoke-onboarding.mjs bash scripts/smoke-chat.sh` and `SKIP_BUILD=1 bash scripts/smoke-calls.sh minimize` all pass at HEAD (the calls smoke reads the TURN key from the env file by itself and never prints it).
- `bash scripts/check-preset.sh` prints "preset ok".
- At HEAD no component calls useBackClose, composer.tsx has no camera-capture inputs, the attach-input testid occurs exactly once in composer.tsx, and no file under web/components or web/app calls the History API push/back/go methods.
</context>

<tasks>

<task type="tracer">
  <name>Task 1: Shared back-close manager, end to end through the viewer and the header menu -> Notifications drawer</name>
  <files>web/lib/back-close.ts, web/components/app/viewer.tsx, web/components/app/shell.tsx, web/components/app/notifications-drawer.tsx, scripts/smoke-chat.mjs</files>
  <action>
QT-lzx-back. Create web/lib/back-close.ts ("use client" is not needed; it is a plain module plus a hook). Name it like the other lib modules, e.g. lib/chat/gestures.ts exports hooks. Give it a top doc comment that explains the why: an installed Android PWA closes on back when there is no history to go back to, so each open overlay holds one same-URL history entry. Module-level state, with no React state:
- `stack`: an array of entries `{ close: () => void }`, newest last.
- `depth`: how many entries this module has pushed that are still behind the current position.
- `pendingBack`: true between a traversal this module started and its popstate.
- `leavingTo`: a URL or null.
- `scheduled`: a coalescing flag for one setTimeout(0) reconcile.
- A once-only flag for installing the window popstate listener lazily on first acquire. Never touch window at module top level, because the static export prerenders.

reconcile() runs from the coalesced setTimeout(0), so a close and an open in the same React commit (menu item -> drawer, or StrictMode's mount/unmount/mount) net out to no history change:
- If pendingBack, return (wait for the popstate).
- If leavingTo is set: when depth > 0, set pendingBack, remember n = depth, set depth = 0 and traverse back n steps with window.history's go method and a negative delta. Otherwise clear leavingTo and call window.location.assign with it. Then return.
- If stack.length > depth, call window.history's pushState with null state and an empty title, and NO url, once per missing entry, incrementing depth each time.
- If stack.length < depth, set pendingBack, traverse back (depth - stack.length) steps with one go call, and set depth = stack.length.

The popstate handler:
- If pendingBack: clear it, then schedule (the reconcile picks up opens that happened meanwhile, or a pending leaveTo).
- Else if depth === 0: ignore it (not ours; Next handles it).
- Else: depth -= 1, pop the newest stack entry, call its close(), then schedule.

The entry is removed before close() runs, so the component's later effect cleanup finds nothing to remove and never triggers a second traversal (no double-close).

useBackClose(open, onClose): wrap onClose with React's useEffectEvent. In one useEffect keyed on [open], when open create a fresh entry whose close calls the effect event, push it onto the stack and schedule. The cleanup removes that exact entry (by identity, a no-op if the popstate handler already removed it) and schedules.

leaveTo(url): set leavingTo and schedule. Document it as "navigate to another document after our history entries are unwound": a traversal racing location.assign can cancel the navigation.

Use one entry per open overlay rather than a single sentinel, so nested overlays never need a re-push from a popstate handler. Chrome's back-button intervention skips entries pushed without user activation, and a re-push would lack it.

Wire it:
- viewer.tsx: add useBackClose(open, onClose) inside Viewer.
- notifications-drawer.tsx: add useBackClose(open, () => onOpenChange(false)) inside NotificationsDrawer.
- shell.tsx: make the header DropdownMenu controlled with a new `menuOpen` state next to `drawerOpen` (open={menuOpen}, onOpenChange={(next) => setMenuOpen(next)}) and add useBackClose(menuOpen, () => setMenuOpen(false)). Change the Call test item's onClick to call leaveTo("/debug/call/") instead of assigning the location directly. Keep its existing comment.

Do not modify web/components/app/call-provider.tsx: its mount-time replaceState strips ?call/?missed before any overlay can open, and the manager tracks depth in memory, never through history.state. In component files, do not call the History API and do not name its methods in comments; refer to useBackClose. Match the repo's comment density (one short doc comment per export, short why-comments).

Add a scenario `back` to the `scenarios` object in scripts/smoke-chat.mjs with a doc comment in the existing style:
1. openChat both pages. Ada picks one makeJpeg photo with pickFiles, fills a uniqueText caption and clicks "Send photo". Bob waits for albumWithCaption plus mediaImagesLoaded(…, 1).
2. On Bob, set a no-reload marker on window through page.evaluate and record base = history.length.
3. Bob clicks "Open photo 1 of 1". Wait for viewer-image to be visible, then until history.length === base + 1.
4. Run a History API back step in Bob's page through page.evaluate (the traversal Android's back button performs). Expect viewer-image hidden within 3 s, the marker intact and Bob's composer field ("Message Ada Smoke") still visible.
5. Three times: open the viewer, press Escape and wait for it to be hidden. Then wait about 300 ms and require history.length === base + 1 (no pile-up) with the marker intact.
6. Click the "Menu" button and then the menuitem "Notifications". Expect notifications-drawer visible, still visible after 500 ms (the menu's closing must not close it), then a back step hides it, with the marker intact.
7. Open the menu (role "menu" visible), then a back step hides it. Require history.length === base + 1 again.
8. Open the menu and click "Call test". Wait for Bob's URL to contain /debug/call/ within 10 s, then openChat(bob, ADA.displayName) so later scenarios start from the chat.
Throw descriptive Errors like the other scenarios do.
  </action>
  <verify>
    <automated>npm --prefix web run typecheck && bash scripts/smoke-chat.sh back album video && SKIP_BUILD=1 SMOKE_SCRIPT=scripts/smoke-onboarding.mjs bash scripts/smoke-chat.sh drawer && test "$(npm exec -w web -- eslint lib/back-close.ts components/app/viewer.tsx components/app/shell.tsx components/app/notifications-drawer.tsx 2>&1 | grep -cE '^\s+[0-9]+:[0-9]+\s+(error|warning)')" -le 2 && test "$(grep -rlE 'useBackClose\(' web/components/app | wc -l)" -eq 3 && test "$(grep -rlE 'history\.(pushState|back|go)\(' web/components web/app | wc -l)" -eq 0 && git diff --quiet HEAD -- web/components/app/call-provider.tsx</automated>
    <human-check>On the Pixel home-screen app: open a photo in the viewer and press system back. The viewer closes and the chat stays. Open the header menu, tap Notifications, press back: the drawer closes. From the plain chat, one back press leaves the app (no swallowed entries). On the iPhone, the viewer and menu still open and close normally.</human-check>
  </verify>
  <done>scripts/smoke-chat.sh back passes: history back closes the viewer without leaving or reloading the page; repeated open/Escape keeps history.length at base + 1; menu -> Notifications keeps the drawer open and back closes it; Call test still reaches /debug/call/. The album, video and onboarding drawer scenarios still pass. Touched-file lint findings are at most 2 (shell.tsx's existing setState-in-effect error, plus the location-assign warning if it is still reported). call-provider.tsx is unchanged.</done>
</task>

<task type="auto">
  <name>Task 2: Back closes the remaining overlays: preview drawer, message long-press menu, permission drawer, call screen</name>
  <files>web/components/app/preview-drawer.tsx, web/components/app/message-row.tsx, web/components/app/permission-drawer.tsx, web/components/app/call-screen.tsx, scripts/smoke-chat.mjs</files>
  <action>
QT-lzx-back, applying the Task 1 hook (import { useBackClose } from "@/lib/back-close"). Each call is one line at the top level of the component, never after an early return:
- preview-drawer.tsx (PreviewDrawer): useBackClose(open, discard). Back drops the selection exactly like swiping the drawer down, which the component doc already describes.
- message-row.tsx (StoredBubble, which owns the long-press Popover state): useBackClose(open, () => setOpen(false)). message-actions.tsx needs no change because it is only the popover body. Nesting works through the stack: if the popover is open and an album tile inside the bubble opens the viewer, back closes the viewer first.
- permission-drawer.tsx (PermissionDrawer): useBackClose(open, () => onOpenChange(false)).
- call-screen.tsx: useBackClose(open, () => callStore.minimize()), placed right after `open` is computed. Back minimizes to the chat exactly like the Dialog's Escape path, and it never hangs up. Add a short comment saying so. The traversal is same-document, so capture is not stopped (Pitfall 8 concerns cross-document navigations only).
- Do NOT add it to incoming-call.tsx (no Back dismissal by design) or a2hs-guide.tsx (not an overlay).

Extend the `back` scenario in scripts/smoke-chat.mjs. Insert these before its final Call test step:
- At the start, record a no-reload marker and base history.length for Ada too.
- Ada: pickFiles one makeJpeg, then a History API back step through page.evaluate. Expect previewDrawer(ada) hidden within 3 s with the marker intact.
- Ada sends a uniqueText text with sendFromComposer and Bob gets it (expectExactlyOnce). Bob right-clicks bubbleOf(bob, text) and waits for the "Reactions" group to be visible; a back step hides it, with the marker intact.
- At the end, both pages have history.length === their base + 1.
  </action>
  <verify>
    <automated>npm --prefix web run typecheck && bash scripts/smoke-chat.sh back photo album react && SKIP_BUILD=1 bash scripts/smoke-calls.sh minimize && test "$(npm exec -w web -- eslint components/app/preview-drawer.tsx components/app/message-row.tsx components/app/permission-drawer.tsx components/app/call-screen.tsx 2>&1 | grep -cE '^\s+[0-9]+:[0-9]+\s+(error|warning)')" -le 2 && test "$(grep -rlE 'useBackClose\(' web/components/app | wc -l)" -eq 7 && test "$(grep -rlE 'history\.(pushState|back|go)\(' web/components web/app | wc -l)" -eq 0</automated>
    <human-check>On the Pixel: pick a photo with + and press back (the drawer closes and nothing is sent). Long-press a message and press back (the menu closes). During a call, press back: the chat shows with the on-call bar, the call keeps going, and tapping the bar returns to the call. Deny the camera permission once to see the permission drawer, then press back to close it.</human-check>
  </verify>
  <done>The extended `back` scenario plus photo/album/react pass. smoke-calls minimize still passes (minimizing still pops the history entry and inbound bytes keep flowing). useBackClose is called in 7 component files, and no component calls the History API directly. Touched-file lint findings are at most 2 (call-screen.tsx's existing two errors).</done>
</task>

<task type="auto">
  <name>Task 3: Camera button (Photo / Video menu) in the composer and a Save button in the viewer</name>
  <files>web/components/app/composer.tsx, web/components/app/viewer.tsx, web/lib/chat/save-media.ts, scripts/smoke-chat.mjs</files>
  <action>
QT-lzx-camera, in composer.tsx:
- Add two hidden file inputs next to the existing attach input, which stays exactly as is (smoke helpers depend on its unique testid). Each has its own useRef:
  - Photo input: accept="image/*", capture="environment", data-testid="camera-photo-input".
  - Video input: accept="video/*", capture="environment", data-testid="camera-video-input".
  - Neither has the multiple attribute. Both use onChange={(e) => void onPick(e)}, so size, duration and count limits, the preview drawer, the caption and sending are reused unchanged.
- Use a Photo / Video menu rather than one combined input: Android Chrome does not reliably offer both modes for accept="image/*,video/*" with capture, while separate inputs open the camera app in the right mode on both iPhone Safari and Pixel Chrome.
- Add a controlled DropdownMenu (state cameraOpen, onOpenChange={(next) => setCameraOpen(next)}) in the same inline-start InputGroupAddon, right after the + button and also hidden while recording.
  - Trigger: DropdownMenuTrigger with render={<InputGroupButton variant="ghost" size="icon-sm" className="size-11 rounded-full" aria-label="Take photo or video" />}, containing Phosphor CameraIcon.
  - DropdownMenuContent: side="top", align="start", className="w-auto". Two DropdownMenuItems: "Photo" with CameraIcon, whose onClick clicks the photo input ref, and "Video" with VideoCameraIcon, which clicks the video input ref. The click stays inside the item's click gesture, as the + button does.
  - Add useBackClose(cameraOpen, () => setCameraOpen(false)) (back closes the menu).
- Update onPick's doc comment to mention the camera inputs.

QT-lzx-save: create web/lib/chat/save-media.ts with no React and no toasts.
- Export type SaveResult = "saved" | "cancelled" | "tap-again", and export async function saveMedia(attachmentId, kind).
- Choose the variant: kind "video" -> "video" (video.mp4), else "display" (display.webp, the best variant the server serves; the original is deliberately not served, T-02-22).
- Fetch `/media/${encodeURIComponent(attachmentId)}/${variant}` (same-origin, so the session cookie goes with it). Throw when !res.ok. Read the blob and build a File named duet-<attachmentId>.mp4 or .webp. Its type is blob.type, or "video/mp4" / "image/webp" when that is empty.
- Keep a module-level `ready: { id: string; file: File } | null`. When ready.id matches, reuse that File WITHOUT awaiting anything before the share call, so a second tap's fresh user activation reaches navigator.share.
- iPhone path, when isIos() (from @/lib/platform) and navigator.canShare?.({ files: [file] }) is true: await navigator.share({ files: [file] }) so the sheet offers Save Image / Save Video.
  - Success: clear ready and return "saved".
  - DOMException name "AbortError" (the user dismissed the sheet): clear ready and return "cancelled".
  - "NotAllowedError" (activation expired during a slow fetch): store ready = { id, file } and return "tap-again".
  - Rethrow anything else.
- Otherwise (Pixel, desktop, or iOS without file sharing): create an object URL and a detached anchor element (do not append it to document.body, because the modal viewer may make outside content inert). Set href and download = file.name, click it, revoke the URL after 30 s with setTimeout, clear ready and return "saved".

In viewer.tsx:
- Add a ghost icon Button with aria-label="Save" directly after the close button in the top bar, so it sits next to close as the user asked. It shows Phosphor DownloadSimpleIcon, or <Spinner /> while saving, and is disabled while saving.
- It is also disabled unless tiles[current] exists with status "ready" and an attachmentId (uploading, processing and failed items have no served copy).
- Its onClick runs an async save(): set saving, then await saveMedia(tile.attachmentId, tile.kind).
  - On "tap-again", call toast("Ready. Tap Save again to save it.").
  - On a throw, call toast.error("Couldn't save. Try again.") (the same phrasing as message-actions' copy failure).
  - Always clear saving in finally.
- Import toast from "sonner". Keep the counter's absolute centring intact.

Add a scenario `camera` to scripts/smoke-chat.mjs:
1. openChat both. Ada clicks "Take photo or video". Using Promise.all with ada.waitForEvent("filechooser") and a click on the menuitem "Video", require chooser.element()'s accept === "video/*" and capture === "environment" and that chooser.isMultiple() is false. Do not set files.
2. Open the menu again and do the same with "Photo" (accept "image/*", capture "environment"). Then chooser.setFiles(makeJpeg(...)), expect the preview drawer showing "1 photo", fill a uniqueText caption, click "Send photo" and wait for the drawer to hide.
3. Bob waits for albumWithCaption and mediaImagesLoaded(…, 1), clicks "Open photo 1 of 1", then uses Promise.all with bob.waitForEvent("download", { timeout: 15_000 }) and a click on the viewer dialog's "Save" button. Require download.suggestedFilename() to match /^duet-[^/]+\.webp$/. Press Escape.
  </action>
  <verify>
    <automated>npm --prefix web run typecheck && bash scripts/smoke-chat.sh camera back album video photo && bash scripts/check-preset.sh && git diff --quiet HEAD -- web/package.json package-lock.json && test "$(grep -o 'capture="environment"' web/components/app/composer.tsx | wc -l)" -ge 2 && test "$(grep -o 'data-testid="attach-input"' web/components/app/composer.tsx | wc -l)" -eq 1 && test "$(grep -rlE 'useBackClose\(' web/components/app | wc -l)" -eq 8 && grep -q 'saveMedia(' web/components/app/viewer.tsx && test "$(npm exec -w web -- eslint lib/chat/save-media.ts components/app/composer.tsx components/app/viewer.tsx 2>&1 | grep -cE '^\s+[0-9]+:[0-9]+\s+(error|warning)')" -eq 0</automated>
    <human-check>Pixel: camera -> Photo opens the camera app for a photo and camera -> Video opens it for a clip; the capture lands in the preview drawer and sends. iPhone: the same, both modes. Viewer Save: on Pixel the .webp/.mp4 lands in Downloads (and shows in Photos); on iPhone the share sheet offers Save Image / Save Video; dismissing the sheet shows no error. Save a long clip over cellular on iPhone: if no sheet appears, the toast asks for a second tap and that tap opens it.</human-check>
  </verify>
  <done>The camera scenario passes: the Video and Photo menu items open file choosers with accept video/* and image/* plus capture=environment, a captured photo goes through preview -> send -> Bob's album, and the viewer's Save downloads duet-<id>.webp. back, album, video and photo still pass, the preset check prints "preset ok", package.json and the lockfile are unchanged, and the three touched files have 0 lint findings.</done>
</task>

</tasks>

<threat_model>
## Trust Boundaries

| Boundary | Description |
|----------|-------------|
| browser history <-> app | Entries this module pushes are traversed by the OS back button and by Next's own router |
| client -> /media/:id/:variant | The Save fetch carries the session cookie to an auth-gated endpoint |
| camera/file picker -> composer | Files the OS hands back are untrusted input to the upload path |

## STRIDE Threat Register

| Threat ID | Category | Component | Severity | Disposition | Mitigation Plan |
|-----------|----------|-----------|----------|-------------|-----------------|
| T-lzx-01 | Denial of service | web/lib/back-close.ts | medium | mitigate | One module owns every entry. A depth counter plus coalesced reconcile means entries exist only while overlays are open and each is popped exactly once. The `back` e2e asserts history.length stays at base + 1 and that the page never reloads or leaves (no back trap, no app exit) |
| T-lzx-02 | Tampering | Next.js router state | medium | mitigate | Push only through Next's patched pushState with null state and no URL, so `__NA` is copied and Next never force-reloads on popstate. call-provider.tsx stays unchanged (diff gate) |
| T-lzx-03 | Information disclosure | web/lib/chat/save-media.ts | low | mitigate | Same-origin fetch only, no token in URLs. The filename is built from the server-issued attachment id only (no caption or user text). The object URL is revoked after 30 s and the cached File is dropped after a successful share or download |
| T-lzx-04 | Tampering | composer camera inputs | low | mitigate | Captured files go through the existing onPick limits (100 MB photo, 200 MB / 3 min video, 10 items) and the server's own validation; no new upload path |
| T-lzx-05 | Denial of service | Save of a large clip | low | accept | Clips are capped at 3 min / 200 MB and only two users exist; holding one blob in memory during a save is acceptable |
| T-lzx-06 | Elevation of privilege | leaveTo(url) | low | mitigate | It is called only with the literal internal path "/debug/call/" from shell.tsx and never with user input |
| T-lzx-SC | Tampering | npm installs | high | mitigate | No package is installed (locked: no new dependencies). The gate `git diff --quiet HEAD -- web/package.json package-lock.json` holds, and check-preset.sh guards forbidden packages |
</threat_model>

<verification>
After all three tasks, run these from the repo root:
- `npm --prefix web run typecheck`
- `bash scripts/smoke-chat.sh` (every chat scenario, including the new back and camera)
- `SKIP_BUILD=1 SMOKE_SCRIPT=scripts/smoke-onboarding.mjs bash scripts/smoke-chat.sh`
- `SKIP_BUILD=1 bash scripts/smoke-calls.sh minimize`
- `bash scripts/check-preset.sh`
- `git diff --quiet HEAD -- web/components/app/call-provider.tsx web/package.json package-lock.json`
- The lint count over all touched files is at most 4: `npm exec -w web -- eslint lib/back-close.ts lib/chat/save-media.ts components/app/viewer.tsx components/app/composer.tsx components/app/shell.tsx components/app/message-row.tsx components/app/preview-drawer.tsx components/app/notifications-drawer.tsx components/app/permission-drawer.tsx components/app/call-screen.tsx 2>&1 | grep -cE '^\s+[0-9]+:[0-9]+\s+(error|warning)'` (baseline 4).

Manual on real devices (cannot be automated; list these in the SUMMARY for the user): the Android system back behaviour for each overlay and during a call; the native camera opening in photo vs video mode on both phones; the iPhone share sheet Save Image / Save Video and the Pixel download.
</verification>

<success_criteria>
- Android system back closes the top overlay (or minimizes the call) instead of closing the app, and overlays closed any other way leave no stray history entries.
- The camera button opens a Photo / Video menu whose choices open the native camera, and captures are sent through the normal preview flow.
- Viewer Save delivers the display.webp / video.mp4 copy through the share sheet on iPhone or a download elsewhere, with a spinner, a failure toast and a silent cancel.
- All automated gates above pass, no new dependencies were added, only preset components and Phosphor icons are used, and call-provider.tsx is untouched.
</success_criteria>

<output>
Create `.planning/quick/261020-lzx-composer-and-viewer-quick-wins-camera-bu/261020-lzx-SUMMARY.md` when done, including the manual real-device checklist from the three <human-check> blocks.
</output>
