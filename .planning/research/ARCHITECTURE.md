> **⚠ 2026-10-09: media plane superseded.** Home is CGNAT, so the user dropped the SFU (see `.planning/phases/01-foundation-auth-media-plane/01-CONTEXT.md` D-16). Calls are now 1:1 peer-to-peer WebRTC with Cloudflare TURN, with TURN credentials minted by the duet server and signaling over duet's WebSocket. Anything below about the self-hosted SFU, coturn, `@sideby-me/rtc`, mediasoup-client, SFU join tokens, router port-forwards or sfu./turn. DNS is historical; ignore it when planning. Everything else stands.

# Architecture Research

**Domain:** Self-hosted, 2-user private chat + 1:1 calling PWA, using an existing mediasoup SFU for media
**Researched:** 2026-10-08
**Confidence:** HIGH for the SFU contract, live machine state and component layout (read directly from the SFU source, the sync token minter, the `@sideby-me/rtc` SDK, `docker ps`, `ss`, whois and DNS). MEDIUM for Cloudflare edge limits and iOS push behaviour (web sources, partly checked against official docs).

---

## 0. Blocking Finding: The SFU Cannot Be Reached Right Now

The call architecture depends on `sfu.sideby.me`. As of 2026-10-08 nobody can reach it from anywhere. The roadmap has to treat this as a Phase 0 gate.

| Check | Result | Confidence |
|-------|--------|------------|
| `docker ps -a` on this machine | Only `sideby-staging-{sync,lens,redis}`. **No `sfu`, `coturn` or `nginx-sni` container, and no image for any of them.** | HIGH |
| `ss -tlnp` / `ss -ulnp` on this machine | Nothing on 8443, 44443 (admin), 44444 (RTC), 3478 or 5349. `:443` is bound **only on the Tailscale IP `100.97.55.101`**, which is `tailscale serve`, tailnet-only. No nginx-sni. | HIGH |
| `~/sideby-staging/docker-compose.yml` on this machine | It says so directly: *"the reused PROD SFU (VM-B, wss://sfu.sideby.me) … No staging SFU/coturn is stood up."* | HIGH |
| SFU repo README + `docker-compose.yml` + `deploy-prod.yml` | Deployed to **GCP VM-B** (`35.208.41.166`, us-central1-a, e2-highcpu-2) over SSH. The README says *never* co-locate it with sync/lens. | HIGH |
| Probe of VM-B `35.208.41.166` | ICMP gets no reply. TCP 22, 80, 443, 3478 and 5349 all time out. A control connection to 1.1.1.1:443 from the same shell works. **VM-B is down, stopped, or firewalled off.** | HIGH |
| `whois sideby.me` | **Registry Expiry 2026-08-20. Status: `redemptionPeriod`** (last updated 2026-09-29, registrar Cloudflare). The .me TLD returns **NXDOMAIN** for `sideby.me`, `sfu.sideby.me`, `turn.sideby.me` and `sync-staging.sideby.me`. | HIGH |
| SFU README "Phase-done gates" | *"Status on the deployed GCP topology: **UNPROVEN**. `bytesReceived > 0` has not been observed on GCP on either the direct or forced-relay path."* | HIGH |

**Where the SFU actually runs:** the user said it runs on this machine. It does not. This machine (`cinedise`, a home server on Wi-Fi at `192.168.0.132`, egress IP `103.198.98.196`) runs sideby **staging** (sync + lens), and staging borrows the **prod** SFU on GCP VM-B. That SFU is unreachable today, and its domain has lapsed into redemption.

**Three facts the roadmap must reflect:**
1. **Renew `sideby.me` now.** It is in the redemption period. Restoring a domain from redemption costs a fee through Cloudflare Registrar. Redemption usually lasts about 30 days and the status changed on 2026-09-29, so the window probably closes in late October 2026. After that the domain goes to pending-delete and could be lost. The assumed `duet.sideby.me` hostname depends on this too. *(The exact deadline is MEDIUM confidence. Check the Cloudflare dashboard.)*
2. **Bring VM-B back**, or decide to rebuild the SFU somewhere else (see §8, Option B).
3. **Media flow has never been proven on GCP.** Even after VM-B is back, someone must run the README's two gates before any call UI depends on it: `bytesReceived > 0` across networks, and forced relay over `turns:` on 443.

**Effect on the roadmap:** chat, auth, push and media messages need nothing from the SFU, so they can go first. Calls must wait behind an explicit "media plane green" gate.

---

## 1. Standard Architecture

### System Overview

