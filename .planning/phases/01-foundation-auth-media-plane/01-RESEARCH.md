> **⚠ 2026-10-09 — partly superseded (D-16 in 01-CONTEXT.md).** The home connection is CGNAT, and the user dropped the SFU. Everything in this file about the self-hosted SFU, coturn, nginx-sni, router port-forwards, sfu./turn.brkn.me DNS/certs, `@sideby-me/rtc`, mediasoup-client and GitHub Packages build secrets is **historical — do not plan from it.** Calls are now 1:1 peer-to-peer WebRTC with Cloudflare TURN (credentials minted by the duet server).
>
> **To plan the media track (INFR-03, INFR-04), read the next section, [Media Track (P2P WebRTC + Cloudflare TURN) — current, 2026-10-09](#media-track-p2p-webrtc--cloudflare-turn--current-2026-10-09). It is self-contained and includes its own Validation Architecture and Security Domain.** The app-track research below it (Fastify, SQLite, auth, Docker, Cloudflare Tunnel, PWA) remains valid, and plans 01-01..01-03 have already executed it. Headings marked *(historical)* below are SFU-era and must not be planned from.

## Media Track (P2P WebRTC + Cloudflare TURN) — current, 2026-10-09

**Researched:** 2026-10-09
**Domain:** Cloudflare Realtime TURN credential minting, WebSocket signaling on the existing Fastify process, 1:1 `RTCPeerConnection` (perfect negotiation), `getStats()` proof, and an iOS/Android PWA call-test harness
**Confidence:** HIGH for the Cloudflare API contract (official docs, with this account's token permissions and reachability probed live), the codebase integration points (files read this session) and `@fastify/websocket` (README and tests read from the 11.3.3 tarball). MEDIUM for iOS standalone-PWA media behaviour, which only real devices can prove.

### Media-track constraints (locked; from 01-CONTEXT.md D-16, CLAUDE.md and user memory)

- **D-16 (verbatim):** "CGNAT confirmed … the user chose to **drop the SFU entirely**: calls become **1:1 peer-to-peer WebRTC** with **Cloudflare TURN** as the relay. The duet server mints short-lived TURN credentials (Cloudflare TURN key created via API with the existing account token, which was verified to reach `/accounts/{id}/calls/turn_keys`); signaling (offer/answer/ICE) rides duet's own WebSocket. No router changes, no VPS, no sfu./turn. DNS records, no `@sideby-me/rtc` SDK, no GitHub Packages build secret."
- **D-12, adapted:** the smoke harness is a hidden, login-gated page inside duet, built only from the locked preset's components. It shows `bytesReceived` and has a **force relay** toggle (`iceTransportPolicy: 'relay'`). Phase 3 reuses the credential endpoint, the WS signaling and the peer wiring. Since there is no SDK, the old `RTCPeerConnection` capture hack is unnecessary: the page owns its `RTCPeerConnection`.
- **D-03:** all hostnames and keys come from env. Never hard-code them.
- **All Cloudflare work goes through the API, never the dashboard** (user memory, and the 01-03 pattern in `deploy/cloudflared/setup.sh`). Never print secrets: the auth header goes in a mode-600 temp file passed with `curl -H @file`.
- **UI:** preset `b51GFhBEQ` only (`base-luma`, Base UI, Phosphor). New components may only arrive through `npx shadcn add`. No lucide and no Radix.
- **Speed first:** the simplest thing that works, and no new infrastructure.
- **Out of scope for Phase 1:** ringing/push-to-answer, call UI polish, call history, reconnect-during-call UX. Those are Phase 3.

### Summary

**There is no infrastructure to build.** Cloudflare Realtime TURN is a managed anycast TURN service. Setup is one API call to create a **TURN key**. It has to be created by API because none exists yet: `GET /accounts/{id}/calls/turn_keys` returned `"result": []` this session. The returned key id and 64-character bearer go into duet's `.env`. After that, the duet server mints per-user credentials with one `POST https://rtc.live.cloudflare.com/v1/turn/keys/{keyId}/credentials/generate-ice-servers {"ttl": N}`. The response is a ready-made `iceServers` array (STUN plus six TURN/TURNS URLs on 3478/443/80/5349) that the browser passes straight into `new RTCPeerConnection({ iceServers })` [CITED: developers.cloudflare.com/realtime/turn/generate-credentials]. The account token is active until 2026-12-08 and includes the **`Calls Write`** and **`Realtime Admin`** permission groups, so creating the key will work [VERIFIED: Cloudflare API `GET /accounts/{id}/tokens/{id}` this session, permission names listed]. From this box, UDP 3478 to `stun.cloudflare.com` and TCP 443/5349 to `turn.cloudflare.com` are open, and the STUN reflexive address came back as `103.198.98.x`, the CGNAT egress [VERIFIED: live probe]. The price is $0.05/GB of egress to the TURN client, with 1,000 GB/month free [CITED: realtime/turn/faq]. That is hundreds of hours of relayed video for two people.

**The server work is small and fits the existing code.** `/ws` does not exist yet: `https://duet.brkn.me/ws` returned 404 to an upgrade probe, and no `ws`/`@fastify/websocket` package is installed. This track adds `@fastify/websocket` 11.3.3 and one `GET /ws` route. The route is authenticated by the existing `duet_session` cookie in a **`preHandler` before the upgrade**, plus an explicit `Origin` check, because the existing Origin guard skips GET. It joins "rooms" that hold at most 2 connections and relays zod-validated `rtc.signal` frames to the other member. Two traps are specific to this codebase:
1. The existing `requireUser` renews the session by re-issuing `Set-Cookie`, and that header is lost on a 101 upgrade response. The WS route therefore needs a **non-renewing** variant, or the 90-day rolling cookie silently stops rolling.
2. Cloudflare drops WebSockets idle for about 100 s, so the hub must ping every ~25 s.

**The client is about 150 lines with no library.** It is the MDN *perfect negotiation* pattern (polite role = string compare of connection ids), `iceTransportPolicy: forceRelay ? 'relay' : 'all'`, and a `getStats()` sampler that reads `inbound-rtp.bytesReceived` and the selected pair via `transport.selectedCandidatePairId`. I proved the stats path in headless Chrome 153 on this box: a fake-media loopback reported `{"bytes":178009,"pairType":"host"}`. The same headless Chrome, driven by `playwright-core`, can run **two logged-in contexts against a local duet with real Cloudflare TURN and forced relay**. That automatically proves INFR-03 and the relay half of INFR-04 from behind this CGNAT before anyone touches a phone. The human step left is one phone on cellular plus a second client, in both modes.

**Primary recommendation:** Three small plans.
- **(a) TURN key + credential endpoint:** an API-only `deploy/cloudflare/turn-key.sh`, then `POST /api/rtc/ice-servers` with a mocked-fetch unit test.
- **(b) WS signaling hub + `/debug/call` harness**, with `injectWS` tests and a headless two-peer forced-relay smoke.
- **(c) Deploy + cellular UAT:** phone on cellular, normal ICE and forced relay, results reported to the server log.

(a) and the hub part of (b) can run in parallel.

<phase_requirements>
#### Phase Requirements (media track)

| ID | Description (REQUIREMENTS.md, revised 2026-10-09) | Research Support |
|----|-----------------------------------------------------|------------------|
| INFR-03 | "TURN relay is provisioned on Cloudflare (TURN key via API) and the duet server mints short-lived TURN credentials for logged-in users only" | §Cloudflare TURN API contract (create key → `uid` + `key` returned **only at creation**; mint via `generate-ice-servers`; TTL ≤ 48 h; revoke → 204). §Pattern M1 (idempotent API-only key script writing `.env`). §Pattern M2 (`POST /api/rtc/ice-servers`, `requireUser` + Origin guard + rate limit, port-53 filter, 503 when unconfigured). §Validation: `turn.test.ts` (mocked Cloudflare), `smoke-call.sh` (real Cloudflare) |
| INFR-04 | "A smoke test proves a peer-to-peer WebRTC connection carries media (`bytesReceived > 0`) between two clients with one phone on cellular, both with normal ICE and with relay-only (forced TURN)" | §Pattern M3 (WS signaling rooms). §Pattern M4 (perfect negotiation). §Pattern M5 (`getStats` gate: `inbound-rtp.bytesReceived` + selected local `candidateType`). §Pattern M6 (`/debug/call` harness with Force relay switch, POST report → `call_smoke` log line). §iOS/Android quirks. §Validation: headless two-peer forced-relay smoke + human cellular UAT |
</phase_requirements>

### What exists today vs. what this track adds (read from the repo this session)

| Fact | Evidence (verbatim) | Consequence |
|------|---------------------|-------------|
| No WebSocket support yet | `server/package.json` dependencies list only `@duet/shared`, `@fastify/cookie`, `@fastify/rate-limit`, `@fastify/static`, `@node-rs/argon2`, `better-sqlite3`, `drizzle-orm`, `fastify`, `jose`, `tsx`, `zod` [VERIFIED: server/package.json:15-25]. Live probe: upgrade to `https://duet.brkn.me/ws` → `404` [VERIFIED: curl this session] | Add `@fastify/websocket` and register it **before** the routes |
| Plugin/route order in `buildApp` | `decorateAuth(app)` / `await app.register(fastifyCookie)` / `await app.register(fastifyRateLimit, { global: false })` / `app.get("/healthz", …)` / `await app.register(usersRoutes)` / `await app.register(authRoutes)` [VERIFIED: server/src/app.ts:51-59] | Insert `await app.register(fastifyWebsocket, { options: { maxPayload: 131072 } })` after the cookie plugin and before the routes. Cookies must be parsed before the WS `preHandler` runs |
| Env allow-list in config | `const keys = ["NODE_ENV", "HOST", "PORT", "DATA_DIR", "WEB_OUT", "APP_ORIGIN", "COOKIE_SECURE", "LOG_LEVEL"] as const` [VERIFIED: server/src/config.ts:43] | New env vars are **silently ignored** unless added to this array **and** to `EnvSchema` |
| Session cookie + renewal | `export const COOKIE_NAME = "duet_session"` [VERIFIED: server/src/auth/session.ts:8]. Renewal branch: `if (now - row.lastSeenAt.getTime() > RENEW_AFTER_MS) {` … `setSessionCookie(reply, token, config)` [VERIFIED: server/src/auth/session.ts:129-137] | On a WS upgrade the `Set-Cookie` is lost, but the DB row is still advanced (Pitfall M1). Use a non-renewing check for `/ws` |
| Origin guard skips GET | `if (!SAFE_METHODS.has(request.method) && isApiUrl(request.url) && request.headers.origin !== config.APP_ORIGIN) {` [VERIFIED: server/src/http/guards.ts:16] | The WS upgrade is a GET to `/ws` (not `/api`), so the global guard never covers it. Check `Origin` in the WS `preHandler` (CSWSH) |
| Client IP behind the tunnel | `const ip = headerValue(request.headers["cf-connecting-ip"]) ?? request.ip` [VERIFIED: server/src/auth/routes.ts:26] | Reuse for rate-limit keys and for the smoke report's client IP (which proves the phone was off the home network) |
| Logout route | `app.post("/api/logout", { preHandler: requireUser }, async (request, reply) => {` [VERIFIED: server/src/auth/routes.ts:78] | Hook point for `hub.closeSession(request.session.id)` |
| Secrets reach the container | `env_file: .env` [VERIFIED: compose.yaml:8]; no published port (comment at compose.yaml:15) | Put `CF_TURN_KEY_ID` / `CF_TURN_KEY_API_TOKEN` in the repo's gitignored `.env`. Redeploy with `docker compose up -d --build` |
| Dev proxy covers `/api` only | `return [{ source: "/api/:path*", destination: "http://localhost:3100/api/:path*" }]` [VERIFIED: web/next.config.ts:16] | In `next dev` the WS URL must be `ws://localhost:3100/ws`. In production it is same-origin `wss://<host>/ws` |
| Preset descriptor | `"style": "base-luma",` / `"iconLibrary": "phosphor",` [VERIFIED: web/components.json:3,13]. Installed UI: avatar, button, card, dropdown-menu, empty, field, input, item, label, separator, sonner, spinner [VERIFIED: ls web/components/ui] | Add `switch` and `badge` via the CLI (both exist as `registry/base-luma/ui/{switch,badge}.tsx` [VERIFIED: `npx shadcn@4.21.4 view switch badge`]) |
| Zone WebSockets | `{"success": true, "value": "on"}` for zone `brkn.me` `settings/websockets` [VERIFIED: Cloudflare API this session] | `wss://duet.brkn.me/ws` will pass through the tunnel with no zone change |

### Architectural Responsibility Map (media track)

| Capability | Primary Tier | Secondary Tier | Rationale |
|------------|-------------|----------------|-----------|
| TURN key creation (one-time) | Host ops script → Cloudflare API | — | Uses the broad account token, which never enters the container |
| TURN credential minting | API / Backend (`POST /api/rtc/ice-servers`) | Cloudflare `rtc.live.cloudflare.com` | The TURN key bearer is a long-term secret and must stay server-side [CITED: generate-credentials] |
| Signaling relay (offer/answer/ICE) | API / Backend (`GET /ws`, in-memory hub) | — | Auth on upgrade. The server only validates size and shape and forwards; it never interprets SDP |
| Negotiation, ICE policy, media capture/render | Browser | — | `RTCPeerConnection`, `getUserMedia` and `<video>` exist only in the client |
| Media transport | Browser ↔ Browser (direct) or ↔ Cloudflare TURN (relay) | — | duet's server never carries media. DTLS-SRTP is end-to-end through TURN [CITED: turn/faq] |
| Proof metrics (`bytesReceived`, candidate type) | Browser (`getStats`) | API (`/api/debug/call-report` → server log) | The phone displays PASS; the server log gives Claude an untranscribed record |
| Page gating for `/debug/call` | Browser (UX only) | API (real enforcement: ice-servers and `/ws` return 401) | The static export can't gate HTML (same rule as the app track) |

### Standard Stack (media track additions only)

| Library | Version | Where | Purpose | Why |
|---------|---------|-------|---------|-----|
| `@fastify/websocket` | **11.3.3** (published 2026-10-03) | `server` dependency | `GET /ws` upgrade on the existing Fastify process | Official Fastify plugin. Its hooks (`onRequest`/`preValidation`/`preHandler`) run before the upgrade and can reply 401. `injectWS` supports socket-free tests [VERIFIED: README + test/inject.test.js:133 in the npm tarball]. 11.3.2 fixed "handle socket errors during upgrade hooks" and 11.3.3 fixed route typing [VERIFIED: GitHub releases]. Pulls in `ws ^8.16.0` (8.22.0 current) |
| `playwright-core` | **1.62.1** (published 2026-07-30) | root `devDependencies` | Headless two-peer smoke driving the **system** Chrome (`/usr/bin/google-chrome` 153), so there is no browser download | This exact Playwright version drove Chrome 153 with fake media on this box this session [VERIFIED: executed]. No `postinstall` script [VERIFIED: npm view] |
| shadcn `switch`, `badge` | via `npx shadcn@4.21.4 add switch badge` (in `web/`) | `web/components/ui` | Force-relay toggle; PASS/candidate-type chips | Preset-native (`base-luma`) [VERIFIED: shadcn view] |
| *(none)* | — | — | Cloudflare calls use Node 24's global `fetch`; WebRTC, `getUserMedia` and `getStats` are browser built-ins | Don't add a WebRTC helper library (simple-peer, PeerJS, etc.); see Don't Hand-Roll |

**Not used:** `@sideby-me/rtc`, `mediasoup-client`, `jose` for media (jose stays installed but is unused by this track), coturn, Socket.IO.

**Installation:**
```bash
npm install -w server @fastify/websocket@11.3.3
npm install -D playwright-core@1.62.1          # root devDependency; npm prune --omit=dev drops it from the image
(cd web && npx shadcn@4.21.4 add switch badge) # then: rm -f web/package-lock.json; rm -rf web/node_modules; npm install (Pitfall 1 of the app track)
```

### Package Legitimacy Audit (media track)

| Package | Registry | Age (latest) | Downloads | Source Repo | Verdict (seam) | Disposition |
|---------|----------|--------------|-----------|-------------|----------------|-------------|
| `@fastify/websocket` | npm | 11.3.3: 6 days | ~2.5M/wk | github.com/fastify/fastify-websocket | SUS (`too-new` only) | **Flagged.** The planner adds a `checkpoint:human-verify` package gate, as 01-01 did. Low real risk: official Fastify org, no postinstall, release notes read. Pinning 11.3.1 (21 days) is the fallback if the user rejects a 6-day-old release, but it lacks the upgrade-hook socket-error fix |
| `playwright-core` | npm | latest 1.64.0: 2 days; **recommended pin 1.62.1: ~10 weeks** | ~121M/wk | github.com/microsoft/playwright | SUS (`too-new`, judged on latest) | **Flagged.** Same human gate. Pin 1.62.1, the version executed this session |
| `ws` (transitive) | npm | 8.22.0: 13 days | ~283M/wk | github.com/websockets/ws | SUS (`too-new`) | Transitive via `@fastify/websocket` (`^8.16.0`). Covered by the same gate, and the lockfile pins it |

**Packages removed due to [SLOP]:** none. **Packages flagged [SUS]:** `@fastify/websocket`, `playwright-core` (and transitive `ws`). Each is flagged only for publish recency, with no postinstall scripts. The planner must put one `checkpoint:human-verify` package gate before the installs.

### Cloudflare TURN API contract

| Item | Value | Tag |
|------|-------|-----|
| Create key | `POST https://api.cloudflare.com/client/v4/accounts/{account_id}/calls/turn_keys` body `{"name": "duet"}` → `result: { uid (32 chars), key (64-char bearer), name, created, modified }` | [CITED: developers.cloudflare.com/api/resources/calls/subresources/turn/methods/create] |
| **`key` is returned only by create** | List (`GET …/turn_keys`) and get (`GET …/turn_keys/{key_id}`) return `created, modified, name, uid`, and **no `key`** | [CITED: api/resources/calls/subresources/turn] |
| Other key ops | `PUT …/turn_keys/{key_id}` (update name), `DELETE …/turn_keys/{key_id}` | [CITED: same] |
| Permission | `Calls Write`. This token has `Calls Write`, `Calls Read`, `Realtime Admin`, and `Realtime Read` | [CITED] + [VERIFIED: token policies read via API] |
| Existing keys | none (`"result": []`) | [VERIFIED: API this session] |
| Mint credentials | `POST https://rtc.live.cloudflare.com/v1/turn/keys/{uid}/credentials/generate-ice-servers`, headers `Authorization: Bearer {key}`, `Content-Type: application/json`, body `{"ttl": 86400}` → **201** | [CITED: realtime/turn/generate-credentials, updated 2026-09-25] |
| Mint response (verbatim URLs) | `{"iceServers":[{"urls":["stun:stun.cloudflare.com:3478"]},{"urls":["turn:turn.cloudflare.com:3478?transport=udp","turn:turn.cloudflare.com:443?transport=udp","turn:turn.cloudflare.com:3478?transport=tcp","turn:turn.cloudflare.com:80?transport=tcp","turns:turn.cloudflare.com:5349?transport=tcp","turns:turn.cloudflare.com:443?transport=tcp"],"username":"…","credential":"…"}]}` | [CITED: same] |
| Port 53 | "The alternate port 53 is known to be blocked by web browsers … you might want to filter out the URL with port 53". The doc example has no `:53` URL, but the note implies real responses may include one. **Filter it server-side** | [CITED: same]. Whether a live response contains `:53`: [ASSUMED] |
| Unknown key | `POST …/keys/000…/credentials/generate-ice-servers` → `404 {"error":"cannot find specified key"}` | [VERIFIED: curl this session] |
| TTL | Max 48 h ("You can set a expiration time for a credential up to 48 hours in the future"). Refresh mid-call with `RTCPeerConnection.setConfiguration()`. If it expires during use: billing stops, then disconnect "after a short delay" | [CITED: realtime/turn/faq] |
| Revoke | `POST https://rtc.live.cloudflare.com/v1/turn/keys/{uid}/credentials/{username}/revoke` → 204 | [CITED: generate-credentials] |
| `customIdentifier` | Documented only on `POST …/credentials/generate` (`{"ttl": 864000, "customIdentifier": "user4523958"}`), for per-user analytics. Not needed for 2 users. Whether `generate-ice-servers` accepts it: undocumented | [CITED: realtime/turn/replacing-existing]. [ASSUMED] for generate-ice-servers |
| Ports/transports | STUN 3478/udp. TURN UDP 3478 (alt 443). TURN TCP 3478 (alt 80). TURN TLS 5349 (alt 443). Anycast to the nearest PoP | [CITED: realtime/turn] |
| Relay behaviour | Relay addresses are IPv4 only (clients may reach TURN over IPv6). No TCP relaying (RFC 6062). CreatePermission is denied for private/loopback ranges | [CITED: turn/faq] |
| Pricing | $0.05/GB of Cloudflare → TURN-client egress, including TURN overhead. **1,000 GB/month free**, shared with SFU. STUN free. Ingress free | [CITED: turn/faq, realtime/pricing] |
| Limits | Per allocation: ~5–10 kpps, ~50–100 Mbps, >5 new unique IPs/s → drops. Up to 1,000 TURN keys per account; unlimited credentials per key | [CITED: realtime/turn, replacing-existing] |
| Reachability from this box | UDP 3478 STUN → srflx `103.198.98.x`. TCP 443 and 5349 to `turn.cloudflare.com` (141.101.90.1) open. `rtc.live.cloudflare.com:443` reachable | [VERIFIED: probes this session] |
| Account-token expiry (2026-12-08) | Doesn't affect calls: the server only uses the TURN key's own bearer. The account token is only needed to create, rotate or delete keys | [VERIFIED: token `expires_on` via API]. TURN-key non-expiry: [ASSUMED] (no expiry field in the create response) |

### System Architecture Diagram

```
 Phone A (cellular, PWA)                           duet server (Docker, behind CF Tunnel)                 Client B (Wi-Fi / phone / laptop)
 ─────────────────────                             ───────────────────────────────────────                 ─────────────────────────────────
 tap Start ──► getUserMedia(a+v)
           ──► POST /api/rtc/ice-servers ───────►  requireUser + Origin guard + rate limit
                                                    └─► POST rtc.live.cloudflare.com/.../generate-ice-servers {ttl}
                                                         (Bearer = TURN key; 201 iceServers) ── filter :53 ──┐
           ◄── { iceServers, ttlSeconds } ◄────────────────────────────────────────────────────────────────┘
           ──► wss://duet.brkn.me/ws  (cookie) ──►  preHandler: session (no renew) + Origin == APP_ORIGIN
           ◄── hello {connId}                        hub: conns{connId→user,session,socket}, rooms{room→≤2 connIds}
           ──► room.join "debug" ──────────────────► room has B? ──► A: room.joined{peers:[B]}   B: room.peer-joined{A}
 new RTCPeerConnection({iceServers,                                                                       new RTCPeerConnection(...)
   iceTransportPolicy: relay? 'relay':'all'})                                                             addTrack(...)
 addTrack → negotiationneeded → offer ──rtc.signal──► forward to the other member only ──rtc.signal──► perfect negotiation
           ◄──────────── answer / ICE candidates (trickle) ◄── forward ◄──────────────────────────────────┘
 ICE: host / srflx (stun.cloudflare.com) / relay (turn.cloudflare.com)  ═══ DTLS-SRTP media ═══►  direct, or via Cloudflare TURN
 every 1 s: pc.getStats() → inbound-rtp.bytesReceived, transport.selectedCandidatePairId → local/remote candidateType
 PASS (connected && bytes>0 && (!relay || local==relay)) ──► POST /api/debug/call-report ──► log {evt:"call_smoke", cfIp, ua, ...}
```

### Recommended file layout (new files only)

```
deploy/cloudflare/turn-key.sh        # API-only, idempotent: create/verify TURN key → .env (CF_TURN_KEY_ID, CF_TURN_KEY_API_TOKEN)
shared/src/rtc.ts                    # IceServer, IceServersResponse, CallReport (zod)
shared/src/ws.ts                     # ClientFrame / ServerFrame discriminated unions, SignalData, RoomId
server/src/rtc/turn.ts               # mintIceServers(deps) — pure, fetch injected
server/src/rtc/routes.ts             # POST /api/rtc/ice-servers, POST /api/debug/call-report
server/src/ws/hub.ts                 # in-memory conns + rooms(≤2) + relay + heartbeat + closeSession()
server/src/ws/routes.ts              # GET /ws { websocket: true, preHandler: requireUserNoRenew + originCheck }
server/test/turn.test.ts             # mocked Cloudflare fetch
server/test/ws.test.ts               # injectWS: auth, origin, rooms, relay, full, bad frames, close
web/lib/ws.ts                        # SignalingClient (same-origin wss / dev ws://localhost:3100/ws, typed frames)
web/lib/rtc/ice.ts                   # fetchIceServers() → apiPost('/api/rtc/ice-servers')
web/lib/rtc/peer.ts                  # createPeer({...}) — perfect negotiation, forceRelay, restartIce on failed
web/lib/rtc/stats.ts                 # sampleCall(pc) → { inboundBytes, localType, remoteType, relayProtocol, rttMs, state }
web/app/debug/call/page.tsx          # thin 'use client' page → <CallTest/>
web/components/app/call-test.tsx     # harness UI from preset components
scripts/smoke-call.sh                # local server + fixture users + real TURN env → node scripts/smoke-call.mjs
scripts/smoke-call.mjs               # playwright-core + /usr/bin/google-chrome, 2 contexts, fake media, relay=1
```
Edits: `server/src/app.ts` (register the plugin, hub and routes), `server/src/config.ts` (new env keys), `server/src/auth/session.ts` (extract the non-renewing check), `server/src/auth/routes.ts` (logout closes sockets), `.env.example` (key names only), `web/components/app/shell.tsx` (a "Call test" menu item, see Pitfall M6), `scripts/smoke-public.sh` (`/ws` without a cookie → 401), `README.md`.

### Pattern M1: TURN key provisioning, API-only and idempotent (INFR-03)

Follow `deploy/cloudflared/setup.sh`: token from `~/.config/duet/cloudflare.ini`, account from `cloudflare.env` `CF_ACCOUNT_ID`, auth header in a mode-600 temp file, `cf()` helper that dies unless `success == true`.

```bash
# deploy/cloudflare/turn-key.sh  (sketch; reuse setup.sh's token/header/cf() preamble verbatim)
NAME="${DUET_TURN_KEY_NAME:-duet}"
ENV_FILE="$ROOT/.env"
have_id="$(sed -n 's/^CF_TURN_KEY_ID=//p' "$ENV_FILE" | tail -n1)"
have_tok="$(sed -n 's/^CF_TURN_KEY_API_TOKEN=//p' "$ENV_FILE" | tail -n1)"
keys="$(cf GET "/accounts/$ACCOUNT/calls/turn_keys")"
if [ -n "$have_id" ] && [ -n "$have_tok" ] && echo "$keys" | jq -e --arg u "$have_id" '.result[] | select(.uid==$u)' >/dev/null; then
  : # reuse
else
  created="$(cf POST "/accounts/$ACCOUNT/calls/turn_keys" "$(jq -cn --arg n "$NAME" '{name:$n}')")"
  have_id="$(echo "$created" | jq -r .result.uid)"; have_tok="$(echo "$created" | jq -r .result.key)"
  # write both lines into .env atomically (umask 077 temp file + mv), replacing old lines; NEVER echo
  # optionally DELETE stale keys named $NAME whose uid != have_id (their bearer is unrecoverable anyway)
fi
# verify: mint a 60 s credential with the TURN bearer (header file, not argv) → expect HTTP 201 and ≥1 turn: URL
printf 'Authorization: Bearer %s\n' "$have_tok" > "$work/turn.hdr"
code="$(curl -sS -o "$work/ice.json" -w '%{http_code}' -X POST -H @"$work/turn.hdr" -H 'Content-Type: application/json' \
  --data '{"ttl":60}' "https://rtc.live.cloudflare.com/v1/turn/keys/$have_id/credentials/generate-ice-servers")"
[ "$code" = 201 ] && jq -e '[.iceServers[].urls[]?] | map(select(startswith("turn"))) | length > 0' "$work/ice.json" >/dev/null || die "mint check failed ($code)"
echo "turn-key ok"
```
- The `key` can't be read back later [CITED]. If `.env` loses it, the script must create a new key (and may delete the stale one). Re-running with a healthy `.env` is a no-op plus a mint check.
- Accept 200 or 201 from the mint check (the docs say 201).
- Agent tooling here blocks reading `.env` with a secret-read hook (observed this session). Executors must verify through the script's own `turn-key ok` and through `smoke-call.sh`, never by cat-ing `.env`.

### Pattern M2: Credential endpoint `POST /api/rtc/ice-servers` (INFR-03)

- **POST, not GET:** the existing Origin guard covers it automatically, it is a side-effecting mint, and the response must never be cached. Set `Cache-Control: no-store`.
- `preHandler: requireUser`. Rate limit with `config.rateLimit { max: 30, timeWindow: "1 minute", keyGenerator: CF-Connecting-IP }`, which stops a client loop from burning credentials.
- If unconfigured (no key id or token): `503 {error:"turn_unconfigured"}`. If Cloudflare fails or times out (5 s): `502 {error:"turn_unavailable"}`. **Never fall back to STUN-only.** A silent fallback would let the smoke "pass" without TURN.
- TTL from `TURN_CREDENTIAL_TTL_SECONDS` (default **86400**, zod `.max(172800)`). That covers an overnight call. Calls longer than that refresh with `setConfiguration()` in Phase 3.
- Don't log `username`/`credential`. Log only `{evt:"turn_mint", userId, ok}`.

```ts
// server/src/rtc/turn.ts
import { z } from "zod"
const CfIce = z.object({ iceServers: z.array(z.object({
  urls: z.union([z.string(), z.array(z.string())]),
  username: z.string().optional(), credential: z.string().optional(),
})).min(1) })
export class TurnError extends Error { constructor(readonly code: "turn_unconfigured" | "turn_unavailable") { super(code) } }
export interface TurnDeps { fetch: typeof fetch; apiBase: string; keyId?: string; apiToken?: string; ttlSeconds: number }

export async function mintIceServers(d: TurnDeps) {
  if (!d.keyId || !d.apiToken) throw new TurnError("turn_unconfigured")
  let res: Response
  try {
    res = await d.fetch(`${d.apiBase}/v1/turn/keys/${encodeURIComponent(d.keyId)}/credentials/generate-ice-servers`, {
      method: "POST",
      headers: { Authorization: `Bearer ${d.apiToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ ttl: d.ttlSeconds }),
      signal: AbortSignal.timeout(5000),
    })
  } catch { throw new TurnError("turn_unavailable") }
  if (!res.ok) throw new TurnError("turn_unavailable")
  const parsed = CfIce.safeParse(await res.json().catch(() => null))
  if (!parsed.success) throw new TurnError("turn_unavailable")
  const iceServers = parsed.data.iceServers
    .map((s) => ({ ...s, urls: (Array.isArray(s.urls) ? s.urls : [s.urls]).filter((u) => !/:53(\?|$)/.test(u)) }))
    .filter((s) => s.urls.length > 0)
  return { iceServers, ttlSeconds: d.ttlSeconds }
}
```
Inject `fetch` and `apiBase` through `buildApp(config, deps?)` (default `globalThis.fetch` and `config.CF_TURN_API_BASE`, which defaults to `https://rtc.live.cloudflare.com`). Tests then pass a fake fetch with no network and no global stubbing.

