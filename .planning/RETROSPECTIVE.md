# Project Retrospective

*A living document updated after each milestone. Lessons feed forward into future planning.*

## Milestone: v1.0 — MVP

**Shipped:** 2026-10-19
**Phases:** 3 | **Plans:** 15 | **Tasks:** 43

### What Was Built
- The self-hosted duet app at https://duet.brkn.me: one Fastify process, SQLite, Docker and a Cloudflare Tunnel, plus password login for two seeded accounts and an installable PWA.
- Real-time chat with reactions, replies, typing and receipts. Photos, video clips and voice notes play on both an iPhone and a Pixel. Web push covers messages and calls.
- 1:1 P2P voice/video calls over Cloudflare TURN with push-to-answer, video controls and auto-reconnect.

### What Worked
- Testing the CGNAT assumption early (Phase 1, 2026-10-09). Dropping the SFU for P2P + Cloudflare TURN removed all router, VPS and cert ops before any call code was written.
- Two-browser headless E2E smokes (chat, then 9 → 15 → 18 call scenarios) caught regressions without needing the phones.
- Holding to the 3-phase coarse roadmap. Merging rich media into Phase 2 kept the milestone to 11 days.
- Doing all Cloudflare work (tunnel, DNS, TURN keys) through the API, in scripts that can be re-run.

### What Was Inefficient
- The stack research spent real effort on the SFU / `@sideby-me/rtc` integration contract, which was all thrown away a day later.
- Two plans (01-04, 03-03) ran 7h+ wall-clock while waiting on real-device or cellular UAT.
- Apple's silent change on the Topic header (400 BadWebPushTopic) only showed up in device UAT. Every push from Phase 2 failed on iPhone until a fix plan (02-06).

### Patterns Established
- Shared zod protocol in `@duet/shared`: ClientFrame is strict and ServerFrame is non-strict, so older installed PWAs tolerate newer servers.
- Server-authoritative state for anything realtime (call registry, push suppression via `hub.isViewing`). Client hints only drive toasts.
- Server-side media normalization for everything (WebP / H.264 MP4 / AAC). Originals are kept.

### Key Lessons
1. Check network topology (CGNAT, public IP) before designing a self-hosted media plane.
2. Test push on a real iPhone as soon as push ships. Apple's push service changes behaviour without notice.
3. For two users, P2P + managed TURN beats an SFU on every axis that matters.

### Cost Observations
- Model profile: adaptive
- Notable: most wall-clock time went to waiting on human device UAT, not to execution.

---

## Cross-Milestone Trends

### Process Evolution

| Milestone | Phases | Plans | Key Change |
|-----------|--------|-------|------------|
| v1.0 | 3 | 15 | Coarse MVP roadmap; media plane pivoted mid-phase (SFU → P2P + TURN) |

### Top Lessons (Verified Across Milestones)

1. (Needs a second milestone to cross-validate.)
