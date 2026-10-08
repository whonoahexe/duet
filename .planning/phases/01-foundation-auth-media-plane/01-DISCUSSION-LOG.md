# Phase 1: Foundation, Auth & Media Plane - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md — this log preserves the alternatives considered.

**Date:** 2026-10-08
**Phase:** 01-foundation-auth-media-plane
**Areas discussed:** Domain & hostnames, Login flow, App identity & landing, SFU smoke test & ops

---

## Domain & hostnames

| Option | Description | Selected |
|--------|-------------|----------|
| Already own one | User names the domain | ✓ |
| Will buy on Cloudflare | Registrar + DNS + Tunnel in one place | |
| Decide later, placeholder | DOMAIN env var; HTTPS waits | |

**User's choice:** brkn.me. It's the user's portfolio domain, already on Cloudflare.

| Option | Description | Selected |
|--------|-------------|----------|
| duet. / sfu. / turn. | Mirrors the SFU repo layout | |
| Apex for app | App at the apex | |
| You decide | Claude picks | ✓ |

**Notes:** Claude chose duet.brkn.me (tunnel, proxied) with sfu./turn.brkn.me DNS-only A records to the home IP. The apex portfolio is untouched.

---

## Login flow

| Option | Description | Selected |
|--------|-------------|----------|
| Type a username | Reveals nothing about who the accounts belong to | |
| Tap your name/avatar | Two tiles, then password | ✓ |

| Option | Description | Selected |
|--------|-------------|----------|
| Two steps | Password, then OTP | |
| One screen | All fields on one form | |

**User's choice (free text):** "no otp, just password". Confirmed in a follow-up:

| Option | Description | Selected |
|--------|-------------|----------|
| Yes, password only | Update AUTH-02/ROADMAP; argon2id + rate limit | ✓ |
| Keep TOTP, but once per device | 2FA on first login per device only | |
| Keep TOTP every login | Original plan | |

| Option | Description | Selected |
|--------|-------------|----------|
| Generic + rate limit | Generic error + cooldown after ~5 failures | |
| You decide | Claude picks | ✓ |

| Option | Description | Selected |
|--------|-------------|----------|
| 90 days, rolling | Extended on use | ✓ |
| 1 year, rolling | Stickier | |
| Never expires | Logout only | |

| Option | Description | Selected |
|--------|-------------|----------|
| Name + initials avatar | Avatar fallback, names from seed | ✓ |
| Name + photo | Seed takes photo paths | |
| Nicknames/emoji | Not real names | |

---

## App identity & landing

| Question | Options | Selected |
|----------|---------|----------|
| Home-screen name | duet / Something private | duet |
| Icon | Simple generated mark / I'll provide one / You decide | Simple generated mark |
| Phase 1 landing | Chat-shaped empty shell / Minimal "logged in as X" | Chat-shaped empty shell |
| Theme | Follow system / Always dark / Always light | Always dark |

---

## SFU smoke test & ops

| Question | Options | Selected |
|----------|---------|----------|
| Harness location | Hidden page in duet / Separate throwaway page | Hidden page in duet |
| Ops split | Checklist, I do router / Walk me through live | Checklist, I do router |
| SFU deploy | Separate compose stack / Same compose as duet | Separate compose stack |
| CGNAT fallback | Cheap VPS / Revive GCP VM-B / Ask ISP | "not sure actually" |

**Notes:** Claude ran a read-only path check from the box. It found double NAT (192.168.0.1 → 192.168.10.1), PPPoE, and a first ISP hop at 10.10.201.4, which is inconclusive for CGNAT. Re-asked with these options:

| Option | Description | Selected |
|--------|-------------|----------|
| Small VPS | ~$4–6/mo; most reliable | |
| Ask ISP for public IP | Free; may take days | |
| Decide if it happens | Ops pauses and asks then | ✓ |

---

## Claude's Discretion

- Hostname layout
- Failed-login message and rate-limit thresholds
- Icon glyph and empty-state copy

## Deferred Ideas

- TOTP / 2FA. Dropped by the user; the cheapest re-add is once per device.
- CGNAT fallback host. Decide only if the check fails.
