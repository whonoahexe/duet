---
phase: "01"
slug: "foundation-auth-media-plane"
status: verified
# threats_open = count of OPEN threats at or above workflow.security_block_on severity (the blocking gate)
threats_open: 0
asvs_level: 1
created: "2026-10-10"
---

# Phase 01 — Security

> Per-phase security contract: threat register, accepted risks, and audit trail.
> Register merged from the `<threat_model>` blocks of 01-01..01-05 PLAN.md (authored at plan time). T-01-20..T-01-31 belonged to the superseded SFU plans and are not part of this phase. block_on: high.

---

## Trust Boundaries

| Boundary | Description | Data Crossing |
|----------|-------------|---------------|
| Internet -> Cloudflare edge -> tunnel -> duet:3100 | The only ingress; TLS terminates at Cloudflare | All app traffic |
| LAN -> host ports | Must not reach duet directly | None (no published port) |
| browser -> `GET /api/users` | Public, unauthenticated | Ids and display names (public by design) |
| browser -> `POST /api/login` | Untrusted credentials | Passwords (high) |
| browser -> authenticated `/api/*` | Cookie-bearing, possibly cross-site | Session cookie (high) |
| browser -> `GET /ws` upgrade | Untrusted signaling frames | SDP/ICE candidates with IP addresses (medium) |
| browser -> `POST /api/rtc/ice-servers` | Spends the owner's Cloudflare TURN key | Minted TURN credentials (high) |
| browser -> `POST /api/debug/call-report` | Untrusted body written to the log | Call stats, UA, client IP (low) |
| browser -> camera/microphone | Call harness capture | Live audio/video (medium) |
| duet server -> `rtc.live.cloudflare.com` | TURN key bearer leaves the server | TURN key bearer (high) |
| operator host -> Cloudflare account API | Account token used by setup/turn-key scripts only | Account token (high) |
| operator terminal -> seed CLI | Plaintext passwords enter the process | Passwords (high) |
| build context -> image layers | Anything copied is readable from the image | Secrets if leaked (high) |
| npm registry -> repo | Third-party code enters the build | Code (high) |

---

## Threat Register

