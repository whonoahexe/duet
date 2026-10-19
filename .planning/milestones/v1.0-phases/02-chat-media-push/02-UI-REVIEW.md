# Phase 02 — UI Review

**Audited:** 2026-10-15
**Baseline:** 02-UI-SPEC.md (approved 2026-10-10)
**Screenshots:** not captured (no dev server on localhost:3000, 5173 or 8080; production is auth-gated). Code-only audit.
**Interaction captures:** off (workflow.ui_interaction_capture is false). All interaction findings are code-derived.

---

## Pillar Scores

| Pillar | Score | Key Finding |
|--------|-------|-------------|
| 1. Copywriting | 3/4 | Every one of the ~40 contract strings is present verbatim. The Notifications drawer tells "unsupported" browsers "Notifications are off" and gives them no action. |
| 2. Visuals | 3/4 | Hierarchy follows the contract. The notifications card moves its icon into `CardAction` (top-right, muted) instead of leading the header. |
| 3. Color | 4/4 | Solid `primary` appears only on the 8 declared elements. No hex/rgb/oklch literals, no lucide/Radix. |
| 4. Typography | 3/4 | Phase 2 code uses 5 sizes against a declared 4. `text-2xl` (the inherited wordmark) is not listed as an exception. Weights are 400/500 only. |
| 5. Spacing | 3/4 | Markers use `py-2` (8px) where the spec says 24px. Undeclared overrides: `py-4` on the typing bubble and an arbitrary `max-w-[158px]` on the waveform. |
| 6. Experience Design | 3/4 | Loading, error, empty, failed and offline states are all covered. One dead-end state in the drawer, and nothing verified visually. |

**Overall: 19/24**

---

## Top 3 Priority Fixes

1. **The Notifications drawer has a dead end for `unsupported`** (WARNING). In `web/components/app/notifications-drawer.tsx:78`, `state === "unsupported"` renders "Notifications are off for this phone.", but the footer at line 86 only renders for `off`/`on`. The user is told notifications are off and gets no way to turn them on. **Fix:** give `unsupported` its own line, for example "This browser can't receive notifications.", or route iOS-browser cases to the Home Screen line.
2. **Marker vertical rhythm is below the contract** (WARNING). The day/time markers at `web/components/app/chat-view.tsx:622` use `py-2`, which with the scroller's `gap-4` gives 24px between groups. The spec (Spacing "lg") wants 24px of space around markers, on top of the 16px item gap. As a result, day breaks read with the same weight as sender-group breaks. **Fix:** change `py-2` to `py-6`, or drop the override and use `my-2` so the result is 24px.
3. **The notifications card header deviates from the declared composition** (WARNING). At `web/components/app/notifications-card.tsx:67-69`, `BellRingingIcon` sits in `CardAction` (top-right, `text-muted-foreground`). The spec says "`CardHeader` with `BellRingingIcon` + `CardTitle` + `CardDescription`", with the icon supporting the title. **Fix:** move the icon in front of the title (inline `flex items-center gap-2`, or a leading media slot) and keep `CardAction` free.

---

## Detailed Findings

### Pillar 1: Copywriting (3/4)
- A grep of every row of the Copywriting Contract found all strings, including "Not sent. Tap to retry." (`message-row.tsx`), "Couldn't load older messages. Tap to retry." (`chat-view.tsx:137`), "Couldn't process this video" (`album.tsx:68`), "Finding message…", "Discard selection", "Remove item", "Continue in Safari for now", all push toasts (`lib/chat/push.ts`) and both blocked-platform bodies.
- All in-progress states use the typographic "…". There are no exclamation marks and no generic Submit/OK labels.
- WARNING: in `notifications-drawer.tsx:78`, `unsupported` is collapsed into the "off" copy (see Fix 1). The contract defines drawer copy only for on/off/blocked/not-installed, so this state is a gap in the copy.
- Minor: the drawer's on/off lines ("Notifications are on for this phone." / "…are off for this phone.") were invented, because the spec says only "one line of 16px body text". They are acceptable, but undeclared.
- Minor: the album retry `aria-label` "Couldn't load. Tap to retry" (`album.tsx:127`) has no closing period, unlike the rest of the copy.

### Pillar 2: Visuals (3/4)
- The primary anchor is correct: a bottom-anchored `MessageScroller` with `autoScroll` (`chat-view.tsx:597`). The composer stays quiet (ghost attach/mic), and accent appears only for Send or while recording (`recorder.tsx:241`).
- Every icon-only control has an `aria-label`: attach, mic, send, send voice note, discard, cancel reply, close viewer, remove item, scroll to latest, play/pause, and menu.
- WARNING: the notifications card's icon placement (Fix 3) weakens the "icon, title and body support it" hierarchy, because the icon becomes a muted corner glyph.
- Minor: the typing indicator overrides the `BubbleContent` padding with `py-4` (`typing-indicator.tsx:15`). It renders taller than a one-line text bubble (about 48px vs about 44px), which is a small visual jump when the real message replaces it.
- Minor: the waveform is capped with `max-w-[158px]` (`voice-note.tsx:195`). In a 288px bubble that leaves dead space when the duration is short. This could not be checked without screenshots.

