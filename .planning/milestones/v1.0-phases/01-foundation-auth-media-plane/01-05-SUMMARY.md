---
phase: 01-foundation-auth-media-plane
plan: 05
subsystem: realtime
tags: [webrtc, perfect-negotiation, cloudflare-turn, getstats, playwright-core, shadcn, call-test]

requires:
  - phase: 01-04
    provides: POST /api/rtc/ice-servers (Cloudflare TURN mint), GET /ws signaling hub, shared ws/rtc zod protocol, package gate approval
  - phase: 01-03
    provides: deployed container at https://duet.brkn.me, smoke-public.sh, check-live-db.sh
provides:
  - /debug/call/ login-gated call-test harness (force-relay switch, live getStats rows, verdict badge)
  - web/lib/ws.ts SignalingClient + signalingUrl()
  - web/lib/rtc/{ice,peer,stats}.ts (fetchIceServers, perfect-negotiation createPeer, sampleCall)
  - shared callVerdict(), CallReport, CandidateType, RelayProtocol, ConnState, CallVerdict, NoContent
  - POST /api/debug/call-report -> one call_smoke log line
  - scripts/smoke-call.{sh,mjs} (headless two-peer smoke with real TURN, both modes)
  - scripts/check-call-smoke.sh (INFR-04 cellular gate from the deployed log)
  - "Call test" header menu item; redeployed container with /ws live
affects: [phase-03 calls (reuses peer/stats/ws modules), phase-02 chat realtime over /ws, end-of-phase UAT]

actuals:
  tokens: 18100
  tasks: 3
  commits: 4
plan_head_before: 5ee85097413e31d31d2ab0569cb0067941073dd1
plan_head_after: cbbf18d68042186689d6a8b8b5a654261dfbc2f7

tech-stack:
  added: ["playwright-core 1.62.1 (root devDependency, exact; pruned from the image)", "shadcn registry items switch + badge (base-luma, via shadcn@4.21.4 CLI, no new npm packages)"]
  patterns:
    - "Start order for a call: getUserMedia inside the tap -> fetchIceServers -> /ws connect -> room.join; rtc.signal frames before the peer exists are buffered and replayed"
    - "polite = ownConnId > peerConnId (string compare); MDN perfect negotiation on both sides"
    - "PASS = shared callVerdict(): failed > not_relayed > connected with growing inbound bytes (relay local candidate when forced) > waiting"
    - "Browser-reported stats are parsed through the shared zod enums before they are reported; unknown values are dropped"
    - "Headless WebRTC smoke: playwright-core + system Chrome, fake media devices, one browser context per fixture account"

key-files:
  created:
    - web/lib/ws.ts
    - web/lib/rtc/ice.ts
    - web/lib/rtc/peer.ts
    - web/lib/rtc/stats.ts
    - web/app/debug/call/page.tsx
    - web/components/app/call-test.tsx
    - web/components/ui/switch.tsx
    - web/components/ui/badge.tsx
    - scripts/smoke-call.sh
    - scripts/smoke-call.mjs
    - scripts/check-call-smoke.sh
    - server/test/call-report.test.ts
  modified:
    - shared/src/rtc.ts
    - server/src/rtc/routes.ts
    - web/components/app/shell.tsx
    - scripts/smoke-public.sh
    - README.md
    - Dockerfile
    - package.json
    - package-lock.json

key-decisions:
  - "Forced relay hairpins through Cloudflare from one host: relay-relay mode connected on the first run, so the MA5 relay-all fallback was not needed"
  - "The call report is sent from stopRun (Stop button, failure, room.full, logout, unmount, pagehide) whenever a sample exists, plus once on the first PASS of a run"
  - "A failed connectionState stops the run (tracks released) and keeps the last sample and the Failed badge on screen"
  - "smoke-call.mjs also asserts every call report answered 204 (8 per smoke run), so the report path is exercised end to end"

patterns-established:
  - "Run object in a ref: one Start..Stop run owns stream, socket, peer, timer, pending signals and report state; every async step re-checks run.stopped"
  - "check-call-smoke.sh decides a human UAT from server log lines without printing IPs or user agents"

requirements-completed: [INFR-04, INFR-03]

