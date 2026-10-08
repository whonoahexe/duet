<!-- GSD:project-start source:PROJECT.md -->

## Project

**duet**

A private, self-hosted chat app for exactly two people — the owner and their girlfriend. Text chat, images, short video clips, voice notes, and 1:1 voice/video calls, delivered as an installable PWA on an iPhone and a Pixel. Calls route through the owner's existing mediasoup SFU (`sfu.sideby.me`); everything else runs on the same machine.

**Core Value:** The two of us can reliably message and call each other — on both phones, including over cellular — on infrastructure we fully control.

### Constraints

- **UI**: shadcn preset `b51GFhBEQ` (`https://ui.shadcn.com/create?preset=b51GFhBEQ`) — locked, no deviation whatsoever. Init via `npx shadcn create --preset b51GFhBEQ` (or equivalent) and only use its components/tokens.
- **Timeline**: Fast — user does not want this to drag on for days. Prefer the simplest thing that works.
- **Hosting**: Self-hosted on this machine (Docker), alongside the SFU. Database + media files on local disk.
- **Platforms**: iPhone (Safari PWA) and Pixel (Chrome PWA).
- **Media plane**: Must use the existing SFU + coturn rather than building P2P/mesh.
- **Transport security**: HTTPS/WSS everywhere (required for PWA install, push, getUserMedia).

<!-- GSD:project-end -->

<!-- GSD:stack-start source:research/STACK.md -->

## Technology Stack

## TL;DR: the stack in one screen

