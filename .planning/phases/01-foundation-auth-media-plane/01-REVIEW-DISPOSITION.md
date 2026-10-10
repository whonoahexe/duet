---
phase: 01
review: 01-REVIEW.md
created: 2026-10-09T21:55:56Z
---

# Phase 01 code review disposition

Every finding starts as `open`. Change one to `fixed`, `accepted`, `deferred` or `wont-fix` once someone triages it.

| ID | Severity | Finding | Disposition | Note |
|----|----------|---------|-------------|------|
| CR-01 | Critical | Origin (CSRF) guard bypassed by percent-encoding the path | fixed | 26c7cfa |
| WR-01 | Warning | Login rate limit keyed only on (client IP, userId) can be bypassed by rotating IPs | fixed | c743038 — owner accepted the per-account lockout trade-off as-is (2026-10-10 UAT test 31) |
| WR-02 | Warning | Revoked or expired sessions keep their /ws sockets open indefinitely | fixed | 69d114d — needs human check |
| WR-03 | Warning | APP_ORIGIN is not normalized, so a trailing slash, uppercase host or path locks out every POST and /ws | fixed | e859d42 |
| IN-01 | Info | Unhandled 5xx errors echo internal error messages to the client | open | |
| IN-02 | Info | Sessions are never pruned and can't be listed or revoked individually | open | |
| IN-03 | Info | Seed allows 1024 code points but login allows only 1024 UTF-16 units | open | |
| IN-04 | Info | SignalingClient.connect() has no timeout | open | |
| IN-05 | Info | Candidate-pair fallback may report the wrong local type on Safari | open | |
| IN-06 | Info | The INFR-04 cellular gate trusts client-reported fields | open | |
| IN-07 | Info | Unused font import | open | |
| IN-08 | Info | Theme hotkey is dead code under forcedTheme="dark" | open | |
| IN-09 | Info | No Content-Security-Policy and a hard-coded cloudflared uid | open | |
