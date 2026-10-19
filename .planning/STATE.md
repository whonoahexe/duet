---
gsd_state_version: "1.0"
current_phase: 03
status: completed
stopped_at: Phase 03 complete — all phases complete
last_updated: "2026-10-19T08:27:08.385Z"
last_activity: 2026-10-19
last_activity_desc: Phase 03 complete
state_head: af4d0ad37c7b895122674de75b80d33922db10b7
progress:
  total_phases: 3
  completed_phases: 3
  total_plans: 15
  completed_plans: 15
  percent: 100
---

# Project State

## Project Reference

See: .planning/PROJECT.md (updated 2026-10-15)

**Core value:** The two of us can reliably message and call each other — on both phones, including over cellular — on infrastructure we fully control.
**Current focus:** Phase 03 — Voice & Video Calls

## Current Position

Phase: 03
Plan: Not started
Status: All phases complete
Last activity: 2026-10-19 — Phase 03 complete

Progress: [██████████] 100%

## Performance Metrics

**Velocity:**
- Total plans completed: 15
- Average duration: -
- Total execution time: 0.0 hours

**By Phase:**

| Phase | Plans | Total | Avg/Plan |
|-------|-------|-------|----------|
| 02 | 6 | - | - |
| 01 | 5 | - | - |
| 03 | 4 | - | - |

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
| Phase 02 P01 | 50min | 3 tasks | 40 files |
| Phase 02 P02 | 28min | 3 tasks | 22 files |
| Phase 02 P03 | 27min | 3 tasks | 24 files |
| Phase 02 P04 | 21min | 3 tasks | 32 files |
| Phase 02 P05 | 30min | 3 tasks | 25 files |
| Phase 02 P06 | 8min | 3 tasks | 9 files |
| Phase 03 P01 | 23min | 3 tasks | 26 files |
| Phase 03 P02 | 12min | 2 tasks | 17 files |
| Phase 03 P03 | 7h 46m | 3 tasks | 18 files |
| Phase 03 P04 | 16min | 3 tasks | 17 files |

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
- [Phase 02]: 02-01: No react-query; one useSyncExternalStore chat store with mergeMessages (newer updatedSeq always wins, window floor)
- [Phase 02]: 02-01: /api/sync cursor = last returned updatedSeq when hasMore else current max; >500 changes drops cache and reloads latest page
- [Phase 02]: 02-01: Any chat 401 or 4401 resets store+outbox and returns to login; logout stops realtime before POST
- [Phase 02]: 02-01: Bubble width fix: BubbleGroup w-full + wrap-anywhere on BubbleContent (utility classes only, preset files untouched)
- [Phase 02]: 02-02: Each stored bubble is its own controlled PopoverTrigger (data-slot kept as bubble, trigger-press ignored); outbox bubbles get no menu or swipe
- [Phase 02]: 02-02: Typing frames only on composer changes (max 1 per 3 s); indicator TTL 5 s, cleared by their message, also shown in an empty chat
- [Phase 02]: 02-02: Read receipts only when visible+focused and the peer bubble ([data-seq]) intersects the list viewport, debounced 500 ms; cursor forward-only, clamped to newest seq
- [Phase 02]: 02-02: Quote jump is instant: scrollToMessage(group) then re-centre the bubble for 6 frames; older-page autoload pauses while highlightSeq is set
- [Phase 02]: 02-02: aria-live announcement written via ref, not state (fixed React #185 on 150-message bursts in 02-01 ScrollFollower)
- [Phase 02]: 02-03: Push suppression is server-side only (hub.isViewing); the service worker shows a notification for every push and closes old ones first (iOS ignores tag)
- [Phase 02]: 02-03: Push body is cut until the JSON payload is <= 3072 bytes; title capped at 60 graphemes
- [Phase 02]: 02-03: Subscriptions upsert by endpoint bound to the session (logout cascades); SSRF host allowlist FCM/*.push.apple.com/Mozilla/WNS; test push goes to this session only
- [Phase 02]: 02-03: Owner approved sharp@0.35.4 for plan 02-04 (reply: approved)
- [Phase 02]: 02-04: MAX_ALBUM_ITEMS lives in shared/src/chat.ts (media.ts imports chat.ts; the reverse would be an ESM cycle)
- [Phase 02]: 02-04: /media checks the variant file exists first, so a miss is JSON 404 no-store, never 404.html with an immutable header
- [Phase 02]: 02-04: Media processor is a kind->{lane, run} handler map; 02-05 registers video (slow) and audio (fast); tests drive it with app.media pause/resume/idle
- [Phase 02]: 02-04: Own uploads keep their local object URL per attachment id until ready; a failed album retries only items without an attachment id, same message id
- [Phase 02]: 02-04: Deployed: ffmpeg + libheif-examples in the image, container HEIC self-test ok, push_config configured true
- [Phase 02]: 02-05: Video and voice originals are kept after transcode (reversible; delete data/media/<id>/original for ready video/audio to reclaim space); rejected uploads have their bytes deleted
- [Phase 02]: 02-05: ffprobe runs with -protocol_whitelist file and -format_whitelist (allowlisted demuxers only); any probe failure is 422 unsupported_media; ffmpeg gets an explicit -f
- [Phase 02]: 02-05: Transcoded video/voice carry no container metadata (-map_metadata -1), like photos drop EXIF/GPS
- [Phase 02]: 02-05: Voice note = exactly one audio attachment, no body (kind voice); other audio mixes are bad_attachment; no voice length cap (200 MB backstop)
- [Phase 02]: 02-05: Tap under 300 ms, a release during the permission prompt, or a pointercancel continue the recording locked; Send ignores clicks for 400 ms after locking
- [Phase 02]: 02-06: Push requests carry no Topic header for any push service (Apple 400 BadWebPushTopic since mid-Sept 2026); collapse stays on-device via SW close-before-show (D-14)
- [Phase 02]: 02-06: Own sends dispatch duet:scroll-to-latest; ScrollFollower calls scrollToEnd auto now + next frame (re-arms following-bottom)
- [Phase 02]: 02-06: push_failed logs a sanitized reason (Apple identifier codes as-is; else endpoint segments/URLs redacted, control chars flattened, 120-char cap)
- [Phase 03]: 03-01: CallId is lowercase-only z.uuid() so callRoom(id) is always a valid RoomId
- [Phase 03]: 03-01: Only invites that would ring count toward the 10 per 60 s flood limit
- [Phase 03]: 03-01: A ring arriving while this device's own Start tap waits for the mic is answered with that mic (client-side D-14 merge)
- [Phase 03]: 03-01: Callee setup failures send call.decline before Couldn't connect, so the caller never rings on
- [Phase 03]: 03-01: smoke-calls pools one login per session slot (login limit 5 per 5 min per account+IP)
- [Phase 03]: 03-02: call pushes skip only sessions with a visible fresh /ws connection (hub.isSessionViewing, research A1 still flagged); the missed push uses the same rule and the normal 24 h TTL
- [Phase 03]: 03-02: ring-on-attach is the authoritative route to the incoming screen; the SW deep link (/?call=, /?missed=) and open-call postMessage are hints that only drive the Missed call toast
- [Phase 03]: 03-02: one PushSender per app (app.push) shared by pushRoutes and the call registry
- [Phase 03]: 03-03: camera on/off and flip are replaceTrack on the video transceiver negotiated at call start; camera state travels in call.media, relayed only between the two bound connections
- [Phase 03]: 03-03: Mode B needs the peer camera flag AND a decoded frame; camera off releases the track before call.media false is sent
- [Phase 03]: 03-03: CALL_INVITE_LIMIT optional server env (unset = 10) so the 15-scenario smoke-calls run stays under the flood guard
- [Phase 03]: 03-04: Calls recover through call.rejoin (same session only, stale connection evicted from the call room) plus caller-only ICE restarts with rollback; one shared 30 s give-up ends as Call dropped
- [Phase 03]: 03-04: The caller retries the ICE restart every 5 s while disconnected/failed, so a restart offer lost on a live socket never strands the call
- [Phase 03]: 03-04: Poor connection = 2 consecutive 2 s samples with inbound loss > 5% or RTT > 400 ms, off after 3 good; hidden during Reconnecting…

### Pending Todos

None yet.

### Blockers/Concerns

- [Phase 1]: Domain resolved: brkn.me (on Cloudflare) — duet.brkn.me via tunnel (live). No sfu./turn. records (SFU dropped 2026-10-09).
- [Phase 1 media]: RESOLVED 2026-10-09 — home is CGNAT, so no home-hosted media; switched to P2P + Cloudflare TURN (D-16). 01-04 and 01-05 done (TURN mint live, /ws deployed, headless two-peer smoke passes in both modes); remaining: the cellular UAT on real phones, then `bash scripts/check-call-smoke.sh` must print call-smoke ok (INFR-04 stays Pending until then). Router changes and the GitHub Packages token are no longer needed.
- [Phase 1]: End-of-phase human UAT still pending: install the PWA on iPhone (Safari) and Pixel (Chrome), stay logged in after force-quit, /signup is not found.
- [Phase 1]: TOTP dropped (password-only); re-running the seed script is the password-reset stopgap until AUTH-06.
- [Phase 2]: Phase 2 is now the largest phase (18 requirements: chat, push, rich media). Expect plan-phase to split it into several plans. Rich-media plans (HEIC/HEVC transcoding, cross-platform voice-note format) need research before planning.

### Quick Tasks Completed

| # | Description | Date | Commit | Directory |
|---|-------------|------|--------|-----------|
| 261015-vkv | Push notification tweaks: hide message preview, duet logo badge, custom notification sound | 2026-10-15 | 971434a | [261015-vkv-push-notification-tweaks-hide-message-pr](./quick/261015-vkv-push-notification-tweaks-hide-message-pr/) |

## Deferred Items

Items acknowledged and deferred at milestone close, most recent first:

| Category | Item | Status | Deferred At | Milestone |
|----------|------|--------|-------------|-----------|
| *(none)* | | | | |

## Session Continuity

Last session: 2026-10-16T07:17:30.694Z
Stopped at: Phase 03 complete — all phases complete
Resume file: None