**New env (add to `EnvSchema` *and* the `keys` array at config.ts:43):** `CF_TURN_KEY_ID` (optional string), `CF_TURN_KEY_API_TOKEN` (optional string), `TURN_CREDENTIAL_TTL_SECONDS` (coerce int, 60..172800, default 86400), `CF_TURN_API_BASE` (url, default above). Keep the TURN vars **optional** so the app track still boots without them, and log one `warn` at boot when they are missing. Add the key **names** (no values) to `.env.example`.

### Pattern M3: WS signaling hub on the existing Fastify process (INFR-04, reused by Phase 3)

```ts
// server/src/ws/routes.ts (shape)
app.get("/ws", {
  websocket: true,
  preHandler: [requireUserNoRenew, wsOriginCheck],   // both run BEFORE the 101; a 401/403 reply aborts the upgrade
}, (socket, request) => hub.attach(socket, request.user!, request.session!.id))
// wsOriginCheck: if (request.headers.origin !== app.config.APP_ORIGIN) return reply.code(403).send({ error: "bad_origin" })
```
- **Rooms of ≤ 2 connections, keyed by a client-chosen `RoomId` (`/^[a-z0-9-]{1,64}$/`).** Any authenticated connection may join, including two connections of the **same** user. The owner can then run the cellular test alone (phone + laptop). A third join gets `room.full`. In Phase 3 the room id becomes the call id and invite/accept frames are added on top. The relay primitive doesn't change.
- **Frames (shared/src/ws.ts, zod discriminated union on `t`):**
  - Client → server: `room.join {room}`, `room.leave {room}`, `rtc.signal {room, data}`.
  - Server → client: `hello {connId, userId}`, `room.joined {room, peers:[{connId,userId}]}`, `room.peer-joined {room, peer}`, `room.peer-left {room, connId}`, `room.full {room}`, `rtc.signal {room, from, data}`, `error {code}`.
  - `SignalData = { description?: {type: "offer"|"answer"|"pranswer"|"rollback", sdp?: string ≤ 65536}, candidate?: {candidate ≤ 2048, sdpMid?, sdpMLineIndex?, usernameFragment?} | null }`.
- **The server only forwards** `rtc.signal` to the *other* member of a room the sender is in. Clients can't address arbitrary connIds. Malformed JSON or a schema failure gets `error {code:"bad_frame"}` and the socket stays open. More than ~100 frames/s closes it with 1008.
- `maxPayload: 131072` (plugin `options`). A video SDP is a few KB. [ASSUMED typical size]
- **Heartbeat:** `setInterval(25_000)` → `socket.ping()`; terminate if no `pong` since the last tick; `clearInterval` in `onClose`. Cloudflare drops idle WebSockets after ~100 s [CITED: developers.cloudflare.com/support/network/using-cloudflare-with-websockets (heartbeat advice); the 100 s figure is MEDIUM, from community sources]. Browsers answer protocol pings automatically.
- **Session revocation:** the hub keeps `sessionId` per connection, and `POST /api/logout` calls `hub.closeSession(sessionId)` (close code 4401). That way a logged-out device can't keep signaling.
- `@fastify/websocket` does **not** run `onSend` hooks for WS routes, and `setErrorHandler` doesn't see errors after the upgrade [VERIFIED: README "Using hooks" / errorHandler sections]. Wrap message handlers in try/catch.

### Pattern M4: 1:1 peer with perfect negotiation (client, reused by Phase 3)

```ts
// web/lib/rtc/peer.ts — MDN perfect negotiation, adapted
export function createPeer(o: {
  iceServers: RTCIceServer[]; forceRelay: boolean; polite: boolean; stream: MediaStream
  send: (data: SignalData) => void; onRemoteStream: (s: MediaStream) => void
}) {
  const pc = new RTCPeerConnection({ iceServers: o.iceServers, iceTransportPolicy: o.forceRelay ? "relay" : "all" })
  let makingOffer = false, ignoreOffer = false, isSettingRemoteAnswerPending = false
  pc.onnegotiationneeded = async () => {
    try { makingOffer = true; await pc.setLocalDescription(); o.send({ description: pc.localDescription!.toJSON() }) }
    catch (err) { console.error(err) } finally { makingOffer = false }
  }
  pc.onicecandidate = ({ candidate }) => { if (candidate) o.send({ candidate: candidate.toJSON() }) }
  pc.ontrack = ({ track, streams }) => o.onRemoteStream(streams[0] ?? new MediaStream([track]))
  pc.oniceconnectionstatechange = () => { if (pc.iceConnectionState === "failed") pc.restartIce() }
  for (const t of o.stream.getTracks()) pc.addTrack(t, o.stream)

  async function handleSignal({ description, candidate }: SignalData) {
    if (description) {
      const readyForOffer = !makingOffer && (pc.signalingState === "stable" || isSettingRemoteAnswerPending)
      const offerCollision = description.type === "offer" && !readyForOffer
      ignoreOffer = !o.polite && offerCollision
      if (ignoreOffer) return
      isSettingRemoteAnswerPending = description.type === "answer"
      await pc.setRemoteDescription(description)
      isSettingRemoteAnswerPending = false
      if (description.type === "offer") { await pc.setLocalDescription(); o.send({ description: pc.localDescription!.toJSON() }) }
    } else if (candidate) {
      try { await pc.addIceCandidate(candidate) } catch (err) { if (!ignoreOffer) throw err }
    }
  }
  return { pc, handleSignal, close: () => pc.close() }
}
```
Source: the variables, handlers and collision logic are MDN's code verbatim [CITED: developer.mozilla.org/en-US/docs/Web/API/WebRTC_API/Perfect_negotiation]. Three things are adapted:
- The null end-of-candidates is skipped.
- `restartIce()` runs on `failed`.
- **Polite role:** MDN leaves it to the app. Use `polite = myConnId > peerConnId` (string compare), which is deterministic on both ends with no extra round trip.

