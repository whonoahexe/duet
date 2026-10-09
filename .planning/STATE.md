---
gsd_state_version: "1.0"
current_phase: 01
current_phase_name: Foundation, Auth & Media Plane
status: executing
stopped_at: Completed 01-03-PLAN.md
last_updated: "2026-10-09T09:23:17.479Z"
last_activity: 2026-10-09
last_activity_desc: Completed 01-02 password login and rolling session
state_head: ed92aeba8236c494b134c9946b1ca168c4d0e16d
progress:
  total_phases: 3
  completed_phases: 0
  total_plans: 5
  completed_plans: 3
  percent: 60
---

# Project State

## Project Reference

See: .planning/PROJECT.md (updated 2026-10-08)

**Core value:** The two of us can reliably message and call each other — on both phones, including over cellular — on infrastructure we fully control.
**Current focus:** Phase 01 — Foundation, Auth & Media Plane

## Current Position

Phase: 01 (Foundation, Auth & Media Plane) — EXECUTING
Plan: 3 of TBD (app track done; media track must be re-planned)
Status: Needs planning — run `/gsd-plan-phase 01` to add the P2P + Cloudflare TURN media-track plans (INFR-03/04). Do NOT verify or complete Phase 1 before those plans exist and run.
Last activity: 2026-10-09 — Calls switched from self-hosted SFU to P2P WebRTC + Cloudflare TURN (home is CGNAT); SFU plans 01-04/01-05 superseded

Progress: [██████░░░░] 60%

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

### Pending Todos

None yet.

### Blockers/Concerns

- [Phase 1]: Domain resolved: brkn.me (on Cloudflare) — duet.brkn.me via tunnel (live). No sfu./turn. records (SFU dropped 2026-10-09).
- [Phase 1 media]: RESOLVED 2026-10-09 — home is CGNAT, so no home-hosted media; switched to P2P + Cloudflare TURN (D-16). Remaining: re-plan and execute the media track (INFR-03/04). Router changes and the GitHub Packages token are no longer needed.
- [Phase 1]: End-of-phase human UAT still pending: install the PWA on iPhone (Safari) and Pixel (Chrome), stay logged in after force-quit, /signup is not found.
- [Phase 1]: TOTP dropped (password-only); re-running the seed script is the password-reset stopgap until AUTH-06.
- [Phase 2]: Phase 2 is now the largest phase (18 requirements: chat, push, rich media). Expect plan-phase to split it into several plans. Rich-media plans (HEIC/HEVC transcoding, cross-platform voice-note format) need research before planning.

## Deferred Items

Items acknowledged and deferred at milestone close, most recent first:

| Category | Item | Status | Deferred At | Milestone |
|----------|------|--------|-------------|-----------|
| *(none)* | | | | |

## Session Continuity

Last session: 2026-10-09T09:23:17.455Z
Stopped at: Media plane switched to P2P + Cloudflare TURN; next is /gsd-plan-phase 01 (add media-track plans)
Resume file: None
