---
phase: 03-voice-video-calls
fixed_at: 2026-10-19T03:07:12Z
review_path: .planning/phases/03-voice-video-calls/03-REVIEW.md
iteration: 1
findings_in_scope: 10
fixed: 10
skipped: 0
status: all_fixed
---

# Phase 3: Code Review Fix Report

**Fixed at:** 2026-10-19T03:07:12Z
**Source review:** .planning/phases/03-voice-video-calls/03-REVIEW.md
**Iteration:** 1

**Summary:**
- Findings in scope: 10 (CR-01, WR-01 to WR-09; IN-* left alone as instructed)
- Fixed: 10
- Skipped: 0

Each fix was committed on its own on `master`, in the main checkout (sequential run, no worktree). Two findings have a follow-up commit, explained under WR-04 and WR-08. Client-side fixes in `web/lib/call/store.ts` have no unit-test harness. They are covered by typecheck and the two-browser smoke test only, so they are marked "requires human verification" below.

## Verification

Every gate ran in the **main checkout** (`/home/cinedise/duet`) after the last commit (`da09609`), so the results can be reproduced from this tree:

| Gate | Result |
|---|---|
| `npm test` | 24 files, 387 passed, 1 skipped (it was skipped before these fixes) |
| `npm run typecheck` | exit 0 (web, server, shared) |
| `bash scripts/check-preset.sh` | `preset ok` |
| `bash scripts/smoke-calls.sh` | all 18 scenarios ok, `smoke-calls ok` |

Not redeployed.

## Fixed Issues

### CR-01: Accepting while the caller's socket is away leaves the "cancelled" timer armed

**Files modified:** `server/src/calls/registry.ts`, `server/test/call-registry.test.ts`
**Commit:** ca95e5f
**Applied fix:** `bind()` now clears the ringing-phase `absentTimer`. If the caller's bound connection is already gone, it arms the 35 s active-call grace, which ends the call as `dropped`. Two regression tests were added:
- The caller closes while ringing and the callee accepts 5 s later. The call survives the old 10 s mark and ends as `dropped` exactly 35 s after the accept.
- The caller rejoins after such an accept. It gets `call.state active`, both connections are in the room, and nothing ends after 60 s.

The first test fails without the fix (checked). To support rejoin tests, the registry test harness gained an optional per-connection session.

### WR-09: After a reload mid-call, the stale server call blocks new calls with "on another device"

**Files modified:** `server/src/calls/registry.ts`, `server/test/call-registry.test.ts`
**Commit:** ee1e1c2
**Applied fix:** A new `abandonedBy()` check runs in `invite()`. When the inviting connection's session is the session bound to one side of the current call, and that side's bound connection has closed, the stale call ends as `dropped` and the new invite rings normally. Deviation from the review's suggestion: I also require the old bound connection to be closed. Otherwise a second tab of the same session would kill a live call. Instead, that tab still gets `busy`, which has its own test. `dropped` is used rather than `cancelled` so no "Missed call" push races the new ring. Four tests cover:
- an active call left by a reloaded caller
- a ringing call left by a reloaded caller (no missed push)
- an active call left by a reloaded callee
- a second open tab staying busy

### WR-07: The service worker closes every notification on every push

**Files modified:** `web/public/sw.js`, `server/test/sw.test.ts`
**Commit:** d3acd01
**Applied fix:** The push handler now closes only notifications of the same kind. A call push closes `duet-call`. Chat and test pushes close everything except `duet-call`. One existing test was updated (its open notification now carries the `duet-call` tag). Two tests were added:
- A chat push leaves the call notification open and closes the chat and test ones.
- A missed-call push replaces the ring and leaves the chat notification open.

### WR-01: A device whose accept crossed another device's accept ignores `call.stop-ringing`

**Files modified:** `web/lib/call/store.ts`
**Commit:** 06d692d
**Status:** fixed: requires human verification (client state machine, no unit harness)
**Applied fix:** The `call.stop-ringing` handler now also acts when this device is the callee in `connecting` with no media yet. It closes the call and toasts "Answered on another device". This is safe because the server only sends stop-ringing to callee connections it did not bind.

### WR-02: A `call.accept` lost to a down socket is never retried