**Ordering rule:** fetch ICE servers and `getUserMedia` **before** `room.join`. `createPeer` can then run synchronously inside the `room.joined` (peer present) or `room.peer-joined` handler, ahead of the first incoming `rtc.signal` on the same ordered socket. As a defensive measure, buffer any `rtc.signal` that arrives before the peer exists.

### Pattern M5: Proof from `getStats()` (INFR-04 gate metric)

```ts
// web/lib/rtc/stats.ts
export async function sampleCall(pc: RTCPeerConnection) {
  const r = await pc.getStats()
  let inboundBytes = 0, pair: any
  r.forEach((s: any) => {
    if (s.type === "inbound-rtp") inboundBytes += s.bytesReceived ?? 0          // THE gate metric (audio + video)
    if (s.type === "transport" && s.selectedCandidatePairId) pair = r.get(s.selectedCandidatePairId)
  })
  if (!pair) r.forEach((s: any) => { if (s.type === "candidate-pair" && s.state === "succeeded" && (s.nominated || s.selected)) pair ??= s })
  const local = pair && r.get(pair.localCandidateId), remote = pair && r.get(pair.remoteCandidateId)
  return {
    state: pc.connectionState, inboundBytes,
    localType: local?.candidateType as string | undefined,   // host | srflx | prflx | relay
    relayProtocol: local?.relayProtocol as string | undefined, // udp | tcp | tls (client→TURN leg)
    remoteType: remote?.candidateType as string | undefined,
    rttMs: pair?.currentRoundTripTime != null ? Math.round(pair.currentRoundTripTime * 1000) : undefined,
  }
}
// PASS = state === "connected" && inboundBytes > 0 && inboundBytes grew since the last sample && (!forceRelay || localType === "relay")
```
- The standard way to find the selected pair is `transport.selectedCandidatePairId`. `candidate-pair.selected` is Firefox-only and non-standard [CITED: MDN RTCIceCandidatePairStats/selected].
- Chrome 153 populates `selectedCandidatePairId`: the headless loopback on this box returned `pairType: "host"` through it [VERIFIED: executed].
- Safari populating it is [ASSUMED], so the `nominated`/`succeeded` fallback stays.
- `relayProtocol` is a standard field per the webrtc-stats spec [ASSUMED, not fetched].

### Pattern M6: `/debug/call` harness (D-12 adapted)

- **Route:** `web/app/debug/call/page.tsx` (`'use client'`). The static export gives `/debug/call/` (`trailingSlash: true`). On mount, `GET /api/me`. On 401, show an `Empty` with a link to `/`.
- **UI, preset components only:**
  - `Card` with a `Switch` labelled "Force relay (TURN only)" (disabled while running) and a `Field`/`Input` for the room (default `debug`).
  - `Button` Start/Stop, and `Spinner` while connecting.
  - Two `<video>` elements: local `autoPlay playsInline muted`, remote `autoPlay playsInline`.
  - `Item` rows: connection state, inbound bytes (live), local/remote candidate type, relay protocol, RTT.
  - A `Badge` that shows PASS/waiting, plus `sonner` toasts for errors.
  - Phosphor icons only.
  - Add `data-testid` on the verdict and the candidate type for the headless smoke.
- **Read `?relay=1` and `?room=` at load** so the smoke and UAT links are one tap.
- **Report:** on the first PASS, and on Stop, `POST /api/debug/call-report {room, forceRelay, pass, inboundBytes, localType, remoteType, relayProtocol, rttMs, ua}`. The body is zod-validated (strings capped), the route uses `requireUser` with a rate limit of 30/min, and it returns 204. The server logs `request.log.info({ evt: "call_smoke", userId, cfIp: CF-Connecting-IP, ...body })`. `cfIp` proves which side was off the home egress (`103.198.98.196`), so Claude verifies with `docker compose logs duet | grep call_smoke`.
- **Reach it from the installed PWA:** add a low-key "Call test" `DropdownMenuItem` to the shell header menu (Pitfall M6). Phase 3 can keep it as "Diagnostics" or remove it.

### iOS Safari (home-screen PWA) and Android Chrome quirks

| Quirk | Handling | Confidence |
|-------|----------|-----------|
| `getUserMedia` needs a user gesture plus a secure context (HTTPS, or `localhost` in tests) | Call it from the Start button handler. `navigator.mediaDevices` is `undefined` on insecure origins: headless `about:blank` failed this way, and it worked on `http://localhost` | [VERIFIED: executed in headless Chrome] |
| iOS standalone PWAs re-prompt for camera/mic often, and capture is stopped/reset by navigation (including hash changes) | Keep the whole test on one page with no route or hash changes while capturing. Request **one** stream and reuse it. Expect a prompt on each launch | MEDIUM [CITED: bugs.webkit.org/show_bug.cgi?id=215884; Apple dev forums 788518] |
| Inline video on iOS | `playsInline` on **both** `<video>` elements, otherwise iOS goes fullscreen. Local preview `muted` | MEDIUM [CITED: webrtchacks guide-to-safari-webrtc] |
| Autoplay with sound | WebKit lets MediaStream media autoplay when the page is already capturing. Still call `video.play()` after `srcObject` is set and catch `NotAllowedError`, showing a "Tap to play" `Button` | MEDIUM [CITED: webrtchacks; WebKit policy secondhand] |
| Codecs | Don't set codec preferences. Chrome↔Safari negotiate VP8 or H.264 automatically | [ASSUMED] (well-known; no Phase 1 requirement depends on the codec) |
| Backgrounding / screen lock stops capture on iOS | Keep the screen on and the app foregrounded during the UAT. Background calls are a Phase 3 topic (push + CallKit-less PWA limits) | [ASSUMED] |
| Installed iOS app has its own cookie jar (app-track Pitfall 6) | Log in **inside** the installed app before the test, or run the test in a Safari tab logged in there | [VERIFIED in app track] |
| Earpiece vs speaker routing on iOS | Not a Phase 1 concern. Phase 3 may look at `navigator.audioSession` | LOW [ASSUMED] |
| Cellular IPv6-only carriers (464XLAT) | Fine: the client→TURN leg may be IPv6, and the relay is IPv4 | [CITED: turn/faq] |

### Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| TURN server, credentials HMAC | coturn, REST-HMAC minting | Cloudflare `generate-ice-servers` | Managed, anycast, revocable. That's the whole point of D-16 |
| WebSocket framing/upgrade | raw `http` upgrade handling | `@fastify/websocket` (ws) | Hooks run before the upgrade (auth), plus `maxPayload` and `injectWS` tests |
| Glare / offer collision handling | ad-hoc "caller/callee" with retries | MDN perfect negotiation (~30 lines) | Handles simultaneous `negotiationneeded` on both ends. Phase 3 renegotiation (camera on/off) needs it too |
| Selected-candidate detection | parsing SDP or candidate strings | `getStats()` `transport.selectedCandidatePairId` → `local-candidate.candidateType` | Standard, and works in Chrome (verified) |
| Browser automation for the 2-peer smoke | raw CDP over WS | `playwright-core` + system Chrome | Fake devices, two isolated cookie jars (contexts), auto-wait |
| WebRTC wrapper libs (simple-peer, PeerJS) | — | plain `RTCPeerConnection` | Unmaintained or old abstractions, and they hide `iceTransportPolicy`/`getStats`. Not needed for 1:1 |

### Common Pitfalls (media track)

**Pitfall M1 — The WS upgrade silently breaks the rolling session.** The existing `requireUser` advances `lastSeenAt`/`expiresAt` in the DB **and** calls `setSessionCookie` (session.ts:129-137). On a WebSocket route, the 101 response is written by `ws`, not by `reply`, so the `Set-Cookie` never reaches the browser while the DB row says "renewed". For the next 24 h no HTTP request re-issues the cookie. If the WS (Phase 2 connects it on app load) keeps winning the daily renewal race, the browser cookie expires on day 90 despite daily use. **Fix:** factor the lookup into `resolveSession(request, reply, { renew })` and use `renew: false` on `/ws`. `requireUser` stays as-is for HTTP. **Warning sign:** session.test still passes, but no test covers WS + renewal. Add one: an injectWS connect with a session older than 24 h must leave `lastSeenAt` unchanged.

**Pitfall M2 — Cross-site WebSocket hijacking.** The global Origin guard only covers non-GET `/api/*` (guards.ts:16). The `SameSite=Lax` cookie is *probably* not sent on a cross-site WS handshake, but don't rely on it. Check `Origin === APP_ORIGIN` in the WS `preHandler`, and test it with injectWS (`origin: "https://evil.example"` → `Unexpected server response: 403`).

**Pitfall M3 — Silent STUN-only fallback.** If the credential endpoint quietly returns only STUN when TURN is misconfigured, "normal ICE" may still pass on Wi-Fi and hide the problem. Return 503/502, and have the harness show the error.

**Pitfall M4 — Forced relay "passes" without being relayed.** Gate the relay mode on `localType === "relay"` for the selected pair on **both** clients, not only on `bytesReceived > 0`. With `iceTransportPolicy: "relay"` there should be no other candidate types; asserting it catches a toggle that was never applied (for example, the switch changed after the PC was created). Disable the switch while running.

**Pitfall M5 — Port-53 TURN URL stalls ICE gathering.** Cloudflare warns that browsers block it. Filter `:53` server-side (Pattern M2). This is harmless if absent.

**Pitfall M6 — The installed iOS PWA has no URL bar.** A "hidden" `/debug/call` page can't be typed into a standalone app. Either add a menu item ("Call test") in the shell's header menu, or run the test in a Safari tab with a separate login. The menu item is recommended because it tests the real Phase 3 environment.

**Pitfall M7 — Async gap between `room.joined` and `createPeer`.** If ICE servers are fetched *after* joining, the other side's offer can arrive before the PC exists and get dropped. Fetch ICE servers and media first, then join, and buffer early signals.

**Pitfall M8 — WS idle drop through Cloudflare (~100 s).** During a test, media flows P2P while signaling sits idle, so the WS dies mid-call without the server heartbeat. The P2P media survives a WS drop, but Phase 3 hang-up/renegotiation would not. Ping every 25 s.

**Pitfall M9 — The TURN bearer is shown once.** If `turn-key.sh` crashes after create but before writing `.env`, the key is orphaned. Write `.env` immediately after create (temp file + `mv`), then verify. Delete orphaned keys named `duet` on the next run.

**Pitfall M10 — "Normal ICE" across two CGNATs may select relay anyway.** Home (CGNAT) ↔ cellular (CGNAT, often symmetric) frequently can't hole-punch, so the normal-mode run may report `localType: relay`. That still satisfies INFR-04 (`bytesReceived > 0` with normal ICE). Record the candidate type: it tells Phase 3 how much traffic will be billed TURN egress.

**Pitfall M11 — Same-LAN second client hides nothing, by design.** For the cellular test the second client should be on home Wi-Fi (or anywhere). Only the phone must have Wi-Fi **off**. The `cfIp` in the report confirms it (not `103.198.98.196`).

**Pitfall M12 — `shadcn add` recreates `web/package-lock.json` and `web/node_modules`** (app-track Pitfall 1, seen again in 01-01). Delete them before the root `npm install`, then run `bash scripts/check-preset.sh`.

### Environment Availability (media track)

| Dependency | Required By | Available | Version | Fallback |
|------------|------------|-----------|---------|----------|
| Cloudflare account token with `Calls Write` | TURN key creation | ✓ | active, expires 2026-12-08 | — |
| Cloudflare TURN key | credential minting | ✗ (none exist yet) | — | Created by `turn-key.sh` (Plan a) |
| Outbound UDP 3478 / TCP 443, 5349 to Cloudflare | TURN from the box (headless smoke) | ✓ | srflx `103.198.98.x` | TURNS 443 (TCP) if UDP is ever blocked |
| `rtc.live.cloudflare.com:443` from the box/container | mint endpoint | ✓ from host (container uses the default bridge, so outbound HTTPS is expected) | — | — |
| Zone WebSockets (`brkn.me`) | `wss://duet.brkn.me/ws` | ✓ `on` | — | — |
| Google Chrome (system) | headless 2-peer smoke | ✓ | 153.0.8010.52 at `/usr/bin/google-chrome` | Playwright browsers in `~/.cache/ms-playwright` (chromium-1243) |
| Playwright | headless smoke | global `@playwright/test@1.62.1` ✓; project-local `playwright-core` ✗ | — | Add `playwright-core@1.62.1` (root devDep) |
| Node (host, tests) | vitest, smoke scripts | ✓ | v22.23.1 (container: Node 24) | — |
| Docker compose stack `duet` | deploy | ✓ `duet-duet-1` healthy, `duet-cloudflared-1` up | — | — |
| Real iPhone + Pixel, cellular data | INFR-04 human UAT | human | — | Owner alone: one phone on cellular + laptop browser (rooms allow the same user twice) |

**Missing with no fallback:** none. **Missing with fallback:** the TURN key and `playwright-core`, both created or installed by the plans.

### Validation Architecture (media track)

> `workflow.nyquist_validation` is `false` in config. The orchestrator asked for this subsection anyway. It **supersedes the INFR-03/INFR-04 and "SFU token" rows** in the historical Validation Architecture further down.

#### Test Framework
| Property | Value |
|----------|-------|
| Framework | Vitest 5.0.3 (server, `pool: "forks"`), `fastify.inject()` + `fastify.injectWS()`; `playwright-core` 1.62.1 + system Chrome for the 2-peer smoke |
| Config file | `server/vitest.config.ts` (exists: `include: ["test/**/*.test.ts"]`, `testTimeout: 20_000`) |
| Quick run command | `npm test -w server` |
| Full suite command | `npm test -w server && npm run typecheck && NEXT_EXPORT=1 npm run build -w web && bash scripts/check-preset.sh && bash scripts/smoke-local.sh && SKIP_BUILD=1 bash scripts/smoke-call.sh` |

#### Phase Requirements → Test Map
| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| INFR-03 | Mint calls `…/keys/{id}/credentials/generate-ice-servers` with `Bearer` + `{ttl}`; returns iceServers with `:53` removed; 201/200 accepted; non-2xx, timeout or bad JSON → `turn_unavailable`; missing env → `turn_unconfigured` | unit (fake fetch) | `npx vitest run test/turn.test.ts` | ❌ Wave 0 |
| INFR-03 | `POST /api/rtc/ice-servers`: 401 without session; 403 without Origin; 503 when unconfigured; 200 + `Cache-Control: no-store` + body matches `IceServersResponse`; 31st call/min → 429 | integration (inject) | `npx vitest run test/turn.test.ts` | ❌ Wave 0 |
| INFR-03 | Real Cloudflare: key exists, a 60 s credential mints (201, has `turn:` URLs) | live smoke | `bash deploy/cloudflare/turn-key.sh` → `turn-key ok` | ❌ Wave 0 |
| INFR-03/04 | `/ws`: no cookie → `Unexpected server response: 401`; bad Origin → 403; `hello` has connId; 2 sockets join `r1` → peer-joined/joined; `rtc.signal` reaches **only** the other member; 3rd join → `room.full`; bad JSON → `error bad_frame` and the socket stays open; close → `room.peer-left`; logout closes that session's sockets; WS connect does not renew the session (Pitfall M1) | integration (injectWS) | `npx vitest run test/ws.test.ts` | ❌ Wave 0 |
| INFR-04 (mechanics) | Two headless Chrome contexts (fixture users alice/bob) on local duet with **real** TURN env open `/debug/call/?room=smoke-<ts>&relay=1`, click Start, both reach PASS with `localType=relay` and inbound bytes > 0 within 30 s | e2e (headless, real TURN) | `bash scripts/smoke-call.sh` → `smoke-call ok` | ❌ Wave 0 |
| INFR-04 (public wiring) | Deployed `/ws` upgrade without cookie → 401 (not 404); `POST /api/rtc/ice-servers` without session → 401 | smoke | `bash scripts/smoke-public.sh` (extended) | ✅ exists, extend |
| INFR-04 (gate) | Phone on cellular (Wi-Fi off) + second client: PASS in normal mode **and** forced-relay mode, on both clients | **manual UAT**, auto-reported | Run `/debug/call/` then `/debug/call/?relay=1`; Claude checks `docker compose logs duet \| grep call_smoke` for ≥ 4 PASS lines (2 per mode), with one `cfIp` ≠ `103.198.98.196` and `localType=relay` on both relay lines | — (human) |
| UI lock | No lucide/Radix; switch/badge came from the CLI | static | `bash scripts/check-preset.sh` | ✅ exists |

`smoke-call.sh` shape: reuse `smoke-local.sh` (temp `DATA_DIR`, seed 2 fixture users via `--stdin`, start the server on 127.0.0.1:31xx with `APP_ORIGIN=http://127.0.0.1:31xx COOKIE_SECURE=false`). Pass the two TURN vars extracted from `.env` with `sed -n 's/^CF_TURN_KEY_ID=//p'` (never echoed). Then run `node scripts/smoke-call.mjs "$BASE"`. The `.mjs` script:
- launches `chromium.launch({ executablePath: process.env.CHROME ?? "/usr/bin/google-chrome", args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream"] })`;
- creates 2 `newContext()`s, logs each in with `ctx.request.post("/api/login", { data, headers: { Origin: BASE } })` (context-shared cookies [ASSUMED]);
- then `page.goto`, clicks Start, and `expect`s/polls the `data-testid` verdict on both pages.

If `.env` has no TURN vars, it prints `smoke-call skipped (no TURN key)` and exits non-zero only in CI-like strict mode. Forced relay with **both** peers on the same host still hairpins through Cloudflare relay addresses (public IPv4), which Cloudflare permits (it only denies private ranges [CITED]). That this works end to end is [ASSUMED] until the first run.

#### Sampling Rate
- **Per task commit:** `npm test -w server`
- **Per wave merge:** full suite command above (smoke-call needs the TURN key from Plan a)
- **Phase gate:** full suite green + `smoke-public.sh` against the redeployed container + the human cellular UAT (both modes), with `call_smoke` lines in the logs, before `/gsd-verify-work`. The app-track device UAT from 01-03 (install, stay logged in, logout) can run in the same phone session.

#### Wave 0 Gaps
- [ ] `server/test/turn.test.ts`, `server/test/ws.test.ts` (extend `test/helpers.ts`: `buildApp(config, { fetch })` injection and a `loginCookie(app, user)` helper)
- [ ] `scripts/smoke-call.sh` + `scripts/smoke-call.mjs`
- [ ] `deploy/cloudflare/turn-key.sh`
- [ ] Installs: `@fastify/websocket@11.3.3` (server), `playwright-core@1.62.1` (root dev), `shadcn add switch badge` (behind the package gate)

### Security Domain (media track)

`security_enforcement: true`, ASVS L1, block on high.

