---
gsd_state_version: "1.0"
current_phase: 01
current_phase_name: Foundation, Auth & Media Plane
status: executing
stopped_at: Completed 01-05-PLAN.md
last_updated: "2026-10-09T21:49:14.860Z"
last_activity: 2026-10-09
last_activity_desc: Completed 01-05 call test harness (headless both modes), deployed; cellular UAT pending
state_head: bad27f5ea56feb3d037dd6719da972dd8494549f
progress:
  total_phases: 3
  completed_phases: 0
  total_plans: 5
  completed_plans: 5
  percent: 0
---

# Project State

## Project Reference

See: .planning/PROJECT.md (updated 2026-10-08)

**Core value:** The two of us can reliably message and call each other — on both phones, including over cellular — on infrastructure we fully control.
**Current focus:** Phase 01 — Foundation, Auth & Media Plane

## Current Position

Phase: 01 (Foundation, Auth & Media Plane) — EXECUTING
Plan: 5 of 5 (all plans executed; end-of-phase UAT pending)
Status: Awaiting end-of-phase UAT (cellular call test INFR-04 + 01-03 device install)
Last activity: 2026-10-09 — Completed 01-05: /debug/call harness + headless smoke (host/host, relay-relay PASS over real Cloudflare TURN), call_smoke reports, "Call test" menu item, redeployed with /ws live; check-call-smoke.sh decides the cellular gate

Progress: [░░░░░░░░░░] 0%

## Performance Metrics

**Velocity:**
- Total plans completed: 0
- Average duration: -
- Total execution time: 0.0 hours

**By Phase:**

| Phase | Plans | Total | Avg/Plan |
|-------|-------|-------|----------|
| - | - | - | - |

**Recent Trend:**
- Last 5 plans: -
- Trend: -

*Updated after each plan completion*
**Per-Plan Metrics:**

| Plan | Duration | Tasks | Files |
|------|----------|-------|-------|
| Phase 01 P01 | 9min | 3 tasks | 65 files |
| Phase 01 P02 | 8min | 3 tasks | 12 files |
| Phase 01 P03 | 12min | 2 tasks | 19 files |
| Phase 01 P04 | 7h 11m | 3 tasks | 20 files |
| Phase 01 P05 | 10min | 3 tasks | 21 files |

## Accumulated Context

### Decisions

Decisions are logged in PROJECT.md Key Decisions table.
Recent decisions affecting current work:

