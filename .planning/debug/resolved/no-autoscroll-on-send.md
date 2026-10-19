---
status: resolved
trigger: "it should auto scroll down when a msg is sent"
created: 2026-10-14T00:00:00Z
updated: 2026-10-19T00:00:00Z
goal: find_root_cause_only
symptoms_prefilled: true
---

## Current Focus
<!-- OVERWRITE on each update - always reflects NOW -->

hypothesis: CONFIRMED — H1. No code path scrolls the list to the end on a local send. Own messages are followed only by the @shadcn/react MessageScroller autoScroll "following-bottom" mode, which is off whenever the user is scrolled up (by design — the same rule drives the incoming-message badge). Secondary: that mode is also disarmed at the bottom by any user scroll intent (wheel/touchmove/keys) that produces no scroll event, so even "at the bottom" sends can fail to follow on phones.
test: headless repro (/tmp/msdbg-scripts/repro.mjs via SMOKE_SCRIPT) — done
expecting: n/a (diagnosed)
next_action: return ROOT CAUSE FOUND to orchestrator (goal: find_root_cause_only); gap-closure plan applies the fix
bug_class: bohrbug (deterministic: same inputs -> same non-scroll)
candidate_causes:
  - "code: no scrollToEnd on own send (composer/store never request it; Composer sits outside MessageScrollerProvider) — CONFIRMED"
  - "code (3rd-party primitive): autoScroll follow mode is position-gated and disarmed by userScrollIntent without re-arm when no scroll event follows — CONFIRMED as secondary (repro C)"
  - "environment (phone): visualViewport/keyboard resize breaks a follow threshold — ELIMINATED as primary (no app follow code exists to break; repro A fails on desktop Chrome without any keyboard)"
  - "spec/config: UI-SPEC never required scroll-on-send (02-UI-SPEC.md:196 only covers 'at the bottom') — contributing (why it was never built)"
and_gate: "no for the reported case (scrolled up): the missing scroll-on-send alone fully explains it. The secondary disarm path only widens the failure to 'at bottom after a touch/swipe'; one fix (unconditional scrollToEnd on own send) covers both."
reasoning_checkpoint: null
tdd_checkpoint: null

## Symptoms
<!-- Written during gathering, then immutable -->

expected: Sending a message scrolls the chat down to show the new message at the bottom, even when you were scrolled up in history.
actual: User (device UAT on installed iPhone/Pixel PWAs) reported "it should auto scroll down when a msg is sent" — sending while scrolled up leaves the view where it was.
errors: none
reproduction: Test 42 in .planning/phases/02-chat-media-push/02-UAT.md — scroll up in history, send a message, the list does not jump to the newest message.
started: discovered during device UAT on 2026-10-13

## Eliminated
<!-- APPEND only - prevents re-investigating after /clear -->

- hypothesis: an existing scroll-on-send only follows when already at the bottom / uses a threshold mis-computed with the keyboard open (visualViewport) / runs before the optimistic message renders / is a smooth scroll interrupted by the keyboard resize
  evidence: there is no scroll-on-send code path at all (grep + composer.tsx:64-73 + store.ts:413-476). Repro A fails identically in headless desktop Chrome with no keyboard and no visualViewport change, so phone-specific timing is not required to explain it.
  timestamp: 2026-10-14T00:20:00Z

## Evidence
<!-- APPEND only - facts discovered during investigation -->

- timestamp: 2026-10-14T00:05:00Z
  checked: Knowledge base (.planning/debug/knowledge-base.md)
  found: does not exist; only other session is iphone-push-not-arriving.md (unrelated)
  implication: no known-pattern candidate

- timestamp: 2026-10-14T00:06:00Z
  checked: grep for scroll/scrollToEnd across web/components, web/lib
  found: the only scrollToEnd caller is ScrollFollower's OPEN_CHAT_EVENT listener (web/components/app/chat-view.tsx:199-206, notification tap). MessageScrollerButton (chat-view.tsx:610-622) scrolls on tap. Nothing else calls scrollToEnd/scrollTop-to-bottom.
  implication: no explicit scroll-on-send exists

- timestamp: 2026-10-14T00:07:00Z
  checked: web/components/app/composer.tsx:64-73 send(), sendPicked() :113-117, recorder onSend :43-46; web/lib/chat/store.ts:413-416 sendText, :422-443 sendMedia, :450-476 sendVoice
  found: send paths only enqueue into the outbox / media list (store state) and refocus the textarea. No scroll call, no event dispatched. Composer is rendered OUTSIDE <MessageScrollerProvider> (chat-view.tsx:629 vs provider at :574-627), so it cannot call useMessageScroller() even if it wanted to.
  implication: own sends rely entirely on the primitive's autoScroll behaviour