coverage:
  - id: D1
    description: "/debug/call/ harness: two logged-in browsers connect peer-to-peer through /ws signaling and real Cloudflare TURN, in normal mode (host/host) and forced-relay mode (relay-relay), and show PASS with growing inbound bytes"
    requirement: "INFR-04"
    verification:
      - kind: e2e
        ref: "bash scripts/smoke-call.sh -> 'smoke-call normal ok (host/host)', 'smoke-call relay ok (relay-relay)', 'smoke-call reports ok (8)', 'smoke-call ok'"
        status: pass
    human_judgment: false
  - id: D2
    description: "Shared callVerdict thresholds and POST /api/debug/call-report (401/403, strict body with integer and length caps, 204 with exactly one call_smoke log line, 30/min per client IP)"
    requirement: "INFR-04"
    verification:
      - kind: unit
        ref: "server/test/call-report.test.ts (23 cases)"
        status: pass
    human_judgment: false
  - id: D3
    description: "Redeployed at https://duet.brkn.me: /ws upgrade 401 with Origin and 403 without, ice-servers and call-report 401 without a session, live DB unchanged, playwright-core pruned from the image"
    requirement: "INFR-03"
    verification:
      - kind: e2e
        ref: "bash scripts/smoke-public.sh -> 'smoke-public ok'; bash scripts/check-live-db.sh --existing ./data -> 'live-db ok'; docker compose exec -T duet test ! -d /app/node_modules/playwright-core"
        status: pass
    human_judgment: false
  - id: D4
    description: "'Call test' item in the shell header menu opens /debug/call/ inside the installed app"
    verification:
      - kind: other
        ref: "grep -c '/debug/call/' web/components/app/shell.tsx -> 1; bash scripts/check-preset.sh -> 'preset ok'"
        status: pass
    human_judgment: true
    rationale: "Reaching the page from the installed iPhone/Pixel app (no URL bar) is only observable on the real devices; it is step 1 of the cellular UAT"
  - id: D5
    description: "INFR-04 gate: a phone on cellular and a second client reach PASS in normal and forced-relay mode; check-call-smoke.sh prints 'call-smoke ok'"
    requirement: "INFR-04"
    verification:
      - kind: manual_procedural
        ref: "End-of-phase cellular UAT, then bash scripts/check-call-smoke.sh"
        status: unknown
    human_judgment: true
    rationale: "Only a real phone on a real cellular network can prove the CGNAT-to-cellular media path; nothing on this box can leave the home network"
  - id: D6
    description: "Privacy prohibition: no camera/microphone access before Start; every captured track stops on Stop, page exit or failure"
    requirement: "INFR-04"
    verification: []
    human_judgment: true
    rationale: "Judgment prohibition per the plan; reviewed during the device UAT (camera indicator off before Start and after Stop)"

duration: 10min
completed: 2026-10-09
status: complete
---

# Phase 1 Plan 05: Call test harness and cellular proof Summary

**Login-gated `/debug/call/` harness built on a perfect-negotiation `RTCPeerConnection` over duet's `/ws` with Cloudflare TURN. A shared `callVerdict` rule only shows PASS on growing inbound bytes, and only on a relay candidate when relay is forced. A headless two-Chrome smoke passes in host/host and relay-relay mode, and the build is deployed to duet.brkn.me with a log-based cellular gate.**

## Performance

- **Duration:** about 10 min
- **Started:** 2026-10-09T21:37:18Z
- **Completed:** 2026-10-09T21:47:43Z
- **Tasks:** 3 of 3
- **Files modified:** 21, including package-lock.json

## Accomplishments

- **`/debug/call/` (Task 1).** The page is login-gated and also reached through the "Call test" header menu item.
  - Start runs in this order: getUserMedia inside the tap, then `POST /api/rtc/ice-servers`, then the `/ws` connect, then `room.join`.
  - It shows local and remote video (`playsInline` on both, with a "Tap to play" fallback) and live rows for connection state, inbound bytes, local and remote candidate types, relay protocol and RTT.
  - "Force relay (TURN only)" sets `iceTransportPolicy: "relay"` and is disabled while a test runs. `?room=` and `?relay=1` preset the room and the switch.
