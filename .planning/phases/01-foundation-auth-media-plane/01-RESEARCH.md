> **⚠ 2026-10-09 — partly superseded (D-16 in 01-CONTEXT.md).** The home connection is CGNAT, and the user dropped the SFU. Everything in this file about the self-hosted SFU, coturn, nginx-sni, router port-forwards, sfu./turn.brkn.me DNS/certs, `@sideby-me/rtc`, mediasoup-client and GitHub Packages build secrets is **historical — do not plan from it.** Calls are now 1:1 peer-to-peer WebRTC with Cloudflare TURN (credentials minted by the duet server). The app-track research (Fastify, SQLite, auth, Docker, Cloudflare Tunnel, PWA) remains valid.

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
| INFR-03 | SFU + coturn on this machine, publicly reachable (DNS, port-forwards, non-CGNAT IPv4) | §Home SFU deployment (env, turnserver.conf, nginx-sni.conf, sfu0 sidecar, certs), §CGNAT check procedure, §Port-forward checklist |
| INFR-04 | Smoke test proves `bytesReceived > 0` from a phone on cellular, direct and forced-relay | §Smoke harness design: an RTCPeerConnection wrapper forces relay **and** captures PCs for `inbound-rtp` stats; two sessions on one phone; results POSTed to the server log |
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
- **Media plane:** use the SFU + coturn (now self-hosted at home); no P2P/mesh.
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

### Pattern 7: Home SFU stack (INFR-03), separate compose project `duet-sfu`

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

### Pattern 8: Smoke harness `/debug/sfu` (INFR-04, D-12)

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

### Anti-Patterns to Avoid
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

### Pitfall 9: SFU worker/port explosion and bind conflicts
**What goes wrong:**
- 16 workers on 16 ports.
- nginx `listen 443` → EADDRINUSE.
- A LAN-IP change (DHCP) breaks `MEDIASOUP_LISTEN_IP`, coturn `listening-ip` and nginx `listen`.

**How to avoid:** `cpus: 2`; listen on `192.168.0.132:443`; **DHCP reservation for 192.168.0.132 on the TP-Link** (user checklist item).

### Pitfall 10: Relay leg needs the sfu0 dummy interface
**What goes wrong:** coturn refuses to relay to its own listening IPs, so forced-relay media never flows (the README's documented failure).
**How to avoid:** `MEDIASOUP_PRIVATE_IP=10.99.0.1` plus `allowed-peer-ip=10.99.0.1` plus the `relay-iface` sidecar. After a reboot the sidecar and the SFU start concurrently. If sfu0 isn't up yet, the SFU fails to bind and `restart: unless-stopped` retries until it is (self-healing).

### Pitfall 11: Wrong gate metric
**What goes wrong:** ICE reaches "connected" or the SDK's `networkQuality` bytes are > 0, yet no RTP flows. The README calls this the classic announcedAddress failure.
**How to avoid:** Use only `inbound-rtp.bytesReceived` (Pattern 8).

### Pitfall 12: Home Wi-Fi hairpin (Phase 3 risk; observe it now)
**What goes wrong:** Phones on home Wi-Fi dial 103.198.98.196. Through double NAT without loopback, both the direct path and TURN fail.
**How to avoid / detect:** After forwards are in place, run `curl -sv --resolve sfu.brkn.me:443:103.198.98.196 https://sfu.brkn.me/` **from the box**. A TLS handshake there means hairpin works. Record the result. If it fails, Phase 3 needs either an extra LAN listenInfo (SFU patch) or router NAT loopback. It is not a Phase 1 gate (cellular is).

### Pitfall 13: PPPoE address changes
**What goes wrong:** `MEDIASOUP_ANNOUNCED_IP`, coturn `external-ip` and the A records go stale after a reconnect.
**How to avoid:** Ask whether the IP is static (Open Question 2). If it isn't, add `ops/sfu/scripts/ddns.sh`, run from cron every 5 min:
1. Compare `curl -4 api.ipify.org` with `.env`.
2. If it changed, PATCH the sfu/turn A records via the API.
3. Re-render `.env` and `turnserver.conf`.
4. `docker compose up -d --force-recreate sfu coturn`.

### Pitfall 14: npm token handling
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

## Validation Architecture

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

## Security Domain

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

## Suggested Plan Shape (coarse, for the planner)
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