```
          iPhone (Safari PWA)                         Pixel (Chrome PWA)
   ┌──────────────────────────────┐          ┌──────────────────────────────┐
   │ Next.js static PWA (shadcn)  │          │ Next.js static PWA (shadcn)  │
   │  - chat UI / call UI         │          │                              │
   │  - Service Worker (push,     │          │  same                        │
   │    notificationclick, cache) │          │                              │
   │  - @sideby-me/rtc (mediasoup-│          │                              │
   │    client) for calls         │          │                              │
   └──┬─────────────┬──────────┬──┘          └──────────────────────────────┘
      │HTTPS+WSS    │WSS       │ RTP/SRTP (UDP 44444 / TURN 443)
      │(app origin) │(sfu)     │
      ▼             │          │
 ┌──────────────────┼──────────┼──────────── Cloudflare edge (TLS, WS proxy) ──┐
 │ duet.<domain>    │          │                                              │
 └────────┬─────────┘          │                                              │
          │ Cloudflare Tunnel (outbound from home box, no open ports)         │
 ═════════╪══════════ HOME BOX "cinedise" (Docker) ═════════════════════════  │
          ▼                                                                   │
 ┌───────────────────────────────────────────────────────────────┐            │
 │ duet-server (single Node process, 127.0.0.1:3100)             │            │
 │  ┌──────────┐ ┌───────────┐ ┌──────────┐ ┌───────────────┐    │            │
 │  │ Auth     │ │ Messages  │ │ Uploads/ │ │ Calls         │    │            │
 │  │ pw+TOTP  │ │ API       │ │ Media    │ │ state machine │    │            │
 │  │ sessions │ │ (REST)    │ │ (Range)  │ │ + token mint  │    │            │
 │  └────┬─────┘ └────┬──────┘ └────┬─────┘ └──────┬────────┘    │            │
 │       │      ┌─────┴─────────────┴──────────────┴─────┐       │            │
 │       │      │ Realtime Hub (ws /ws, in-memory)       │       │            │
 │       │      │ fan-out, typing, receipts, call events │       │            │
 │       │      └─────┬──────────────────────────────────┘       │            │
 │       │            │            ┌─────────────────┐           │            │
 │       │            └──────────► │ Push Sender     │──────────────► FCM / Apple Web Push
 │       │                         │ (web-push+VAPID)│           │
 │  static PWA files (Next export) └─────────────────┘           │
 └───────┬───────────────────────────────┬───────────────────────┘
         ▼                               ▼
 ┌──────────────────┐          ┌──────────────────────┐
 │ SQLite (WAL)     │          │ /data/media/…        │
 │ /data/duet.db    │          │ originals + thumbs   │
 └──────────────────┘          └──────────────────────┘
 ═════════════════════════════════════════════════════════════════════════════
                                                                              │
 ═════════ GCP VM-B (separate host, NOT this machine) ═══════════════════════ │
  nginx-sni :443 ──SNI sfu.sideby.me──► sfu WSS :8443 (own TLS)  ◄────────────┘
              └──SNI turn.sideby.me─► coturn turns: :5349
  mediasoup RTC :44444-44445 udp/tcp   coturn relay 49152-65535/udp
  admin :44443 (X-Sfu-Secret) — FIREWALLED, not reachable from home box
```

The key boundary: **duet-server never touches media and never calls the SFU over the network.** It shares one secret with the SFU, `SFU_TOKEN_SECRET`, and uses it to mint HS256 join tokens. Clients take those tokens straight to `wss://sfu.sideby.me`.

### Component Responsibilities