- **Client modules reused by Phase 3:**
  - `SignalingClient` / `signalingUrl()`.
  - `fetchIceServers()`, with no fallback ICE list.
  - `createPeer()`, which is MDN perfect negotiation. The polite side is the one whose own connId is greater than the peer's.
  - `sampleCall()`, which reads `transport.selectedCandidatePairId` and falls back to a nominated, succeeded candidate pair.
- **Headless smoke.** `scripts/smoke-call.sh` runs a local duet with the real TURN key. Two Chrome contexts, logged in as the smoke-ada and smoke-bob fixtures, click Start at the same moment, which exercises the glare path.
  - Results: `smoke-call normal ok (host/host)`, `smoke-call relay ok (relay-relay)`, `smoke-call reports ok (8)`, `smoke-call ok`.
  - Forced relay hairpinned through Cloudflare on the first try, so the MA5 relay-all fallback was not needed.
- **Shared verdict rule.** `callVerdict()` in `@duet/shared` checks, in order: failed, then not_relayed, then pass (connected, inbound bytes above zero and above the previous sample, and a relay local candidate when relay is forced), then waiting.
  - `CallReport` is a strict zod object: `inboundBytes` is a safe integer, `rttMs` is a whole number of milliseconds up to 600000, and `ua` is at most 300 characters.
  - `POST /api/debug/call-report` answers 204 and logs exactly one `call_smoke` line: userId, cfIp and the validated fields.
  - The harness reports the first PASS of a run and again when the run stops.
- **Deployed (Task 3).** The container was rebuilt and is healthy. `smoke-public.sh` now also checks that a `/ws` upgrade gets 401 with Origin and 403 without, and that call-report gets 401 without a session. `check-live-db` passes, and playwright-core is absent from the image. `https://duet.brkn.me/debug/call/` answers 200.
- **Cellular gate.** `scripts/check-call-smoke.sh` decides INFR-04 from the server log without printing IPs or user agents. It was tested against synthetic logs with a fake `docker` (pass case, two failure cases, empty log). Run against the live log now, it correctly reports 0 PASS reports, because the UAT has not run yet.

## Task Commits

1. **Task 1 (tracer): /debug/call harness proven headless over Cloudflare TURN.** `5105a28` (feat). The tracer gate (interactive mode, end-of-phase, automated-only `<verify>`) re-ran the smoke, which passed, and execution continued to the next task.
2. **Task 2 (TDD): shared callVerdict and POST /api/debug/call-report.**
   - RED: `5dc683f` (test)
   - GREEN: `9027fc8` (feat)
   - REFACTOR: none needed
3. **Task 3: ship the call test (menu item, public checks, cellular gate, README, Dockerfile, redeploy).** `cbbf18d` (feat)

**Plan metadata:** the docs commit that adds this SUMMARY.

## TDD Gate Compliance (Task 2)

- **RED (`5dc683f`):** `npm --prefix server run --silent test -- test/call-report.test.ts --reporter=tap-flat` exited 1. It discovered 23 tests: 22 failed and 1 passed.
  - Target: `POST /api/debug/call-report > answers 204 to a valid report and writes exactly one call_smoke line with the report fields`.
  - `gsd-tools check tdd-red-evidence` returned `RED_EVIDENCE_OK` (`target_test_failed`). The record is `.planning/phases/01-foundation-auth-media-plane/.tdd/01-05-T2-red.json`.
  - Semantic assessment: this is a valid RED. The target ran and failed on its planned assertion: it expected 204 and got 404, because the route did not exist. The file loaded cleanly.
  - The callVerdict cases failed with `TypeError: callVerdict is not a function`, because the shared exports did not exist yet.
  - The 403-without-Origin case already passed, because the global originGuard predates this plan.
- **GREEN (`9027fc8`):** call-report.test.ts passes 23 of 23, and the full server suite passes 113 of 113 across 9 files.
- **Order:** the `test(01-05)` commit precedes the `feat(01-05)` commit.

## Files Created/Modified