| ASVS Category | Applies | Standard Control |
|---------------|---------|-----------------|
| V2 Authentication | yes (reuse) | No new auth. `/ws` and the credential/report endpoints reuse the `duet_session` check |
| V3 Session Management | yes | `/ws` uses a non-renewing check (Pitfall M1). Logout closes that session's sockets |
| V4 Access Control | yes | `requireUser` on `POST /api/rtc/ice-servers`, `POST /api/debug/call-report`, `GET /ws`. Signals relay only within a room the sender joined (≤ 2 members). No addressing of arbitrary connIds |
| V5 Input Validation | yes | zod `ClientFrame` for every WS frame. SDP ≤ 64 KiB, candidate ≤ 2 KiB, `maxPayload` 128 KiB, RoomId regex. Report body zod with string caps |
| V6 Cryptography | yes (delegated) | No hand-rolled crypto. TURN creds are minted by Cloudflare. Media is DTLS-SRTP end-to-end, and Cloudflare relays only encrypted packets [CITED: turn/faq] |
| V12/V14 Config & secrets | yes | TURN bearer only in the gitignored `.env` (`.dockerignore` excludes `.env`, so it never enters the image). Account token stays on the host (`~/.config/duet`), never in the container. Scripts never echo secrets (header file, not argv) |
| CSRF / CSWSH | yes | Origin guard covers `POST /api/rtc/*` and `/api/debug/*` automatically. Explicit Origin check on `/ws` |

| Threat | STRIDE | Mitigation |
|--------|--------|------------|
| Outsider mints TURN creds and uses Cloudflare bandwidth on the owner's bill | Elevation / DoS (cost) | Login required. Rate limit 30/min/IP. TTL 24 h (max 48 h). Revocation endpoint available. Free tier is 1,000 GB/mo. Optional TURN usage check via the GraphQL analytics API (Phase 3) |
| TURN key bearer leak | Info disclosure | Server-side only. Not logged. Rotate with `turn-key.sh` (create a new key, delete the old one) |
| Cross-site WebSocket hijack | Spoofing | Origin check before the upgrade. `SameSite=Lax` cookie |
| Signal injection into someone else's call | Tampering | Rooms capped at 2. Relay only to the room peer. Phase 3 binds rooms to the two user ids |
| WS resource exhaustion | DoS | `maxPayload`, per-socket frame rate cap, heartbeat terminates dead sockets, rooms ≤ 2 |
| IP address exposure to the peer (normal ICE) | Info disclosure | Accepted (two partners). Forced relay hides it if ever wanted |
| Smoke report log contains client IP + UA | Privacy | Own server log, two users. Only the CF-Connecting-IP and UA (≤ 300 chars) |

### Assumptions Log (media track)

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| MA1 | Live `generate-ice-servers` responses may include a `:53` URL (implied by the doc note, absent from the doc example) | API contract, M2 | None: the filter is a no-op if absent |
| MA2 | `generate-ice-servers` accepts the same `ttl` semantics as `/generate`, and TURN keys don't expire on their own | API contract | Low: `turn-key.sh` re-verifies by minting. Re-run it if keys ever expire |
| MA3 | TURN works on this account without adding a payment method (free tier usage) | API contract | Medium: key creation or mint could fail with a billing error. `turn-key.sh` surfaces Cloudflare's error. Then the user must enable billing (decision checkpoint) |
| MA4 | Safari exposes `transport.selectedCandidatePairId`; `relayProtocol` is present on local candidates | M5 | Low: the fallback to `nominated` + `succeeded` pairs covers it. relayProtocol is informational |
| MA5 | Forced relay with both peers on this one host connects through Cloudflare (relay ↔ relay hairpin) | Validation | Medium: if it doesn't, run smoke-call with one peer forced-relay and the other `all`. The gate still proves TURN allocation + media through Cloudflare |
| MA6 | Playwright `context.request` shares cookies with the context's pages | Validation | Low: fall back to logging in through the UI, or `context.addCookies` from a curl login |
| MA7 | The Cloudflare idle WebSocket timeout is ~100 s | M3, M8 | Low: a 25 s heartbeat is safe for any timeout above 30 s |
| MA8 | Chrome↔Safari codec negotiation needs no preference tweaks; iOS stops capture when backgrounded | quirks | Low for Phase 1 (foreground UAT) |
| MA9 | A typical video SDP is ≪ 64 KiB | M3 | Low: raise the caps if a real SDP is rejected (the test logs `bad_frame`) |
| MA10 | ~0.9 GB/h per relayed client at ~2 Mbps, so the 1,000 GB free tier ≈ 500+ h/month of fully relayed video | Summary | Low: informational |

### Open Questions (media track)

1. **Does the Cloudflare account need billing enabled for TURN?**
   - What we know: the token has the permissions, and the free tier exists.
   - What's unclear: whether a payment method is a prerequisite.
   - Recommendation: Plan (a) Task 1 runs `turn-key.sh`. If Cloudflare returns a billing error, stop at a `checkpoint:decision` for the user.
2. **Harness entry point: a menu item vs. Safari-only.**
   - Recommendation: a "Call test" item in the header menu (it makes the installed PWA testable). It is low-key, login-gated, and trivially removable in Phase 3. This is the planner's call, not a locked decision.
3. **Second client for the cellular UAT.**
   - Recommendation: whichever is at hand. The room model allows owner-phone + owner-laptop (the same account twice), so the test doesn't need both people present.

### Suggested Plan Shape (media track; replaces the superseded 01-04/01-05)

