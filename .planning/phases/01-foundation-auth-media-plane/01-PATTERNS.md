# Phase 1: Foundation, Auth & Media Plane (media track) - Pattern Map

**Mapped:** 2026-10-09
**Scope:** INFR-03 / INFR-04 only (P2P WebRTC + Cloudflare TURN, D-16). App-track files (01-01..01-03) are the analogs.
**Files analyzed:** 27 (19 new, 8 modified)
**Analogs found:** 23 / 27

## File Classification

| File | New/Mod | Role | Data Flow | Closest Analog | Match |
|---|---|---|---|---|---|
| `deploy/cloudflare/turn-key.sh` | new | ops script | request-response (CF API) | `deploy/cloudflared/setup.sh` | exact |
| `shared/src/rtc.ts` | new | schema | transform | `shared/src/api.ts` | exact |
| `shared/src/ws.ts` | new | schema | event-driven | `shared/src/api.ts` | role-match |
| `shared/src/index.ts` | mod | barrel | - | itself | - |
| `server/src/rtc/turn.ts` | new | service | request-response (outbound fetch) | none (first outbound HTTP) | partial |
| `server/src/rtc/routes.ts` | new | route | request-response | `server/src/routes/users.ts` + `auth/routes.ts` (`/api/me`) | exact |
| `server/src/ws/hub.ts` | new | service/store | event-driven, pub-sub | none | no analog |
| `server/src/ws/routes.ts` | new | route | event-driven | `server/src/auth/routes.ts` (preHandler pattern) | role-match |
| `server/src/app.ts` | mod | config/bootstrap | - | itself | - |
| `server/src/config.ts` | mod | config | - | itself | - |
| `server/src/auth/session.ts` | mod | middleware | request-response | itself (`requireUser`) | - |
| `server/src/auth/routes.ts` | mod | route | - | itself (logout) | - |
| `server/test/helpers.ts` | mod | test util | - | itself | - |
| `server/test/turn.test.ts` | new | test | - | `server/test/users.test.ts` | exact |
| `server/test/ws.test.ts` | new | test | event-driven | `server/test/users.test.ts` | role-match |
| `web/lib/ws.ts` | new | client utility | event-driven | `web/lib/api.ts` | partial |
| `web/lib/rtc/ice.ts` | new | client utility | request-response | `web/lib/api.ts` (`apiPost`) | exact |
| `web/lib/rtc/peer.ts` | new | client utility | event-driven | none (RESEARCH Pattern M4) | no analog |
| `web/lib/rtc/stats.ts` | new | client utility | transform | none (RESEARCH Pattern M5) | no analog |
| `web/app/debug/call/page.tsx` | new | page | request-response | `web/app/page.tsx` | exact |
| `web/components/app/call-test.tsx` | new | component | event-driven | `web/components/app/shell.tsx` | role-match |
| `web/components/app/shell.tsx` | mod | component | - | itself (DropdownMenuItem) | - |
| `scripts/smoke-call.sh` | new | test script | batch | `scripts/smoke-local.sh` / `smoke-public.sh` | exact |
| `scripts/smoke-call.mjs` | new | test script | event-driven | none (playwright-core) | no analog |
| `scripts/smoke-public.sh` | mod | test script | - | itself | - |
| `.env.example`, `compose.yaml` | mod | config | - | themselves | - |
| `README.md` | mod | docs | - | itself | - |

## Pattern Assignments

### `deploy/cloudflare/turn-key.sh` (analog `deploy/cloudflared/setup.sh`)
Copy lines 14-60 verbatim: `set -euo pipefail`, `ROOT`, `SECRETS_DIR`/`INI`, `die()`, tool checks, `umask 077`, `work=$(mktemp -d)` + trap, token read from ini into `auth.hdr` header file (never argv), `unset token`, and the `cf METHOD PATH [BODY]` helper that dies unless `.success == true`.
```bash
printf 'Authorization: Bearer %s\n' "$token" > "$work/auth.hdr"
unset token
cf() { local method="$1" path="$2" body="${3:-}" out="$work/resp.json"
  ... curl -sS -X "$method" -H @"$work/auth.hdr" ... -o "$out" "$API$path"
  [ "$(jq -r '.success' "$out")" = "true" ] || die "$method $path failed: ..." }
```
Note: TURN credential mint endpoint (`rtc.live.cloudflare.com`) is not a v4 envelope (no `.success`), so the verify step needs its own curl checking HTTP 201, bearer via a second header file. Write `.env` keys idempotently (sed-replace or append), 0600.