- `web/lib/ws.ts`: `SignalingClient` (`connect` resolves on hello, typed `send`, `onFrame`, `onClose`, `close`) and `signalingUrl()`
- `web/lib/rtc/ice.ts`: `fetchIceServers()`
- `web/lib/rtc/peer.ts`: `createPeer()`, perfect negotiation with `iceTransportPolicy` relay/all and `restartIce` when ICE fails
- `web/lib/rtc/stats.ts`: `sampleCall()` and `CallSample`
- `web/app/debug/call/page.tsx`: `/api/me` gate, an Empty "Log in first" state linking to `/`, and the `CallTest` component
- `web/components/app/call-test.tsx`: the harness (Run ref, signal buffering, 1 s sampling, `callVerdict`, report POSTs, dark Toaster)
- `web/components/ui/switch.tsx`, `web/components/ui/badge.tsx`: added by the shadcn CLI and not edited by hand
- `shared/src/rtc.ts`: the `CandidateType`, `RelayProtocol`, `ConnState` and `CallVerdict` enums, `callVerdict()`, `CallReport` and `NoContent`
- `server/src/rtc/routes.ts`: a shared `perIpLimit()` and `POST /api/debug/call-report`
- `server/test/call-report.test.ts`: the threshold table and the endpoint cases
- `scripts/smoke-call.sh`, `scripts/smoke-call.mjs`: the headless two-peer smoke
- `scripts/check-call-smoke.sh`: the INFR-04 log gate
- `scripts/smoke-public.sh`: the `/ws` 401/403 and call-report 401 checks
- `web/components/app/shell.tsx`: the "Call test" menu item
- `README.md`: the "Calls: TURN and the call test" section, plus the Secrets row and env sentence updates
- `Dockerfile`: line 3 comment only
- `package.json`, `package-lock.json`: `playwright-core@1.62.1` (root devDependency, exact)

## Decisions Made

- The run's final report is sent from the single stop path, `stopRun`. Stop, failure, room.full, logout, unmount and pagehide all go through it, so "report when the run stops" holds whatever ended the run.
- A failed `connectionState` stops the run, so tracks are released (the privacy prohibition). The last sample and the Failed badge stay visible.
- Values the browser reports in getStats are parsed through the shared enums before they are reported. Anything outside the schema is dropped, so a report can never be rejected because of an unexpected browser value.
- `clientId` is generated lazily, once per page load, with `crypto.randomUUID()`.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 2 - Missing critical] The headless smoke also checks the call-report path**
- **Found during:** Task 2
- **Issue:** The plan's smoke checks only the verdict. A report rejected with 400 would have gone unnoticed, and the cellular gate depends on those reports.
- **Fix:** `smoke-call.mjs` records the status of every `/api/debug/call-report` response. It requires at least 8 reports (2 runs × 2 pages × first PASS + Stop), all answering 204.
- **Files modified:** scripts/smoke-call.mjs
- **Verification:** the smoke prints `smoke-call reports ok (8)`.
- **Committed in:** 9027fc8

**2. [Rule 1 - Bug] jq operator precedence in check-call-smoke.sh**
- **Found during:** Task 3, while testing against synthetic logs
- **Issue:** `map(select($relay | not) or .allRelay)` produced booleans instead of room objects, and jq crashed on the pass case.
- **Fix:** Changed it to `map(select(($relay | not) or .allRelay))`.
- **Files modified:** scripts/check-call-smoke.sh
- **Verification:** the synthetic pass log gives `call-smoke ok`. The failure logs name the unmet condition and exit 1.
- **Committed in:** cbbf18d

**3. [Process] Commits landed on `master`**
- This follows the project's established practice, as the orchestrator directed.

---

**Total deviations:** 2 auto-fixed (1 missing critical, 1 bug), plus 1 process note
**Impact on plan:** None on scope. Both fixes strengthen the INFR-04 evidence chain.

## Issues Encountered

- None. Forced relay worked from a single host on the first run (MA5 resolved as relay-relay). The MA6 cookie sharing between `context.request` and pages worked without the fallback.
- The package install added only `playwright-core@1.62.1`, which has no dependencies and no install script. The shadcn CLI added no npm package: `web/package.json` is unchanged and no nested lockfile is left.

## Flagged assumptions, resolved status

- **MA5 (forced relay hairpin on one host):** resolved. `relay-relay` passed, with both local types `relay`.
- **MA6 (`context.request` shares cookies with pages):** resolved. No fallback was used.
- **MA4/MA8 (Safari `selectedCandidatePairId`; iOS stops capture in the background):** still open. The cellular UAT checks them, keeping both apps in the foreground with screens on.