- [Roadmap]: 3 coarse phases (MVP mode). The user capped it at 3. SFU + coturn bring-up and the cellular media smoke test (INFR-03/04) are a parallel, user-gated ops track inside Phase 1; it gates Phase 3 only, not Phase 2.
- [Roadmap]: Rich media (MDIA-01..05) is merged into Phase 2 alongside chat and push. There is no standalone media phase.
- [Roadmap]: SHEL-03 (iOS onboarding + test-push button) lives in Phase 2 alongside web push, not Phase 1.
- [Roadmap]: Calls (Phase 3) come last, after chat/media/push (ringing needs push).
- [Phase 01]: 01-01: Kept next 16.3.8 emitted by the shadcn 4.21.4 template (patch bump within the scaffold pin)
- [Phase 01]: 01-01: forcedTheme=dark alone neutralizes the scaffold d-key hotkey; theme-provider.tsx unchanged
- [Phase 01]: 01-01: Seed keeps the stored hash when the password is unchanged (byte-identical re-runs); length counted in NFC code points
- [Phase 01]: 01-01: Commits land on master as dispatched although git.base-branch flags it protected; consider git.allow_default_branch_commits: true
- [Phase 01]: 01-02: Root setErrorHandler maps FST_ERR_CTP_* to 400 invalid_body and sends @fastify/rate-limit's thrown object with its statusCode (rethrowing it gave 200)
- [Phase 01]: 01-02: Origin guard runs on every non-GET /api/* including 404s; APP_ORIGIN must exactly match the public origin in 01-03 or all login POSTs get 403
- [Phase 01]: 01-02: Logout 401 counts as logged out; other failures toast via a dark Toaster mounted in Shell
- [Phase 01]: 01-03: Docker build stage installs python3/make/g++ because better-sqlite3 13.0.3 has no prebuilt for Node 24.21 (ABI 137); runtime stage has no toolchain
- [Phase 01]: 01-03: Tunnel 'duet' (b338db16) and the duet.brkn.me proxied CNAME are created via the Cloudflare API only (setup.sh, zone-diff guard); ~/.cloudflared untouched
- [Phase 01]: 01-03: Cloudflare zone Browser Cache TTL rewrites /sw.js no-cache to max-age=14400 at the edge; SW registered with updateViaCache none, zone setting left alone (D-01)
- [Phase 01]: 01-03: seed-users.json shredded after the public login round-trip; password reset = interactive seed via docker compose exec -it duet
- [Phase 01]: 2026-10-09 (D-16): Home connection is CGNAT (ONT PPPoE WAN 172.18.28.128 vs egress 103.198.98.196; no public IPv6). User dropped the SFU: calls are 1:1 peer-to-peer WebRTC with Cloudflare TURN relay, TURN credentials minted by the duet server, signaling over duet's WS. No VPS, no router changes, no sfu./turn. DNS, no @sideby-me/rtc SDK. Old 01-04/01-05 plans moved to phases/01-.../superseded/ (history only). The Cloudflare account token (~/.config/duet/cloudflare.ini + cloudflare.env, expires 2026-12-08) is verified to reach /accounts/{id}/calls/turn_keys; user wants all Cloudflare work done via API, never manual.
- [Phase 01]: 01-04: turn-key.sh reads the TURN bearer as .result.key // .result.secret (the live Cloudflare API returns result.secret)
- [Phase 01]: 01-04: ServerFrame is non-strict zod (ClientFrame stays strict) so older installed PWAs tolerate fields a newer server adds
- [Phase 01]: 01-04: /ws authenticates with requireUserNoRenew (no renewal, no cookie) because a 101 cannot carry Set-Cookie; HTTP requests keep the 90-day session rolling
- [Phase 01]: 01-04: The signaling hub addresses connections (connId), not users; a room holds two connections, possibly of the same person
- [Phase 01]: 01-04: injectWS tests need a pong shim and terminate() disconnects (PassThrough pair never finishes a graceful close); graceful close verified over real TCP
- [Phase 01]: 01-05: Forced relay hairpins through Cloudflare from one host (relay-relay passed first try); MA5 relay-all fallback unused, MA6 cookie sharing works without fallback
- [Phase 01]: 01-05: callVerdict lives in @duet/shared (failed > not_relayed > pass on growing bytes, relay required when forced > waiting); call reports go through one stopRun path plus the first PASS
- [Phase 01]: 01-05: INFR-04 cellular gate is decided by scripts/check-call-smoke.sh from call_smoke log lines (two clientIds, one cfIp off the home egress IP, relay-only in forced mode)

### Pending Todos

None yet.

### Blockers/Concerns

- [Phase 1]: Domain resolved: brkn.me (on Cloudflare) — duet.brkn.me via tunnel (live). No sfu./turn. records (SFU dropped 2026-10-09).
- [Phase 1 media]: RESOLVED 2026-10-09 — home is CGNAT, so no home-hosted media; switched to P2P + Cloudflare TURN (D-16). 01-04 and 01-05 done (TURN mint live, /ws deployed, headless two-peer smoke passes in both modes); remaining: the cellular UAT on real phones, then `bash scripts/check-call-smoke.sh` must print call-smoke ok (INFR-04 stays Pending until then). Router changes and the GitHub Packages token are no longer needed.
- [Phase 1]: End-of-phase human UAT still pending: install the PWA on iPhone (Safari) and Pixel (Chrome), stay logged in after force-quit, /signup is not found.
- [Phase 1]: TOTP dropped (password-only); re-running the seed script is the password-reset stopgap until AUTH-06.
- [Phase 2]: Phase 2 is now the largest phase (18 requirements: chat, push, rich media). Expect plan-phase to split it into several plans. Rich-media plans (HEIC/HEVC transcoding, cross-platform voice-note format) need research before planning.

## Deferred Items

Items acknowledged and deferred at milestone close, most recent first:

| Category | Item | Status | Deferred At | Milestone |
|----------|------|--------|-------------|-----------|
| *(none)* | | | | |

## Session Continuity

Last session: 2026-10-09T21:49:14.832Z
Stopped at: Completed 01-05-PLAN.md
Resume file: None
