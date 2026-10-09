# Roadmap: duet

## Overview

duet goes from nothing to a private two-person messenger in three coarse phases. Phase 1 stands up a real HTTPS origin on the new domain, the self-hosted app/DB, two-account password login, and an installable PWA on both phones; in parallel, a media-plane track provisions Cloudflare TURN and proves a peer-to-peer WebRTC connection carries media from a phone on cellular (switched from a self-hosted SFU on 2026-10-09: home is CGNAT). Phase 2 delivers the core value: reliable real-time chat with web push, plus photos, video clips and voice notes that play on both an iPhone and a Pixel. Phase 3 adds peer-to-peer voice and video calls with push-to-answer, and only starts once the Phase 1 media smoke test is green.

## Phases

**Phase Numbering:**
- Integer phases (1, 2, 3): Planned milestone work
- Decimal phases (2.1, 2.2): Urgent insertions (marked with INSERTED)

Decimal phases appear between their surrounding integers in numeric order.

- [ ] **Phase 1: Foundation, Auth & Media Plane** - Live HTTPS app on the new domain, two-account password login, installable PWA; media track proves P2P WebRTC + Cloudflare TURN carries media over cellular
- [ ] **Phase 2: Chat, Media & Push** - Reliable real-time chat with history, receipts, typing, reactions and replies; photos, video clips and voice notes on both phones; message push notifications
- [ ] **Phase 3: Voice & Video Calls** - 1:1 peer-to-peer voice/video calls (Cloudflare TURN relay) with push-to-answer, in-call controls and reconnect, on Wi-Fi and cellular

## Phase Details

### Phase 1: Foundation, Auth & Media Plane

**Goal**: Both of us can open duet at its own HTTPS address, log in with a password, and install it to our home screens, and a peer-to-peer WebRTC call path (Cloudflare TURN relay) is proven to carry media from a phone on cellular
**Mode:** mvp
**Depends on**: Nothing (first phase)
**Requirements**: INFR-01, INFR-02, INFR-03, INFR-04, AUTH-01, AUTH-02, AUTH-03, AUTH-04, SHEL-01, SHEL-02
**Success Criteria** (what must be TRUE):
  1. Opening the duet URL on the new domain over HTTPS (Cloudflare Tunnel) shows a login screen built only from shadcn preset `b51GFhBEQ`; app, SQLite DB and media dir run in Docker on this machine and data survives a container restart
  2. Each of the two seeded users can log in by tapping their name and entering their password, a wrong password is rejected (and repeated failures are rate-limited), and there is no sign-up path anywhere in the app
  3. A logged-in user who closes and reopens the installed app days later is still logged in, and can log out explicitly
  4. The app can be added to the home screen on the iPhone (Safari) and the Pixel (Chrome) and launches standalone, without browser chrome
  5. Media track: the duet server mints short-lived Cloudflare TURN credentials for logged-in users, and from a phone on cellular the smoke harness connects peer-to-peer to a second client and reports `bytesReceived > 0`, both with normal ICE and with relay-only TURN forced

**Plans:** 5/5 plans executed. App track 01→02→03 is executed. Media track 04→05 (P2P WebRTC + Cloudflare TURN, INFR-03/INFR-04) is planned. The original SFU plans 01-04/01-05 were superseded on 2026-10-09 and kept in `phases/01-foundation-auth-media-plane/superseded/`; the new plans reuse their IDs. Phase 1 is not complete until 01-04/01-05 have run and the end-of-phase cellular and device UAT passes.

Plans:
**Wave 1**
- [x] 01-01-PLAN.md — Walking skeleton: package gate, preset scaffold + one Fastify process + SQLite (migrations proven live) + seed; login screen lists the two people (wave 1)
- *(original SFU 01-04 superseded 2026-10-09; see superseded/README.md. The ID is reused by the media track in wave 4)*

**Wave 2** *(blocked on Wave 1 completion)*
- [x] 01-02-PLAN.md — Auth slice: tap name → password → chat-shaped shell; rate limit + Origin check; 90-day rolling session; logout menu (wave 2)

**Wave 3** *(blocked on Wave 2 completion)*
- [x] 01-03-PLAN.md — Live at https://duet.brkn.me via Docker + Cloudflare Tunnel with persistent ./data; installable dark PWA; end-of-phase device UAT (wave 3)

**Wave 4** *(blocked on Wave 3 completion)*
- [x] 01-04-PLAN.md — TURN credentials + signaling: Cloudflare TURN key via API, POST /api/rtc/ice-servers (deployed), package gate, authenticated /ws hub with rooms of two (wave 4)