## Human Verification (end-of-phase cellular UAT, INFR-04 gate)

Run this in the same phone session as the pending 01-03 device UAT:
1. Phone A (iPhone or Pixel): turn Wi-Fi OFF so it is on cellular only. Open the installed duet app (log in inside it if asked), then header menu → Call test.
2. Client B: the other phone on Wi-Fi, or a laptop browser at https://duet.brkn.me. Log in to either account; using the same account on both is fine. Open Call test.
3. Normal mode, on both: keep Room "debug" and Force relay OFF. Tap Start and allow camera and microphone. Wait until both show PASS and you can see and hear each other, then tap Stop on both.
4. Forced relay, on both: turn Force relay ON, tap Start, and wait for PASS with Local candidate "relay" on both. Then tap Stop.
5. Keep both screens on and both apps in the foreground. Then tell Claude "done" so it runs `bash scripts/check-call-smoke.sh`, which must print `call-smoke normal ok`, `call-smoke relay ok` and `call-smoke ok`.

Also check the privacy prohibition: the camera indicator stays off until Start and goes off after Stop.

## Plan-level verification

- `bash scripts/smoke-call.sh` (full build, final code): `smoke-call normal ok (host/host)`, `smoke-call relay ok (relay-relay)`, `smoke-call reports ok (8)`, `smoke-call ok`
- `npm --prefix server run test`: 9 files, 113 tests passed
- `npm run typecheck`: exit 0. `bash scripts/check-preset.sh`: `preset ok`. `test ! -e web/package-lock.json`: passes
- `SKIP_BUILD=1 bash scripts/smoke-local.sh`: `turn unconfigured ok`, `smoke-local ok`
- Redeployed: health `healthy`, `bash scripts/smoke-public.sh` gives `smoke-public ok`, `bash scripts/check-live-db.sh --existing ./data` gives `live-db ok`, playwright-core is absent in the container, the newest `turn_config` line says `configured: true`, and `/debug/call/` answers 200 publicly
- `git diff --quiet HEAD -- server/src/db server/drizzle`: no schema change
- Acceptance greps:
  - `iceTransportPolicy` in peer.ts: 2. `selectedCandidatePairId` in stats.ts: 3. `playsInline` in call-test.tsx: 2. `useSearchParams` in both files: 0.
  - `callVerdict(` in call-test.tsx: 1. `/api/debug/call-report` in call-test.tsx: 1. `call_smoke` in routes.ts: 2.
  - `/debug/call/` in shell.tsx: 1. README heading: 1. `BuildKit` in the Dockerfile: 0.
  - `web/out/debug/call/index.html` exists.
- `bash scripts/check-call-smoke.sh` on the live log: 0 PASS reports, as expected until the UAT runs

## User Setup Required

None beyond the end-of-phase cellular UAT above.

## Next Phase Readiness

- Phase 1 is complete as code. Still pending at end of phase: the cellular UAT (INFR-04 gate) and the 01-03 device UAT, run in one phone session. Phase 3 (calls) waits on `check-call-smoke.sh` printing `call-smoke ok`.
- Phase 3 reuses `web/lib/ws.ts`, `web/lib/rtc/peer.ts` (renegotiation-safe), `stats.ts` and `ice.ts`. The "Call test" menu item can stay as "Diagnostics" or be removed.
- `requirements-completed` lists INFR-03 and INFR-04 because the plan declares both. In REQUIREMENTS.md only INFR-03 is checked off. INFR-04's text requires the cellular proof, so it stays Pending until `check-call-smoke.sh` prints `call-smoke ok`.

## Self-Check: PASSED

- FOUND: web/lib/ws.ts, web/lib/rtc/ice.ts, web/lib/rtc/peer.ts, web/lib/rtc/stats.ts, web/app/debug/call/page.tsx, web/components/app/call-test.tsx, web/components/ui/switch.tsx, web/components/ui/badge.tsx, scripts/smoke-call.sh, scripts/smoke-call.mjs, scripts/check-call-smoke.sh, server/test/call-report.test.ts
- FOUND commits: 5105a28, 5dc683f, 9027fc8, cbbf18d (`git rev-list --count 5ee8509..HEAD` = 4)

---
*Phase: 01-foundation-auth-media-plane*
*Completed: 2026-10-09*