- **01-04 — TURN credentials (INFR-03)** (wave 4, parallel with 01-05's hub tasks):
  1. Package gate (`checkpoint:human-verify`: @fastify/websocket 11.3.3, playwright-core 1.62.1, shadcn switch/badge).
  2. `deploy/cloudflare/turn-key.sh`, run it (`turn-key ok`). On a billing error, a decision checkpoint.
  3. `turn.ts` + `POST /api/rtc/ice-servers` + config/env + `turn.test.ts` (TDD).
- **01-05 — Signaling + harness + proof (INFR-04)** (wave 4→5):
  1. Non-renewing session check + `/ws` hub + `ws.test.ts` (TDD).
  2. `web/lib/{ws,rtc/*}` + `/debug/call` UI + report endpoint + menu item.
  3. `smoke-call.sh` headless forced-relay run with the real TURN key (`smoke-call ok`).
  4. Redeploy (`docker compose up -d --build`) + extended `smoke-public.sh`.
  5. `checkpoint:human-verify`: cellular UAT, both modes, plus the pending app-track device UAT. Claude confirms the `call_smoke` log lines.

### Sources (media track)

**Primary (HIGH):**
- Cloudflare docs, fetched as markdown 2026-10-09:
  - [Generate Credentials](https://developers.cloudflare.com/realtime/turn/generate-credentials/) (updated 2026-09-25)
  - [TURN FAQ](https://developers.cloudflare.com/realtime/turn/faq/) (updated 2026-07-14)
  - [Replacing existing TURN servers](https://developers.cloudflare.com/realtime/turn/replacing-existing/)
  - [TURN overview](https://developers.cloudflare.com/realtime/turn/)
  - [Realtime pricing](https://developers.cloudflare.com/realtime/pricing/)
  - [API: create TURN key](https://developers.cloudflare.com/api/resources/calls/subresources/turn/methods/create/)
  - [API: TURN key methods](https://developers.cloudflare.com/api/resources/calls/subresources/turn/)
- [MDN: Perfect negotiation](https://developer.mozilla.org/en-US/docs/Web/API/WebRTC_API/Perfect_negotiation); [MDN: RTCIceCandidatePairStats.selected](https://developer.mozilla.org/en-US/docs/Web/API/RTCIceCandidatePairStats/selected)
- `@fastify/websocket@11.3.3` npm tarball: README (hooks, errorHandler, injectWS), `index.js` (injectWS implementation), `test/inject.test.js:133`. GitHub releases v11.3.0–v11.3.3
- Executed this session:
  - Cloudflare API: `turn_keys` list (empty), token verify plus policies (Calls Write, Realtime Admin; expires 2026-12-08), zone `websockets` = on
  - `generate-ice-servers` with an unknown key → 404 JSON
  - STUN UDP probe → srflx 103.198.98.x; TCP 443/5349 to turn.cloudflare.com
  - Public `/ws` upgrade → 404
  - Headless Chrome 153 + Playwright 1.62.1 fake-media loopback → bytes 178009, `transport.selectedCandidatePairId` → host
  - `npx shadcn@4.21.4 view switch badge`
  - `npm view` versions/dates; package-legitimacy seam
- Repo files read this session: `server/src/{app,config,index}.ts`, `server/src/auth/{session,routes}.ts`, `server/src/http/guards.ts`, `server/test/helpers.ts`, `server/vitest.config.ts`, `server/package.json`, `web/{package.json,next.config.ts,components.json}`, `web/app/{page,layout}.tsx`, `web/components/app/{shell,sw-register}.tsx`, `web/lib/api.ts`, `web/public/sw.js`, `shared/src/{api,index}.ts`, `compose.yaml`, `Dockerfile`, `.dockerignore`, `.env.example`, `deploy/cloudflared/setup.sh`, `scripts/{smoke-local,check-preset}.sh`

**Secondary (MEDIUM):**
- [Cloudflare: using Cloudflare with WebSockets](https://developers.cloudflare.com/support/network/using-cloudflare-with-websockets/) (heartbeat advice). The ~100 s figure comes from [Cloudflare community](https://community.cloudflare.com/t/cloudflare-websocket-timeout/5865) and [websocket.org guide](https://websocket.org/guides/infrastructure/cloudflare/)
- [WebKit bug 215884](https://bugs.webkit.org/show_bug.cgi?id=215884) (standalone PWA capture reset on navigation); [Apple forums 788518](https://developer.apple.com/forums/thread/788518) (repeated camera prompts)
- [webrtcHacks: Guide to Safari WebRTC](https://webrtchacks.com/guide-to-safari-webrtc/) (playsinline, autoplay while capturing)

**Valid until:** 2026-11-08 (Cloudflare Realtime docs change monthly; re-check the mint response shape on first run).

---

# Phase 1: Foundation, Auth & Media Plane - Research

**Researched:** 2026-10-08
**Domain:** Self-hosted PWA foundation (Next static export + Fastify + SQLite in Docker behind Cloudflare Tunnel), password auth, and a home-hosted mediasoup SFU + coturn behind double NAT
**Confidence:** HIGH for the app track (most claims were executed in this session). MEDIUM for the ops track: the SFU config was read from source, but home-network reachability can only be proven after the user acts.

> This file builds on `.planning/research/{STACK,ARCHITECTURE,PITFALLS,SUMMARY}.md` and does not repeat them. Where it disagrees with them, this file wins: it is newer and it was checked by running things on this box.

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions

#### Domain & hostnames
- **D-01:** Domain is **`brkn.me`** (the owner's portfolio domain, DNS already on Cloudflare). The apex/portfolio records must not be touched.
- **D-02:** Hostnames: **`duet.brkn.me`** → the app via Cloudflare Tunnel (proxied/orange cloud); **`sfu.brkn.me`** and **`turn.brkn.me`** → A records pointing directly at the home public IP, **DNS-only (grey cloud)**, because the Cloudflare proxy cannot carry SFU/TURN UDP. Accepted consequence: the home IP becomes publicly resolvable through those two names. — **Reversibility:** costly — the hostnames get baked into the SFU's TLS certs, its TURN config, the app env and the PWA's origin. Changing the app origin later invalidates installed PWAs and their push subscriptions.
- **D-03:** Make the domain configurable through env (`APP_ORIGIN`, `SFU_URL`, `TURN_HOST`). Never hard-code it.

#### Login flow
- **D-04:** Login screen shows **two tiles, one per person (name + initials Avatar)**. Tapping one asks for that person's password. No username field and no sign-up path anywhere. Display names are set by the seed script. Accepted consequence: anyone who opens the URL sees both names.
- **D-05:** **Password only. TOTP 2FA is dropped** (user decision). This overrides AUTH-02's "password + TOTP" and the stack doc's otplib/qrcode/input-otp entries: do **not** install `otplib` or `qrcode`, and build no OTP step or `input-otp` usage. Compensating controls: argon2id (`@node-rs/argon2`), `@fastify/rate-limit` on `/api/login`, and a seed script that refuses weak passwords (e.g. ≥ 12 characters). REQUIREMENTS.md, ROADMAP.md and PROJECT.md have been updated to match.
- **D-06:** Session: opaque random token in an `httpOnly; Secure; SameSite=Lax` cookie plus a sessions table, **90-day rolling expiry** (any authenticated use extends it). Logout deletes the session row and clears the cookie.
- **D-07:** The seed script (`AUTH-01`) creates exactly two users (display name, password) and is idempotent and re-runnable. Re-running it with a new password is also the password-reset path (stopgap for AUTH-06).

#### App identity & landing
- **D-08:** PWA `name`/`short_name`: **`duet`** (lowercase).
- **D-09:** Icon: a simple generated mark, a Phosphor glyph (e.g. heart or chat bubble) on the preset's rose primary, exported to the PNG sizes iOS and Android need (incl. 180px apple-touch-icon, 192/512, and a maskable variant). No external design assets.
- **D-10:** **Always dark theme.** Force the preset's dark tokens (e.g. a `dark` class on `<html>`) and set the manifest `theme_color`/`background_color` and the iOS status-bar style to match. Use the preset's own dark tokens; adding a custom palette would deviate from the preset.
- **D-11:** Logged-in landing in Phase 1 is a **chat-shaped empty shell**: a header with the other person's name and initials Avatar, an `empty`-component placeholder where messages will go, and **logout in a header menu**. Phase 2 builds on this layout.

#### SFU smoke test & ops
- **D-12:** The smoke harness is a **hidden, login-gated page inside duet** (e.g. `/debug/sfu`). It uses the real server-side join-token minter (jose HS256) and `@sideby-me/rtc`, publishes mic/camera, consumes, displays `bytesReceived`, and has a **"force relay"** toggle (`iceTransportPolicy: 'relay'`). The SDK exposes no such option, so a minimal patch or wrapper is needed, per the stack notes. Phase 3 reuses the token minter and SDK wiring.
- **D-13:** Ops split: Claude does everything possible from this box (Docker, `cloudflared` tunnel `duet`, SFU stack, DNS records through the Cloudflare API if the user supplies a scoped API token). The user gets an **exact checklist** for router port-forwards and for the GitHub PAT with `read:packages`.
- **D-14:** The SFU + coturn (+ nginx-sni per the SFU repo) run as their **own separate Docker Compose stack** on this box, independent of duet's compose file.
- **D-15:** **CGNAT fallback is undecided on purpose.** If the CGNAT check fails, the ops track **pauses and asks the user**. The options to present are (a) a small VPS (~$4–6/mo) for SFU + coturn, or (b) asking the ISP for a public IPv4. The app track continues either way (Phase 2 doesn't depend on ops).

### Claude's Discretion
- Exact hostname layout (user said "you decide" → D-02).
- Failed-login UX: generic "Wrong password" message; cooldown/rate-limit after ~5 failures per user/IP within a short window.
- Icon glyph choice and the exact empty-state copy.

### Deferred Ideas (OUT OF SCOPE)
- TOTP / 2FA. The user explicitly dropped it. If it's ever wanted again, the cheapest form is TOTP once per device, with the 90-day session carrying it afterwards.
- CGNAT fallback host choice (VPS vs ISP public IP). Decide only if the check fails (D-15).
</user_constraints>

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|------------------|
| INFR-01 | duet reachable at an HTTPS URL on the new domain via Cloudflare Tunnel to this machine | §Cloudflare Tunnel for duet.brkn.me: a locally-managed named tunnel `duet` running as a compose service with `user: "1000:1000"`; CNAME created via the API, not `tunnel route dns` |
| INFR-02 | App, SQLite, media in Docker on a persistent volume | §Container layout: `./data:/data` bind mount, uid 1000, WAL SQLite, migrate on boot; restart-persistence test |
| INFR-03 | *(historical — see Media Track section at the top)* SFU + coturn on this machine, publicly reachable (DNS, port-forwards, non-CGNAT IPv4) | §Home SFU deployment (env, turnserver.conf, nginx-sni.conf, sfu0 sidecar, certs), §CGNAT check procedure, §Port-forward checklist |
| INFR-04 | *(historical — see Media Track section at the top)* Smoke test proves `bytesReceived > 0` from a phone on cellular, direct and forced-relay | §Smoke harness design: an RTCPeerConnection wrapper forces relay **and** captures PCs for `inbound-rtp` stats; two sessions on one phone; results POSTed to the server log |
| AUTH-01 | Exactly two accounts from a seed script; no sign-up UI | §Seed script pattern (upsert by username, ≥12 chars, revoke sessions on reset); no register route exists |
| AUTH-02 | Tap name + password login | §Login API + UI composition (Item/Avatar tiles → Field/Input/Button), argon2id defaults verified |
| AUTH-03 | Long rolling session | §Session pattern: sha256-hashed opaque token, 90 d, **re-set the cookie on renewal**; iOS home-screen storage notes |
| AUTH-04 | Logout | Delete the row + `clearCookie`; menu via preset `dropdown-menu` |
| SHEL-01 | Preset `b51GFhBEQ` only | §Scaffold facts (executed): `base-luma`, Phosphor, Base UI; delete nested `web/.git`; `forcedTheme="dark"` |
| SHEL-02 | Installable on iPhone + Pixel, standalone | §PWA installability: manifest.ts verified in static export, Next 16 emitted head tags, icon generation via ImageMagick, iOS 26 behavior |
</phase_requirements>

## Project Constraints (from CLAUDE.md)

- **UI:** shadcn preset `b51GFhBEQ` is locked. Init once via the CLI, then add components **only** with `npx shadcn add`. No lucide, no Radix, no copied Radix snippets, no custom palette.
- **Speed:** prefer the simplest thing that works; the phase must not drag on.
- **Hosting:** self-hosted on this machine in Docker; DB and media on local disk.
- **Platforms:** iPhone Safari PWA and Pixel Chrome PWA.
- ~~**Media plane:** use the SFU + coturn (now self-hosted at home); no P2P/mesh.~~ **Superseded 2026-10-09 (D-16):** 1:1 P2P WebRTC + Cloudflare TURN; see Media Track section.
- **Transport:** HTTPS/WSS everywhere.
- **Stack (from the CLAUDE.md table):** Next static export (`output: 'export'`) served by **one** Fastify 5 process; better-sqlite3 + Drizzle 0.45 (not 1.0 rc); `@node-rs/argon2`; `@fastify/cookie`, `@fastify/rate-limit`, `@fastify/static`; zod 4 in `shared/`; `tsx` runtime; `node:24-bookworm-slim` (no Alpine); `typescript@^5` (not TS 7); mediasoup-client **exactly 3.20.0** via the SDK only; `jose` for HS256; never call the SFU admin API; **no Serwist**; no `next/image` loader; no Server Actions.
- **Superseded by D-05:** the CLAUDE.md rows for TOTP, otplib, qrcode and input-otp. Do not install them.
- **GSD workflow:** file changes go through GSD commands. Planning artifacts are committed (`commit_docs: true`).

## Summary

**The app track is low-risk, and I verified it by running it.** In a scratch directory I ran the locked preset scaffold, added the shell components with `shadcn add`, built a static export containing `app/manifest.ts` and a `/debug/sfu` route, served it from Fastify 5.12.5 + `@fastify/static` 10.1.5, and exercised `@fastify/rate-limit` 11.2.1, `@fastify/cookie`, Drizzle 0.45.4 migrations, `@node-rs/argon2` 2.2.2 and jose 6.2.12. Everything worked. That surfaced six concrete traps the planner must design around:
1. The scaffold creates a nested `web/.git` and its own lockfile.
2. The scaffold ships a `d` hotkey that toggles light mode, which conflicts with always-dark.
3. `@fastify/static` 10's `setHeaders` receives the Fastify `reply` (`reply.header()`), not a raw `res`.
4. The rate-limit `keyGenerator` cannot see `req.body` unless the route uses `hook: 'preHandler'`.
5. Behind Cloudflare Tunnel every request comes from cloudflared, so the client IP must come from `CF-Connecting-IP`.
6. The rolling session must **re-issue the cookie**, not only extend the DB row.

**The ops track is feasible but gated on the user.** I read the SFU source to get the exact env and config. The home topology is the same shape as the SFU's "GCP form":
- Bind the LAN IP and announce the public IP: `MEDIASOUP_LISTEN_IP=192.168.0.132`, `MEDIASOUP_ANNOUNCED_IP=103.198.98.196`.
- Give coturn a third local address to relay to: `MEDIASOUP_PRIVATE_IP=10.99.0.1` on an `sfu0` dummy interface.

Box-specific facts found this session:
- **16 CPUs.** With no cgroup CPU limit the SFU spawns 16 workers on 16 RTC ports. `cpus: 2` in compose caps it at 2 (ports 44444–44445). Verified via `cpu.max`.
- **Tailscale owns `100.97.55.101:443`, so a wildcard `listen 443` fails with EADDRINUSE** (reproduced). nginx-sni must `listen 192.168.0.132:443`.
- **The inner TP-Link router's WAN IP is `192.168.10.100`** (from NAT-PMP). That is the DMZ target on the outer router (`192.168.10.1`).
- **The SFU image on GHCR is private, and the box's existing ghcr credentials are denied.** One `read:packages` token unblocks both the SFU image and the `@sideby-me/rtc` SDK.

Because coturn relays to the SFU *locally* (10.99.0.1), **the coturn relay port range does not need router forwarding**. Routing WAN **UDP 443 → 3478** at the router makes the SFU's hard-coded `turn:host:443?transport=udp` URL work without patching the SFU. The minimum forward set is TCP 443, UDP 443→3478, and UDP+TCP 44444–44445.

**Forced relay needs no SDK patch.** mediasoup-client 3.20.0 constructs `new RTCPeerConnection({... iceTransportPolicy: iceTransportPolicy ?? 'all' })` using the global constructor. A page-level `RTCPeerConnection` subclass can therefore (a) force `iceTransportPolicy: 'relay'` and (b) capture every PC, so the page can read real `inbound-rtp` `bytesReceived` and the selected candidate type. That matters because **the SDK's own `networkQuality.bytesReceived` sums every stats report, including transport and DTLS bytes, so it is not a valid gate signal.**

**Primary recommendation:** Build the app track first (scaffold → Fastify + auth → Docker + tunnel → device install). In parallel, run the ops track as a sequence of explicit user checkpoints: (1) read the outer router's WAN IP; (2) provide a Cloudflare API token and a GitHub `read:packages` token; (3) set up router forwards. Claude does everything between those checkpoints: DNS, DNS-01 certs, the SFU compose stack, the token minter, and the harness.

## Architectural Responsibility Map

| Capability | Primary Tier | Secondary Tier | Rationale |
|------------|-------------|----------------|-----------|
| TLS for `duet.brkn.me` | CDN / Edge (Cloudflare) | — | The tunnel terminates TLS at the edge; the origin speaks HTTP on the compose network |
| Login screen, shell UI, install metadata | Browser / Client (static export) | CDN / Static (Fastify serving `web/out`) | No SSR; everything interactive is client-side |
| Auth decision (password verify, rate limit) | API / Backend (Fastify) | Database (users) | Never in the client; argon2 runs server-side |
| Session validity + rolling renewal | API / Backend | Database (sessions) | Opaque token; the server owns expiry and re-issues the cookie |
| Route gating (`/` login vs shell, `/debug/sfu`) | Browser (UX only) | API (real enforcement via 401) | A static export can't gate HTML; protected data/actions are gated at `/api/*` |
| SFU join-token minting | API / Backend | — | `SFU_TOKEN_SECRET` must never reach the client |
| Media transport (RTP) | Browser ↔ SFU (home, host network) | coturn (relay) | duet's server never proxies media |
| Forced-relay toggle + stats capture | Browser (debug page) | — | Wraps `RTCPeerConnection`; no SDK patch |
| Certificates for `sfu.`/`turn.` | Host ops (certbot DNS-01 container) | Cloudflare DNS API | :443 is SNI passthrough; :80 isn't forwarded |
| Persistence | Database / Storage (`/data` volume) | — | SQLite WAL file + media dir on a bind mount |

## Standard Stack

### Core (versions verified with `npm view` on 2026-10-08)

| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| shadcn CLI (preset `b51GFhBEQ`) | 4.21.4 | Scaffold + component adds | Locked. Executed this session: `components.json` → `"style": "base-luma"`, `"iconLibrary": "phosphor"`, `"baseColor": "mist"` [VERIFIED: scratch scaffold `components.json`] |
| next | 16.3.6 (pinned by scaffold; 16.4.0 latest) | UI build → static export | The scaffold pins it; export with `manifest.ts` verified |
| react / react-dom | 19.3.0 | UI runtime | Scaffold pin |
| @base-ui/react, @phosphor-icons/react | ^1.8.0 / ^2.1.10 | Preset primitives/icons | Scaffold deps |
| next-themes | ^0.4.6 | Comes with the scaffold (`components/theme-provider.tsx`) | Use with `forcedTheme="dark"` |
| fastify | 5.12.5 | Single server process | Project stack |
| @fastify/static | 10.1.5 | Serve `web/out` (and `/media` in Phase 2) | Verified: 301 trailing-slash redirect, `application/manifest+json` |
| @fastify/cookie | 11.1.3 | Session cookie | Verified emitted `Max-Age=7776000; Path=/; HttpOnly; Secure; SameSite=Lax` |
| @fastify/rate-limit | 11.2.1 | Throttle `/api/login` | Verified per-route config + `hook: 'preHandler'` keyed on IP+userId |
| @node-rs/argon2 | 2.2.2 | argon2id | Defaults verified: `$argon2id$v=19$m=19456,t=2,p=1$` (OWASP minimum) |
| better-sqlite3 | 13.0.3 | SQLite driver | WAL verified |
| drizzle-orm / drizzle-kit | 0.45.4 / 0.31.11 | Schema, migrations | `generate` + `migrate()` at boot verified |
| jose | 6.2.12 | Mint SFU HS256 tokens | Mint/verify round-trip verified with the SFU's verify options |
| zod | 4.6.5 | Request/env validation, shared schemas | Project stack |
| tsx | 4.23.15 | Run TS server in dev/prod | Must be a **runtime** dependency of `server/` |

### Supporting

| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| @sideby-me/rtc | 0.9.0 (GitHub Packages, private) | SFU client for `/debug/sfu` | **Ops-track plan only.** Add it once the `read:packages` token exists; adding it earlier breaks `npm ci` |
| vitest | 5.0.3 | Server tests via `fastify.inject` | Wave 0 |
| @types/better-sqlite3 | 9.6.0 | Types | dev |
| @tanstack/react-query | 5.104.1 | Optional in Phase 1 (`/api/me`); required in Phase 2 | Fine to add now for the `me` query |

**Container images (verified tags):** `node:24-bookworm-slim`; `cloudflare/cloudflared:2026.10.0` (runs as `65532:65532`, entrypoint `cloudflared --no-autoupdate`) [VERIFIED: `docker image inspect`]; `coturn/coturn:4.11.0` (exists on Docker Hub; 4.18.0 is newest) [VERIFIED: hub API]; `nginx:1.27`; `alpine:3` (busybox `ip link add … type dummy` works) [VERIFIED: executed in an isolated netns]; `certbot/dns-cloudflare` [VERIFIED: hub tags exist]; `ghcr.io/sideby-me/sfu.sideby.me:0.9.2` (the SFU compose pin; **private**, see Environment).

**Do NOT install:** `otplib`, `qrcode`, `input-otp` (D-05), `lucide-react`, `@radix-ui/*`, `serwist`, a standalone `mediasoup-client` (3.24.5 is the latest; the SDK pins 3.20.0), `sharp` (icons are generated once with ImageMagick and committed).

**Installation (app track):**
```bash
# repo root
npx -y shadcn@4.21.4 init -t next -p b51GFhBEQ --name web --yes      # creates ./web (verified)
rm -rf web/.git web/package-lock.json                                  # nested repo + lockfile (see Pitfalls)
cd web && npx shadcn@4.21.4 add avatar empty dropdown-menu input field card spinner sonner item label --yes && cd ..
npm i -w server fastify@5.12.5 @fastify/static@10.1.5 @fastify/cookie@11.1.3 @fastify/rate-limit@11.2.1 \
  @node-rs/argon2@2.2.2 better-sqlite3@13.0.3 drizzle-orm@0.45.4 jose@6.2.12 zod@4.6.5 tsx@4.23.15
npm i -w server -D drizzle-kit@0.31.11 vitest@5.0.3 @types/better-sqlite3 typescript@^5
```
`shadcn add` for those components produced `avatar, button, card, dropdown-menu, empty, field, input, item, label, separator, sonner, spinner`, with no lucide or Radix imports (grep was empty) [VERIFIED: executed].

## Package Legitimacy Audit

`gsd-tools query package-legitimacy check --ecosystem npm` was run on 2026-10-08. Every "SUS" verdict carries only the reason `too-new`: the **latest version** was published recently. The packages themselves are long-established. Examples: fastify was created 2016-10-07 and has ~18.1M weekly downloads; @node-rs/argon2 was created 2021-12-29 and has ~1.9M/wk. No package has a postinstall script (`npm view <pkg> scripts.postinstall` was empty for all of them).

| Package | Registry | Age | Downloads | Source Repo | Verdict | Disposition |
|---------|----------|-----|-----------|-------------|---------|-------------|
| fastify 5.12.5 | npm | 10 yrs (ver 2026-09-16) | ~18.1M/wk | github.com/fastify/fastify | SUS (too-new version) | Approved, exact pin |
| @fastify/static 10.1.5 | npm | multi-yr | high | github.com/fastify/fastify-static | SUS (too-new) | Approved, exact pin |
| @fastify/cookie 11.1.3 | npm | multi-yr | high | github.com/fastify/fastify-cookie | SUS (too-new) | Approved, exact pin |
| @fastify/rate-limit 11.2.1 | npm | multi-yr | high | github.com/fastify/fastify-rate-limit | SUS (too-new) | Approved, exact pin |
| @node-rs/argon2 2.2.2 | npm | ~5 yrs (ver **2026-10-06**, 2 days old) | ~1.9M/wk | github.com/napi-rs/node-rs | SUS (too-new) | Flagged. Planner adds a `checkpoint:human-verify`, or pins **2.2.1** (2026-09-10) |
| better-sqlite3 13.0.3 | npm | multi-yr | high | github.com/WiseLibs/better-sqlite3 | OK | Approved |
| drizzle-orm 0.45.4 / drizzle-kit 0.31.11 | npm | multi-yr | high | github.com/drizzle-team/drizzle-orm | SUS (too-new) | Approved, exact pin |
| jose 6.2.12 | npm | multi-yr | high | github.com/panva/jose | OK | Approved |
| zod 4.6.5 | npm | multi-yr | high | github.com/colinhacks/zod | SUS (too-new) | Approved, exact pin |
| tsx 4.23.15 | npm | multi-yr | high | github.com/privatenumber/tsx | SUS (too-new) | Approved, exact pin |
| vitest 5.0.3 | npm | multi-yr (ver 2026-09-30) | ~142M/wk | github.com/vitest-dev/vitest | SUS (too-new) | Approved, exact pin |
| @types/better-sqlite3 | npm | multi-yr | ~5.9M/wk | DefinitelyTyped | OK | Approved |
| shadcn 4.21.4 | npm | multi-yr | high | github.com/shadcn-ui/ui | SUS (too-new) | Approved (locked by project) |
| @sideby-me/rtc 0.9.0 | GitHub Packages | owner's own | n/a | github.com/sideby-me/rtc.sideby.me | not checkable (private) | Approved (owner's SDK; source read) |

**Packages removed due to [SLOP] verdict:** none.
**Packages flagged as suspicious [SUS]:** All the "too-new" items above are established packages with recent releases. Mitigation: exact version pins plus a committed lockfile. `@node-rs/argon2@2.2.2` is only 2 days old: the planner should either add a `checkpoint:human-verify` before installing it or pin `2.2.1`.

## Architecture Patterns

### System Architecture Diagram

```
                         ┌──────────────── Cloudflare edge (TLS, CF-Connecting-IP) ───────────────┐
 iPhone / Pixel PWA ─────┤ https://duet.brkn.me                                                    │
   │                     └──────────────┬─────────────────────────────────────────────────────────┘
   │                                    │ outbound tunnel (QUIC/HTTP2)
   │                     ┌──────────────▼──────────────┐   compose network "duet"
   │                     │ cloudflared (uid 1000)      │──http://duet:3100──┐
   │                     └─────────────────────────────┘                    │
   │                                                     ┌──────────────────▼───────────────────────┐
   │                                                     │ duet (Fastify, node 24)                  │
   │                                                     │  onRequest: Origin check (POST /api/*)   │
   │                                                     │  /api/users  /api/login(rate-limit)      │
   │                                                     │  /api/me /api/logout  (requireUser)      │
   │                                                     │  /api/debug/sfu-token (requireUser→jose) │
   │                                                     │  /api/debug/sfu-report → log             │
   │                                                     │  static web/out (manifest, sw.js, icons) │
   │                                                     └──────────────┬───────────────────────────┘
   │                                                                    │ better-sqlite3 (WAL)
   │                                                            /data/duet.sqlite  (bind ./data)
   │
   │  media plane (does NOT touch Cloudflare)
   │   wss://sfu.brkn.me:443 ─┐            UDP/TCP 103.198.98.196:44444-44445 (direct ICE)
   │   turns:turn.brkn.me:443 ┤            UDP 443 → 3478 (stun:/turn: udp)
   ▼                          ▼
 outer router 192.168.10.1 (PPPoE, WAN must == 103.198.98.196) ── DMZ → 192.168.10.100
   └─ inner TP-Link 192.168.0.1 ── port-forwards → 192.168.0.132 (this box, Wi-Fi, host network)
        ├─ nginx-sni  192.168.0.132:443  (ssl_preread)  sfu.brkn.me→127.0.0.1:8443 | turn.brkn.me→127.0.0.1:5349 | default→127.0.0.1:3478
        ├─ sfu (mediasoup, 2 workers) bind 192.168.0.132:44444-5 announce 103.198.98.196 ; bind+announce 10.99.0.1:44444-5
        ├─ coturn listen 192.168.0.132 + 127.0.0.1 (3478, tls 5349) → relays ONLY to 10.99.0.1 (sfu0 dummy iface)
        └─ relay-iface sidecar (NET_ADMIN) keeps sfu0=10.99.0.1/32 up
```

### Recommended Project Structure

```
duet/
├── package.json              # npm workspaces: web, server, shared (ONE lockfile at root)
├── .npmrc                    # @sideby-me:registry=https://npm.pkg.github.com + ${NODE_AUTH_TOKEN} (harmless when unset, verified)
├── Dockerfile                # build web export + server deps → node:24-bookworm-slim runtime, USER node
├── compose.yaml              # duet + cloudflared (project "duet"); ./data:/data
├── .env.example              # APP_ORIGIN, SFU_URL, TURN_HOST, SFU_TOKEN_SECRET, COOKIE_SECURE, DATA_DIR
├── deploy/cloudflared/       # config.yml (committed), credentials.json (gitignored)
├── web/                      # shadcn scaffold (components/ui untouched)
│   ├── app/layout.tsx        # metadata/viewport (appleWebApp, themeColor), html.dark, ThemeProvider forcedTheme
│   ├── app/manifest.ts       # export const dynamic = "force-static"
│   ├── app/page.tsx          # client gate: /api/me → <Login/> or <Shell/>
│   ├── app/debug/sfu/page.tsx# ops-track harness (client-only, dynamic import of SDK)
│   ├── components/app/       # LoginTiles, PasswordStep, Shell, SfuHarness (compose preset components only)
│   ├── lib/api.ts            # fetch wrapper (credentials: 'same-origin', JSON, 401 → login)
│   ├── lib/pc-capture.ts     # RTCPeerConnection wrapper (force relay + stats)
│   └── public/{sw.js,icons/} # minimal SW (no fetch handler); generated PNGs committed
├── server/
│   ├── src/index.ts          # Fastify boot, plugin order, static, not-found
│   ├── src/config.ts         # zod-validated env (fail fast)
│   ├── src/db/{schema.ts,client.ts}  + drizzle/ (generated SQL, committed)
│   ├── src/auth/{password.ts,session.ts,routes.ts}
│   ├── src/sfu/token.ts      # mintJoinToken (reused by Phase 3)
│   ├── scripts/seed-users.ts # idempotent; prompts for passwords (no shell history)
│   └── test/*.test.ts
├── shared/src/{api.ts,sfu.ts}# zod schemas: LoginBody, MeResponse, SfuTokenResponse
├── scripts/gen-icons.mjs     # Phosphor path → SVG → ImageMagick PNGs (dev-time, run once)
└── ops/sfu/                  # SEPARATE compose project "duet-sfu" (D-14)
    ├── compose.yaml          # relay-iface, sfu, coturn, nginx-sni (all network_mode: host)
    ├── nginx-sni.conf        # brkn.me names, listen 192.168.0.132:443
    ├── turnserver.conf.tmpl  # rendered to turnserver.conf (gitignored) with the secret
    ├── .env.example          # SFU env (see below); .env gitignored
    ├── letsencrypt/          # certbot output (gitignored, root-owned)
    └── scripts/{certs.sh,renew.sh,cgnat-check.sh,dns.sh,ddns.sh}
```

### Pattern 1: Static export + Fastify, one origin

**What:** In production, Next builds `web/out` (`NEXT_EXPORT=1`) and Fastify serves it together with `/api/*`. In dev, `next dev` proxies `/api` to Fastify on :3100.
**Verified config** (built for export with no warnings; dev rewrite proxied):
```ts
// web/next.config.ts  — Source: executed in scratch scaffold 2026-10-08
import type { NextConfig } from "next"
const isExport = !!process.env.NEXT_EXPORT
const nextConfig: NextConfig = {
  output: isExport ? "export" : undefined,
  trailingSlash: true,            // emits debug/sfu/index.html; Fastify redirect:true handles /debug/sfu → /debug/sfu/
  images: { unoptimized: true },
  ...(isExport ? {} : {
    async rewrites() {
      return [{ source: "/api/:path*", destination: "http://localhost:3100/api/:path*" }]
    },
  }),
}
export default nextConfig
```
Note: in dev, `trailingSlash` makes `POST /api/login` answer `308 → /api/login/` (verified). A 308 keeps the method and body, and the proxied path reaches Fastify as `/api/login`, so it works with one extra hop.

```ts
// server/src/index.ts (static part) — Source: executed Fastify 5.12.5 + @fastify/static 10.1.5
await app.register(fastifyStatic, {
  root: WEB_OUT,
  redirect: true,                      // /debug/sfu → 301 /debug/sfu/
  setHeaders(reply, filePath) {        // v10: FIRST ARG IS THE FASTIFY REPLY (reply.header), not raw res
    if (filePath.endsWith(".html") || filePath.endsWith("sw.js") || filePath.endsWith(".webmanifest"))
      reply.header("Cache-Control", "no-cache")
    else if (filePath.includes("/_next/static/"))
      reply.header("Cache-Control", "public, max-age=31536000, immutable")
  },
})
app.setNotFoundHandler((req, reply) =>
  req.url.startsWith("/api/")
    ? reply.code(404).send({ error: "not_found" })
    : reply.code(404).type("text/html").sendFile("404.html"))
```
Observed responses: `/` 200 html; `/debug/sfu` 301; `/manifest.webmanifest` 200 `application/manifest+json`; `/nope` 404 html; `/api/nope` 404 json. Note: `wildcard: false` crashed at boot with "The path could not be empty", so keep the default.

### Pattern 2: Password login + opaque rolling session

```ts
// server/src/auth/session.ts — pattern (values D-06)
import { createHash, randomBytes } from "node:crypto"
const COOKIE = "duet_session"
const TTL_MS = 90 * 24 * 60 * 60 * 1000
const RENEW_AFTER_MS = 24 * 60 * 60 * 1000          // throttle DB writes + cookie re-issue to ≤1/day
export const hashToken = (t: string) => createHash("sha256").update(t).digest("hex")

export function issue(reply, userId: string, ua?: string) {
  const token = randomBytes(32).toString("base64url")  // 256-bit
  const now = Date.now()
  db.insert(sessions).values({ id: hashToken(token), userId, createdAt: new Date(now),
    lastSeenAt: new Date(now), expiresAt: new Date(now + TTL_MS), userAgent: ua ?? null }).run()
  setCookie(reply, token)
}
export function setCookie(reply, token: string) {
  reply.setCookie(COOKIE, token, { httpOnly: true, secure: config.COOKIE_SECURE, sameSite: "lax",
    path: "/", maxAge: TTL_MS / 1000 })              // @fastify/cookie maxAge is SECONDS (verified Max-Age=7776000)
}
// requireUser preHandler: cookie → hashToken → row; missing/expired → delete row, clearCookie, 401.
// If now - lastSeenAt > RENEW_AFTER_MS → update lastSeenAt/expiresAt AND setCookie(reply, token) again.
```
The login route uses a per-route rate limit. This was verified: requests 1–3 returned 200, request 4 returned 429; another user from the same IP got 200; the same user from another IP got 200.
```ts
await app.register(rateLimit, { global: false })
app.post("/api/login", { config: { rateLimit: {
    max: 5, timeWindow: "5 minutes",
    hook: "preHandler",                                    // REQUIRED: default onRequest runs before body parsing
    keyGenerator: (req) => `${req.headers["cf-connecting-ip"] ?? req.ip}:${(req.body as any)?.userId ?? "-"}`,
  } } }, async (req, reply) => {
  const { userId, password } = LoginBody.parse(req.body)     // zod, shared/
  const user = db.select().from(users).where(eq(users.id, userId)).get()
  const ok = user ? await verify(user.passwordHash, password) : (await verify(DUMMY_HASH, password), false)
  if (!ok) return reply.code(401).send({ error: "wrong_password" })   // generic copy: "Wrong password"
  issue(reply, user.id, req.headers["user-agent"]); return { ok: true }
})
```

### Pattern 3: Seed script (AUTH-01, D-07)
- Run it inside the container (`docker compose exec duet node --import tsx server/scripts/seed-users.ts`) so it writes to the real `/data` DB.
- Prompt for each password with input hidden (Node `readline` with muted output) so passwords never reach shell history. Optionally read `DUET_SEED_FILE` (JSON, mode 600) for automation.
- Reject passwords shorter than 12 characters.
- Upsert by `username` (verified Drizzle `onConflictDoUpdate({ target: users.username, set: {...} })`).
- Enforce exactly 2 rows; exit non-zero if a third would be created.
- **On a password change, delete that user's sessions.** A reset must revoke stolen sessions.
- Hash with `hash(pw)` from `@node-rs/argon2`. The defaults are already argon2id m=19456 t=2 p=1, so **do not import the `Algorithm` const enum**: it is declared `export declare const enum Algorithm` [VERIFIED: package/index.d.ts], and const enums don't survive `isolatedModules`/esbuild (tsx).

### Pattern 4: Always-dark preset with no token edits
- `<html className={cn("dark", ...)}>` and `<ThemeProvider forcedTheme="dark">`. The scaffold's `ThemeProvider` mounts a `ThemeHotkey` that calls `setTheme(...)` when **"d"** is pressed outside inputs [VERIFIED: scratch `components/theme-provider.tsx`]. `forcedTheme` neutralizes it without editing the component.
- Hex values for manifest/meta, computed from the preset's own `.dark` tokens in `app/globals.css:85-117` (verbatim `--background: oklch(0.148 0.004 228.8);`, `--primary: oklch(0.455 0.188 13.697);`, `--primary-foreground: oklch(0.969 0.015 12.422);`). By oklch→sRGB conversion: background **`#090b0c`**, primary **`#a50036`**, primary-foreground **`#fff1f2`**. Re-derive them if the scaffold output ever differs.
- Layout wrappers (not tokens) handle the safe areas: `min-h-dvh`, and `pt-[env(safe-area-inset-top)]` on the header because of `black-translucent`.

### Pattern 5: PWA metadata (verified emitted tags)
```ts
// web/app/layout.tsx additions — Source: executed static export; emitted tags below
export const metadata: Metadata = {
  title: "duet",
  appleWebApp: { capable: true, title: "duet", statusBarStyle: "black-translucent" },
  icons: { apple: "/icons/apple-touch-icon.png" },
}
export const viewport: Viewport = { themeColor: "#090b0c", viewportFit: "cover", colorScheme: "dark" }
```
Emitted tags: `<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover"/>`, `<meta name="theme-color" content="#090b0c"/>`, `<link rel="manifest" href="/manifest.webmanifest"/>`, `<meta name="mobile-web-app-capable" content="yes"/>`, `<meta name="apple-mobile-web-app-title" content="duet"/>`, `<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent"/>`, `<link rel="apple-touch-icon" href="/icons/apple-touch-icon.png"/>`. Note that Next 16 emits `mobile-web-app-capable`, not the `apple-` variant.

```ts
// web/app/manifest.ts — verified to emit out/manifest.webmanifest
import type { MetadataRoute } from "next"
export const dynamic = "force-static"
export default function manifest(): MetadataRoute.Manifest {
  return { id: "/", name: "duet", short_name: "duet", start_url: "/", scope: "/", display: "standalone",
    background_color: "#090b0c", theme_color: "#090b0c",
    icons: [
      { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png" },
      { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png" },
      { src: "/icons/icon-maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ] }
}
```

**Icons (D-09):**
- `next/og` `ImageResponse` with a Phosphor React component **fails** in the static export: "Only intrinsic elements are supported inside <svg>" [VERIFIED: executed].
- Instead, extract the fill-weight path from `node_modules/@phosphor-icons/react/dist/defs/Heart.es.js` (viewBox 256). Wrap it in an SVG with a `#a50036` background and a `#fff1f2` glyph, and rasterize with ImageMagick (`/usr/bin/magick`, present on the box) to `apple-touch-icon.png` (180, opaque), `icon-192.png`, `icon-512.png`, and `icon-maskable-512.png` (glyph padded about 28% for the safe zone). Add `-depth 8`. This was executed and the output inspected.
- Commit the PNGs. Nothing is generated in Docker.

**Service worker in Phase 1:**
- Register `/sw.js` containing only `install` → `skipWaiting` and `activate` → `clients.claim`. **No fetch handler**: it would interfere with Range and auth later.
- Chrome's menu install has not needed a fetch handler since Chrome 108 on mobile [CITED: developer.chrome.com/blog/update-install-criteria].
- Push handlers arrive in Phase 2.

### Pattern 6: Cloudflare Tunnel for duet.brkn.me (INFR-01)

The box already has `~/.cloudflared/cert.pem` plus systemd-run tunnels for `*.sideby.me` [VERIFIED: config files, systemctl]. Recommended steps:
1. `cloudflared tunnel create duet` on the host. Tunnel creation is account-level and writes `~/.cloudflared/<UUID>.json`. If cert.pem is rejected, back it up and run `cloudflared tunnel login`, selecting **brkn.me**.
2. **Do not use `cloudflared tunnel route dns`.** cert.pem was minted for the sideby.me zone, and a known cloudflared bug can create `duet.brkn.me.sideby.me` [CITED: cloudflared mirror commit "Fix cloudflared tunnel route dns zone resolution bug", 2026-03; LOW]. Create a **proxied CNAME** `duet` → `<UUID>.cfargotunnel.com` in the brkn.me zone through the Cloudflare API (with the user-supplied token, Zone:DNS:Edit for brkn.me) or in the dashboard. Touch no other records (D-01).
3. Run cloudflared in duet's compose with `user: "1000:1000"`. The image runs as `65532:65532` and cannot read the `0400` credentials file owned by uid 1000 [VERIFIED: image inspect + file mode].
```yaml
# compose.yaml (duet)
name: duet
services:
  duet:
    build: { context: . }            # add `secrets: [npm_token]` only in the ops-track plan
    restart: unless-stopped
    env_file: .env
    environment: { DATA_DIR: /data, PORT: "3100", HOST: "0.0.0.0" }
    volumes: ["./data:/data"]
    # no `ports:` — reachable only through cloudflared → CF-Connecting-IP is trustworthy
  cloudflared:
    image: cloudflare/cloudflared:2026.10.0
    restart: unless-stopped
    user: "1000:1000"
    command: tunnel --config /etc/cloudflared/config.yml run
    volumes: ["./deploy/cloudflared:/etc/cloudflared:ro"]
    depends_on: [duet]
```
```yaml
# deploy/cloudflared/config.yml
tunnel: <UUID>
credentials-file: /etc/cloudflared/credentials.json
no-autoupdate: true
ingress:
  - hostname: duet.brkn.me
    service: http://duet:3100
  - service: http_status:404
```
Build secret for the private SDK (verified: `compose build` exposed it at `/run/secrets/npm_token`):
```yaml
services: { duet: { build: { context: ., secrets: [npm_token] } } }
secrets: { npm_token: { environment: NODE_AUTH_TOKEN } }
# Dockerfile: RUN --mount=type=secret,id=npm_token NODE_AUTH_TOKEN="$(cat /run/secrets/npm_token)" npm ci
```

### Pattern 7 (historical — SFU, do not plan): Home SFU stack (INFR-03), separate compose project `duet-sfu`

**Env (`ops/sfu/.env`).** The names are verbatim from `sfu.sideby.me/src/config.ts:74-91`:
```
announcedIp: requireEnv('MEDIASOUP_ANNOUNCED_IP'),
listenIp: process.env.MEDIASOUP_LISTEN_IP?.trim() || requireEnv('MEDIASOUP_ANNOUNCED_IP'),
privateIp: process.env.MEDIASOUP_PRIVATE_IP?.trim() ?? '',
rtcBasePort: Number(process.env.RTC_BASE_PORT ?? 44444),
tokenSecret: requireEnv('SFU_TOKEN_SECRET'),
protocolVersion: Number(process.env.SFU_PROTOCOL_VERSION ?? 1),
clockToleranceSec: Number(process.env.SFU_CLOCK_TOLERANCE_SEC ?? 60),
adminSecret: process.env.SFU_ADMIN_SECRET ?? '',
turnStaticAuthSecret: process.env.TURN_STATIC_AUTH_SECRET ?? '',
turnPublicHost: process.env.TURN_PUBLIC_HOST ?? '',
tlsCertPath: process.env.SFU_TLS_CERT ?? '',
tlsKeyPath: process.env.SFU_TLS_KEY ?? '',
turnCredTtlSec: Number(process.env.TURN_CRED_TTL_SEC ?? 3600),
```
plus `const WSS_PORT = Number(process.env.SFU_WSS_PORT ?? 8443);` (`src/signaling/gateway.ts:43`) [VERIFIED: read via gh api this session]. Home values:
```
MEDIASOUP_ANNOUNCED_IP=103.198.98.196      # public egress (verified via api.ipify)
MEDIASOUP_LISTEN_IP=192.168.0.132          # box LAN IP (needs DHCP reservation)
MEDIASOUP_PRIVATE_IP=10.99.0.1             # sfu0 dummy iface (coturn relay leg)
RTC_BASE_PORT=44444
SFU_TOKEN_SECRET=<openssl rand -base64 48>  # NEW secret, also in duet .env; never sideby's
SFU_ADMIN_SECRET=<random>                   # admin listens on all ifaces :44443 — never forward
TURN_STATIC_AUTH_SECRET=<random>            # == static-auth-secret in turnserver.conf
TURN_PUBLIC_HOST=turn.brkn.me
SFU_TLS_CERT=/etc/letsencrypt/live/duet-sfu/fullchain.pem
SFU_TLS_KEY=/etc/letsencrypt/live/duet-sfu/privkey.pem
NODE_ENV=production
# Leave OTEL_EXPORTER_OTLP_ENDPOINT UNSET (bootstrap skips telemetry when unset; .env.example's localhost:4318 would be wrong)
```

**ICE servers the SFU hands out.** Verbatim `src/turn/ice-servers.ts:43-49`:
```
{ urls: `stun:${host}:443` },
{ urls: `turn:${host}:443?transport=udp`, username, credential },
{ urls: `turn:${host}:443?transport=tcp`, username, credential },
{ urls: `turns:${host}:443?transport=tcp`, username, credential },
```
Everything is on 443. So:
- **UDP 443 must be forwarded to coturn's 3478**, at the router (port translation) or by a host iptables REDIRECT.
- **Plain TCP to 443 carries no SNI.** Point nginx's `default` at coturn's plain port so `turn:…:443?transport=tcp` works too. This relies on non-TLS streams falling through with an empty SNI. That is inferred from the nginx doc example that maps an empty `$ssl_preread_protocol` to an SSH upstream [CITED: nginx.org ngx_stream_ssl_preread_module; inference, see A3].

```nginx
# ops/sfu/nginx-sni.conf  (original: sideby.me names at lines 27-29, `listen 443;` at line 45)
events {}
stream {
  map $ssl_preread_server_name $upstream {
    sfu.brkn.me   127.0.0.1:8443;   # SFU WSS (terminates own TLS)
    turn.brkn.me  127.0.0.1:5349;   # coturn turns:
    default       127.0.0.1:3478;   # non-TLS (plain TURN/TCP on :443) — original repo used sfu_wss here
  }
  server {
    listen 192.168.0.132:443;       # NOT `listen 443` — tailscale holds 100.97.55.101:443 → EADDRINUSE (reproduced)
    ssl_preread on;
    proxy_pass $upstream;
  }
}
```

```
# ops/sfu/turnserver.conf.tmpl  (derived from turnserver.conf.example: listening-ip lines 36-37, external-ip 57,
#   min/max-port 64-65, use-auth-secret 68, static-auth-secret 70, cert/pkey 79-80, allowed-peer-ip 100, total-quota 106)
listening-port=3478
tls-listening-port=5349
listening-ip=192.168.0.132
listening-ip=127.0.0.1
relay-ip=192.168.0.132
external-ip=103.198.98.196/192.168.0.132
realm=brkn.me
server-name=turn.brkn.me
min-port=49160
max-port=49260
use-auth-secret
static-auth-secret=${TURN_STATIC_AUTH_SECRET}
lt-cred-mech
fingerprint
cert=/etc/letsencrypt/live/duet-sfu/fullchain.pem
pkey=/etc/letsencrypt/live/duet-sfu/privkey.pem
log-file=stdout
simple-log
no-cli
no-multicast-peers
no-tcp-relay
denied-peer-ip=0.0.0.0-255.255.255.255   # home-LAN SSRF guard: relay ONLY to the SFU
allowed-peer-ip=10.99.0.1                # "specified as both allowed and denied → allowed" (coturn docs)
total-quota=100
```
coturn doesn't expand env vars, so render the template with `envsubst` into a gitignored `turnserver.conf`.

```yaml
# ops/sfu/compose.yaml
name: duet-sfu
services:
  relay-iface:                       # replaces scripts/sfu-relay-iface.service (needs no sudo; user is in docker group)
    image: alpine:3
    network_mode: host
    cap_add: [NET_ADMIN]
    restart: unless-stopped
    command: ["sh","-c","ip link show sfu0 >/dev/null 2>&1 || ip link add sfu0 type dummy; ip link set sfu0 up; ip addr replace 10.99.0.1/32 dev sfu0; exec sleep infinity"]
  sfu:
    image: ghcr.io/sideby-me/sfu.sideby.me:0.9.2     # try 0.9.3 first (repo package.json is 0.9.3); private → docker login ghcr.io
    init: true
    network_mode: host
    restart: unless-stopped
    cpus: 2                                          # → cgroup cpu.max "200000 100000" → 2 workers → ports 44444-44445
    env_file: .env
    volumes: ["./letsencrypt:/etc/letsencrypt:ro"]
    depends_on: [relay-iface]
  coturn:
    image: coturn/coturn:4.11.0
    user: root                                       # reads root-only LE privkey (repo compose rationale)
    init: true
    network_mode: host
    restart: unless-stopped
    command: ["-c", "/etc/coturn/turnserver.conf"]
    volumes: ["./turnserver.conf:/etc/coturn/turnserver.conf:ro", "./letsencrypt:/etc/letsencrypt:ro"]
    depends_on: [relay-iface]
  nginx-sni:
    image: nginx:1.27
    init: true
    network_mode: host
    restart: unless-stopped
    volumes: ["./nginx-sni.conf:/etc/nginx/nginx.conf:ro"]
```
Why the worker cap matters: `const numWorkers = getCpuLimit();` (`src/mediasoup/workers.ts:78`) reads cgroup `cpu.max`. Unlimited containers show `max 100000`, which falls back to `os.cpus().length` = **16** on this box. `const port = config.rtcBasePort + workerIndex;` (`src/mediasoup/webrtc-server.ts:78`) then gives 16 ports. Both readings were verified with `docker run --cpus 2 … cat /sys/fs/cgroup/cpu.max` → `200000 100000`.

**Certificates.** Use DNS-01 with one SAN cert named `duet-sfu`, written to `ops/sfu/letsencrypt` (no sudo needed: the docker daemon writes as root):
```bash
docker run --rm -v "$PWD/letsencrypt:/etc/letsencrypt" -v "$PWD/cloudflare.ini:/cf.ini:ro" certbot/dns-cloudflare \
  certonly --dns-cloudflare --dns-cloudflare-credentials /cf.ini --cert-name duet-sfu \
  -d sfu.brkn.me -d turn.brkn.me --agree-tos -m <owner email> --non-interactive
# cloudflare.ini: dns_cloudflare_api_token = <token>   (chmod 600, gitignored)
```
For renewal, add a weekly user crontab entry (no sudo): run `certbot renew` in the same container. If `fullchain.pem`'s sha256 changed, then `docker kill -s USR2 duet-sfu-coturn-1 && docker restart duet-sfu-sfu-1`. The repo's `--deploy-hook` approach can't work here, because the hook would run inside the certbot container, which has no docker access.

### Pattern 8 (historical — superseded by Media Track Pattern M6): Smoke harness `/debug/sfu` (INFR-04, D-12)

The token contract is verbatim from `rtc-types/src/token.ts:27-33`:
```
mediaRoomId: z.string().min(1),
participantId: z.string().min(1),
canPublish: z.boolean(),
canSubscribe: z.boolean(),
protocolVersion: z.number().int().min(1),
```
The response shape is verbatim from `token.ts:14-20` (`sfuUrl: z.string().url()`, `mediaRoomId`, `participantId`, `token: z.string().min(1)`, `canPublish: z.boolean()`). How the SFU verifies (`sfu src/signaling/auth.ts:55-56,67,76,86`):
- `algorithms: ['HS256']` and `clockTolerance: config.clockToleranceSec`.
- The token's `mediaRoomId`/`participantId` must equal the join fields.
- It rejects `'participant_already_active'`.

The SDK fills the join fields from the token payload (`rtc/src/connect.ts:454-456`: `protocolVersion: 1,` `mediaRoomId: tokenPayload.mediaRoomId,` `participantId: tokenPayload.participantId,`).

```ts
// server/src/sfu/token.ts — round-trip verified with jose 6.2.12 + SFU verify options
import { SignJWT } from "jose"
import { randomUUID } from "node:crypto"
const key = new TextEncoder().encode(config.SFU_TOKEN_SECRET)
export async function mintJoinToken(mediaRoomId: string) {
  const participantId = randomUUID()                 // fresh per attempt → never participant_already_active
  const token = await new SignJWT({ mediaRoomId, participantId, canPublish: true, canSubscribe: true, protocolVersion: 1 })
    .setProtectedHeader({ alg: "HS256" }).setIssuedAt().setExpirationTime("2m").sign(key)
  return { sfuUrl: config.SFU_URL, mediaRoomId, participantId, token, canPublish: true }  // = MediaTokenResponse
}
// POST /api/debug/sfu-token {mediaRoomId: /^[a-z0-9-]{1,64}$/}  — preHandler: requireUser
// POST /api/debug/sfu-report {...}  — requireUser; req.log.info({ evt: "sfu_smoke", ...body })
```

```ts
// web/lib/pc-capture.ts — install BEFORE importing/connecting the SDK
// Works because mediasoup-client 3.20.0 does `this._pc = new RTCPeerConnection({ ...,
//   iceTransportPolicy: iceTransportPolicy ?? 'all' })` with the GLOBAL constructor
//   (lib/handlers/Chrome111.js:120-122, Safari12.js:115-117).
export const capturedPcs: RTCPeerConnection[] = []
export function installPcCapture(forceRelay: boolean) {
  const Native = window.RTCPeerConnection
  class Captured extends Native {
    constructor(cfg?: RTCConfiguration) {
      super(forceRelay ? { ...cfg, iceTransportPolicy: "relay" } : cfg)
      capturedPcs.push(this)
    }
  }
  window.RTCPeerConnection = Captured as unknown as typeof RTCPeerConnection
}
export async function sample() {
  let inboundRtpBytes = 0; const pairs: { local?: string; protocol?: string; relayProtocol?: string }[] = []
  for (const pc of capturedPcs) {
    if (pc.connectionState === "closed") continue
    const report = await pc.getStats(); const byId = new Map<string, any>(); report.forEach((r: any) => byId.set(r.id, r))
    report.forEach((r: any) => {
      if (r.type === "inbound-rtp") inboundRtpBytes += r.bytesReceived ?? 0       // THE gate metric
      if (r.type === "candidate-pair" && r.state === "succeeded" && (r.nominated || r.selected)) {
        const l = byId.get(r.localCandidateId)
        pairs.push({ local: l?.candidateType, protocol: l?.protocol, relayProtocol: l?.relayProtocol })
      }
    })
  }
  return { inboundRtpBytes, pairs }
}
```
Harness flow on **one phone** (on cellular, Wi-Fi off), mode chosen by `?relay=1` read at module load:
1. Call `installPcCapture`.
2. `getUserMedia({audio:true, video:true})` from a button tap.
3. Mint token A, `connect({url: sfuUrl, token, getToken: () => mint(room)})`, then `publishMic` + `publishCamera`.
4. Mint token B, `connect(...)`. B's existing producers are consumed at connect.
5. Attach B's `trackSubscribed` tracks to `<video autoPlay playsInline muted>`.
6. Poll `sample()` every second. Show **PASS** when `inboundRtpBytes > 0` and, in relay mode, every selected local candidate is `relay`.
7. POST the result plus the UA to `/api/debug/sfu-report`. Claude can then read it with `docker compose logs duet | grep sfu_smoke`, and the user doesn't need to transcribe anything.
8. Run once with `/debug/sfu/` and once with `/debug/sfu/?relay=1`.

Never use the SDK `networkQuality` bytes as the gate. It does `totals.bytesReceived += typeof report.bytesReceived === 'number' ? report.bytesReceived : 0;` over **every** stats report (`rtc/src/connect.ts:545`), which includes DTLS and transport bytes.

### Anti-Patterns to Avoid (SFU/nginx/coturn items are historical)
- **Wildcard `listen 443` in nginx-sni.** It fails next to Tailscale's `100.97.55.101:443`.
- **No CPU limit on the SFU container.** You get 16 workers and 16 ports to forward.
- **Using the repo's `turnserver.conf` "historical/0.0.0.0" forms.** coturn would own every host IP and refuse to relay to the SFU.
- **Forwarding the coturn relay range.** It is unnecessary here because the peer is local, and it is a big attack surface.
- **`cloudflared tunnel route dns` with the sideby.me cert.pem.** It risks wrong-zone records.
- **Publishing duet's port 3100 on the host.** Anything on the LAN could then forge `CF-Connecting-IP`.
- **Gating pages with HTML-level redirects in a static export.** Gate in the client and enforce at `/api/*`.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Password hashing | custom KDF/bcrypt | `@node-rs/argon2` `hash()/verify()` defaults | argon2id with OWASP params by default; prebuilt napi |
| Login throttling | in-memory counters | `@fastify/rate-limit` per-route + `hook: 'preHandler'` | 429 + `retry-after` handled; verified keying |
| HS256 JWT | manual base64/HMAC | `jose` `SignJWT` | Same lib the SFU verifies with |
| SFU handshake | raw mediasoup-client plumbing | `@sideby-me/rtc` `connect()` | The SDK owns join/transports/consume/resume |
| Forced relay | SDK fork/patch-package | `RTCPeerConnection` subclass (Pattern 8) | Zero SDK changes; also gives stats access |
| Static serving + Range | custom file handler | `@fastify/static` | Range/ETag/redirects built in |
| Certs for sfu./turn. | self-signed / manual | `certbot/dns-cloudflare` DNS-01 | :443 is passthrough and :80 isn't forwarded; strict TURN clients reject self-signed certs |
| Icons | design tooling / sharp | ImageMagick one-off + Phosphor path | Already on the box; output committed |
| Migrations | hand SQL at boot | drizzle-kit `generate` + `migrate()` | Verified flow |

**Key insight:** the risky parts of this phase are configuration surfaces (NAT, ports, SNI, cgroups, cookie re-issue), not code volume. Every config value above was read from source or reproduced on this box. Do not "improve" them from memory.

## Common Pitfalls

### Pitfall 1: Nested git repo and second lockfile from the scaffold
**What goes wrong:** `shadcn init` creates `web/.git` (with a commit "feat: initial commit") and `web/package-lock.json` [VERIFIED: executed]. Committing makes `web/` a gitlink, or two lockfiles fight inside the workspace.
**How to avoid:** Right after init, `rm -rf web/.git web/package-lock.json`, then `npm install` at the root. Keep the scaffold's `AGENTS.md`/`CLAUDE.md` inside `web/` or delete them; they are Next agent docs, not project rules.

### Pitfall 2: The "d" hotkey flips the app to light mode
**What goes wrong:** The scaffold's `ThemeHotkey` toggles the theme on the `d` key (bluetooth keyboard, desktop testing).
**How to avoid:** `<ThemeProvider forcedTheme="dark">` plus `className="dark"` on `<html>`. Don't edit `components/ui/*`.

### Pitfall 3: Rate-limit key can't see the body
**What goes wrong:** With the default `onRequest` hook, `req.body` is undefined, so every user shares one bucket. One person's typos lock out the other [VERIFIED: the other user got 429 before the fix and 200 after].
**How to avoid:** `hook: 'preHandler'` in the route's `rateLimit` config.

### Pitfall 4: Every request comes from cloudflared
**What goes wrong:** `req.ip` is the cloudflared container's address, so the IP limit is global.
**How to avoid:** Key on `CF-Connecting-IP` [CITED: developers.cloudflare.com/fundamentals/reference/http-headers]. Don't publish 3100 on the host, so only cloudflared can set that header.

### Pitfall 5: Rolling session that doesn't roll
**What goes wrong:** Extending `expires_at` in the DB while the browser cookie still expires 90 days after login logs the user out on day 90 regardless.
**How to avoid:** Re-issue `Set-Cookie` with a fresh `Max-Age` when renewing (at most once a day).

### Pitfall 6: iOS installed app has its own cookie jar
**What goes wrong:** The user logs in in Safari, adds to the home screen, and the app opens logged out. Home-screen web apps keep storage separate from Safari [CITED: WebKit bug 181849, "by design"; MEDIUM].
**How to avoid:** UAT step: log in **inside** the installed app. Home-screen apps have their own ITP day counter, and WebKit says "We do not expect the first-party in such a web application to have its website data deleted" [CITED: webkit.org/blog/10218]. The httpOnly server-set cookie is not script-writable storage.

### Pitfall 7: `@fastify/static` v10 `setHeaders` signature
**What goes wrong:** Old snippets call `res.setHeader` and crash with "res.setHeader is not a function" [VERIFIED: executed].
**How to avoid:** `setHeaders(reply, path, stat) { reply.header(...) }`.

### Pitfall 8: Phosphor React icons in `next/og`
**What goes wrong:** The build fails with "Only intrinsic elements are supported inside <svg>".
**How to avoid:** Generate the icon PNGs offline (Pattern 5).

### Pitfall 9 (historical — SFU era): SFU worker/port explosion and bind conflicts
**What goes wrong:**
- 16 workers on 16 ports.
- nginx `listen 443` → EADDRINUSE.
- A LAN-IP change (DHCP) breaks `MEDIASOUP_LISTEN_IP`, coturn `listening-ip` and nginx `listen`.

**How to avoid:** `cpus: 2`; listen on `192.168.0.132:443`; **DHCP reservation for 192.168.0.132 on the TP-Link** (user checklist item).

### Pitfall 10 (historical — SFU era): Relay leg needs the sfu0 dummy interface
**What goes wrong:** coturn refuses to relay to its own listening IPs, so forced-relay media never flows (the README's documented failure).
**How to avoid:** `MEDIASOUP_PRIVATE_IP=10.99.0.1` plus `allowed-peer-ip=10.99.0.1` plus the `relay-iface` sidecar. After a reboot the sidecar and the SFU start concurrently. If sfu0 isn't up yet, the SFU fails to bind and `restart: unless-stopped` retries until it is (self-healing).

### Pitfall 11 (historical — SFU era): Wrong gate metric
**What goes wrong:** ICE reaches "connected" or the SDK's `networkQuality` bytes are > 0, yet no RTP flows. The README calls this the classic announcedAddress failure.
**How to avoid:** Use only `inbound-rtp.bytesReceived` (Pattern 8).

### Pitfall 12 (historical — SFU era): Home Wi-Fi hairpin (Phase 3 risk; observe it now)
**What goes wrong:** Phones on home Wi-Fi dial 103.198.98.196. Through double NAT without loopback, both the direct path and TURN fail.
**How to avoid / detect:** After forwards are in place, run `curl -sv --resolve sfu.brkn.me:443:103.198.98.196 https://sfu.brkn.me/` **from the box**. A TLS handshake there means hairpin works. Record the result. If it fails, Phase 3 needs either an extra LAN listenInfo (SFU patch) or router NAT loopback. It is not a Phase 1 gate (cellular is).

### Pitfall 13 (historical — SFU era): PPPoE address changes
**What goes wrong:** `MEDIASOUP_ANNOUNCED_IP`, coturn `external-ip` and the A records go stale after a reconnect.
**How to avoid:** Ask whether the IP is static (Open Question 2). If it isn't, add `ops/sfu/scripts/ddns.sh`, run from cron every 5 min:
1. Compare `curl -4 api.ipify.org` with `.env`.
2. If it changed, PATCH the sfu/turn A records via the API.
3. Re-render `.env` and `turnserver.conf`.
4. `docker compose up -d --force-recreate sfu coturn`.

### Pitfall 14 (historical — SFU era): npm token handling
**Facts:**
- The `.npmrc` `${NODE_AUTH_TOKEN}` line does **not** break unrelated installs when the variable is unset (verified with npm 10.9.8).
- Adding `@sideby-me/rtc` to `package.json` **does** break `npm ci` without the token.

**How to avoid:** Add the dependency and the compose `build.secrets` only in the ops-track plan. Never pass the token as an `ARG`.

## Code Examples
See Patterns 1–8 above. Every snippet marked "verified" was executed in `/tmp/claude-1000/.../scratchpad` on 2026-10-08 against the pinned versions.

Drizzle schema (verified with `drizzle-kit generate` and `migrate()`):
```ts
import { sqliteTable, text, integer } from "drizzle-orm/sqlite-core"
export const users = sqliteTable("users", {
  id: text("id").primaryKey(),
  username: text("username").notNull().unique(),
  displayName: text("display_name").notNull(),
  passwordHash: text("password_hash").notNull(),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
})
export const sessions = sqliteTable("sessions", {
  id: text("id").primaryKey(),                       // sha256(token) hex
  userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  lastSeenAt: integer("last_seen_at", { mode: "timestamp_ms" }).notNull(),
  expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
  userAgent: text("user_agent"),
})
// client.ts: new Database(`${DATA_DIR}/duet.sqlite`); pragma journal_mode=WAL, foreign_keys=ON, busy_timeout=5000;
// drizzle(sqlite); migrate(db, { migrationsFolder }) at boot   (verified journal_mode → "wal")
```

The login UI uses only preset parts:
- `Item`/`Card` tiles, each with `Avatar` → `AvatarFallback` initials and the name.
- On tap: `Field` + `Label` + `Input type="password" autoComplete="current-password"`, plus a hidden `<input autoComplete="username" value={username} readOnly hidden>` so iOS Keychain associates the right account.
- `Button` with a `Spinner` while submitting; error text "Wrong password".

The shell uses:
- A header with `Avatar` + the peer's name and a `DropdownMenu` (Base UI uses `render`, not `asChild`) containing "Log out", with a Phosphor `SignOutIcon`.
- An `Empty` placeholder for the message area.

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| iOS standalone only with meta tag/manifest | iOS 26: "Open as Web App" is **on by default** for any site added to the Home Screen | iOS 26 (2025) | Install always yields standalone unless the user flips the toggle; still ship the manifest + apple-touch-icon [CITED: heise.de/-10749652, WebKit Safari 26 notes via search; MEDIUM] |
| SW with fetch handler required for install | Not required for Chrome menu install since Chrome 108 (mobile) | 2022–23 | Phase 1 SW stays handler-free [CITED: developer.chrome.com/blog/update-install-criteria] |
| `apple-mobile-web-app-capable` | Next 16 emits `mobile-web-app-capable` | Next 15/16 | Fine for iOS ≥16.4, which reads the manifest `display` |
| `@fastify/static` `setHeaders(res)` | `setHeaders(reply)` | v10 | Use `reply.header` |
| `argon2` (node-gyp) | `@node-rs/argon2` prebuilt, argon2id defaults | — | No toolchain in Docker |

**Deprecated/outdated for this project:** the SFU repo's `scripts/sfu-relay-iface.service` (needs sudo; replaced by the sidecar), its `nginx-sni.conf` names and `listen 443`, its `turnserver.conf` sideby.me realm/cert paths, and its `--deploy-hook`-in-container assumption.

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | The outer router's WAN IP is the public 103.198.98.196 (not CGNAT) | CGNAT check | SFU can't be reached at home → D-15 pause (VPS or ISP) |
| A2 | The TP-Link and the outer router support port translation (external UDP 443 → internal 3478) and a DMZ host | Port forwards | Fall back to forwarding UDP 443→443 and a host `iptables -t nat -A PREROUTING -p udp --dport 443 -j REDIRECT --to-ports 3478` (needs sudo), or skip UDP TURN (turns: still works) |
| A3 | nginx `ssl_preread` forwards non-TLS streams with an empty SNI to `default` | nginx-sni.conf | Plain `turn:…:443?transport=tcp` fails; harmless, since turns:/UDP paths remain |
| A4 | A `gh auth refresh -s read:packages` OAuth token works for both `docker login ghcr.io` and `npm.pkg.github.com`; otherwise a classic PAT with `read:packages` | Ops tokens | User makes a classic PAT instead |
| A5 | `cloudflared tunnel create duet` works with the existing sideby.me cert.pem | Tunnel | Run `cloudflared tunnel login` (select brkn.me) first |
| A6 | `ghcr.io/sideby-me/sfu.sideby.me:0.9.3` exists (the repo is at 0.9.3; compose pins 0.9.2) | SFU compose | Use 0.9.2 |
| A7 | Safari exposes `candidate-pair.nominated` and `local-candidate.candidateType` in `getStats()` (relayProtocol may be Chrome-only) | Harness | Relay verification on iPhone relies on `candidateType` only; Pixel gives full detail |
| A8 | `@sideby-me/rtc` builds and runs in Safari under Turbopack (STACK verified the build with a mock only) | Harness | Fall back to `next build --webpack` |
| A9 | next-themes `forcedTheme` neutralizes `ThemeHotkey`'s `setTheme` visually | Dark mode | Remove the `ThemeHotkey` usage in our provider wrapper (it lives outside `components/ui`) |
| A10 | Two `connect()` sessions in one page (publisher + subscriber) work with the SDK | Harness | Use two devices (Pixel publishes on cellular, iPhone subscribes on cellular) |
| A11 | Cloudflare edge→cloudflared delivers `CF-Connecting-IP` through Tunnel (the doc covers proxied origins generally) | Rate limit | Fallback to `X-Forwarded-For` first hop |

## Open Questions

1. **CGNAT (blocking for the ops track).**
   - What we know:
     - Egress is 103.198.98.196 (DEN Aaron Cable Net, IN).
     - Path: TP-Link 192.168.0.1 (WAN 192.168.10.100) → outer router 192.168.10.1 (web UI reachable at `http://192.168.10.1`, server header "Virtual Web 0.9") → PPPoE peer 10.10.201.4.
     - `tailscale netcheck` shows `MappingVariesByDestIP: true`.
   - What's unclear: whether the PPPoE WAN address is public. A private PPPoE peer is common and is not proof either way.
   - Recommendation: the user reads the WAN/PPPoE IPv4 on the outer router's status page. If it equals the egress IP, there is no CGNAT. If it is 100.64.0.0/10, 10/8, 172.16/12 or 192.168/16, it is CGNAT → **stop and ask (D-15)**. After the forwards, prove it by falsification: `python3 -m http.server 44444 --bind 192.168.0.132` (before the SFU starts) and open `http://103.198.98.196:44444/` on a phone with Wi-Fi off.
2. **Static or dynamic public IP?** Ask the user or the ISP. If dynamic, include the DDNS script (Pitfall 13) in the ops plan.
3. **Which router layout?** Recommended: outer router DMZ → `192.168.10.100`, with forwards only on the TP-Link. The alternative is to forward on both routers.
4. **Owner email for Let's Encrypt** (`-m`). Use the git/user email or ask.

## Environment Availability

| Dependency | Required By | Available | Version | Fallback |
|------------|------------|-----------|---------|----------|
| Docker / Compose | All | ✓ | 29.6.1 / v5.2.0 | — |
| Node (host, dev) | Dev, scripts | ✓ | 22.23.1 (container: 24) | — |
| npm | Workspaces | ✓ | 10.9.8 | — |
| cloudflared (host) | `tunnel create` | ✓ | 2026.6.1 (image 2026.10.0) | Dashboard tunnel |
| ~/.cloudflared/cert.pem | `tunnel create` | ✓ (sideby.me zone) | — | `cloudflared tunnel login` |
| ImageMagick | Icon generation | ✓ | `/usr/bin/magick` | — |
| CPU / RAM / disk | SFU + app | ✓ | 16 cores, 14 GiB, 33 GB free on / | — |
| Ports 443 (LAN IP), 3478, 5349, 8443, 44443-44445 | SFU stack | ✓ free (443 only on 192.168.0.132) | — | — |
| passwordless sudo | sfu0 systemd unit, iptables | ✗ | — | `relay-iface` sidecar (docker group); router port translation |
| GitHub `read:packages` token | SFU image + `@sideby-me/rtc` | ✗ (gh token lacks scope; existing ghcr creds → `denied: denied` for 0.9.2) | — | **None: blocks the ops track** |
| Cloudflare API token (Zone:DNS:Edit, brkn.me) | DNS records, DNS-01, DDNS | ✗ | — | User creates records/certs manually in the dashboard |
| Router admin access (outer + TP-Link) | Forwards, DMZ, DHCP reservation | ✗ (user) | TP-Link UPnP/NAT-PMP enabled | — |
| brkn.me on Cloudflare | DNS | ✓ | NS carioca/jaxson.ns.cloudflare.com; apex A 216.198.79.1 (untouched) | — |
| Physical phones on cellular | INFR-04, SHEL-02 | user | — | — |

**Missing dependencies with no fallback:** the GitHub `read:packages` token (ops track only); router access plus a non-CGNAT IP (ops track only).
**Missing dependencies with fallback:** sudo (sidecar / router translation); the Cloudflare API token (manual dashboard steps).

## Validation Architecture (app track; INFR-03/04 and SFU-token rows are historical)

> **2026-10-09:** for INFR-03/INFR-04 use **Media Track → Validation Architecture** at the top of this file. The INFR-03, INFR-04 and "SFU token" rows below are SFU-era and must not be planned from. The app-track rows were executed by plans 01-01..01-03.

> `workflow.nyquist_validation` is `false` in config, but the orchestrator explicitly requested this section.

### Test Framework

| Property | Value |
|----------|-------|
| Framework | Vitest 5.0.3 (server), `fastify.inject()`; no browser test runner in Phase 1 |
| Config file | none → Wave 0 creates `server/vitest.config.ts` |
| Quick run command | `npm test -w server` (vitest run, < 10 s) |
| Full suite command | `npm test -w server && npm run typecheck -ws && NEXT_EXPORT=1 npm run build -w web && bash scripts/check-preset.sh` |

### Phase Requirements → Test Map

| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| AUTH-01 | Seed creates exactly 2, idempotent, rejects <12 chars, re-run resets the password and revokes sessions | unit | `npx vitest run test/seed.test.ts` | ❌ Wave 0 |
| AUTH-01 | No sign-up route/UI | unit + grep | `vitest run test/routes.test.ts` (POST /api/register, /api/signup → 404) + `! grep -rniE "sign ?up|register" web/app web/components/app` | ❌ Wave 0 |
| AUTH-02 | Correct password → 200 + cookie attrs; wrong → 401 generic; 6th attempt per IP+user → 429; other user unaffected | integration | `npx vitest run test/auth.test.ts` | ❌ Wave 0 |
| AUTH-03 | `/api/me` with valid cookie → 200; renewal re-issues Set-Cookie after 24 h (fake timers/DB edit); expired → 401 | integration | `npx vitest run test/session.test.ts` | ❌ Wave 0 |
| AUTH-04 | Logout deletes the row, clears the cookie; reused token → 401 | integration | `npx vitest run test/session.test.ts` | ❌ Wave 0 |
| SHEL-01 | No lucide/radix; `components/ui` only changed via the CLI | static check | `bash scripts/check-preset.sh` (`! grep -rE "lucide-react|@radix-ui" web/ --include=*.tsx`, `jq -e '.style=="base-luma"' web/components.json`) | ❌ Wave 0 |
| SHEL-02 | Manifest served with the correct MIME + fields; icons exist at declared sizes; head tags present | integration + file | `vitest run test/static.test.ts` (inject `/manifest.webmanifest`, `/icons/*`, parse `index.html`) + `identify web/public/icons/*.png` | ❌ Wave 0 |
| SHEL-02 | Installs standalone on iPhone + Pixel | **manual UAT** | Real devices (can't be automated cheaply) | — |
| INFR-01 | `https://duet.brkn.me/` 200 via the tunnel; `/api/me` 401 JSON | smoke | `curl -sf https://duet.brkn.me/ >/dev/null && curl -s -o /dev/null -w '%{http_code}' https://duet.brkn.me/api/me` → 401 | ❌ Wave 0 (`scripts/smoke-public.sh`) |
| INFR-02 | Data survives `docker compose restart` / `down && up` | smoke | `scripts/smoke-persistence.sh` (seed → count users → `docker compose down && up -d` → count == 2) | ❌ Wave 0 |
| INFR-03 | Local: nginx routes SNI correctly; certs valid; SFU logs 2 workers; coturn TLS up | smoke (box) | `openssl s_client -connect 192.168.0.132:443 -servername turn.brkn.me </dev/null \| grep -q 'CN.*sfu.brkn.me\|turn.brkn.me'`; `docker logs duet-sfu-sfu-1 \| grep -q '"numWorkers":2'` | ❌ Wave 0 (`ops/sfu/scripts/check-local.sh`) |
| INFR-03 | Public reachability (non-CGNAT) | **manual** (phone on cellular) | Temporary `http.server` on 44444 → open from the phone | — |
| INFR-04 | `inbound-rtp.bytesReceived > 0`, direct and `?relay=1` (selected local candidate = relay) | **manual on device**, auto-reported | Phone runs `/debug/sfu/` twice → `docker compose logs duet \| grep sfu_smoke` shows two PASS lines | — |
| SFU token | Minted token verifies with `algorithms:['HS256'], clockTolerance:60`; claims exactly the 5 keys; endpoint 401 without a session | unit | `npx vitest run test/sfu-token.test.ts` | ❌ Wave 0 |

### Sampling Rate
- **Per task commit:** `npm test -w server`
- **Per wave merge:** full suite command (tests + typecheck + export build + preset check)
- **Phase gate:** full suite green, plus the `smoke-public.sh` / `smoke-persistence.sh` scripts, plus manual UAT (install on both phones; log in inside the installed app; reopen after a force-quit; logout; cellular smoke direct + relay), before `/gsd-verify-work`

### Wave 0 Gaps
- [ ] `server/vitest.config.ts` and a `test/helpers.ts` (build the app with a temp `DATA_DIR`, seed 2 users)
- [ ] `server/test/{auth,session,seed,routes,static,sfu-token}.test.ts`
- [ ] `scripts/check-preset.sh`, `scripts/smoke-public.sh`, `scripts/smoke-persistence.sh`
- [ ] `ops/sfu/scripts/check-local.sh`
- [ ] Framework install: `npm i -w server -D vitest@5.0.3`

## Security Domain (app track; SFU/coturn/token rows are historical — see Media Track → Security Domain)

`security_enforcement: true`, ASVS level 1, block on high.

### Applicable ASVS Categories

| ASVS Category | Applies | Standard Control |
|---------------|---------|-----------------|
| V2 Authentication | yes | argon2id (`@node-rs/argon2` defaults); ≥12-char passwords enforced in the seed; `@fastify/rate-limit` 5 per 5 min per IP+user; generic error; dummy verify for unknown userId |
| V3 Session Management | yes | 256-bit random opaque token, stored as sha256; `HttpOnly; Secure; SameSite=Lax; Path=/`; new token per login (no fixation); server-side revoke on logout and on password reset; 90 d rolling (accepted by D-06) |
| V4 Access Control | yes | `requireUser` on every `/api/*` except `GET /api/users`, `POST /api/login`, `GET /healthz`; the debug token endpoint requires a session; the static HTML is public by design |
| V5 Input Validation | yes | zod schemas in `shared/` for every body; `mediaRoomId` regex `^[a-z0-9-]{1,64}$` |
| V6 Cryptography | yes | node `crypto.randomBytes`, argon2, `jose` HS256 (`alg` pinned on the verify side by the SFU); nothing hand-rolled |
| V12/V14 Config | yes | Secrets only in gitignored `.env` files; BuildKit secret for `NODE_AUTH_TOKEN`; new `SFU_TOKEN_SECRET` not shared with sideby; port 3100 not published |
| CSRF (V4/V13) | yes | SameSite=Lax + an `onRequest` check that `Origin === APP_ORIGIN` for non-GET `/api/*` + JSON-only bodies |

### Known Threat Patterns for this stack

| Pattern | STRIDE | Standard Mitigation |
|---------|--------|---------------------|
| Online password guessing against a known username (names are public, D-04) | Spoofing | Rate limit on IP+user via `CF-Connecting-IP`; ≥12-char passwords; argon2id cost |
| Client IP spoofing via a forged `CF-Connecting-IP` | Spoofing | No published app port; only cloudflared reaches duet |
| Session theft / replay | Spoofing | HttpOnly cookie; hashed at rest; revoke on reset/logout |
| CSRF on `/api/logout` or `/api/debug/*` | Tampering | Origin check + SameSite=Lax |
| SFU token minting by an outsider | Elevation | `requireUser` on `/api/debug/sfu-token`; 2-minute expiry; the secret stays server-side |
| TURN as an open relay / SSRF into the home LAN | Elevation / Info disclosure | HMAC time-limited creds (SFU-minted only on a valid join); `denied-peer-ip=0.0.0.0-255.255.255.255` + `allowed-peer-ip=10.99.0.1`; `no-tcp-relay`; `total-quota=100` |
| SFU admin surface exposure (`:44443`, all interfaces) | Elevation | Never forwarded; strong `SFU_ADMIN_SECRET`; duet never calls it |
| Home IP exposure via sfu./turn. A records | Info disclosure | Accepted (D-02); forward only the minimal port set |
| Secret leakage in the image | Info disclosure | BuildKit secret mount (verified), never `ARG`; `.dockerignore` excludes `.env*`, `data/`, `ops/sfu/letsencrypt` |

## Suggested Plan Shape (historical — app-track items 1-3 were executed as 01-01..01-03; item 4 is SFU-era and replaced by Media Track → Suggested Plan Shape)
1. **Scaffold + server skeleton** (wave 1): workspaces, preset init with the nested `.git`/lockfile removed, forced dark, icons, manifest, minimal SW, Fastify static + `/healthz`, Drizzle schema/migrate, Wave 0 test infra.
2. **Auth + shell UI** (wave 2): seed script, login/me/logout, rate limit, Origin check, login tiles, password step, chat-shaped empty shell with a logout menu.
3. **Docker + tunnel + device UAT** (wave 3): Dockerfile, compose with cloudflared, tunnel create, CNAME via API, smoke scripts, install on both phones (checkpoint).
4. **Ops track** (parallel after 1; user-gated checkpoints):
   - (a) CGNAT read-out (checkpoint; may pause per D-15).
   - (b) Tokens (CF API, `read:packages`).
   - (c) DNS A records, certs, `ops/sfu` stack, local checks.
   - (d) Router checklist (DMZ, forwards, DHCP reservation) plus an external reachability test.
   - (e) Add `@sideby-me/rtc`, the token endpoint and the `/debug/sfu` harness.
   - (f) Cellular smoke run (direct + relay) and a hairpin observation.

## Sources

### Primary (HIGH confidence)
- **Executed in this session (scratchpad):**
  - `shadcn@4.21.4 init -t next -p b51GFhBEQ` + `shadcn add …`.
  - `next build` static export with `manifest.ts`, `/debug/sfu`, metadata/viewport; `next/og` icon failure.
  - Fastify 5.12.5 / @fastify/static 10.1.5 / @fastify/rate-limit 11.2.1 / @fastify/cookie 11.1.3 behavior.
  - Drizzle 0.45.4 generate + migrate; @node-rs/argon2 2.2.2 defaults; jose 6.2.12 mint/verify.
  - Compose build secret; `--cpus` → `cpu.max`; busybox dummy iface.
  - Bind-conflict reproduction; `tailscale netcheck`; `docker image inspect cloudflared`; ghcr access probes; npm `.npmrc` unset-var behavior; ImageMagick icon render.
- **Source read via `gh api`:**
  - `sideby-me/sfu.sideby.me`: README, `.env.example`, `docker-compose.yml`, `nginx-sni.conf`, `turnserver.conf.example`, `src/config.ts`, `src/turn/ice-servers.ts`, `src/mediasoup/{webrtc-server,workers}.ts`, `src/signaling/{auth,gateway}.ts`, `src/http/admin.ts`, `src/telemetry/bootstrap.ts`, `scripts/*`, `Dockerfile`.
  - `sideby-me/rtc.sideby.me`: `packages/rtc-types/src/token.ts`, `packages/rtc/src/{types,connect}.ts`, `transport/{send,recv,device}.ts`, `package.json`.
- **npm tarball:** `mediasoup-client@3.20.0` `lib/handlers/{Chrome111,Safari12}.js`, `lib/Transport.js`.

### Secondary (MEDIUM confidence)
- https://web.dev/articles/install-criteria (2024-09-19). Chrome install criteria.
- https://developer.chrome.com/blog/update-install-criteria. Fetch handler not required for menu install (Chrome 108 mobile).
- https://github.com/fastify/fastify-rate-limit (README). `global:false`, `hook`, `keyGenerator`.
- https://developers.cloudflare.com/fundamentals/reference/http-headers/. CF-Connecting-IP.
- https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/get-started/create-remote-tunnel/. Dashboard tunnel flow.
- https://raw.githubusercontent.com/coturn/coturn/master/examples/etc/turnserver.conf. Allowed-over-denied precedence, external-ip format.
- https://nginx.org/en/docs/stream/ngx_stream_ssl_preread_module.html. Empty-protocol example.
- https://webkit.org/blog/10218/full-third-party-cookie-blocking-and-more/. Home-screen apps have their own day counter.

### Tertiary (LOW confidence)
- [heise: iOS 26 changed web app behaviour](https://heise.de/-10749652), [MacObserver iOS 26 home screen](https://www.macobserver.com/?p=402884), [ithinkdiff iOS 26 web app](https://www.ithinkdiff.com/add-web-app-bookmark-iphone-home-screen-ios-26/). "Open as Web App" defaults on.
- [WebKit bug 181849](https://bugs.webkit.org/show_bug.cgi?id=181849), [Xojo forum](https://forum.xojo.com/47447-cookies-safari-vs-home-screen-webapp). Separate home-screen storage.
- [cloudflared mirror commit: route dns zone bug](https://git.nixnet.services/curben/cloudflared-mirror/commit/ef095a3ac8e586ceffaf27bab920b9b289dadb50). Wrong-zone CNAME.

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH. Every version was checked with `npm view`, and the key behaviors were executed.
- Architecture (app track): HIGH. Built and served end-to-end in the scratchpad.
- Architecture (ops track): MEDIUM. The config comes from source plus local reproductions; public reachability, CGNAT and router capabilities are unverified until the user acts.
- Pitfalls: HIGH for the 10 reproduced here; MEDIUM for the iOS storage and hairpin items.

**Research date:** 2026-10-08
**Valid until:** 2026-11-07 for the app track. The ops facts (IP, router state) must be re-checked whenever they are used.
