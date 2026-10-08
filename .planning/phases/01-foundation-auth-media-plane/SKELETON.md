# Walking Skeleton: duet

**Phase:** 1
**Generated:** 2026-10-09

## Capability Proven End-to-End

One of the two seeded people opens https://duet.brkn.me on their phone, taps their name, enters their password and lands in the chat-shaped shell that names the other person. The app is served by one Fastify process from SQLite, running in Docker on this machine behind a Cloudflare Tunnel.

Locally, the same path runs with `npm run build && npm start` (http://127.0.0.1:3100) or `bash scripts/smoke-local.sh`. Plan 01-01 builds the locally runnable skeleton, 01-02 adds real login, and 01-03 deploys it. The ops track (01-04, 01-05) adds the media plane that later phases call into.

## Architectural Decisions

| Decision | Choice | Rationale |
|---|---|---|
| UI system | shadcn preset `b51GFhBEQ` scaffolded with `npx shadcn@4.21.4 init -t next -p b51GFhBEQ` (style `base-luma`: Base UI primitives, Phosphor icons, Tailwind v4, Space Grotesk). Components are added only with `npx shadcn add`, and `web/components/ui/*` is never hand-edited | Locked by the user (SHEL-01); `scripts/check-preset.sh` guards it |
| Theme | Always dark: `html.dark` + `ThemeProvider forcedTheme="dark"`, using the preset's own `.dark` tokens; manifest/meta colour `#090b0c` | D-10; no custom palette |
| Framework | Next.js 16.3.6 App Router (scaffold pin), built as a static export (`output: 'export'` when `NEXT_EXPORT=1`, `trailingSlash: true`). Everything interactive is a client component. No Server Actions, no `next/image` loader, no SSR | One origin and no Next server runtime in prod; dev uses `next dev` with `/api` rewrites to :3100 |
| Server | ONE Node 24 process running Fastify 5.12.5 via `tsx` (no build step). It serves `web/out` (via `@fastify/static`), `/api/*` and `/healthz`, and from Phase 2 `/ws` and `/media/*`. The app factory is `buildApp(config)` in `server/src/app.ts` | Single process; testable with `fastify.inject` |
| Config | zod-validated env in `server/src/config.ts` (`loadConfig`). The domain lives only in env: `APP_ORIGIN`, `SFU_URL`, `TURN_HOST` (D-03) | Fail fast; no hard-coded hostnames |
| Shared contracts | `shared/` workspace (`@duet/shared`) with zod schemas, consumed as TS source by the server (tsx) and the web app (`transpilePackages`) | One schema per request/response; Phase 2 WS frames go here too |
| Data layer | SQLite file `${DATA_DIR}/duet.sqlite` (WAL, `foreign_keys=ON`, `busy_timeout=5000`) via better-sqlite3 13 + Drizzle ORM 0.45 (not 1.0 rc). drizzle-kit `generate` produces committed SQL migrations, and `migrate()` runs at every boot | Two users, one writer; backup is one file. `scripts/check-live-db.sh` proves migrations against a live file |
| Media storage | `${DATA_DIR}/media/` on the same volume (created at boot; filled in Phase 2) | INFR-02 |
| Auth | Password only (TOTP dropped, D-05): argon2id via `@node-rs/argon2` 2.2.1 defaults, NFC-normalized passwords of at least 12 code points. Exactly two accounts are created by the idempotent seed CLI (`server/scripts/seed-users.ts`), and there is no sign-up anywhere | AUTH-01/02; re-running the seed is the password reset |
| Sessions | Opaque 256-bit token in the `duet_session` cookie (httpOnly, Secure, SameSite=Lax, Path=/). Only the sha256 is stored in `sessions`. 90-day rolling expiry: any use more than 24 h after the last renewal extends it AND re-issues the cookie. Logout deletes the row | D-06; `requireUser` preHandler is the single auth gate for every protected route in later phases |
| Request safety | `originGuard` (Origin must equal `APP_ORIGIN` on non-GET `/api/*`), `securityHeaders`, per-route `@fastify/rate-limit` keyed on `CF-Connecting-IP` + userId with `hook: 'preHandler'` | CSRF + brute-force controls that replace TOTP |
| Deployment target | Docker on this box. Compose project `duet` has the services `duet` (two-stage `node:24-bookworm-slim`, `USER node`, no published port) and `cloudflared` (2026.10.0, uid 1000). `./data:/data` is the persistent volume | Self-hosted (PROJECT constraint); data survives `down`/`up` |
| Ingress | Cloudflare Tunnel `duet` (locally managed, created via the CF API) feeding a proxied CNAME `duet.brkn.me`. TLS terminates at Cloudflare's edge | D-02; no app port forward; the tunnel cannot carry UDP media |
| Media plane | Home SFU stack as a SEPARATE compose project `duet-sfu` (`ops/sfu/`), all on the host network: the owner's mediasoup SFU image (2 workers, RTC 44444-44445), coturn 4.11.0 (relays only to `sfu0` 10.99.0.1), nginx SNI router on `192.168.0.132:443`, and a relay-iface sidecar. `sfu.brkn.me` and `turn.brkn.me` are DNS-only A records with LE DNS-01 certs | D-12/D-14; the Phase 3 gate is the cellular smoke run |
| Call client | `@sideby-me/rtc` 0.9.0 (wraps `mediasoup-client` 3.20.0, exact pin), installed via GitHub Packages with a BuildKit secret. duet's server mints HS256 join tokens with `jose` (`mintJoinToken` in `server/src/sfu/token.ts`); rooms are created lazily, and the SFU admin API is never used | Reused unchanged by Phase 3 calls |
| PWA | `web/app/manifest.ts` (id `/`, standalone, name `duet`), generated heart icons (ImageMagick, committed), and a hand-written `web/public/sw.js` with install/activate only. **No Serwist.** Phase 2 adds the push handlers to the same SW | SHEL-02; no fetch handler, so auth and Range requests are never intercepted |
| Secrets | Outside the repo in `~/.config/duet/` (mode 700/600): `cloudflare.ini`, `github-packages.token`, and the one-time `seed-users.json`. Gitignored `.env`, `ops/sfu/.env` and tunnel credentials | Never committed, never in image layers |
| Testing | Vitest 5 server suites (`server/test/*.test.ts`, `makeTestApp` helper with a temp `DATA_DIR`) plus bash smoke scripts (`smoke-local`, `check-live-db`, `check-preset`, `smoke-public`, `smoke-persistence`, `ops/sfu/scripts/check-local`) | Fast, deterministic proofs; device behaviour is checked by end-of-phase UAT |
| Directory layout | npm workspaces: `web/` (Next export: `app/`, `components/ui` (CLI-only), `components/app` (ours), `lib/`), `server/` (`src/{config,app,index}.ts`, `src/db`, `src/auth`, `src/http`, `src/routes`, `src/sfu`, `scripts/`, `drizzle/`, `test/`), `shared/src/`, `scripts/` (repo-level checks), `deploy/cloudflared/`, `ops/sfu/` | Feature code for Phase 2 goes in new `server/src/<feature>/` and `web/components/app/` folders on the same seams |

## Stack Touched in Phase 1

- [ ] Project scaffold: preset init, npm workspaces, TypeScript, Vitest, one root lockfile (01-01)
- [ ] Routing: `/` (client-gated tiles/password/shell), `/debug/sfu/`, `/api/users`, `/api/login`, `/api/me`, `/api/logout`, `/api/debug/*`, `/healthz` (01-01, 01-02, 01-05)
- [ ] Database: a real write (seed upsert, session insert/delete) and a real read (`/api/users`, session lookup); migrations proven on a live file (01-01, 01-02)
- [ ] UI: name tile, password step, shell, logout menu, all wired to the API (01-01, 01-02)
- [ ] Deployment: Docker + Cloudflare Tunnel at https://duet.brkn.me, persistence proven, installable on both phones (01-03)
- [ ] Media plane: home SFU + TURN, token minter, cellular smoke PASS direct and relay (01-04, 01-05)

## Out of Scope (Deferred to Later Slices)

- TOTP / 2FA of any kind (user dropped it, D-05; deferred idea only)
- A password-reset UI or CLI beyond re-running the seed (AUTH-06, v2)
- Chat, WebSocket hub, message schema, history, receipts, typing, reactions, replies (Phase 2)
- Photos, video clips, voice notes, `/media/*` serving and transcoding (Phase 2)
- Web push, VAPID, iOS onboarding and the test-push button (SHEL-03, Phase 2)
- Calls UI, ringing, call state (Phase 3); offline app-shell caching (no Serwist)
- Backups and disk alerts (OPS-01/02, v2); log-out-everywhere; an admin UI
- CGNAT fallback host (VPS vs ISP IP), decided only if the check fails (D-15)

## Subsequent Slice Plan

Each later phase adds one vertical slice on top of this skeleton without changing its architectural decisions:

- **Phase 2: Chat, Media & Push.** A logged-in person sends a message that appears on the other phone in real time (raw `ws` via `@fastify/websocket` on the same Fastify process, auth from `duet_session` before upgrade, zod frames in `shared/`, a `messages` table added through a new Drizzle migration). Media then goes to `${DATA_DIR}/media` behind `requireUser`, and push comes through the existing `sw.js` + `web-push`.
- **Phase 3: Voice & Video Calls.** Either person calls the other through the home SFU, using `mintJoinToken` and the `@sideby-me/rtc` wiring proven by the `/debug/sfu/` harness, with ringing over Phase 2's push. It starts only when `ops/sfu/NETWORK.md` records the cellular smoke run as GREEN.