| Threat ID | Category | Component | Severity | Disposition | Mitigation | Status |
|-----------|----------|-----------|----------|-------------|------------|--------|
| T-01-01 | Information disclosure | `GET /api/users` | high | mitigate | Explicit column projection `server/src/routes/users.ts:13`; users.test asserts key set | closed |
| T-01-02 | Information disclosure | Seed CLI password handling | medium | mitigate | Hidden prompt / `--stdin` / mode-600 file only (`server/scripts/seed-users.ts`); NFC + ≥12 code points (seed.test) | closed |
| T-01-03 | Elevation of privilege | Static file serving | medium | mitigate | `@fastify/static` with fixed root (`server/src/app.ts:105`); `/api/*` 404s JSON | closed |
| T-01-04 | Information disclosure | SQLite file at `DATA_DIR` | low | accept | See accepted risks AR-01 | closed |
| T-01-05 | Spoofing | `POST /api/login` online guessing | high | mitigate | Rate limit 5 / 5 min per IP+userId (`server/src/auth/routes.ts:97`) plus per-account lockout `LOGIN_ACCOUNT_MAX_FAILURES = 20` (WR-01, c743038); argon2id | closed |
| T-01-06 | Information disclosure | Login enumeration / timing | low | mitigate | `DUMMY_HASH` verify with identical 401 (`server/src/auth/routes.ts:16,118`) | closed |
| T-01-07 | Spoofing | Session theft/replay | high | mitigate | 256-bit token, sha256 stored (`server/src/auth/session.ts:44`); HttpOnly, Secure, SameSite=Lax (`session.ts:49-51`); fresh token per login | closed |
| T-01-08 | Tampering | CSRF on state-changing `/api/*` | medium | mitigate | Global `originGuard` onRequest hook (`server/src/app.ts:52`); APP_ORIGIN normalized (WR-03, e859d42); CR-01 encoded-path bypass fixed | closed |
| T-01-09 | Elevation of privilege | Protected routes without session | high | mitigate | `requireUser` preHandler on `/api/me`, `/api/logout`, rtc routes; 401 tests | closed |
| T-01-10 | Spoofing | Forged `CF-Connecting-IP` | medium | mitigate | No published app port (`compose.yaml:15`); verified in 01-03 | closed |
| T-01-11 | Information disclosure | Passwords/cookies in logs | medium | mitigate | Default serializers, no body logging on `/api/login` | closed |
| T-01-12 | Tampering | Clickjacking | low | mitigate | `securityHeaders` DENY/nosniff/Referrer-Policy/HSTS (`server/src/http/guards.ts:42-46`) | closed |
| T-01-13 | Information disclosure | Secrets in Docker image | high | mitigate | `.dockerignore` excludes `.env*`, `data`, `credentials.json`, `config.yml`, `ops`, `.planning`; no ARG secrets | closed |
| T-01-14 | Spoofing | LAN bypass of tunnel | medium | mitigate | No `ports:` on duet (`compose.yaml:15`) | closed |
| T-01-15 | Information disclosure | Tunnel `credentials.json` leak | high | mitigate | Mode 0400, gitignored, dockerignored, mounted `:ro` into cloudflared only (`compose.yaml:25`) | closed |
| T-01-16 | Tampering | DNS changes to portfolio apex | medium | mitigate | Before/after zone diff guard in `deploy/cloudflared/setup.sh` | closed |
| T-01-17 | Information disclosure | Plaintext `seed-users.json` | medium | mitigate | Outside repo, mode 600, stdin, no `set -x`, shredded after login round-trip | closed |
| T-01-18 | Denial of service | SW intercepting requests | low | mitigate | `web/public/sw.js` has only install/activate listeners; served no-cache | closed |
| T-01-19 | Denial of service | Disturbing tailscale / sideby-staging | medium | mitigate | Separate compose project and tunnel; before/after checks (UAT 22) | closed |
| T-01-32 | Elevation / DoS (cost) | `POST /api/rtc/ice-servers` | high | mitigate | `requireUser`, originGuard, 30/min (`server/src/rtc/routes.ts:29`), TTL max 172800 (`server/src/config.ts:48`), `no-store` | closed |
| T-01-33 | Information disclosure | TURN key bearer | high | mitigate | Env file mode 600, dockerignored; `turn_mint` logs userId/ok only (`server/src/rtc/routes.ts:59,64`); turn.test asserts no leak | closed |
| T-01-34 | Information disclosure | Cloudflare account token | high | mitigate | Stays in `~/.config/duet` (mode 600); passed via header file; never in env file or image | closed |
| T-01-35 | Tampering | Cloudflare account state | medium | mitigate | `deploy/cloudflare/turn-key.sh` writes only `/calls/turn_keys`; re-run reuses key (UAT 30) | closed |
| T-01-36 | Spoofing | Cross-site WebSocket hijacking | high | mitigate | `wsOriginCheck` before upgrade (`server/src/ws/routes.ts:13,19`); ws.test evil/missing Origin | closed |
| T-01-37 | Elevation of privilege | Unauthenticated `/ws` | high | mitigate | `requireUserNoRenew` preHandler (`server/src/auth/session.ts:114`) | closed |
| T-01-38 | Tampering | Signal injection into another room | medium | mitigate | Rooms of 2, relay to other member only, `not_in_room` (`server/src/ws/hub.ts:153`) | closed |
| T-01-39 | Denial of service | WS resource exhaustion | medium | mitigate | `maxPayload` (`server/src/app.ts:77`), 100 frames/s → 1008 (`server/src/ws/hub.ts:117-124`), 4 rooms/conn, heartbeat | closed |
| T-01-40 | Repudiation / session | Logged-out device keeps signaling | medium | mitigate | Logout `hub.closeSession` 4401 (`server/src/auth/routes.ts:145`); heartbeat re-checks session and closes revoked/expired sockets (WR-02, 69d114d) — earlier residual now mitigated | closed |
| T-01-41 | Information disclosure | Signaling payloads in logs | medium | mitigate | Hub never logs/stores frames; ws.test asserts logs lack SDP/candidates | closed |
| T-01-42 | Information disclosure | Peer IP via host/srflx candidates | low | accept | See AR-02 | closed |
| T-01-43 | Tampering / DoS | `POST /api/debug/call-report` | medium | mitigate | `requireUser`, originGuard, strict zod `CallReport` with caps (`shared/src/rtc.ts:60-74`), 30/min, whitelisted log fields | closed |
| T-01-44 | Information disclosure | `call_smoke` log line (IP + UA) | low | accept | See AR-03 | closed |
| T-01-45 | Information disclosure | Camera/microphone capture | medium | mitigate | getUserMedia only on Start; tracks stopped on Stop/unmount/pagehide/error (`web/components/app/call-test.tsx:162-181`); UAT 7 pass | closed |
| T-01-46 | Spoofing | Misleading PASS | medium | mitigate | `callVerdict` requires growing bytes and relay candidate under forced relay (`shared/src/rtc.ts`); smoke-call asserts relay-relay | closed |
| T-01-47 | Information disclosure | `/debug/call/` HTML without login | low | accept | See AR-04 | closed |
| T-01-48 | Information disclosure | TURN secrets in image or smoke output | high | mitigate | `.dockerignore` excludes env file; compose `env_file` only; smoke scripts print no secrets | closed |
| T-01-SC | Tampering | npm installs, base images, shadcn registry items | high | mitigate | Blocking-human legitimacy gates (01-01 T1, 01-04 T2); exact pins; one committed root lockfile; pinned image tags; playwright-core pruned from image | closed |