### `shared/src/rtc.ts`, `shared/src/ws.ts` (analog `shared/src/api.ts`)
Pattern: zod 4 schema + same-named type export, doc comment per schema.
```ts
export const MeResponse = z.object({ user: UserSummary, peer: UserSummary.nullable() })
export type MeResponse = z.infer<typeof MeResponse>
```
For ws frames use `z.discriminatedUnion("type", [...])`. Re-export from `shared/src/index.ts`.

### `server/src/rtc/routes.ts` (analogs `server/src/routes/users.ts`, `server/src/auth/routes.ts:70-78`)
Plugin = `export async function xRoutes(app: FastifyInstance)`; authed routes use `{ preHandler: requireUser }`; typed return from `@duet/shared`; errors as `reply.code(n).send({ error: "snake_code" })`.
```ts
app.get("/api/me", { preHandler: requireUser }, async (request): Promise<MeResponse> => { ... })
```
POSTs automatically pass through `originGuard` (`server/src/http/guards.ts`) because path starts with `/api/`. Validate bodies with `Schema.safeParse(request.body)` -> 400 `{ error: "invalid_body" }`. Upstream TURN failure -> 502 `{ error: "turn_unavailable" }`, never echo the CF response.

### `server/src/rtc/turn.ts` (no direct analog)
Make it pure with injected `fetch` (testability, matches `buildApp(config, { fetch })` plan). Read key id/token from `Config`, never log them.

### `server/src/ws/routes.ts` + `server/src/ws/hub.ts`
Auth via preHandler like `/api/me`, but using the new non-renewing check (WS upgrade cannot Set-Cookie). Origin: originGuard only checks non-GET, so `/ws` (GET) needs an explicit `request.headers.origin !== config.APP_ORIGIN` -> 403 in its preHandler (mirror `guards.ts:15-22`). Hub: decorate like `db`/`config` in `app.ts:13-18` (`declare module "fastify" { interface FastifyInstance { hub: Hub } }`) and clean up in an `onClose` hook like `app.ts:26-28`.

### `server/src/auth/session.ts` (modify)
Split `requireUser` (lines ~90-140): extract the lookup + expiry part (`hashToken`, join select, expired -> delete) into `lookupSession(db, token)` returning row|null with no renewal/no cookie writes; `requireUser` keeps the renewal block; add `requireUserNoRenew` that sets `request.user`/`request.session` without the `RENEW_AFTER_MS` branch. Keep `{ error: "unauthenticated" }` 401 body.

### `server/src/auth/routes.ts` (modify, line 78 logout)
After deleting the session row, call `app.hub.closeSession(request.session.id)`.

### `server/src/app.ts` (modify)
Register `@fastify/websocket` after `fastifyCookie`/rate-limit (lines 52-55) and before route plugins; add `await app.register(rtcRoutes)` / `wsRoutes` next to `usersRoutes`/`authRoutes` (lines 59-60). Extend signature `buildApp(config, deps?: { fetch?: typeof fetch })`. Note setNotFoundHandler only JSON-404s `/api`; `/ws` must be registered as a route.

### `server/src/config.ts` (modify)
Add to `EnvSchema` (optional strings, e.g. `CF_TURN_KEY_ID`, `CF_TURN_KEY_API_TOKEN`, TTL via `z.coerce.number()`), AND add the names to the `keys` array in `loadConfig` (line ~50) or they are silently dropped. Production-required rule goes in `superRefine` like `APP_ORIGIN`.

### Tests (analog `server/test/users.test.ts`, `server/test/helpers.ts`)
```ts
let t: TestApp
beforeAll(async () => { t = await makeTestApp({ seed: true }) })
afterAll(async () => { await t.close() })
const res = await t.app.inject({ method: "POST", url, headers: { origin: "http://localhost:3000" }, payload })
```
Extend helpers: `makeTestApp({ fetch })` passed into `buildApp`, `testConfig` adds dummy TURN keys, add `loginCookie(app, user)` (POST `/api/login` with origin header, read `duet_session` set-cookie). WS tests use `app.injectWS` from @fastify/websocket.