**Wave 5** *(blocked on Wave 4 completion)*
- [x] 01-05-PLAN.md — Call test + proof: /debug/call harness (perfect negotiation, force relay, getStats), headless two-peer smoke in both modes, call_smoke reports, "Call test" menu item, redeploy, cellular UAT checked by check-call-smoke.sh (wave 5)

**UI hint**: yes
**Notes**: INFR-03/INFR-04 are the media track: a Cloudflare TURN key created via the API, server-minted TURN credentials, WS signaling, and a cellular smoke test on real phones. Since D-16 (2026-10-09) it needs no router changes, DNS records or private SDK. Phase 2 does not wait on it; Phase 3 does.

### Phase 2: Chat, Media & Push

**Goal**: We can message each other in real time, reliably, with history kept forever, share photos, short video clips and voice notes that display and play correctly on both an iPhone and a Pixel (visible only to the two of us), and get a push notification when the app is not open
**Mode:** mvp
**Depends on**: Phase 1 (app track: INFR-01/02, AUTH, SHEL-01/02); does not require the ops track to be green
**Requirements**: CHAT-01, CHAT-02, CHAT-03, CHAT-04, CHAT-05, CHAT-06, CHAT-07, CHAT-08, CHAT-09, NOTF-01, NOTF-02, NOTF-03, SHEL-03, MDIA-01, MDIA-02, MDIA-03, MDIA-04, MDIA-05
**Success Criteria** (what must be TRUE):
  1. A message sent from one phone appears on the other in real time; the sender sees sending, sent, read and failed states; each person sees a typing indicator, can react with an emoji and reply to a specific message as a quoted reply; scrolling up loads older history all the way back to the first message
  2. Messages typed while offline are queued and send automatically on reconnect, failed ones can be retried with a tap, no message ever appears twice, and returning to the app after it was backgrounded shows everything missed without a manual refresh
  3. With the app closed or backgrounded, a new message raises a push notification on both the iPhone and the Pixel; tapping it opens the app into the chat, no push arrives while the recipient is actively viewing the chat, and first run on the iPhone walks the user through Add to Home Screen and enabling notifications with a test-push button that delivers a real notification
  4. User can send a photo from the camera or photo library (an iPhone HEIC photo displays correctly on the Pixel, and tapping any image opens it full screen) and a short video clip from either phone (including an iPhone HEVC `.MOV`) that plays on both phones
  5. User can record and send a voice note that the other person plays with a working scrubber on either phone; seeking within videos and voice notes works (Range requests), and media URLs return no content without a logged-in session

**Plans**: TBD
**UI hint**: yes

### Phase 3: Voice & Video Calls

**Goal**: We can call each other by voice or video, peer-to-peer with Cloudflare TURN relay, on Wi-Fi or cellular, with push-to-answer ringing
**Mode:** mvp
**Depends on**: Phase 2 (web push for ringing); Phase 1 media track GREEN (INFR-03/INFR-04: Cloudflare TURN credentials + P2P smoke test passed from cellular)
**Requirements**: CALL-01, CALL-02, CALL-03, CALL-04, CALL-05, CALL-06, CALL-07, CALL-08, CALL-09
**Success Criteria** (what must be TRUE):
  1. From the chat, either person can start a voice call or a video call and both hear (and see) each other, including with one phone on cellular via TURN relay and the other on Wi-Fi
  2. With the recipient's app closed, an incoming-call push arrives; tapping it, or simply opening the app, shows an incoming-call screen with Accept and Decline; an unanswered call stops ringing after a timeout, and the caller can cancel while it rings
  3. During a call, user can mute/unmute, turn the camera on/off, switch between front and back camera, and hang up, and the screen does not lock for the duration of the call
  4. A brief network drop mid-call shows "Reconnecting…" and the call resumes automatically without either person redialing

**Plans**: TBD
**UI hint**: yes

## Progress

**Execution Order:**
Phases execute in numeric order: 1 → 2 → 3. The Phase 1 ops track (INFR-03/04) runs in parallel with Phases 1-2 and must be green before Phase 3 starts.

| Phase | Plans Complete | Status | Completed |
|-------|----------------|--------|-----------|
| 1. Foundation, Auth & Media Plane | 5/5 | In Progress | - |
| 2. Chat, Media & Push | 0/TBD | Not started | - |
| 3. Voice & Video Calls | 0/TBD | Not started | - |