- timestamp: 2026-10-14T00:10:00Z
  checked: @shadcn/react 0.3.1 dist/message-scroller/index.js (prettified with esbuild to /tmp/msdbg/ms.pretty.js)
  found: autoScroll is a mode machine (modeRef: following-bottom | free-scrolling | settling-jump | anchored-to-message). New content (MutationObserver on Content childList -> handleContentChange, pretty:274) and content/viewport resize (ResizeObserver -> handleResize, pretty:277-279) call scrollToEnd ONLY when mode === "following-bottom". userScrollIntent (touchmove / wheel / scroll keys on the viewport, pretty:312-313) sets mode to "free-scrolling"; it is only re-armed in the commit step (pretty:197) when the list is within scrollEdgeThreshold (default 8px, pretty:5 `_e = 8`) of the bottom. The primitive does not know who sent a message — own and incoming appends are treated identically.
  implication: when scrolled up (free-scrolling), an appended own message is not followed. This is the same rule that makes the incoming-message badge work (ScrollFollower counts peer messages while scrollable.end), so the primitive is behaving as designed; the app never asks for a scroll on send.

- timestamp: 2026-10-14T00:11:00Z
  checked: .planning/phases/02-chat-media-push/02-UI-SPEC.md:196, 02-CONTEXT.md
  found: spec only says "When you are at the bottom, new messages auto-scroll into view" and the badge rule for scrolled-up incoming messages. No requirement "sending scrolls to latest" existed, so no plan task implemented it.
  implication: spec gap -> implementation gap; not a regression

- timestamp: 2026-10-14T00:18:00Z
  checked: headless repro, SKIP_BUILD=1 SMOKE_PORT=3199 SMOKE_SCRIPT=/tmp/msdbg-scripts/repro.mjs bash scripts/smoke-chat.sh (web/out built 2026-10-13 14:56, after the last web/ source commit 14:54). Ada seeds 60 messages; Bob sends from the composer.
  found: |
    A (wheel up 1200px, then send): before {scrollTop:1360, fromBottom:1200} -> after {scrollTop:1360, fromBottom:1376}, new bubble in view = false  -> NOT followed (scrollTop unchanged)
    B (control: tap Scroll to latest, then send): before {2642, 0} -> after {2692, 0}, in view = true -> followed
    C (at bottom, wheel toward the end that cannot scroll, then send): before {2692, 0} -> after {2692, fromBottom:50} -> NOT followed (scrollTop unchanged; bubble text at the bottom edge, status line and padding below the fold)
  implication: A confirms H1 deterministically. C confirms the secondary path: a userScrollIntent with no resulting scroll event (here wheel; on phones touchmove from an overscroll drag at the end, a horizontal swipe-to-reply drag — gestures.ts uses pointer events and does not stop touchmove from bubbling to the viewport — or long-press jitter) flips the primitive to free-scrolling, and since the list is still at the bottom no scroll event re-arms it; the next appended message pushes fromBottom past the 8px threshold and following stays off.

## Resolution
<!-- OVERWRITE as understanding evolves -->

root_cause: "No code path scrolls the message list to the end when the user sends. Composer.send()/sendPicked()/recorder onSend (web/components/app/composer.tsx:43-46, 64-73, 113-117) and chatStore.sendText/sendMedia/sendVoice (web/lib/chat/store.ts:413-476) only enqueue optimistic entries; the only scrollToEnd caller is ScrollFollower's OPEN_CHAT_EVENT handler (web/components/app/chat-view.tsx:199-206), and Composer is rendered outside <MessageScrollerProvider> (chat-view.tsx:574-629) so it has no access to useMessageScroller(). Own messages therefore depend on the @shadcn/react MessageScroller autoScroll 'following-bottom' mode, which treats own and incoming appends identically and is off whenever the user is scrolled up (by design — it is what keeps the incoming badge working). Secondary: that follow mode is also disarmed at the bottom by any wheel/touchmove/scroll-key intent that produces no scroll event (e.g. Android overscroll drag, swipe-to-reply), so sends 'at the bottom' can also fail to follow on phones."
fix:
verification:
oracle_type:
files_changed: []
