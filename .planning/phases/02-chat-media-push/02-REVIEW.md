---
phase: 02-chat-media-push
reviewed: 2026-10-15T14:45:00Z
depth: standard
scope: incremental (plan 02-06, diff 5cf446e..HEAD)
files_reviewed: 8
files_reviewed_list:
  - scripts/smoke-chat.mjs
  - server/src/push/sender.ts
  - server/test/push.test.ts
  - shared/src/push.ts
  - web/components/app/chat-view.tsx
  - web/components/app/composer.tsx
  - web/lib/chat/events.ts
  - web/lib/chat/push.ts
findings:
  critical: 0
  warning: 3
  info: 4
  total: 7
status: issues_found
---

# Phase 2: Code Review Report (incremental, plan 02-06)

**Reviewed:** 2026-10-15T14:45:00Z
**Depth:** standard
**Files Reviewed:** 8
**Status:** issues_found

> **Supersedes the earlier full-phase report.** This file replaces the previous full-phase 02-REVIEW.md. That report's findings and their dispositions are tracked in `02-REVIEW-DISPOSITION.md`, and the full text is still in git history. This review covers only the 02-06 gap-closure diff (`git diff 5cf446e..HEAD`): G-02-42 (jump to the newest message on every local send) and G-02-7 (topic-free Web Push, the sanitized `push_failed` reason, and the reworded test-push toasts).

## Summary

**Scroll-on-send (G-02-42).** I traced this through the minified `@shadcn/react/message-scroller` primitive. `scrollToEnd` sets `mode = autoScroll ? "following-bottom" : "free-scrolling"`, and `chat-view.tsx` mounts the provider with `autoScroll`, so the immediate call does put the list back into following mode as the comment says. The rAF follow-up runs before the frame's ResizeObserver callback, and it reads `scrollHeight` after the commit. Appending to an existing sender group changes no children of the content element. That case falls to the content ResizeObserver, which also scrolls to the end in following mode. The `scroll-send` smoke scenario really separates fixed from unfixed behavior: the wheel at the bottom forces `free-scrolling`, and without the fix the appended bubble would stay below the fold. I found no correctness defect in this half.

**Push (G-02-7).** Removing the topic is applied everywhere. No reference to `PUSH_TOPIC_*` or `topic` remains, and the tests assert that the property is absent. `server/test/push.test.ts` passes (23/23). The new `pushFailureReason` sanitizer is weaker than the threat model it cites (T-02-16 / T-02-36). It only redacts endpoint path segments, but one of the allowlisted push services (Windows WNS) puts its capability in the query string. Its identifier fast-path also returns before any redaction. Both gaps were confirmed with a scratch probe against the real function. The reworded test-push toasts still mislabel common non-network failures. For a pruned subscription they also give advice ("Reopen duet") that can never fix the problem.

## Warnings

### WR-01: `pushFailureReason` redaction misses query-string capabilities (WNS) and skips redaction on the identifier fast path

**File:** `server/src/push/sender.ts:55`, `server/src/push/sender.ts:62-75`
**Issue:** The sanitizer treats "endpoint path segments ≥ 8 chars" as the only per-device capability. That model does not fit every host that `isAllowedPushEndpoint` accepts:

- **WNS** (`*.notify.windows.com`, allowed at line 106) endpoints look like `https://wns2-xxx.notify.windows.com/w/?token=BQYAAA…`, so the capability sits in `URL.search`, not the pathname. A refusal body that echoes the token is logged verbatim. Probe result: `pushFailureReason("Invalid channel BQYAAAB1secretTOKENvalueXYZ+Abc", wnsEndpoint)` returns `"Invalid channel BQYAAAB1secretTOKENvalueXYZ+Abc"`.
- **Fast path (line 55):** an identifier-shaped JSON `reason` is returned before the segment redaction loop runs. Probe result: `pushFailureReason('{"reason":"ABCDEFGH12345678"}', "https://web.push.apple.com/ABCDEFGH12345678")` returns the path segment unredacted. Real Apple and FCM tokens are longer than the 64-character cap, so this is unlikely in practice. Still, the redaction guarantee depends on that size accident, not on the code.
- **FCM** tokens are `<instanceId>:<token>`. Only the whole segment is redacted, so a body that echoes just the `APA91b…` half goes through unchanged (confirmed by probe).

The new test only exercises FCM and Apple endpoints, so these gaps go untested. T-02-16 promises that the endpoint capability is never logged.
**Fix:** Redact every capability-bearing piece of the endpoint (path segments, query values, and `:`-split parts), and run that pass on the fast path too:
```ts
function endpointSecrets(endpoint: string): string[] {
  try {
    const u = new URL(endpoint)
    const parts = [...u.pathname.split("/"), ...[...u.searchParams.values()]]
      .flatMap((p) => [p, ...p.split(":")])
    return [...new Set(parts.flatMap((p) => {
      let d = p; try { d = decodeURIComponent(p) } catch {}
      return [p, d]
    }))].filter((p) => p.length >= SECRET_SEGMENT_MIN_CHARS)
  } catch { return [] }
}
// fast path:
if (typeof obj.reason === "string" && REASON_CODE.test(obj.reason) &&
    !endpointSecrets(endpoint).some((s) => obj.reason.includes(s))) return obj.reason
```
Add a WNS case (`?token=`) to the `pushFailureReason` unit tests.

