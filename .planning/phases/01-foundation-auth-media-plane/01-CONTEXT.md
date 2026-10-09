# Phase 1: Foundation, Auth & Media Plane - Context

**Gathered:** 2026-10-08
**Status:** Ready for planning

<domain>
## Phase Boundary

duet is live at `https://duet.brkn.me` (Cloudflare Tunnel → this machine, Docker, SQLite + media on a persistent volume). Two seeded users log in by tapping their name and entering a password, stay logged in on a 90-day rolling session, can log out, and can install the app to the home screen on iPhone (Safari) and Pixel (Chrome). The logged-in view is an empty chat-shaped shell (Phase 2 fills it). In parallel, a user-gated ops track brings the SFU + coturn up on this machine and proves media flows from a phone on cellular (direct and forced-relay) via a hidden debug page inside duet.

Requirements: INFR-01, INFR-02, INFR-03, INFR-04, AUTH-01, AUTH-02 (now password-only — see D-05), AUTH-03, AUTH-04, SHEL-01, SHEL-02.

</domain>

<decisions>
## Implementation Decisions

### Domain & hostnames
- **D-01:** Domain is **`brkn.me`** (the owner's portfolio domain, DNS already on Cloudflare). The apex/portfolio records must not be touched.
- **D-02:** Hostnames: **`duet.brkn.me`** → the app via Cloudflare Tunnel (proxied/orange cloud); **`sfu.brkn.me`** and **`turn.brkn.me`** → A records pointing directly at the home public IP, **DNS-only (grey cloud)**, because the Cloudflare proxy cannot carry SFU/TURN UDP. Accepted consequence: the home IP becomes publicly resolvable through those two names. — **Reversibility:** costly — the hostnames get baked into the SFU's TLS certs, its TURN config, the app env and the PWA's origin. Changing the app origin later invalidates installed PWAs and their push subscriptions.
- **D-03:** Make the domain configurable through env (`APP_ORIGIN`, `SFU_URL`, `TURN_HOST`). Never hard-code it.

### Login flow
- **D-04:** Login screen shows **two tiles, one per person (name + initials Avatar)**. Tapping one asks for that person's password. No username field and no sign-up path anywhere. Display names are set by the seed script. Accepted consequence: anyone who opens the URL sees both names.
- **D-05:** **Password only. TOTP 2FA is dropped** (user decision). This overrides AUTH-02's "password + TOTP" and the stack doc's otplib/qrcode/input-otp entries: do **not** install `otplib` or `qrcode`, and build no OTP step or `input-otp` usage. Compensating controls: argon2id (`@node-rs/argon2`), `@fastify/rate-limit` on `/api/login`, and a seed script that refuses weak passwords (e.g. ≥ 12 characters). REQUIREMENTS.md, ROADMAP.md and PROJECT.md have been updated to match.
- **D-06:** Session: opaque random token in an `httpOnly; Secure; SameSite=Lax` cookie plus a sessions table, **90-day rolling expiry** (any authenticated use extends it). Logout deletes the session row and clears the cookie.
- **D-07:** The seed script (`AUTH-01`) creates exactly two users (display name, password) and is idempotent and re-runnable. Re-running it with a new password is also the password-reset path (stopgap for AUTH-06).

### App identity & landing
- **D-08:** PWA `name`/`short_name`: **`duet`** (lowercase).
- **D-09:** Icon: a simple generated mark, a Phosphor glyph (e.g. heart or chat bubble) on the preset's rose primary, exported to the PNG sizes iOS and Android need (incl. 180px apple-touch-icon, 192/512, and a maskable variant). No external design assets.
- **D-10:** **Always dark theme.** Force the preset's dark tokens (e.g. a `dark` class on `<html>`) and set the manifest `theme_color`/`background_color` and the iOS status-bar style to match. Use the preset's own dark tokens; adding a custom palette would deviate from the preset.
- **D-11:** Logged-in landing in Phase 1 is a **chat-shaped empty shell**: a header with the other person's name and initials Avatar, an `empty`-component placeholder where messages will go, and **logout in a header menu**. Phase 2 builds on this layout.

### SFU smoke test & ops
- **D-12:** The smoke harness is a **hidden, login-gated page inside duet** (e.g. `/debug/sfu`). It uses the real server-side join-token minter (jose HS256) and `@sideby-me/rtc`, publishes mic/camera, consumes, displays `bytesReceived`, and has a **"force relay"** toggle (`iceTransportPolicy: 'relay'`). The SDK exposes no such option, so a minimal patch or wrapper is needed, per the stack notes. Phase 3 reuses the token minter and SDK wiring.
- **D-13 [informational]:** (Superseded by D-16.) Ops split: Claude does everything possible from this box (Docker, `cloudflared` tunnel `duet`, SFU stack, DNS records through the Cloudflare API if the user supplies a scoped API token). The user gets an **exact checklist** for router port-forwards and for the GitHub PAT with `read:packages`.
- **D-14 [informational]:** (Superseded by D-16.) The SFU + coturn (+ nginx-sni per the SFU repo) run as their **own separate Docker Compose stack** on this box, independent of duet's compose file.
- **D-15 [informational]:** (Superseded by D-16.) **CGNAT fallback is undecided on purpose.** If the CGNAT check fails, the ops track **pauses and asks the user**. The options to present are (a) a small VPS (~$4–6/mo) for SFU + coturn, or (b) asking the ISP for a public IPv4. The app track continues either way (Phase 2 doesn't depend on ops).
- **D-16 (2026-10-09, supersedes D-02's sfu./turn. records, D-14 and the SFU parts of D-13/D-15):** CGNAT confirmed — the outer router (OP-XONT71000 ONT) PPPoE WAN is **172.18.28.128** while egress is 103.198.98.196, and there is no public IPv6. Rather than a VPS or ISP public IP, the user chose to **drop the SFU entirely**: calls become **1:1 peer-to-peer WebRTC** with **Cloudflare TURN** as the relay. The duet server mints short-lived TURN credentials (Cloudflare TURN key created via API with the existing account token, which was verified to reach `/accounts/{id}/calls/turn_keys`); signaling (offer/answer/ICE) rides duet's own WebSocket. No router changes, no VPS, no sfu./turn. DNS records, no `@sideby-me/rtc` SDK, no GitHub Packages build secret. Plans 01-04 and 01-05 are superseded and must be replanned for this design.

### Claude's Discretion
- Exact hostname layout (user said "you decide" → D-02).
- Failed-login UX: generic "Wrong password" message; cooldown/rate-limit after ~5 failures per user/IP within a short window.
- Icon glyph choice and the exact empty-state copy.

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Project scope & requirements
- `.planning/PROJECT.md` — vision, constraints (locked shadcn preset, self-hosting), key decisions
- `.planning/REQUIREMENTS.md` — INFR-01..04, AUTH-01..04, SHEL-01..02 (AUTH-02 updated to password-only)
- `.planning/ROADMAP.md` §Phase 1 — goal, success criteria, ops-track notes

### Stack & architecture research
- `.planning/research/STACK.md` — versions, shadcn init command (`npx shadcn@4.21.4 init -t next -p b51GFhBEQ`), static export + Fastify, SFU integration contract, SDK caveats (no `iceTransportPolicy`, `node:crypto` import), GitHub Packages BuildKit-secret pattern. **Ignore its TOTP/otplib/qrcode/input-otp parts (D-05).**
- `.planning/research/ARCHITECTURE.md` — component layout, Cloudflare Tunnel pattern used on this box
- `.planning/research/PITFALLS.md` — iOS PWA, cookie, push, SFU/TURN pitfalls
- `.planning/research/SUMMARY.md` — consolidated research and phase-0 blockers
- `.claude/CLAUDE.md` — project instructions (stack table; its Auth row still lists TOTP and is superseded by D-05)

### External
- `https://github.com/sideby-me/sfu.sideby.me` — SFU repo: README media gates, `.env.example`, `nginx-sni.conf`, `src/turn/ice-servers.ts`, `dev/e2e-join.ts` (token + join reference)
- `https://github.com/sideby-me/rtc.sideby.me` — `@sideby-me/rtc` SDK source

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- None. This is a greenfield repo (only `.planning/` and `.claude/` exist).

### Established Patterns
- None yet. Follow STACK.md: npm workspaces `web/` (Next static export from the shadcn preset), `server/` (Fastify 5, run via `tsx`), `shared/` (zod).

### Integration Points
- This box already runs `sideby-staging-*` containers and a Cloudflare Tunnel for staging. Add a **new** tunnel/ingress for `duet.brkn.me` without disturbing the existing one.
- `tailscale serve` occupies `100.97.55.101:443`. The SFU's nginx-sni must bind `:443` on the LAN/public interface without colliding with it.

### Network findings (2026-10-08, from this box)
- Egress IPv4: `103.198.98.196`.
- **Double NAT**: path is `192.168.0.1` (inner router) → `192.168.10.1` (outer router) → PPPoE (pmtu 1492) → first ISP hop `10.10.201.4` (private, which *might* indicate CGNAT).
- The first ops checklist item is to confirm the outer router's WAN IP equals `103.198.98.196`. If it shows 100.64.0.0/10 or 10.x, it's CGNAT → D-15. Port-forwards (TCP 443; SFU RTC UDP/TCP 44444-44445; TURN 3478/5349; relay range UDP 49152-65535, or a narrowed range) are needed on **both** routers, or the inner router must be bridged/DMZ'd to the outer one.

</code_context>

<specifics>
## Specific Ideas

- Login feels personal: tap your own name tile, then enter your password.
- Dark-only look using the preset's rose accent.
- The home-screen label is just "duet".

</specifics>

<deferred>
## Deferred Ideas

- TOTP / 2FA. The user explicitly dropped it. If it's ever wanted again, the cheapest form is TOTP once per device, with the 90-day session carrying it afterwards.
- CGNAT fallback host choice (VPS vs ISP public IP). Decide only if the check fails (D-15).

</deferred>

---

*Phase: 01-foundation-auth-media-plane*
*Context gathered: 2026-10-08*