### Pillar 3: Color (4/4)
- `primary` usages: quote bar `border-primary` (`quote-block.tsx:72`), upload `Spinner text-primary` (`album.tsx:190`), jump highlight `ring-primary` (`message-row.tsx:268/287/300`), selected reaction `bg-primary/20 ring-1 ring-primary` (`message-actions.tsx:49`). Implicit `variant="default"` appears on Send, Send voice note, mic while active, the voice-note play button, the preview send button, and Enable notifications. All are in the declared list of 8.
- `destructive` is limited to the failed footer, the recording dot, discard, tile errors and voice-note load failure, as specified.
- Bubbles use `tinted` (yours) and `muted` (theirs). The waveform uses `text-foreground` / `text-foreground/30`, as specified.
- No hardcoded colors and no lucide or `@radix-ui` imports anywhere in `web/`.
- Note: during the post-success state, the notifications card shows no solid accent ("Send test notification" is outline), which matches the spec. Composer Send can be on screen at the same time as "Enable notifications". The spec accepts this, but it means the card is not always "the only solid accent control".

### Pillar 4: Typography (3/4)
- Size distribution across the Phase 2 app components: `text-xs` ×11, `text-sm` ×7, `text-base` ×9, `text-xl` ×4, `text-2xl` ×1.
- `text-2xl` is the "duet" wordmark in `a2hs-guide.tsx:47`. The spec says the wordmark is "unchanged from Phase 1", but the Typography table declares "exactly 4 sizes" and does not list it as an exception. WARNING (contract hygiene): either declare it or reuse the shared wordmark component.
- Weights are only `font-medium` ×15 and `font-normal` ×1 (the quote snippet, as specified). No semibold/bold.
- Bubble text uses `text-base leading-normal` (`message-row.tsx` CONTENT_CLASS). The composer and caption use `text-base md:text-base`, which avoids iOS zoom. Durations and the counter use `tabular-nums`.

### Pillar 5: Spacing (3/4)
- Top classes: `gap-2` ×15, `gap-1` ×14, `px-4` ×8, `py-2` ×4, `gap-4` ×3, `py-8` ×2. These sit on the declared 4/8/16/24/32 scale.
- Contract met: `MessageScrollerContent className="gap-4 px-4 py-8"` (`chat-view.tsx:604`), composer `px-4 py-2 pb-[max(8px,env(safe-area-inset-bottom))]` (`composer.tsx:131`), reaction bubble `mb-4` (`message-row.tsx:248`), 44px `size-11` touch targets on all composer and play buttons, album/voice `w-72 max-w-[80%]`, guide `px-6` plus `4rem` safe-area padding.
- WARNING: markers use `py-2` instead of the 24px declared for markers (Fix 2).
- Undeclared values: `px-3` on the recording row (`recorder.tsx:269`, 12px is off-scale), `py-4` on the typing bubble, `max-w-[158px]` on the waveform, `px-1.5`/`py-0.5` on badges, and `pt-3` / `max(12px,…)` on the viewer caption (12px is off-scale).

### Pillar 6: Experience Design (3/4)
- State coverage was checked against the spec's UI Considerations table:
  - First-load skeletons (6, alternating, 40/60/50%) are in `chat-view.tsx:151-160`.
  - The history marker covers loading, error-with-retry, finding and beginning (`chat-view.tsx:115-150`).
  - Empty state and failed footer with keyboard-activatable retry are present (`message-row.tsx:108-118`).
  - Album states uploading/processing/failed/broken are present (`album.tsx`).
  - The voice-note spinner/broken/retry and the waveform `role="slider"` are present.
  - The typing indicator has `role="status"` and `motion-reduce:animate-none`.
  - An `aria-live` announcer is present (`chat-view.tsx:234`).
  - Busy/disabled buttons with spinners are on enable and test push.
- Destructive confirmations: none are required by the contract, which is correct.
- WARNING: the dead-end `unsupported` drawer state (Fix 1).
- WARNING: nothing was verified visually or interactively in this audit. Swipe-to-reply, long-press popover anchoring, recorder slide/lock, and the 10-item viewer backstop are scored from code only. The score stays at 3 rather than 4 because gesture-heavy UX can't be confirmed without device captures.
- Registry audit: `components.json` uses only the official `@shadcn` registry and the UI-SPEC declares no third-party registries. 0 third-party blocks checked, no flags.

---

## Files Audited
- web/components/app/chat-view.tsx
- web/components/app/composer.tsx
- web/components/app/recorder.tsx
- web/components/app/message-row.tsx
- web/components/app/message-actions.tsx
- web/components/app/quote-block.tsx
- web/components/app/typing-indicator.tsx
- web/components/app/album.tsx
- web/components/app/voice-note.tsx
- web/components/app/preview-drawer.tsx
- web/components/app/viewer.tsx
- web/components/app/notifications-card.tsx
- web/components/app/notifications-drawer.tsx
- web/components/app/a2hs-guide.tsx
- web/components/app/shell.tsx
- web/lib/chat/push.ts, web/lib/chat/store.ts (copy strings)