### WR-02: Test-push catch-all toast blames the connection for 503, 429 and 401 responses

**File:** `web/lib/chat/push.ts:132-137`
**Issue:** After the rewrite, every thrown `apiPost` error goes to "Couldn't send the test. Check your connection and try again." The docstring (line 128) says this branch covers "a failed request". But `apiPost` throws an `ApiError(status, code)` for any non-2xx response. `POST /api/push/test` returns **503 `push_unconfigured`** when VAPID is missing (`server/src/push/routes.ts:75`) and **429** from `perIpLimit(10)`, and an expired session gives a 401. None of these is a connection problem. The point of G-02-7 was to make iPhone push failures diagnosable, and in these cases the user is sent to check Wi-Fi.
**Fix:** Branch on `ApiError`:
```ts
} catch (err) {
  if (err instanceof ApiError && err.code === "push_unconfigured")
    toast.error("Notifications aren't set up on the server yet.")
  else if (err instanceof ApiError && err.status === 429)
    toast.error("Too many tests. Wait a minute and try again.")
  else if (err instanceof ApiError)
    toast.error("Couldn't send the test. Try again.")
  else
    toast.error("Couldn't send the test. Check your connection and try again.")
  return false
}
```
Keep the exact wording consistent with the UI-SPEC copy contract.

### WR-03: The sent-0 toast's advice ("Reopen duet") cannot recover a pruned subscription, which leaves the user in a loop

**File:** `web/lib/chat/push.ts:126-129`, `web/lib/chat/push.ts:142`
**Issue:** The docstring says a sent-0 result is fixed by reopening, because `syncSubscription` re-saves the subscription. That holds only when this session has no row. When the push service answered 404/410, `sendOne` deleted the row (`sender.ts:166-168`), but the browser still holds the same dead `PushSubscription` (iOS in particular keeps returning it from `getSubscription()`). Reopening runs `syncSubscription`, which upserts the same dead endpoint. The next test gets 410 again, the row is pruned again, and the same toast appears. Reopening also cannot fix 400/403 refusals (for example a VAPID/JWT problem), because the subscription is unchanged. The advice can't work in exactly the failure cases this plan was meant to diagnose.
**Fix:** On `sent === 0`, try one self-heal before showing the toast. Unsubscribe the current subscription, subscribe again with the VAPID key (permission is already granted, so no prompt appears), `save()` it, and retry `/api/push/test` once. Alternatively, return a `pruned`/`refused` hint from `/api/push/test` and change the copy to "Turn notifications off and on again" for that case. At minimum, change the docstring so it doesn't claim that reopening fixes a refused or pruned subscription.

## Info

### IN-01: Composer asks for a scroll even when the store silently drops the send

**File:** `web/components/app/composer.tsx:46`, `web/components/app/composer.tsx:118` (with `web/lib/chat/store.ts:423`, `:452`)
**Issue:** `chatStore.sendVoice` returns early on an empty blob, and `sendMedia` returns early on zero files. The composer still calls `requestScrollToLatest()` and clears the reply target, so the user gets yanked to the bottom with nothing sent. The impact is harmless today, but the trigger sits one layer away from the actual send.
**Fix:** Have the `send*` store methods return a boolean (or dispatch the event themselves after enqueueing), and request the scroll only when something was enqueued.

### IN-02: Network-level push failures (`code: 0`) still log no cause

**File:** `server/src/push/sender.ts:163-179`
**Issue:** For timeouts, DNS errors and ECONNRESET, `err.statusCode` and `err.body` are both missing, so the `push_failed` line holds only `code: 0` and the host. G-02-7 is about diagnosing why push fails, and this class of failure stays opaque.
**Fix:** When `code === 0`, log `err.code` if it matches `REASON_CODE` (for example `ETIMEDOUT`, `ECONNRESET`) as `reason`. The error message is already known to be safe to drop.

### IN-03: The sanitizer keeps bidi overrides and C1 controls

**File:** `server/src/push/sender.ts:81`
**Issue:** Only C0 and DEL are flattened. U+202E (RLO), U+2066-2069 and C1 controls such as U+009B (8-bit CSI) survive. A probe confirmed `"evil \u202e …"` passes through, and pino's JSON encoding does not escape them. This allows cosmetic log spoofing when the logs are viewed in a terminal. The push services are trusted, so the risk is low.
**Fix:** Use `.replace(/[\u0000-\u001f\u007f-\u009f\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, " ")`.

### IN-04: The blanket topic removal also drops FCM coalescing, which was not broken

**File:** `server/src/push/sender.ts:21-27`, `server/src/push/sender.ts:155-160`
**Issue:** Only Apple rejects the Topic header. Removing it for every host means a Pixel that is offline for up to `PUSH_TTL_SECONDS` (24 h) now gets every queued chat push as a separate push event (each one wakes the SW) instead of one coalesced push. On a busy day it may also run into FCM's per-device limit on stored non-collapsible messages. The comment's statement that "collapsing happens on the device" covers what is displayed, not delivery.
**Fix:** If this matters, send `topic` only when `!host.endsWith(".push.apple.com")`. Otherwise document the trade-off as accepted in the plan or CONTEXT.

---

_Reviewed: 2026-10-15T14:45:00Z_
_Reviewer: Claude (gsd-code-reviewer)_
_Depth: standard_