| Layer | Pick | Version (verified 2026-10-08) |
|---|---|---|
| UI scaffold | `npx shadcn@4.21.4 init -t next -p b51GFhBEQ` → Next.js App Router, **Base UI** primitives, Tailwind v4, Phosphor icons, Space Grotesk | shadcn 4.21.4 · next 16.3.6 (pinned by the template) · react 19.3.0 · @base-ui/react 1.8.0 · tailwindcss 4.3.3 · @phosphor-icons/react 2.1.10 |
| UI build mode | `output: 'export'` (static SPA in `web/out`) | — |
| Server | **One** Node process: Fastify 5 serves `web/out`, `/api/*`, `/ws`, `/media/*` | node 24 LTS · fastify 5.12.5 |
| Realtime | `@fastify/websocket` (raw `ws`) carrying a zod-typed JSON protocol | @fastify/websocket 11.3.3 · ws 8.x |
| DB | SQLite file in WAL mode via better-sqlite3 + Drizzle ORM | better-sqlite3 13.0.3 · drizzle-orm 0.45.4 · drizzle-kit 0.31.11 |
| Auth | Hand-rolled: argon2id password + opaque session cookie (TOTP dropped 2026-10-08, see Phase 1 CONTEXT D-05) | @node-rs/argon2 2.2.2 |
| Files | Local disk volume `/data/media`, uploaded through `@fastify/multipart` and served through `@fastify/static` (HTTP Range support, which iOS video needs) behind an auth hook | @fastify/multipart 10.1.3 · @fastify/static 10.1.5 |
| Push | `web-push` with VAPID; a hand-written `public/sw.js` | web-push 3.6.7 |
| PWA | `app/manifest.ts` plus the hand-written SW. **No Serwist.** | — |
| Calls | **`@sideby-me/rtc` 0.9.0** (the owner's own SDK, which wraps `mediasoup-client`) + `jose` on the server to mint HS256 join tokens | @sideby-me/rtc 0.9.0 · mediasoup-client **3.20.0** (exact) · jose 6.2.x |
| Client data | TanStack Query (history pagination + cache patched by WS events) | @tanstack/react-query 5.104.1 |
| Validation | zod 4, with schemas shared by web and server | zod 4.6.5 |
| Container | `node:24-bookworm-slim`, one `duet` service, volume `/data` | Docker 29 / Compose v5 (present on the box) |
| Ingress | Cloudflare Tunnel (already used on this box by `sideby-staging`). Fallbacks: Tailscale Funnel, or Caddy 2.11 with a port-forward | cloudflared 2026.10.0 · caddy 2.11.7 |

## Recommended Stack

### Core Technologies

| Technology | Version | Purpose | Why Recommended | Confidence |
|---|---|---|---|---|
| **shadcn CLI, preset `b51GFhBEQ`** | shadcn 4.21.4 | Locked UI system | I decoded the preset with `shadcn preset decode b51GFhBEQ`: style **luma**, baseColor **mist**, theme/chart **rose**, iconLibrary **phosphor**, font **space-grotesk**, radius **large**, menuAccent subtle, menuColor default-translucent. A real `shadcn init -t next -p b51GFhBEQ` run produced `components.json` with `"style": "base-luma"`, i.e. **Base UI (`@base-ui/react`), not Radix**, plus `@phosphor-icons/react`, `next/font/google` Space_Grotesk, Tailwind v4, `tw-animate-css` and the `cn` package. The command is non-interactive, so the init is reproducible. | HIGH (executed) |
| **Next.js (App Router)** | 16.3.6 as scaffolded (16.4.0 is latest; a patch/minor bump is fine) | UI framework, built as a static export | It comes with the preset, so there is nothing to choose. Static export (`output: 'export'`) keeps the Next server runtime out of production: no custom-server and standalone conflict, no SSE/compression buffering, no route-handler singleton duplication. Everything interactive in this app is client-side anyway. Turbopack is the default bundler and builds the SDK's import pattern fine (tested, see Version Compatibility). | HIGH |
| **React** | 19.3.0 | UI runtime | Pinned by the scaffold. `@sideby-me/rtc` declares `react >=18` as a peer, and `watch.sideby.me` already runs it on React 19.1. | HIGH |
| **Node.js** | 24.x LTS (`node:24-bookworm-slim`) | Server runtime | Node 24 is Active LTS until 2026-10-20 and then in maintenance until 2028-04-30. Node 26 only becomes LTS on 2026-10-28, so don't start on it this week. better-sqlite3 13 requires Node ≥22. Use a Debian (glibc) image, not Alpine, so better-sqlite3 and @node-rs/argon2 use prebuilt binaries. | HIGH (Node release schedule.json) |
| **Fastify** | 5.12.5 | The one server process | One process serves static `web/out`, JSON API, WS upgrade, authenticated media with Range, and the push sender. Its plugins cover every need: `@fastify/websocket` for upgrades with cookie auth before `handleUpgrade`, `@fastify/static` for Range/206 responses (which iOS `<video>` playback needs), `@fastify/multipart` for streaming uploads to disk, `@fastify/rate-limit` for the login endpoint, and `@fastify/cookie`. | HIGH |
| **SQLite (better-sqlite3)** | 13.0.3 | All persistent data | Two users and one writer. The trade-off is clear: no DB server, no container, no connection pool, and backup is copying one file (`VACUUM INTO` or `.backup`). Use WAL mode, `foreign_keys=ON` and `busy_timeout`. Postgres adds a container, credentials and backups for zero benefit. | HIGH |
| **Drizzle ORM + drizzle-kit** | 0.45.4 / 0.31.11 | Typed schema, queries, migrations | Thin, SQL-shaped, with first-class `drizzle-orm/better-sqlite3` support. Run migrations at boot with `migrate()` from `drizzle-orm/better-sqlite3/migrator`. Stay on the **0.45 stable line**; 1.0 is still `rc`. | HIGH |
| **`@sideby-me/rtc`** | 0.9.0 (GitHub Packages, `restricted`) | Browser side of calls | The owner's own SDK, already used in production by `watch.sideby.me`. It implements the whole SFU handshake (see the SFU contract section below): `connect({ url, token, getToken })` → `SfuSession` with `publishMic/publishCamera`, `muteMic/muteCamera`, `setMicDevice/setCameraDevice`, events `trackSubscribed / trackUnsubscribed / trackMuted / participantLeft / reconnecting / reconnected / failed / networkQuality / audioLevel`, `getSnapshot()`, plus a `useMediaRoom` hook at `@sideby-me/rtc/react`. It includes ICE restart and full reconnect via `getToken()`. **This saves about a day compared with hand-writing mediasoup-client plumbing.** | HIGH (source read) |
| **mediasoup-client** | **3.20.0, exact pin** | WebRTC device/transport (a dependency of the SDK) | The SDK pins `mediasoup-client: "3.20.0"` and the SFU pins the same in its own package.json alongside server `mediasoup 3.20.5`. Don't add a separate newer copy (3.24.5 is latest), or you get two `Device` implementations in the bundle. Bump only together with the SDK. | HIGH |
| **jose** | 6.2.x | Mint SFU join tokens (HS256) on the server | It's the library the SFU uses to verify (`jose@^6.2.3`). Use `SignJWT` with `alg: 'HS256'`. | HIGH |

### Supporting Libraries

| Library | Version | Purpose | When to Use |
|---|---|---|---|
| `@fastify/websocket` | 11.3.3 | WS endpoint `/ws` | Always. Authenticate from the session cookie in the upgrade `preValidation` hook and reject with 401 before the socket opens. |
| `@fastify/static` | 10.1.5 | Serve `web/out` + `/media/*` | Always. Media sits behind an `onRequest` auth hook. Range requests come built-in, so iOS video plays. |
| `@fastify/multipart` | 10.1.3 | Streaming uploads (images, clips, voice notes) | Always. Set `limits.fileSize` (e.g. 100 MB). Stream to `/data/media/tmp` and rename atomically. Never buffer whole files in memory. |
| `@fastify/cookie` | 11.1.3 | Session cookie | Always. Use `httpOnly; Secure; SameSite=Lax; Path=/` with a 90-day sliding expiry. Re-entering TOTP on a phone PWA is painful. |
| `@fastify/rate-limit` | 11.2.1 | Throttle `/api/login` and `/api/totp` | Always. TOTP is only 6 digits. |
| `@node-rs/argon2` | 2.2.2 | argon2id password hashing | Always. Ships prebuilt napi binaries, so no node-gyp step in Docker (unlike `argon2` 0.45). |
| `otplib` | 13.5.0 | TOTP verify + `otpauth://` URI | Always. **v13 is a rewrite**: functional and async (`await verify({ secret, token })` returns `{ valid }`, plus `generateSecret()` and `generateURI({ issuer, label, secret })`). Older v12 `authenticator.*` snippets on the web won't work. |
| `qrcode` | 1.5.4 | Print the TOTP enrollment QR in the terminal | Only in the seed script (`QRCode.toString(uri, { type: 'terminal' })`). That way no enrollment UI is needed for two fixed accounts. |
| `web-push` | 3.6.7 | Send VAPID-signed Web Push | Always. Use `TTL` (short, ~45 s, for ring pushes), `urgency: 'high'` for calls, and `topic` to collapse/replace a ring with "missed call". Delete subscriptions on 404/410. The package was last published 2024-01; it's stable and still the de facto choice. |
| `@tanstack/react-query` | 5.104.1 | History pagination (`useInfiniteQuery`), cache | Always on the client. WS events update the cache through `queryClient.setQueryData`. |
| `zod` | 4.6.5 | Schemas for every REST body + WS frame in a `shared/` package | Always. The SFU's own `@sideby-me/rtc-types` is also zod 4. |
| `drizzle-kit` | 0.31.11 | `generate` SQL migrations from the TS schema | Dev-time. Commit the generated SQL. |
| `date-fns` | 4.4.0 | Message timestamps / day separators | Optional, small. `Intl.DateTimeFormat` also works. |
| `tsx` | 4.23.x | Run the TS server in dev (`tsx watch`) and prod (`node --import tsx`) | This is the same pattern the SFU repo uses (`"start": "node --import tsx src/index.ts"`), so there's no separate server build step. |
| shadcn registry components | via `npx shadcn add …` | Chat UI | Use `message`, `bubble`, `message-scroller`, `attachment`, `marker` (new chat primitives in the @shadcn registry, confirmed with `shadcn search`), plus `input-group`, `textarea`, `avatar`, `popover` (fixed reaction set), `drawer`, `sheet`, `dialog`, `alert-dialog`, `sonner`, `spinner`, `empty`, `item`, `field`, `input-otp` (TOTP entry), `toggle-group` (call controls), `skeleton`. Always add through the CLI so the `base-luma` variant is used. |

### Development Tools

| Tool | Purpose | Notes |
|---|---|---|
| npm workspaces | `web/` (Next), `server/` (Fastify), `shared/` (zod protocol + types) | One lockfile, one `npm ci` in Docker. |
| `next dev` + `tsx watch server` | Local dev | Static export **forbids `rewrites` in `next dev`** (the docs say using unsupported features errors). Set `output: 'export'` only for the production build (e.g. `output: process.env.NEXT_EXPORT ? 'export' : undefined`) and add dev-only `rewrites()` for `/api` and `/media` → `http://localhost:3100`. Connect WS straight to `ws://localhost:3100/ws` in dev. Cookies are not port-scoped, so the session cookie still applies. |
| `next dev --experimental-https` | Test SW/push/getUserMedia locally | Recommended by the Next.js PWA guide. Real-device testing still needs the public HTTPS hostname. |
| `npx web-push generate-vapid-keys` | VAPID keypair | Generate once and store in `.env` (`VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT=mailto:…`). Rotating keys invalidates every subscription. |
| Docker BuildKit secrets | Pull `@sideby-me/rtc` from GitHub Packages | `.npmrc`: `@sideby-me:registry=https://npm.pkg.github.com` + `//npm.pkg.github.com/:_authToken=${NODE_AUTH_TOKEN}` (the same file `watch` and `sfu` use). Build with `--secret id=npm,env=NODE_AUTH_TOKEN` and `RUN --mount=type=secret,id=npm …`. **Never** pass the token as `ARG`. The local `gh` token currently lacks `read:packages`, so a PAT with that scope is needed. |
| Vitest 5 / Playwright 1.64 | Tests | Optional. Unit-test the token minter against SFU-style verification. Real-device call testing can't be automated cheaply. |

## Installation

# 1. UI scaffold: zero deviation, non-interactive (verified to work with shadcn 4.21.4)

# web/ runtime deps (the private SDK needs NODE_AUTH_TOKEN + .npmrc)

# 2. server/

## SFU Integration Contract (read from `sideby-me/sfu.sideby.me` v0.9.3 and `sideby-me/rtc.sideby.me`)

### What duet's server must do

### What the client does (the SDK does all of this; listed so you can debug or reimplement)

| Step | Client → SFU | Response payload |
|---|---|---|
| 1 | `join { token, protocolVersion: 1, mediaRoomId, participantId }` | `{ rtpCapabilities, iceServers, existingProducers: [{ producerId, participantId, kind }] }`. `iceServers` = `stun:` + `turn:(udp,tcp)` + `turns:` on `TURN_PUBLIC_HOST:443`, with coturn REST HMAC creds minted per join (TTL 3600 s) |
| 2 | `device.load({ routerRtpCapabilities })` (local) | — |
| 3 | `createWebRtcTransport { direction: 'send' \| 'recv' }` (×2) | `{ id, iceParameters, iceCandidates, dtlsParameters }`. Pass `iceServers` into `device.createSendTransport/createRecvTransport` |
| 4 | on transport `connect` → `connectTransport { transportId, dtlsParameters }` | `{ connected: true }` |
| 5 | on send-transport `produce` → `produce { transportId, kind, rtpParameters }` | `{ id }` (producerId) |
| 6 | `consume { transportId, producerId, rtpCapabilities: device.rtpCapabilities }` | `{ id, producerId, kind, rtpParameters }`. **Always created paused** |
| 7 | `resume { consumerId }` after attaching the track | `{ resumed: true }` |
| — | `pauseProducer` / `resumeProducer { producerId }` (wire mute), `closeProducer { producerId }`, `restartIce { transportId }` → `{ iceParameters }`, `getRouterRtpCapabilities` | — |

### SDK caveats

- `signaling/client.ts` does `import { randomUUID } from 'node:crypto'` and `await import('ws')` (Node fallback). I **tested that this pattern builds under Next 16.3.6 Turbopack** (a mock package with identical imports compiled and prerendered cleanly). `watch.sideby.me` ships it on Next 15/webpack. If a runtime problem appears in the browser, fall back to `next build --webpack`. (MEDIUM: build verified, runtime in Safari not verified.)
- The SDK exposes no `iceTransportPolicy` option. Forcing relay for the SFU's "forced-relay" gate needs a small SDK patch or a debug flag.
- If GitHub Packages access is unacceptable, the fallback is to vendor `@sideby-me/rtc-types` (zod schemas, about 200 lines) and write the ~300-line client above directly on `mediasoup-client@3.20.0`. That costs about a day.

## TLS / Reverse Proxy Fit

- **The SFU is not on this machine.** `docker ps` shows only `sideby-staging-{sync,lens,redis}`. Nothing listens on :443 except Tailscale (`100.97.55.101:443`, `tailscale serve`). The box is a home LAN host (`192.168.0.132`, egress IP `103.198.98.196`). The SFU README places SFU + coturn + nginx-sni on GCP VM-B (`35.208.41.166`), and `:443` there **timed out** from this box.
- **`sideby.me` returns NXDOMAIN** from Google and Cloudflare DoH, for the apex, `sfu.`, `turn.` and `duet.`. `ARCHITECTURE.md` found through whois that the domain is in **redemptionPeriod** (expired 2026-08-20). **The SFU and TURN hostnames won't resolve or renew certs until this is fixed. That's a phase-0 blocker for calls**, and it is independent of the duet stack.

## Alternatives Considered

| Recommended | Alternative | When to Use Alternative |
|---|---|---|
| Next static export + Fastify server | **Next.js full-stack** (`output: 'standalone'`, route handlers, SSE via `EventSource` for server→client and POST for client→server, Better Auth) | If you'd rather have one framework and one dev server. It's viable: SSE's built-in `Last-Event-ID` gives free catch-up. But you must set `compress: false` (or SSE stalls behind gzip), keep the event hub on `globalThis`, avoid Server Actions for chat (the client dispatches them one at a time), and accept Next server-runtime self-hosting quirks. **Don't** combine a Next custom server with WS: the Next 16.4 docs state that standalone output doesn't trace custom-server files, so the two can't be combined. |
| Raw `ws` via `@fastify/websocket` | Socket.IO 4.8.4 | If you want rooms, acks and auto-reconnect for free. For two users, a 40-line reconnect + catch-up cursor is simpler than adding a second protocol next to the SFU's raw-`ws` one (the SFU deliberately rejected Socket.IO). |
| Hand-rolled auth (argon2id + otplib + session table) | **Better Auth 1.7.7** (`username` + `twoFactor` plugins) | If you go full-stack Next. Its TOTP flow (`twoFactorRedirect` → `verifyTotp`, trusted devices, backup codes) is solid. But for **two seeded accounts** it adds friction: `enableTwoFactor` requires a live session plus the password, and whether `disableSignUp` also blocks server-side `auth.api.signUpEmail` is undocumented (unverified). Seeding needs a workaround (e.g. a `databaseHooks.user.create.before` guard capping users at 2). The hand-rolled version is ~150 lines, and the seed script prints the QR to the terminal. |
| SQLite | Postgres 17 | Never for this project. Consider it only if the user count grows past two or a second writer process appears, which is out of scope. |
| Drizzle | Prisma 7/8 | Prisma's `latest` is an 8.0 RC right now, and it brings a heavier engine/codegen step. Drizzle on better-sqlite3 is lighter. |
| Drizzle | Raw better-sqlite3 prepared statements | Also fine for ~8 tables. Drizzle earns its place through typed rows shared with `shared/` and generated migrations. |
| Hand-written `public/sw.js` | Serwist 9.5.13 (`@serwist/turbopack`) | Only if real offline caching of the app shell becomes a requirement. Installability and push don't need it (the Next.js PWA guide uses a plain SW and lists Serwist only for offline caching). The SW here is ~60 lines: `push` → `showNotification`, `notificationclick` → focus/open deep link, optional shell cache. |
| `@sideby-me/rtc` SDK | Raw `mediasoup-client` 3.20.0 | If GitHub Packages auth in Docker is unacceptable. See the SDK caveats. |
| Cloudflare Tunnel | Tailscale Funnel / Caddy + port-forward | If the user rejects Cloudflare seeing plaintext in transit. See TLS section. |
| Local disk for media | MinIO / S3-compatible | Never here. It adds a service for zero benefit at two users. |

## What NOT to Use

| Avoid | Why | Use Instead |
|---|---|---|
| **lucide-react**, Radix (`@radix-ui/*`), copy-pasted shadcn snippets from blogs/docs pages built for Radix | The preset is **Base UI + Phosphor** (`style: base-luma`, `iconLibrary: phosphor`). Lucide icons or Radix-variant snippets are a visible deviation from the locked preset. | `npx shadcn add <component>` only, and `@phosphor-icons/react` for icons |
| Emoji-picker libraries with their own UI (emoji-mart etc.) | They bring their own styling, which is a preset deviation and adds bundle weight | A fixed reaction set (❤️ 😂 😮 😢 👍 🔥) in a shadcn `popover`/`toggle-group` |
| Next.js **custom server** + WS | It can't use standalone output, it needs dev HMR upgrade forwarding, and the hub singleton gets duplicated | Fastify serves the static export (recommended) |
| Server Actions for chat sends/uploads | The client queues them one at a time, so a slow upload blocks text sends. They're also unavailable in a static export. | `fetch` to Fastify REST endpoints |
| `next/image` default loader | Unsupported in static export, and media is auth-gated anyway | Plain `<img>`/`<video>` against `/media/*` (or `images.unoptimized: true`) |
| `otplib` v12 examples (`authenticator.verify(...)`) | v13 is a breaking rewrite: async, functional API, no `authenticator` export | `import { verify, generateSecret, generateURI } from 'otplib'` |
| `argon2` (node-gyp) / bcrypt | Native build toolchain in Docker; bcrypt is the weaker KDF | `@node-rs/argon2` (prebuilt napi), argon2id |
| A newer standalone `mediasoup-client` (3.24.x) alongside the SDK | Duplicate `Device` and handler code, and version skew with what the SFU team tested | Exactly 3.20.0, upgraded together with `@sideby-me/rtc` |
| Calling the SFU admin API (`POST /rooms`, `X-Sfu-Secret`) | Not needed (rooms are lazy). It's internal-only port 44443, unreachable from this box, and it's the SFU's SSRF/abuse surface. | Just mint tokens. The first `join` creates the room. |
| Silent/data-only push | iOS revokes push permission for pushes that don't show a notification (`userVisibleOnly: true` is mandatory) | Every push must `showNotification` |
| Alpine base image | musl means no prebuilt binaries for better-sqlite3 / @node-rs/argon2 / Next SWC on some paths | `node:24-bookworm-slim` |
| TypeScript 7 (`latest` = 7.0.2, the Go-native compiler) | Brand new. Next 16.3 and the toolchain were scaffolded with `^5` (resolves to 5.9.3). Mixing is risky for zero gain. | Keep `typescript@^5` as scaffolded |
| Postgres, Redis, a queue, MinIO | Each one is a container, credentials and backups, for 2 users | SQLite + in-memory hub + disk |

## Stack Patterns by Variant

- Vendor `@sideby-me/rtc-types` into `shared/` and write a thin client on `mediasoup-client@3.20.0`.
- The protocol table above is the complete spec.
- Use Tailscale Funnel on `cinedise.persian-elnath.ts.net:8443` (port 443 is already taken by `tailscale serve` for another app) or `:10000`. TLS terminates on the box.
- Or use Caddy + router port-forward + DNS-01 (requires a non-CGNAT public IP and a resolvable domain).
- Add a `duet.<domain>` entry to `nginx-sni.conf` → Caddy on 127.0.0.1:8444, cert via DNS-01.
- Expect home-NAT work for media: forward UDP/TCP 44444-44445 (RTC), 3478/5349, and the coturn relay range 49152-65535/udp. Set `MEDIASOUP_ANNOUNCED_IP` to the public IP. That is substantial ops work, so prefer restoring VM-B.
- Add an `ffmpeg` transcode step in the server container (`apt-get install ffmpeg`, run to H.264/AAC MP4 on upload). Only do this after verifying the problem on the real devices.

## Version Compatibility

| Package A | Compatible With | Notes |
|---|---|---|
| shadcn 4.21.4 preset `b51GFhBEQ` | next 16.3.6, react 19.3.0, @base-ui/react ^1.8.0, @phosphor-icons/react ^2.1.10, tailwindcss ^4, typescript ^5 (→5.9.3) | Verified by actually running the scaffold on 2026-10-08. |
| @sideby-me/rtc 0.9.0 | mediasoup-client 3.20.0 (exact), @sideby-me/rtc-types ^0.9.0, ws 8.21.0, react ≥18 | SDK `tsup` marks `mediasoup-client`, `ws`, `react` as external. The consumer installs them. |
| mediasoup-client 3.20.0 | SFU mediasoup 3.20.5 | Same pin as the SFU repo's own dependency. |
| Next 16.3.6 Turbopack | SDK's `node:crypto` + dynamic `import('ws')` | `next build` compiled and prerendered a client page importing an identical mock module. Browser runtime not yet verified. |
| better-sqlite3 13.0.3 | Node ≥22 (engines) | Use Node 24 bookworm-slim. drizzle-orm 0.45.4 peer `better-sqlite3 >=7`. |
| next 16.x | Node ≥20.9 | Node 24 OK. |
| @fastify/websocket 11.3.3 | fastify 5, ws ^8.16 | — |
| web-push 3.6.7 | Chrome/FCM, Apple Web Push (iOS 16.4+ home-screen apps), Firefox | Declarative Web Push (iOS 18.4+) is optional. The standard SW path works everywhere. |
| SFU protocolVersion | 1 | Hard-coded by the SDK (`protocolVersion: 1`) and the SFU (`SFU_PROTOCOL_VERSION=1`). Major mismatch → 1008 close. |

## Sources

- **Primary source code (HIGH):** `gh api repos/sideby-me/sfu.sideby.me` (README, `package.json`, `src/signaling/{auth,gateway,handlers}.ts`, `src/http/admin.ts`, `src/room-registry.ts`, `src/turn/ice-servers.ts`, `src/mediasoup/codecs.ts`, `src/config.ts`, `nginx-sni.conf`, `.env.example`, `dev/e2e-join.ts`). `sideby-me/rtc.sideby.me` (`packages/rtc-types/src/{protocol,token}.ts`, `packages/rtc/src/{index,types,connect,events}.ts`, `transport/*.ts`, `signaling/client.ts`, `tsup.config.ts`). `sideby-me/watch.sideby.me` (`package.json`, `.npmrc`, `src/features/media/use-media.ts`).
- **Executed (HIGH):** `npx shadcn@4.21.4 preset decode b51GFhBEQ`; `npx shadcn@4.21.4 init -t next -p b51GFhBEQ` (inspected `package.json`, `components.json`, `layout.tsx`, `button.tsx`); `npx shadcn search @shadcn` (chat components); `next build` Turbopack test with a mock of the SDK's imports; `npm view` for every version listed; `docker ps`, `ss -ltnp`, `ip addr`, `tailscale serve status`; DoH lookups (dns.google, cloudflare-dns.com) → NXDOMAIN; nodejs/Release `schedule.json`.
- **Official docs via WebFetch:** https://nextjs.org/docs/app/guides/progressive-web-apps (v16.4.0, updated 2026-07-30). https://nextjs.org/docs/app/guides/custom-server (v16.4.0, 2026-08-24: standalone and custom server can't be combined). https://nextjs.org/docs/app/guides/static-exports (v16.4.0, 2026-08-09: unsupported features incl. rewrites, which error in `next dev`). https://www.better-auth.com/docs/plugins/2fa and https://www.better-auth.com/docs/adapters/sqlite (for the alternative). https://tailscale.com/kb/1223/funnel (validated 2026-01-20).
- **Web search (MEDIUM):** [WebKit: Meet Declarative Web Push](https://webkit.org/?p=16535) (iOS 18.4). [Pushpad: iOS special requirements](https://pushpad.xyz/blog/ios-special-requirements-for-web-push-notifications) (home-screen-only, separate storage). [Better Auth signup_disabled](https://www.better-auth.com/docs/errors/signup_disabled) (seeding ambiguity). SSE buffering reports ([medium.com](https://medium.com/@oyetoketoby80/fixing-slow-sse-server-sent-events-streaming-in-next-js-and-vercel-99f42fbdb996), [Next compress docs](https://nextjs.org/docs/app/api-reference/config/next-config-js/compress)), used only for the Alternatives entry.
- **Sibling research:** `.planning/research/ARCHITECTURE.md` (whois redemptionPeriod for sideby.me, the Cloudflare Tunnel pattern on this box). I aligned with its component layout on purpose.

<!-- GSD:stack-end -->

<!-- GSD:conventions-start source:CONVENTIONS.md -->

## Conventions

Conventions not yet established. Will populate as patterns emerge during development.
<!-- GSD:conventions-end -->

<!-- GSD:architecture-start source:ARCHITECTURE.md -->

## Architecture

Architecture not yet mapped. Follow existing patterns found in the codebase.
<!-- GSD:architecture-end -->

<!-- GSD:skills-start source:skills/ -->

## Project Skills

No project skills found. Add skills to any of: `.claude/skills/`, `.agents/skills/`, `.cursor/skills/`, `.github/skills/`, or `.codex/skills/` with a `SKILL.md` index file.
<!-- GSD:skills-end -->

<!-- GSD:workflow-start source:GSD defaults -->

## GSD Workflow Enforcement

Before using Edit, Write, or other file-changing tools, start work through a GSD command so planning artifacts and execution context stay in sync.

Use these entry points:
- `/gsd-fast` for a trivial task inline, with no subagents and no PLAN.md
- `/gsd-quick` for small fixes, doc updates, and ad-hoc tasks
- `/gsd-debug` for investigation and bug fixing
- `/gsd-execute-phase` for planned phase work

Do not make direct repo edits outside a GSD workflow unless the user explicitly asks to bypass it.
<!-- GSD:workflow-end -->

<!-- GSD:profile-start -->

## Developer Profile

> Profile not yet configured. Run `/gsd-profile-user` to generate your developer profile.
> This section is managed by `generate-claude-profile` -- do not edit manually.
<!-- GSD:profile-end -->