### `web/lib/rtc/ice.ts` (analog `web/lib/api.ts`)
```ts
export function apiPost<S extends z.ZodType>(path: string, body: unknown, schema: S)
```
`fetchIceServers = () => apiPost("/api/rtc/ice-servers", {}, IceServersResponse)`. Errors surface as `ApiError(status, code)`.

### `web/lib/ws.ts`
Follow `api.ts` conventions: parse every inbound frame with the shared zod schema (`safeParse`, drop on failure), typed send. URL: same-origin `wss://` in prod, `ws://localhost:3100/ws` in dev (CLAUDE.md dev note).

### `web/app/debug/call/page.tsx` (analog `web/app/page.tsx`)
`"use client"`, discriminated `State` union with `useState`, `useCallback` loader that calls `apiGet("/api/me", MeResponse)` and on `ApiError` 401 renders `Empty` with link to `/`; `Spinner` while loading. Render `<CallTest me={...} />`.

### `web/components/app/call-test.tsx` (analog `web/components/app/shell.tsx`)
Imports: `@phosphor-icons/react` (`...Icon` names), `@/components/ui/*`, `toast` from `sonner`, `<Toaster theme="dark" position="top-center" />`, safe-area header classes. Add `switch`, `badge` via `npx shadcn@4.21.4 add switch badge` (then delete `web/package-lock.json`/`web/node_modules`, run `scripts/check-preset.sh`).

### `web/components/app/shell.tsx` (modify)
Add a `DropdownMenuItem` before "Log out" (inside `DropdownMenuContent`):
```tsx
<DropdownMenuItem onClick={() => { window.location.href = "/debug/call/" }}>
  <PhoneIcon /> Call test
</DropdownMenuItem>
```
(trailing slash: static export uses `trailingSlash: true`).

### `scripts/smoke-call.sh` (analog `scripts/smoke-public.sh`) and `scripts/smoke-public.sh` (modify)
Copy preamble: `set -euo pipefail`, `ROOT`, `die()`, `umask 077`, tmp + trap, `get()` helper setting `$status`, final line `"smoke-call ok"`; never print secrets. Add to smoke-public after step 3:
```bash
get -H 'Connection: Upgrade' -H 'Upgrade: websocket' -H 'Sec-WebSocket-Version: 13' -H 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==' "$BASE/ws"
[ "$status" = "401" ] || die "/ws without cookie returned $status, expected 401"
```

### `.env.example` / `compose.yaml`
`.env.example`: add key names only with comment (D-03 style). `compose.yaml`: `env_file: .env` already passes them; no `ports:` change.

## Shared Patterns
- **Auth:** `requireUser` preHandler (`server/src/auth/session.ts`); 401 `{ error: "unauthenticated" }`.
- **CSRF/Origin:** `originGuard` covers non-GET `/api/*` automatically; `/ws` needs its own check.
- **Errors:** JSON `{ error: "snake_code" }`; `app.ts` error handler maps body-parse failures to `invalid_body`.
- **Schemas:** shared zod in `@duet/shared`, parsed on both ends.
- **Secrets in shell:** header files in `mktemp -d` under `umask 077`, never argv, never echoed.
- **UI:** preset components only, Phosphor icons, always-dark Toaster.

## No Analog Found
| File | Reason |
|---|---|
| `server/src/ws/hub.ts` | No WS/realtime code yet; use RESEARCH Pattern M3 |
| `server/src/rtc/turn.ts` | No outbound HTTP from server yet; RESEARCH M2 + CF TURN API contract |
| `web/lib/rtc/peer.ts`, `web/lib/rtc/stats.ts` | No WebRTC code; RESEARCH M4/M5 |
| `scripts/smoke-call.mjs` | No browser automation yet; RESEARCH M6 / Validation |

## Metadata
Search scope: `server/`, `shared/`, `web/`, `scripts/`, `deploy/` (all git-tracked). Files scanned: ~20.