**Files modified:** `web/lib/call/store.ts`
**Commit:** 2736820
**Status:** fixed: requires human verification
**Applied fix:** The fix uses the ring-based approach from the review. The server re-rings only a call that is still ringing (ring-on-attach). So when a `call.ring` arrives for the current call while this device is the callee in `connecting` with no media and a session, it means the accept never arrived, and the accept is sent again. This covers both a send that failed outright and a frame lost with a dying socket. When `call.accepted` arrives after such a resend, it also clears `rejoinPending` and runs `checkRecovered()`, so "Reconnecting…" cannot stick.

### WR-03: The peer hanging up during "Connecting…" shows "Couldn't connect"

**Files modified:** `web/lib/call/store.ts`
**Commit:** 539768c
**Status:** fixed: requires human verification
**Applied fix:** `hangup` and `failed` are now handled separately in `handleEnded`:
- `hangup` closes a ring that has not been answered yet (`ringing-in`) and otherwise shows "Call ended · m:ss" ("0:00" with no media).
- Only `failed` with no media shows "Couldn't connect".

### WR-04: A call missed while duet is in the foreground leaves no trace

**Files modified:** `web/lib/call/store.ts`
**Commits:** b88149e, da09609
**Status:** fixed: requires human verification
**Applied fix:** On the callee, a `no-answer` end now always shows the "Missed call from X" toast with Call back, de-duplicated by call id. That covers the case the finding describes: a ring left unanswered for the full timeout while the session is "viewing", so the push is suppressed.

The first commit also toasted for `cancelled`. That broke the `cancel` smoke scenario, which enforces UI-SPEC section 5: "Cancelled (callee side) … no toast if the app is open, since the user saw it ring". The follow-up commit da09609 restores that spec behaviour: a cancelled ring closes quietly unless Accept was already tapped. The server-side push suppression is unchanged.

### WR-05: The other person's ring is dropped while this device is setting up its own call

**Files modified:** `web/lib/call/store.ts`
**Commit:** f33f487
**Status:** fixed: requires human verification
**Applied fix:** A `deferredRing` now holds a `call.ring` that arrives while this device is in `ringing-out` and its invite has not been sent yet.
- It is cleared when the invite is sent (the server then merges per D-14), by `call.ended` or `call.stop-ringing` for that call, by a new `startCall`, and by `reset()`/`leave()`.
- `closeNow()` and `showFailure()` replay it when the local attempt ends. Those are the paths for a failed ICE fetch, a cancel, and a failed invite send.

### WR-06: Logging out during a call never ends it

**Files modified:** `web/lib/call/store.ts`, `web/components/app/shell.tsx`
**Commit:** 3242a5e
**Status:** fixed: requires human verification
**Applied fix:** A new `sendLeave()` sends `call.end` when this device is bound to the call: `ringing-out` after the invite was sent, or `connecting`/`live`. Wiring:
- `callStore.reset()` calls `sendLeave()` first.
- A new `callStore.leave()` ends the call and closes it locally while keeping the peer binding, so a failed logout still leaves the store usable.
- In `Shell`, `handleLogout` calls `callStore.leave()` before `stopRealtime()`. The session-gone and `finishLogout` paths now call `callStore.reset()` before `stopRealtime()`.

Deviation: a ring this device is only receiving (`ringing-in`) is not declined on logout. Nothing is bound to that device, and declining would end the ring on the person's other phone too.

### WR-08: Callee-side technical failures are reported to the caller as "Declined"

**Files modified:** `shared/src/ws.ts`, `server/src/calls/registry.ts`, `web/lib/call/store.ts`, `server/test/call-registry.test.ts`, `server/test/calls.test.ts`
**Commit:** 451a44f
**Applied fix:** This uses the review's dedicated-reason option.
- **Schema:** `call.decline` takes an optional `reason: "failed"`.
- **Server:** the registry ends such a decline as `failed` (no missed-call push). The caller is on `ringing-out` with no media, so it shows "Couldn't connect" with Retry.
- **Client:** `answer()` sends `reason: "failed"` for an unavailable mic, a failed TURN-credential fetch and a session setup error.
- **Denied mic:** stays a plain decline, per UI-SPEC section 8 ("declined on the callee side"), as the review allowed. I folded this into the WR-08 commit with `--amend` while it was still HEAD.

Tests added:
- registry: a failed decline ends as `failed` on every connection, with no missed push
- registry: a failed decline from the caller gets `not_allowed`
- integration: the same over the real hub
- schema: `reason: "failed"` is accepted, any other reason is rejected

The client half (which paths send `failed`) requires human verification.

---

_Fixed: 2026-10-19T03:07:12Z_
_Fixer: Claude (gsd-code-fixer)_
_Iteration: 1_
