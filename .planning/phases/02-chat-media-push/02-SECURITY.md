---
phase: "02"
slug: "chat-media-push"
status: verified
# threats_open = count of OPEN threats at or above workflow.security_block_on severity (the blocking gate)
threats_open: 0
asvs_level: 1
created: "2026-10-15"
---

# Phase 02 — Security

> Per-phase security contract: threat register, accepted risks, and audit trail.
> Register merged from the `<threat_model>` blocks of 02-01..02-06 PLAN.md (authored at plan time). T-02-SC appears in every plan and is listed once. block_on: high. ASVS L1, so the evidence is grep-level (the code location or the test that asserts the control).

---

## Trust Boundaries

| Boundary | Description | Data Crossing |
|----------|-------------|---------------|
| browser -> `POST/GET /api/messages`, `GET /api/sync` | Untrusted bodies and query strings from a logged-in client | Message text (high) |
| browser -> `/ws` frames (`ping`, `presence`, `typing`) | Untrusted frames after a cookie-authenticated upgrade, relayed to the other person | Presence/typing state (low) |
| browser -> `PUT /api/messages/:seq/reaction`, `POST /api/read` | Untrusted path params and bodies | Reactions, read cursor (medium) |
| phone localStorage | Unsent text sits on the device | Outbox text (low) |
| server -> Cloudflare edge -> phone | Private message JSON and media cross the CDN | Messages, photos, video, voice (high) |
| browser -> `POST /api/push/subscriptions` | Client hands the server a URL the server later POSTs to | Push endpoint + keys (high, SSRF surface) |
| duet server -> push services (Apple, FCM) | Encrypted previews signed with the VAPID private key | Message previews (high) |
| operator host -> repo env file | deploy/vapid-keys.sh writes the VAPID private key | VAPID private key (high) |
| push service -> service worker | Payload lands on a possibly logged-out lock screen | Message previews (high) |
| browser -> `/api/uploads/*` chunks, `GET /media/:id/:variant` | Untrusted bytes up to 200 MB; private media served back | Photos/video/voice incl. EXIF/GPS (high) |
| server -> sharp / heif-convert / ffmpeg / ffprobe | Untrusted media parsed by native tools | Uploaded bytes (high) |
| browser -> microphone | Voice note capture | Live audio (high) |

---

## Threat Register