| Component | Owns | Implementation (recommended) |
|-----------|------|------------------------------|
| **PWA client** | All UI (shadcn preset only); optimistic message state; WS client with reconnect and catch-up; call UI; mediasoup consumption | Next.js App Router with `output: 'export'` (static, client-rendered); shadcn preset `b51GFhBEQ`; hand-written or Serwist service worker; `@sideby-me/rtc` for the SFU |
| **Service Worker** | `push` → always `showNotification`; `notificationclick` → focus or open a deep link; app-shell cache | `public/sw.js` (or Serwist), registered from the root layout |
| **duet-server: Auth** | Password (argon2id) + TOTP check; session cookies; WS upgrade auth; login rate limit | Fastify + `@fastify/cookie` + `@fastify/rate-limit`; `@node-rs/argon2`; `otplib` |
| **duet-server: Messages API** | Persist messages, reactions, replies, read state; catch-up queries; idempotency by `clientId` | REST routes over SQLite (Drizzle + better-sqlite3) |
| **duet-server: Uploads/Media** | Stream uploads to disk; size and MIME limits; auth-gated serving with **HTTP Range**; thumbnails/posters | `@fastify/multipart` → `/data/media`; a custom Range route or `@fastify/static` with auth hook |
| **duet-server: Realtime Hub** | `userId → Set<socket>` registry; per-socket visibility; fan-out of persisted events; ephemeral events (typing); call signaling events; heartbeat | `@fastify/websocket` (`ws`) on `/ws`, in-memory, single process |
| **duet-server: Calls** | Call state machine (`ringing → active → ended`, plus missed/declined/cancelled); ring timeout; mints SFU join tokens; call-log system messages | Plain service module; `jose` `SignJWT` HS256 (same as sync's `TokenMinter`) |
| **duet-server: Push Sender** | VAPID keys; per-device subscriptions; decides when to push (recipient not foreground); prunes subscriptions that return 404/410 | `web-push` npm, in-process (not a separate service) |
| **SQLite** | Users, sessions, messages, attachments, reactions, read state, push subscriptions, calls | One file `/data/duet.db`, WAL mode, nightly `.backup` |
| **Media disk** | Binary blobs | `/data/media/YYYY/MM/<uuid>.<ext>` (+ `.thumb.jpg`) on a bind-mounted volume |
| **Ingress** | Public TLS for `duet.<domain>`, WebSocket proxying | **Cloudflare Tunnel** (`cloudflared` container). This is the pattern sideby-staging already uses on this box. |
| **SFU (external, VM-B)** | Rooms, transports, producers/consumers; coturn credentials (inside the join response) | Existing `sfu.sideby.me` 0.9.x. Not modified by duet. |

---

## 2. Recommended Project Structure

One repo, one container image for the app, one compose file.

```
duet/
├── web/                         # Next.js app (shadcn preset), output: 'export'
│   ├── app/
│   │   ├── login/page.tsx       # password + TOTP steps
│   │   ├── chat/page.tsx        # the one conversation
│   │   ├── call/page.tsx        # /call?id=<callId>  (query param: static export has no dynamic SSR)
│   │   ├── settings/page.tsx    # notifications enable, devices, logout
│   │   └── layout.tsx           # SW registration, auth gate (client-side GET /api/me)
│   ├── components/ui/           # shadcn preset components ONLY (locked)
│   ├── components/chat/         # MessageList, Composer, VoiceRecorder, ReactionBar…
│   ├── components/call/         # IncomingCall, CallScreen, CallControls
│   ├── lib/
│   │   ├── api.ts               # fetch wrapper (same-origin, credentials: include)
│   │   ├── realtime.ts          # WS client: reconnect, heartbeat, catch-up cursor
│   │   ├── store.ts             # message/outbox state (Zustand or useSyncExternalStore)
│   │   ├── push.ts              # subscribe/unsubscribe flow
│   │   └── call.ts              # wraps @sideby-me/rtc connect(); call lifecycle client side
│   ├── public/
│   │   ├── manifest.webmanifest
│   │   ├── sw.js                # push + notificationclick + shell cache
│   │   └── icons/
│   └── next.config.ts           # output: 'export'
├── server/
│   ├── src/
│   │   ├── index.ts             # Fastify boot: static(web/out), /api, /ws, /media
│   │   ├── config.ts            # env validation (zod) — fail fast
│   │   ├── db/
│   │   │   ├── schema.ts        # Drizzle schema (single source of truth)
│   │   │   ├── client.ts        # better-sqlite3, WAL, foreign_keys=ON
│   │   │   └── migrations/
│   │   ├── auth/                # password, totp, sessions, requireUser hook, ws-auth
│   │   ├── messages/            # routes + service (insert → publish → push)
│   │   ├── media/               # upload, serve-with-range, thumbnailing
│   │   ├── realtime/
│   │   │   ├── hub.ts           # socket registry + publish(userIds, event)
│   │   │   └── protocol.ts      # zod schemas for every WS frame (shared with web/)
│   │   ├── calls/
│   │   │   ├── service.ts       # state machine + timers
│   │   │   ├── sfu-token.ts     # mintJoinToken + deriveParticipantId (port of sync TokenMinter)
│   │   │   └── routes.ts
│   │   └── push/
│   │       ├── vapid.ts
│   │       └── sender.ts        # notifyMessage(), notifyCall(), prune on 404/410
│   └── scripts/
│       ├── seed-users.ts        # creates the 2 accounts, prints TOTP otpauth:// URIs / QR
│       └── gen-vapid.ts
├── shared/                      # zod schemas + types used by both web and server
│   └── protocol.ts
├── docker-compose.yml           # duet (app) + cloudflared; volumes ./data:/data
├── Dockerfile                   # build web export → copy into server image
└── .env.example                 # SFU_TOKEN_SECRET, SFU_PUBLIC_URL, VAPID_*, SESSION_SECRET…
```

### Structure Rationale

- **`web/` is a static export served by `server/`.** All interactive features (chat, calls, push) run client-side, so SSR adds nothing. A static export gives one origin, one process, and no Next server runtime. That avoids the most common Next.js self-hosting trap: a custom server plus WebSockets, where route handlers and the custom server end up with **two separate copies of the hub singleton** because the bundler duplicates modules.
- **`server/` is a single Fastify process** that owns the DB, the hub, call timers and the push sender. With exactly 2 users, in-process state is correct. Redis, queues and a separate push worker would be pure overhead.
- **`shared/protocol.ts`** holds the zod schemas for every REST body and WS frame, imported by both sides. Contract drift between client and server is the main class of bugs in a hand-rolled realtime protocol, and this prevents it.
- **Acceptable alternative** if the stack researcher insists on Next.js route handlers: a Next.js custom `server.ts` that mounts `ws` on the same HTTP server. In that case the hub **must** live on `globalThis.__duetHub`, and dev HMR upgrades must be forwarded to `app.getUpgradeHandler()`. This is more fragile, so it is not the first choice.

---

## 3. Architectural Patterns

### Pattern 1: Write over HTTP, notify over WebSocket

**What:** Every durable mutation (send message, react, upload, mark read, start/accept/end call) goes through a REST endpoint that writes to SQLite **first** and then calls `hub.publish(...)`. The WS carries server-to-client events plus a few ephemeral client-to-server frames (typing, visibility, heartbeat).

**When to use:** Always, in this app.

**Trade-offs:** About one extra RTT per send compared with sending over the socket. In exchange you get HTTP retry semantics, the clean status codes that iOS needs when the WS is half-dead after backgrounding, and a single write path. Worth it.

```typescript
// server/src/messages/service.ts
export function sendMessage(userId: string, input: SendMessageInput) {
  // idempotent on clientId: a retried POST returns the same row
  const row = db.insert(messages).values({ ...input, senderId: userId })
    .onConflictDoNothing({ target: messages.clientId }).returning().get()
    ?? db.select().from(messages).where(eq(messages.clientId, input.clientId)).get()!;

  hub.publish([userId, peerOf(userId)], { type: 'message.new', message: row });
  if (!hub.isForeground(peerOf(userId))) push.notifyMessage(peerOf(userId), row);
  return row;
}
```

### Pattern 2: One monotonic change cursor for catch-up

**What:** Messages get `seq INTEGER PRIMARY KEY` (the total order). Any later change to a message (reaction, edit, delete) also bumps `messages.updated_seq` from a global counter. On every WS (re)connect the client calls `GET /api/sync?since=<cursor>` and gets back new and changed messages plus the peer's `last_read_seq`.

**When to use:** Mandatory for a PWA. iOS kills the WS whenever the app is backgrounded, so events *will* be missed.

**Trade-offs:** Slightly more schema than "just reload history", but reconnects become correct and cheap.

### Pattern 3: Server-authoritative call state, client-authoritative media

**What:** duet-server owns *whether a call exists and what state it is in* (a `calls` row plus in-memory timers). The SFU owns *media*. Clients bridge the two: they get a token from duet, connect to the SFU, and report hangups to duet. Status changes are atomic conditional updates (`UPDATE calls SET status='active' WHERE id=? AND status='ringing'`). That settles races such as double-accept, accept after cancel, or accept after timeout.

**When to use:** For any call signaling on top of a product-agnostic SFU.

**Trade-offs:** Two sources of truth. You have to reconcile when a client disappears (see §5, "Call lifecycle").

### Pattern 4: Push only when not in the foreground

**What:** Each socket reports `visibility: 'visible' | 'hidden'` (from `document.visibilitychange`). The push sender skips message pushes when the recipient has a visible socket. **Call invites always push**, because a visible socket might be on a different device than the phone.

**Why:** iOS requires every push to show a notification (silent pushes are not allowed). Pushing while the app is open gives duplicate banners.

---

## 4. Data Model (SQLite)

```
users            (id TEXT PK, username UNIQUE, display_name, password_hash, totp_secret_enc,
                  totp_last_step INTEGER, created_at)
sessions         (id TEXT PK /* sha256(token) */, user_id FK, created_at, last_seen_at,
                  expires_at, user_agent)
messages         (seq INTEGER PK AUTOINCREMENT, client_id TEXT UNIQUE, sender_id FK,
                  kind TEXT CHECK(kind IN ('text','image','video','voice','call')),
                  body TEXT, reply_to_seq INTEGER NULL FK, attachment_id TEXT NULL FK,
                  call_id TEXT NULL FK, created_at, updated_seq INTEGER, deleted_at NULL)
attachments      (id TEXT PK, uploader_id FK, mime, size_bytes, path, thumb_path,
                  width, height, duration_ms, created_at)
reactions        (message_seq FK, user_id FK, emoji, created_at,
                  PK(message_seq, user_id))           -- one reaction per user per message
read_state       (user_id PK, last_read_seq INTEGER, updated_at)
push_subscriptions (id PK, user_id FK, endpoint UNIQUE, p256dh, auth, user_agent,
                  created_at, last_ok_at, fail_count)
calls            (id TEXT PK, media_room_id TEXT UNIQUE, caller_id FK, callee_id FK,
                  kind TEXT CHECK(kind IN ('audio','video')),
                  status TEXT CHECK(status IN ('ringing','active','ended','missed',
                                               'declined','cancelled','failed')),
                  created_at, answered_at, ended_at, end_reason)
meta             (key PK, value)                       -- e.g. global change counter
```

There is no `conversations` table: there is exactly one conversation, and making that implicit removes a whole class of authorization code. The authorization rule is simply "the requester is one of the 2 users". Read receipts come from `read_state`: a message from me is "read" when `peer.last_read_seq >= message.seq`.

---

## 5. Data Flow

### Key Flow A: Send a text message

```
Composer ──(clientId=uuid, optimistic "sending")──► POST /api/messages
   │                                                     │ INSERT … ON CONFLICT(client_id) DO NOTHING
   │                                                     ▼
   │                                              hub.publish([me, peer], message.new)
   │                                                     │
   │◄── 201 {seq,…} (status: sent) ──────────────────────┤
   │                                                     ├──► peer sockets (if any) → render
   │                                                     └──► if peer not foreground:
   │                                                          web-push → FCM/APNs-web → SW
   │                                                          → showNotification(tag='chat')
Peer chat visible ──► POST /api/read {upTo: seq} ──► read_state ──► hub → me: receipt.read
```

### Key Flow B: Image / video clip / voice note

```
pick/record → client-side: compress image (canvas), cap video size, poster frame
  → POST /api/uploads (multipart, streamed to /data/media/tmp → fsync → rename)
  → 201 {attachmentId} → POST /api/messages {kind:'image'|'video'|'voice', attachmentId}
  → same as Flow A
View: <img|video|audio src="/media/<id>"> → server checks session cookie
  → serves with Accept-Ranges/206 + Cache-Control: private, max-age=31536000, immutable
```

**Range support is mandatory.** iOS Safari will not play `<video>` or `<audio>` from a server that ignores `Range`. Cloudflare's proxied request body limit is 100 MB on the Free plan (official Cloudflare docs, MEDIUM), so cap uploads well below that (for example 80 MB) or chunk them.

### Key Flow C: Typing indicator

WS frame `typing {state:'start'|'stop'}` → hub relays to the peer's sockets → peer shows the indicator with a 5 s client-side expiry. Never persisted, never pushed.

### Key Flow D: Reconnect / catch-up

```
app foregrounded / network back → WS connect (cookie auth on upgrade)
  → send {type:'hello', visibility}
  → GET /api/sync?since=<lastCursor> → merge into store → flush local outbox (re-POST, idempotent)
heartbeat: client ping every 25 s (Cloudflare drops WS idle ~100 s — MEDIUM confidence)
```

### Key Flow E: Call lifecycle (ring via push → accept → both join SFU → hangup/missed)

```
CALLER (A)                     duet-server                         CALLEE (B)                SFU (VM-B)
   │ POST /api/calls {kind}       │                                    │                         │
   │─────────────────────────────►│ INSERT calls(status=ringing,       │                         │
   │                              │   media_room_id=uuidv4())          │                         │
   │                              │ start ringTimer(45s)               │                         │
   │                              │ hub → B: call.invite ─────────────►│ (if app open: ring UI)  │
   │                              │ web-push → B (urgency=high,        │                         │
   │                              │   TTL=45, tag=call-<id>,           │                         │
   │                              │   data.url=/call?id=<id>) ────────►│ notification            │
   │◄── 201 {callId, sfu:{sfuUrl, │                                    │                         │
   │     token, mediaRoomId,      │ mint token(A)                      │                         │
   │     participantId}}          │                                    │                         │
   │ connect(sfuUrl, token) ──────┼────────────────────────────────────┼────────────────────────►│ join → ensureRoom (lazy)
   │ publish mic(+cam)  (pre-warm; B gets media instantly on join)     │                         │
   │                              │                                    │ tap notification        │
   │                              │                                    │ → SW focus/openWindow   │
   │                              │                                    │ → /call?id=<id>         │
   │                              │◄──────────── GET /api/calls/<id> ──│ (still ringing?)        │
   │                              │◄──── POST /api/calls/<id>/accept ──│ user taps Accept        │
   │                              │ UPDATE … WHERE status='ringing'    │ (user gesture → gUM)    │
   │                              │ cancel ringTimer                   │                         │
   │◄─ hub: call.accepted ────────│── 200 {sfu:{sfuUrl, token(B)…}} ──►│                         │
   │                              │                                    │ connect + publish ─────►│ join; consume A
   │◄═════════════════════════ media via SFU (+TURN if needed) ═══════►│                         │
   │ POST /api/calls/<id>/end ───►│ status=ended, ended_at, reason     │                         │
   │                              │ INSERT messages(kind='call')       │                         │
   │  disconnect() ───────────────┼── hub: call.ended ────────────────►│ disconnect() ──────────►│ peers gone → room
   │                              │                                    │                         │ reclaimed after 30 s
```

**Branches:**

| Event | Server action | Clients |
|-------|---------------|---------|
| Ring timer fires (45 s), still `ringing` | `status=missed`; call-log message; hub `call.missed`; push B "Missed call" (same `tag` so it replaces the ring notification) | A tears down its SFU session |
| B taps Decline | `ringing → declined` | A gets `call.declined` and disconnects |
| A cancels before accept | `ringing → cancelled`; push B "Missed call" with the same tag | B's ring UI closes |
| B opens the app after timeout/cancel | `GET /api/calls/:id` returns a terminal state | Show "Missed call · Call back" |
| Second device of B accepts | Conditional UPDATE fails for the loser → 409 | Loser shows "Answered on another device" |
| Media drops (SFU `participantLeft`, or the `@sideby-me/rtc` `failed` event) | — | SDK auto-reconnects using `getToken()` → `POST /api/calls/:id/token`. If still disconnected after 20 s → client POSTs `/end {reason:'connection_lost'}` |
| Both clients vanish (app killed) | Watchdog: `active` call with no duet-WS heartbeat from either party for 60 s → `ended(failed)` | — |

**Token minting (port sync's `TokenMinter.ts` exactly):**

```typescript
// server/src/calls/sfu-token.ts
import { SignJWT } from 'jose';
import { createHmac } from 'node:crypto';
const key = new TextEncoder().encode(env.SFU_TOKEN_SECRET); // MUST equal the SFU's SFU_TOKEN_SECRET

export const deriveParticipantId = (mediaRoomId: string, userId: string) =>
  createHmac('sha256', env.SFU_PARTICIPANT_SECRET ?? env.SFU_TOKEN_SECRET)
    .update(`${mediaRoomId}:${userId}`).digest('base64url').substring(0, 22);

export async function mintJoin(call: Call, userId: string) {
  const participantId = deriveParticipantId(call.mediaRoomId, userId);
  const token = await new SignJWT({
      mediaRoomId: call.mediaRoomId, participantId,
      canPublish: true, canSubscribe: true, protocolVersion: 1,
    })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt().setNotBefore('0s').setExpirationTime('120s')
    .sign(key);
  // Shape = @sideby-me/rtc-types MediaTokenResponseSchema → feeds the SDK's getToken()
  return { sfuUrl: env.SFU_PUBLIC_URL, mediaRoomId: call.mediaRoomId, participantId, token, canPublish: true };
}
```

**How room provisioning works:**
- **Do not call the admin `POST /rooms`.** The SFU's `handleJoin` calls `ensureRoom(mediaRoomId)` lazily and idempotently on the first join (`src/signaling/handlers.ts`, `src/room-registry.ts`). So provisioning is optional pre-warming. The admin port `44443` is firewalled to VM-B ops only and cannot be reached from the home box. Calling it would mean opening a public SSRF surface for zero benefit. (HIGH: read from source.)
- **Use a fresh `mediaRoomId` (uuidv4) for every call**, never per conversation. The SFU keeps an empty room's Router for `RECONNECT_GRACE_MS` (30 s). Reusing an ID could attach a new call to a stale Router, and `participant_already_active` would reject a fast redial from the same user.
- **Tokens are admission-only.** The SFU checks `exp` only at join time, so a 120 s TTL does not cut off long calls. Re-mint on every (re)connect.
- **`participantId` is deterministic per (room, user).** That intentionally blocks the same user from joining one room from two devices. On a reconnect race the SFU returns `participant_already_active` until the old socket closes, so the client must retry with backoff (the SDK's `fullReconnect` handles this).
- **TURN credentials come from the SFU** in `join:response.iceServers` (HMAC over `TURN_STATIC_AUTH_SECRET`). duet never touches coturn.
- **`PARTICIPANT_CAP`** defaults to 8. A 2-person call is fine without any override.

**Client library:** use **`@sideby-me/rtc` 0.9.0** (in the private `sideby-me/rtc.sideby.me` monorepo, published `restricted` to GitHub Packages). It already wraps the whole mediasoup handshake: `connect({url, token, getToken})`, `publishMic/publishCamera`, `muteMic/muteCamera`, `trackSubscribed`, `reconnecting/reconnected/failed`, plus a `/react` subpath. It pins `mediasoup-client` 3.20.0 to match the SFU's mediasoup 3.20.5. The build needs `NODE_AUTH_TOKEN` with `read:packages`, passed as a Docker BuildKit secret and never as an ARG. Fallback if that is unacceptable: vendor `@sideby-me/rtc-types` schemas and write a ~300-line client on `mediasoup-client`. That costs about a day.

### State Management (client)

```
realtime.ts (WS events) ──┐
api.ts (REST responses) ──┼──► store (messages by seq, outbox by clientId, peer read cursor,
push (SW → postMessage) ──┘          typing flag, activeCall) ──► React components (subscribe)
```

One store, keyed by `seq` for confirmed messages and by `clientId` for pending ones. When the server confirms a send, the pending entry is replaced by `clientId`.

---

## 6. TLS and Ingress for the duet Domain

**The premise needs correcting:** nginx-sni does **not** own :443 on this machine. It runs on VM-B. Here, `:443` is bound only by `tailscale serve` on the tailnet IP, and public ingress for sideby-staging already goes through **Cloudflare Tunnel** (`~/.cloudflared/config-staging.yml` → `sync-staging.sideby.me → http://localhost:3001`). The box is a Wi-Fi home server behind NAT, so inbound :443 would need router port-forwarding, and possibly a non-CGNAT IP (unverified).

**Recommendation: a dedicated Cloudflare named tunnel `duet`**, run as a `cloudflared` service in duet's compose file:

```yaml
# ~/.cloudflared/config-duet.yml (or the compose service equivalent)
tunnel: <duet-tunnel-uuid>
credentials-file: /etc/cloudflared/<uuid>.json
ingress:
  - hostname: duet.sideby.me          # or a new domain if sideby.me can't be restored
    service: http://127.0.0.1:3100    # duet-server; WebSocket upgrade is proxied automatically
  - service: http_status:404
```

- No ports open, no certbot, nothing to coordinate with nginx-sni or Tailscale. This is the same pattern already in use on this box.
- WS works through the tunnel. Keep heartbeats under the ~100 s idle cut-off (MEDIUM).
- **Privacy trade-off (needs a user decision):** Cloudflare's edge terminates TLS, so Cloudflare could technically see message and media plaintext in transit. PROJECT.md accepts "TLS + self-hosting" with no E2EE and only excludes third-party *hosting* of data. A tunnel is transit, not hosting, but it should be an explicit Key Decision. If the user rejects it, the alternatives are: (a) router port-forward 443 → Caddy on the box with an ACME DNS-01 certificate (needs a public, non-CGNAT IPv4); (b) Tailscale on both phones and `tailscale serve`, with no public exposure at all (simplest and most private, but a VPN is always on and the URL is `*.ts.net`).

**When an SNI route would be right:** only if duet were hosted on the same box as nginx-sni and that box had public :443. That would be VM-B (not recommended: the README makes VM-B a dedicated SFU service root, and the data must live on the home box), or the home box under Option B in §8. In that case:

```nginx
map $ssl_preread_server_name $upstream {
    sfu.sideby.me   sfu_wss;
    turn.sideby.me  coturn_tls;
    duet.sideby.me  duet_tls;      # NEW
    default         sfu_wss;
}
upstream duet_tls { server 127.0.0.1:8444; }   # Caddy terminates duet's own TLS here
```

Caddy must get its certificate by **DNS-01** (or HTTP-01 on :80) because :443 is owned by the router. Even on that box, keeping duet on the Cloudflare Tunnel is simpler and avoids touching the SFU's router config.

---

## 7. Integration Points

### External Services

| Service | Integration Pattern | Notes |
|---------|---------------------|-------|
| `sfu.sideby.me` (mediasoup) | Shared `SFU_TOKEN_SECRET`; duet mints HS256 JWTs; **clients** connect via raw WSS | No duet→SFU network call is needed. That secret is shared with sideby prod and staging sync: anyone holding it can mint for any room, so keep it in `.env` only and never in client code. |
| coturn (on the SFU host) | Indirect: credentials arrive in `join:response.iceServers` | Port `stun:/turn:/turns:` all on `:443`. Cellular reliability depends on the README's unproven forced-relay gate. |
| Web Push services (FCM for Chrome, Apple Web Push for iOS) | `web-push` with VAPID (`subject: mailto:`) | iOS: only after Home Screen install (16.4+), permission requested from a user gesture, and `notificationclick` deep links are unreliable when the app is cold (WebKit bug 263687, LOW/MEDIUM). Put the URL in `notification.data`, run `clients.matchAll` + `focus` first, and call `openWindow` once. The app must also check for a pending ringing call on launch (`GET /api/calls/pending`) so it routes to the call even if the deep link is lost. |
| Cloudflare Tunnel | `cloudflared` outbound | 100 MB request body cap (Free). WS idle cut-off of ~100 s. |
| GitHub Packages | Build-time only, for `@sideby-me/rtc` | BuildKit `--secret id=npm,env=NODE_AUTH_TOKEN`. |

### Internal Boundaries

| Boundary | Communication | Notes |
|----------|---------------|-------|
| PWA ↔ duet-server | Same-origin REST (`/api/*`) + WS (`/ws`) + `/media/*`; httpOnly `Secure` `SameSite=Lax` session cookie | WS authenticates with the cookie on upgrade and rejects with 401 before `handleUpgrade`. Long sessions (90 d sliding): re-entering TOTP on a phone PWA is painful. |
| Routes ↔ Realtime Hub | Direct function call `hub.publish(userIds, event)` | Same process. Publish **after** the DB commit, never before. |
| Services ↔ Push Sender | Direct async call, fire-and-forget with logging | Prune a subscription on 404/410; never block the HTTP response on push. |
| Calls ↔ timers | In-memory `setTimeout` per ringing call | On boot, sweep `ringing` rows older than 45 s → `missed` (timers die on restart). |
| PWA ↔ SFU | `@sideby-me/rtc` over `wss://sfu.sideby.me` | Fully independent of the duet WS. A duet WS reconnect must not tear down the call. |
| Service Worker ↔ page | `postMessage` / `clients.matchAll` | The SW hands the deep link to an already-open page instead of opening a second window. |

---

## 8. Media-Plane Recovery Options (Phase 0)

| Option | What | Effort | Risk | Recommendation |
|--------|------|--------|------|----------------|
| **A. Revive VM-B** | Restore `sideby.me` from redemption; start/repair VM-B (check GCP billing and the instance state); confirm `/readiness`; **run both README media gates** from a phone on cellular | Low–medium, mostly user/ops actions | Gates have never passed on GCP (announced-IP / `sfu0` relay-interface issues are documented) | **Do this.** It is the stated constraint and needs no duet code. |
| **B. Run the SFU stack on the home box** | Deploy sfu + coturn + nginx-sni here | High | Needs router port-forwards (TCP 443, UDP 44444+, 3478, relay range), a static or non-CGNAT public IPv4 (`MEDIASOUP_ANNOUNCED_IP` is static and has no auto-detect), and `listen <LAN-IP>:443` to coexist with `tailscale serve` on 100.97.55.101:443. Home upload bandwidth carries all relayed media. | Fallback only, if VM-B is gone for good. |
| **C. New small VPS for the SFU** | Same stack on any VM with a real public IP | Medium | New IP and DNS. The SFU README's "pre-GCP" path (public IP on the NIC) is actually simpler. | Second fallback. |

Write a 50-line **smoke harness** for whichever option is chosen: a script that mints two tokens with duet's `sfu-token.ts`, plus a page that uses `@sideby-me/rtc` to publish and consume while logging `bytesReceived`. It doubles as duet's first call-plumbing code.

---

## 9. Suggested Build Order

```
Phase 0  Media-plane recovery (parallel, user/ops-gated) ───────────────────────┐
         renew sideby.me · revive VM-B · README gates green · smoke harness     │
                                                                                 │
Phase 1  Foundation + auth + deploy                                              │
         repo, shadcn preset, Fastify+SQLite, seed 2 users, pw+TOTP, sessions,   │
         static PWA served by server, manifest+SW installable,                   │
         cloudflared tunnel → real HTTPS URL on both phones                      │
            │                                                                    │
Phase 2  Realtime text chat                                                      │
         messages API + hub + catch-up cursor + outbox, typing, read receipts,   │
         replies, reactions                                                      │
            │                                                                    │
Phase 3  Web push                                                                │
         VAPID, subscribe UX (iOS install gate), message notifications,          │
         notificationclick deep link, foreground suppression                     │
            │                                                                    │
Phase 4  Calls  ◄──── requires Phase 0 GREEN ────────────────────────────────────┘
         calls table + state machine + timers, token mint, @sideby-me/rtc,
         call push (ring), accept/decline/cancel/missed/end, call-log messages
            │
Phase 5  Rich media messages (can swap with Phase 4 if Phase 0 is still red)
         uploads, Range serving, images, video clips, voice notes, thumbnails
            │
Phase 6  Hardening: backups (sqlite .backup + rsync of /data/media), rate limits,
         cellular/relay test matrix on both phones, disk-usage alerting
```

**Ordering rationale:**
- **Deploy in Phase 1, not at the end.** PWA install, service workers, push and `getUserMedia` all require a real HTTPS origin, and iOS behaviour can only be checked on the installed Home Screen app. The tunnel and domain have to exist before almost anything can be verified on the phones.
- **Chat before push.** Push payloads and deep links point at chat state, and the "foreground suppression" rule needs the hub's visibility tracking.
- **Push before calls.** Ringing is a push. A call feature without push only works when both apps are already open.
- **Calls depend on Phase 0**, which is outside the codebase. Phase 0 starts on day one in parallel so it does not end up on the critical path. If it is still red when Phase 3 ends, do Phase 5 (rich media) before Phase 4.
- **Rich media is independent** of calls and push and carries little architectural risk, which makes it the natural buffer phase.

**Research flags for phases:**
- Phase 0: needs ops investigation (GCP VM state, domain restore deadline, why the gates failed). It cannot be planned from the code alone.
- Phase 3: needs deeper research into iOS PWA push (current iOS 26-era behaviour, Declarative Web Push on iOS 18.4+, cold-start deep-link bugs).
- Phase 4: needs `@sideby-me/rtc` API research (reconnect semantics, React hook) and an iOS `getUserMedia` / audio-session check (speaker vs earpiece, autoplay after accept).
- Phase 5: needs research on cross-platform voice note format. iOS MediaRecorder produces `audio/mp4` while Chrome may produce `audio/webm;opus`. Decide between server-side ffmpeg normalization to AAC/m4a and a client-side `audio/mp4` preference.
- Phases 1 and 2: standard patterns, unlikely to need research.

---

## 10. Scaling Considerations

The user count is fixed at 2, so scale is not a concern. What can actually break:

| Concern | Reality for duet |
|---------|------------------|
| Concurrency | Trivial. One Node process, SQLite WAL, in-memory hub. Never add Redis, queues or a second instance: in-memory hub and timers *require* a single instance. |
| **Disk (first bottleneck)** | Media is kept forever. The home box has **~34 GB free of 98 GB** today and is shared with other projects. Video clips at 5–20 MB each add up. Compress client-side, cap clip length, and alert at 80% disk. |
| **Backups (second risk)** | One machine holds everything. Run a nightly `sqlite3 .backup` plus rsync of `/data/media` to another disk or host. Without this, "kept forever" depends on a single SSD. |
| Media egress | Relayed call media runs through coturn on GCP and is billed as egress (README "cost watch"). Two users is negligible. |
| Home uplink | Serving video clips to the peer on cellular uses the home upload bandwidth. Fine at this scale. |

---

## 11. Anti-Patterns

### Anti-Pattern 1: Calling the SFU admin API from duet
**What people do:** POST `/rooms` with `X-Sfu-Secret` before every call, so they open `:44443` to the internet or tunnel to it.
**Why it's wrong:** The README names it the SSRF/abuse surface and firewalls it. It is also unnecessary, because join lazily creates the room.
**Do this instead:** Mint a token with a fresh `mediaRoomId` and let the first join create the room.

### Anti-Pattern 2: Proxying SFU signaling or media through duet-server or the Cloudflare tunnel
**What people do:** Route `wss://duet…/sfu` → SFU so that only one origin exists.
**Why it's wrong:** It adds a hop and a failure point, and Cloudflare Tunnel cannot carry the UDP RTP anyway. The SFU already has its own TLS and SNI routing.
**Do this instead:** Clients connect to `SFU_PUBLIC_URL` directly. Allow it in CSP `connect-src`.

### Anti-Pattern 3: Reusing one `mediaRoomId` per conversation
**Why it's wrong:** Stale Routers within the 30 s grace window, `participant_already_active` on fast redial, and no per-call history.
**Do this instead:** One uuid per call, stored on the `calls` row.

### Anti-Pattern 4: WS-only delivery with no catch-up
**Why it's wrong:** iOS suspends the PWA as soon as it is backgrounded, and events sent during that gap are lost.
**Do this instead:** Persist first, publish second, and sync from a cursor on every reconnect.

### Anti-Pattern 5: Next.js custom server with a module-level hub singleton
**Why it's wrong:** Route handlers (bundled) and `server.ts` (not bundled) get different module instances. `publish` then silently reaches nobody.
**Do this instead:** Static export plus a plain Fastify server (recommended), or `globalThis`-anchored singletons.

### Anti-Pattern 6: Sending push while the recipient has the app open
**Why it's wrong:** Duplicate banners. iOS also penalizes pushes that show no notification, so you cannot "push silently" instead.
**Do this instead:** Track visibility per socket and suppress message pushes when the app is in the foreground. Call pushes are always sent.

### Anti-Pattern 7: Serving media without Range, or from a public unauthenticated path
**Why it's wrong:** iOS will not play the video or audio, and media URLs would leak private photos.
**Do this instead:** Serve `/media/:id` behind a session check, with 206 Range support and `Cache-Control: private`.

---

## Sources

**Primary (read directly, HIGH):**
- `sideby-me/sfu.sideby.me` @ HEAD (via `gh`): `README.md`, `docker-compose.yml`, `nginx-sni.conf`, `.env.example`, `turnserver.conf.example`, `src/signaling/{auth,gateway,handlers}.ts`, `src/room-registry.ts`, `src/http/admin.ts`, `src/contract/schema.ts`, `src/turn/ice-servers.ts`, `dev/e2e-join.ts`, `.github/workflows/deploy-prod.yml`
- `sideby-me/sync.sideby.me` → `src/server/services/TokenMinter.ts` (reference token minter: HS256, 120 s TTL, 22-char HMAC participantId)
- `sideby-me/rtc.sideby.me` → `packages/rtc` (`@sideby-me/rtc` 0.9.0: `ConnectOptions`, `SfuSession`), `packages/rtc-types` (`MediaTokenResponseSchema`)
- Local machine: `docker ps -a`, `ss -tlnp/-ulnp`, `ip addr`, `~/.cloudflared/config-*.yml`, `~/sideby-staging/docker-compose.yml`, `tailscale serve status`, TCP/ICMP probes of `35.208.41.166`, `whois sideby.me`, DoH lookups (cloudflare-dns.com, dns.google)

**Secondary (web, MEDIUM/LOW):**
- [Cloudflare Workers limits: request body 100 MB Free/Pro](https://developers.cloudflare.com/workers/platform/limits) (MEDIUM, official)
- [Cloudflare 413 troubleshooting](https://docs-durable-objects-instance-replaced-errors.previews.developers.cloudflare.com/support/troubleshooting/http-status-codes/4xx-client-error/error-413/index.md) (MEDIUM)
- [websocket.org: Cloudflare WebSockets, ~100 s idle timeout](https://websocket.org/guides/infrastructure/cloudflare/) and [Cloudflare Community: WebSocket timeout](https://community.cloudflare.com/t/cloudflare-websocket-timeout/5865) (LOW–MEDIUM, secondary)
- [WebKit bug 263687: openWindow opens root when PWA closed](https://bugs.webkit.org/show_bug.cgi?id=263687) (MEDIUM)
- [Apple forums: PWA push clients.openWindow issues](https://developer.apple.com/forums/thread/733538), [thread 733604](https://developer.apple.com/forums/thread/733604), [thread 728436](https://developer.apple.com/forums/thread/728436) (LOW)
- [WebKit: Meet Declarative Web Push](https://webkit.org/?p=16535) (MEDIUM)

---
*Architecture research for: self-hosted 2-user chat + calling PWA on an existing mediasoup SFU*
*Researched: 2026-10-08*