*Status: open · closed · open — below high threshold (non-blocking)*
*Severity: critical > high > medium > low — only open threats at or above workflow.security_block_on count toward threats_open*
*Disposition: mitigate (implementation required) · accept (documented risk) · transfer (third-party)*

---

## Accepted Risks Log

| Risk ID | Threat Ref | Rationale | Accepted By | Date |
|---------|------------|-----------|-------------|------|
| AR-01 | T-01-04 | SQLite file on a single-owner box, owned by uid 1000, `data/` gitignored, Docker volume | owner (plan 01-01) | 2026-10-08 |
| AR-02 | T-01-42 | The two peers are partners; forced relay hides addresses when wanted | owner (plan 01-04) | 2026-10-09 |
| AR-03 | T-01-44 | Own server log for two people; UA capped at 300 chars; check script prints no IPs/UAs | owner (plan 01-05) | 2026-10-09 |
| AR-04 | T-01-47 | Debug HTML carries no data; every API it uses answers 401 without a session | owner (plan 01-05) | 2026-10-09 |
| AR-05 | T-01-05 (WR-01) | Per-account lockout (20 failures/hour from any IP blocks new logins up to an hour) lets anyone who knows a public user id lock that account out of new logins; existing sessions are unaffected | owner (UAT test 31) | 2026-10-10 |

*Accepted risks do not resurface in future audit runs.*

---

## Security Audit Trail

| Audit Date | Threats Total | Closed | Open | Run By |
|------------|---------------|--------|------|--------|
| 2026-10-10 | 37 | 37 | 0 | /gsd-secure-phase (orchestrator, ASVS L1 grep-depth; auditor skipped per short-circuit rule) |

---

## Sign-Off

- [x] All threats have a disposition (mitigate / accept / transfer)
- [x] Accepted risks documented in Accepted Risks Log
- [x] `threats_open: 0` confirmed
- [x] `status: verified` set in frontmatter

**Approval:** verified 2026-10-10