| Threat ID | Category | Component | Severity | Disposition | Mitigation | Status |
|-----------|----------|-----------|----------|-------------|------------|--------|
| T-02-01 | Spoofing | POST /api/messages | high | mitigate | `request.user!.id` as sender (server/src/chat/routes.ts:41); strict body schema | closed |
| T-02-02 | Tampering | message id reuse | medium | mitigate | server/src/chat/service.ts:73 `id_conflict` 409; chat.test.ts:92 | closed |
| T-02-03 | Information disclosure | server log | high | mitigate | chat.test.ts:275 "never writes a message body to the log" | closed |
| T-02-04 | Information disclosure | edge caching of chat JSON | medium | mitigate | `Cache-Control: no-store` in server/src/chat/routes.ts:60,71,98,111 | closed |
| T-02-05 | Denial of service | oversized bodies / pages | low | mitigate | MESSAGE_BODY_MAX_CODE_POINTS 4000 (shared/src/chat.ts:11), PAGE_SIZE_MAX (chat.ts:160), WS rate cap closes 1008 (ws/hub.ts:142) | closed |
| T-02-06 | Tampering (XSS) | message text rendering | high | mitigate | no `dangerouslySetInnerHTML`/`innerHTML` anywhere in web/components or web/lib | closed |
| T-02-07 | Spoofing | presence frames | low | accept | see Accepted Risks | closed |
| T-02-08 | Information disclosure | localStorage outbox | low | accept | see Accepted Risks | closed |
| T-02-09 | Spoofing | reaction / read routes | high | mitigate | acting user is always `request.user!.id` (chat/routes.ts:76,101); strict schemas | closed |
| T-02-10 | Tampering | reaction emoji | medium | mitigate | `z.enum(REACTIONS)` (shared/src/chat.ts:56-57); positive-integer `:seq` parser (chat/routes.ts:25) | closed |
| T-02-11 | Information disclosure | read receipts | medium | mitigate | receipts only when visible + focused (web/components/app/chat-view.tsx:321) | closed |
| T-02-12 | Denial of service | typing frames | low | accept | see Accepted Risks | closed |
| T-02-13 | Tampering | replyToSeq | low | mitigate | parent checked in the send transaction, 400 `bad_reply` (chat/service.ts:79) | closed |
| T-02-14 | Information disclosure / SSRF | push subscription endpoint | high | mitigate | `isAllowedPushEndpoint` host allowlist (push/sender.ts:93) enforced in push/routes.ts:58 | closed |
| T-02-15 | Information disclosure | lock-screen previews after logout | high | mitigate | push_subscriptions.session_id `onDelete: cascade` (db/schema.ts:100-102) | closed |
| T-02-16 | Information disclosure | VAPID private key | high | mitigate | `umask 077` + atomic write in deploy/vapid-keys.sh:24; push logs carry code + host only | closed |
| T-02-17 | Spoofing | forged notifications | medium | transfer | VAPID-signed, RFC 8291-encrypted sends via web-push; push services verify the JWT | closed |
| T-02-18 | Denial of service | POST /api/push/test | low | mitigate | rate limit per 1 minute (push/routes.ts:26) | closed |
| T-02-19 | Denial of service | iOS push permission revocation | high | mitigate | sw.js:33 always calls `showNotification`; sw.test.ts:70 covers malformed/empty payloads | closed |
| T-02-20 | Tampering | SW intercepting /media, /api, /ws | medium | mitigate | no `fetch` listener in web/public/sw.js | closed |
| T-02-21 | Information disclosure | GET /media | high | mitigate | `preHandler: requireUser` (media/routes.ts:47); 22-char random ids | closed |
| T-02-22 | Tampering (stored XSS) | serving uploaded bytes | high | mitigate | only regenerated variants served; global `X-Content-Type-Options: nosniff` (http/guards.ts:42) | closed |
| T-02-23 | Tampering (path traversal) | media/uploads paths | high | mitigate | `ATTACHMENT_ID_RE = /^[A-Za-z0-9_-]{22}$/` (media/uploads.ts:27); fixed variant map | closed |
| T-02-24 | Denial of service | chunk uploads | medium | mitigate | `onRequest: requireUser, bodyLimit: UPLOAD_CHUNK_SIZE` (media/uploads.ts:118) | closed |
| T-02-25 | Denial of service | decompression bombs | medium | mitigate | sharp default `limitInputPixels` kept (media/image.ts:30); 100 MB image cap | closed |
| T-02-26 | Information disclosure | photo EXIF/GPS | high | mitigate | media.test.ts:88,95 assert display and thumb have no EXIF | closed |
| T-02-27 | Information disclosure | edge caching of media | medium | mitigate | `Cache-Control: private, …` (media/routes.ts:61); no-store on 404s | closed |
| T-02-28 | Elevation of privilege | attaching uploads | medium | mitigate | 400 `bad_attachment` checks in the send transaction (chat/service.ts:104,108) | closed |
| T-02-29 | Tampering (command injection) | heif-convert/ffmpeg spawns | high | mitigate | `spawn(..., args[], { shell: false })` (media/exec.ts:34-36); timeouts | closed |
| T-02-30 | Information disclosure (SSRF/LFI) | ffmpeg on crafted playlists | high | mitigate | ffprobe `format_name` allowlist + explicit `-f` (media/probe.ts:10-23) | closed |
| T-02-31 | Denial of service | long/heavy transcodes | medium | mitigate | separate slow lane (media/process.ts:18), `nice -n 10`, VIDEO_TIMEOUT_MS 15 min (media/video.ts:8) | closed |
| T-02-32 | Information disclosure | microphone left open | high | mitigate | every track stopped (web/lib/chat/recorder.ts:68); pagehide/hidden interrupt (recorder.ts:118); UAT test 11 confirmed the iOS mic indicator turns off | closed |
| T-02-33 | Denial of service | unlimited voice length (D-11) | low | accept | see Accepted Risks | closed |
| T-02-34 | Tampering | tested vs deployed drift (02-05) | low | mitigate | post-deploy e2e, in-container self-test, smoke-public, live-db (02-05-SUMMARY; UAT test 41) | closed |
| T-02-35 | Tampering (XSS) | message/caption rendering | high | mitigate | same as T-02-06: no raw-HTML rendering in web/components or web/lib | closed |
| T-02-36 | Information disclosure | push_failed reason logging | medium | mitigate | `pushFailureReason` redacts endpoint segments and URLs, capped (push/sender.ts:48-77) | closed |
| T-02-37 | Tampering (log injection) | push error body in logs | low | mitigate | control chars flattened (push/sender.ts:81); pino JSON-escapes | closed |
| T-02-38 | Denial of service | no Topic header, no coalescing | low | accept | see Accepted Risks | closed |
| T-02-39 | Tampering | tested vs deployed drift (02-06) | low | mitigate | post-rebuild health, smoke-public, live-db and in-container greps (02-06-SUMMARY) | closed |
| T-02-SC | Tampering | npm installs | high | mitigate | audit passed for @shadcn/react, web-push, embla; sharp pinned 0.35.4 after the owner's recorded approval (02-03-SUMMARY:72); 02-02/02-05/02-06 install nothing | closed |

*Status: open · closed · open — below high threshold (non-blocking)*
*Severity: critical > high > medium > low — only open threats at or above workflow.security_block_on count toward threats_open*
*Disposition: mitigate (implementation required) · accept (documented risk) · transfer (third-party)*

---

## Accepted Risks Log

| Risk ID | Threat Ref | Rationale | Accepted By | Date |
|---------|------------|-----------|-------------|------|
| AR-02-01 | T-02-07 | A client can only claim that its own user is viewing, which only suppresses that user's own notifications. Two authenticated users. | owner (plan 02-01) | 2026-10-10 |
| AR-02-02 | T-02-08 | The outbox holds only this user's unsent text on their own phone, and it is cleared on logout. | owner (plan 02-01) | 2026-10-10 |
| AR-02-03 | T-02-12 | Typing frames are throttled to one per 3 s on the client, the connection cap is 100 frames/s, and they are relayed only to the other user's sockets. | owner (plan 02-02) | 2026-10-10 |
| AR-02-04 | T-02-33 | Voice length is unlimited by decision D-11. The 200 MB per-upload cap is the only backstop. Two authenticated users. | owner (plan 02-05) | 2026-10-12 |
| AR-02-05 | T-02-38 | Without a Topic header, an offline phone may receive each queued push when it reconnects. The SW closes the previous notification before showing the next, so the user sees one. The volume is tiny. | owner (plan 02-06) | 2026-10-15 |

---

## Security Audit Trail

| Audit Date | Threats Total | Closed | Open | Run By |
|------------|---------------|--------|------|--------|
| 2026-10-15 | 40 | 40 | 0 | /gsd-secure-phase 02 (orchestrator, L1 grep evidence; auditor skipped per short-circuit rule) |

---

## Sign-Off

- [x] All threats have a disposition (mitigate / accept / transfer)
- [x] Accepted risks documented in Accepted Risks Log
- [x] `threats_open: 0` confirmed
- [x] `status: verified` set in frontmatter

**Approval:** verified 2026-10-15
