# Phase 2: Chat, Media & Push - Pattern Map

**Mapped:** 2026-10-10
**Files analyzed:** 38 (new + modified)
**Analogs found:** 32 / 38

All analog paths below are git-tracked source (checked with `git ls-files`).

## File Classification

| New/Modified File | Role | Data Flow | Closest Analog | Match Quality |
|---|---|---|---|---|
| `server/src/db/schema.ts` (mod) | model | CRUD | itself (`users`, `sessions`) | exact |
| `server/drizzle/0001_*.sql` (new, generated) | migration | batch | `server/drizzle/0000_amusing_bishop.sql` | exact |
| `shared/src/chat.ts` (new) | model/schema | request-response | `shared/src/api.ts` | exact |
| `shared/src/chat-logic.ts` (new) | utility (pure) | transform | none (pure helpers) | no analog |
| `shared/src/ws.ts` (mod) | schema | event-driven | itself | exact |
| `shared/src/index.ts` (mod) | barrel | - | itself | exact |
| `server/src/chat/routes.ts` (new) | controller | CRUD | `server/src/rtc/routes.ts` | exact |
| `server/src/chat/service.ts` (new) | service | CRUD | `server/src/routes/users.ts` (query) + `auth/routes.ts:142-145` (write then hub) | role-match |
| `server/src/ws/hub.ts` (mod) | service | pub-sub | itself | exact |
| `server/src/media/uploads.ts` (new) | controller | file-I/O | `server/src/rtc/routes.ts` | role-match |
| `server/src/media/process.ts` (new) | service | batch / file-I/O | none (child_process ffmpeg/sharp) | no analog |
| `server/src/media/routes.ts` (new) | controller | file-I/O (streaming, Range) | `server/src/app.ts:102-118` (fastifyStatic) + `rtc/routes.ts` | partial |
| `server/src/push/sender.ts` (new) | service | event-driven | `server/src/rtc/turn.ts` (external call wrapper with typed error) | role-match |
| `server/src/push/routes.ts` (new) | controller | request-response | `server/src/rtc/routes.ts` | exact |
| `server/src/app.ts` (mod) | config/bootstrap | - | itself | exact |
| `server/src/config.ts` (mod: VAPID_*, media limits) | config | - | itself (CF_TURN_* pair) | exact |
| `server/test/chat.test.ts`, `media.test.ts`, `push.test.ts` (new) | test | - | `server/test/ws.test.ts`, `users.test.ts`, `turn.test.ts` | exact |
| `server/test/helpers.ts` (mod, maybe) | test util | - | itself | exact |
| `Dockerfile` (mod: ffmpeg, heif in runtime) | config | - | itself | exact |
| `.env.example` (mod: VAPID) | config | - | itself | exact |
| `server/package.json` (mod: web-push, sharp, @fastify/multipart?) | config | - | itself | exact |
| `web/lib/chat/store.ts` (new) | store | CRUD (TanStack cache) | `web/lib/api.ts` | partial |
| `web/lib/chat/realtime.ts` (new) | client | event-driven | `web/lib/ws.ts` (`SignalingClient`) | exact |
| `web/lib/chat/outbox.ts` (new) | utility | event-driven | none | no analog |
| `web/lib/chat/upload.ts` (new) | utility | file-I/O | `web/lib/api.ts` `request()` | partial |
| `web/lib/chat/push.ts` (new) | utility | request-response | `web/components/app/sw-register.tsx` + `web/lib/api.ts` | partial |
| `web/public/sw.js` (mod) | worker | event-driven | itself | exact |
| `web/next.config.ts` (mod: `/media` rewrite) | config | - | itself line 16 | exact |
| `web/app/layout.tsx` (mod: `interactiveWidget`) | config | - | itself lines 24-28 | exact |
| `web/app/page.tsx` (mod: A2HS gate before tiles) | component | request-response | itself (`State` union) | exact |
| `web/components/app/shell.tsx` (mod: h-dvh, menu item, chat view) | component | - | itself | exact |
| `web/components/app/chat-view.tsx`, `message-row.tsx`, `composer.tsx` | component | event-driven | `shell.tsx`, `password-step.tsx` | role-match |
| `web/components/app/album.tsx`, `viewer.tsx`, `preview-drawer.tsx` | component | - | `shell.tsx` (preset imports) | role-match |
| `web/components/app/recorder.tsx`, `voice-note.tsx` | component | streaming (MediaRecorder) | `web/components/app/call-test.tsx` (getUserMedia lifecycle) | partial |
| `web/components/app/a2hs-guide.tsx` | component | - | `web/app/page.tsx:57-110` (centered max-w-sm page) | role-match |
| `web/components/app/notifications-card.tsx`, `notifications-drawer.tsx` | component | request-response | `password-step.tsx` (pending + ApiError) | role-match |
| `web/components/ui/*` (message, bubble, ..., carousel) | vendor | - | `npx shadcn add` only, never hand-written | n/a |

## Pattern Assignments

### `server/src/db/schema.ts` + `server/drizzle/0001_*.sql`

**Analog:** `server/src/db/schema.ts` lines 1-20
```ts
import { sqliteTable, text, integer } from "drizzle-orm/sqlite-core"
export const sessions = sqliteTable("sessions", {
  id: text("id").primaryKey(), // sha256(token) hex
  userId: text("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  ...
})
```
- Conventions: snake_case column names, `text` ids (UUID), timestamps as `integer(..., { mode: "timestamp_ms" })`, FK with `onDelete: "cascade"`.
- `push_subscriptions.session_id` -> `sessions.id` `onDelete: "cascade"` (RESEARCH Pitfall 9).
- Migration: run `npm run db:generate -w server` (`drizzle-kit generate`), commit the SQL + `meta/`. Applied at boot by `server/src/db/client.ts:34` (`migrate(db, { migrationsFolder })`). Note `foreign_keys = ON` is set in `client.ts:30`. `data/media` is already created at `client.ts:25`.

### `shared/src/chat.ts`

**Analog:** `shared/src/api.ts` lines 1-38
```ts
import { z } from "zod"
export const LoginBody = z.object({
  userId: z.uuid(),
  password: z.string().min(1).max(1024),
})
export type LoginBody = z.infer<typeof LoginBody>
```
- Pattern: schema const and type with the same name (`export const X = z.object(...)`, `export type X = z.infer<typeof X>`). Bound every string (`.max()`). Reuse `OkResponse` / `ErrorResponse`.
- Export `REACTIONS = ["💕","💔","😋","😝","😘","😭"] as const` here (D-04) and add `export * from "./chat"` and `"./chat-logic"` to `shared/src/index.ts` (currently 3 lines).

### `shared/src/ws.ts` (add chat frames)

**Analog:** itself, lines 44-70
```ts
export const ClientFrame = z.discriminatedUnion("t", [
  z.strictObject({ t: z.literal("room.join"), room: RoomId }),
  ...
])
export const ServerFrame = z.discriminatedUnion("t", [
  z.object({ t: z.literal("hello"), connId: z.uuid(), userId: z.uuid() }),
  ...
])
```
- Client frames use `z.strictObject` (an unknown key means bad_frame). Server frames use `z.object` (tolerant for older PWAs). New client frames: `ping`, `typing`, `presence{visible}`. New server frames: `pong`, `msg`/`msg.updated`, `read`, `typing`, `media.ready`. Keep `WS_MAX_FRAMES_PER_SECOND` (line 14) unchanged. Extend `WsErrorCode` (line 58) if needed.

### `server/src/chat/routes.ts`, `server/src/push/routes.ts`, `server/src/media/uploads.ts`

**Analog:** `server/src/rtc/routes.ts` (whole file, 92 lines)

Imports (lines 1-4):
```ts
import type { FastifyInstance, FastifyRequest } from "fastify"
import { CallReport, type IceServersResponse } from "@duet/shared"
import { requireUser } from "../auth/session"
```
Auth + rate limit + validation (lines 79-91):
```ts
app.post("/api/debug/call-report", { preHandler: requireUser, config: perIpLimit() },
  async (request, reply) => {
    const parsed = CallReport.safeParse(request.body)
    if (!parsed.success) return reply.code(400).send({ error: "invalid_body" })
    request.log.info({ evt: "call_smoke", userId: request.user!.id, ... })
    return reply.code(204).send()
  })
```
Typed-error mapping (lines 62-69):
```ts
} catch (err) {
  if (err instanceof TurnError) {
    request.log.warn({ evt: "turn_mint", userId, ok: false, code: err.code })
    return reply.code(status).send({ error: err.code })
  }
  throw err
}
```
- Plugin shape: `export async function chatRoutes(app: FastifyInstance, opts?)`, registered in `app.ts`.
- Every route: `preHandler: requireUser`. Validate with `Schema.safeParse(request.body)` and answer `{ error: "invalid_body" }` 400. Errors are `{ error: "<snake_code>" }`. Logs use `{ evt: "...", userId }` and never log message bodies or push endpoints.
- Non-GET routes are already Origin-checked globally (`server/src/http/guards.ts:29-37`). Do not re-check.
- Rate limits: copy `perIpLimit()`/`clientIp()` (lines 16-39), using `cf-connecting-ip`.
- Push routes: `reply.header("Cache-Control", "no-store")` as in lines 60/65.

### `server/src/chat/service.ts`

**Analog (query):** `server/src/routes/users.ts` lines 11-17
```ts
const rows = app.db
  .select({ id: users.id, username: users.username, displayName: users.displayName })
  .from(users)
  .orderBy(asc(users.createdAt), asc(users.username))
  .all()
```
- Explicit column projection into DTOs (`toDto()`). Never `select()` everything into a response.

**Analog (write, then notify the hub):** `server/src/auth/routes.ts` lines 142-145
```ts
app.db.delete(sessions).where(eq(sessions.id, request.session!.id)).run()
...
app.hub.closeSession(request.session!.id)
```
- Routes and services write to the DB, then call hub methods. The hub stays DB-free (RESEARCH anti-pattern). The idempotent send uses select-then-insert in a transaction (RESEARCH Pattern 1).

### `server/src/ws/hub.ts` (extend)

**Analog:** itself
- `Conn` interface (lines 30-39): add `visible: boolean`, `lastSeenAt: number`.
- Frame dispatch `switch (frame.t)` (lines 144-160): add `ping` -> `send(conn, { t: "pong" })`, `typing` -> relay to the other user's conns, `presence` -> set `conn.visible`.
- Add a fan-out helper in the style of `send`/`sendTo` (lines 58-66):
```ts
function send(conn: Conn, frame: ServerFrame): void {
  if (conn.closing || conn.socket.readyState !== conn.socket.OPEN) return
  conn.socket.send(JSON.stringify(frame))
}
```
  New methods on `Hub` (lines 22-28): `publishToUser(userId, frame)`, `publishToUsers`, `isViewing(userId)`. Keep the doc-comment style.
- Dependencies are injected through `HubOptions` (lines 41-52, as `isSessionLive` is). Never import db.

### `server/src/media/routes.ts` (GET /media/:id/:variant)

**Analog:** `server/src/app.ts` lines 102-118 (`fastifyStatic` already decorates `reply.sendFile`) + `rtc/routes.ts` auth shape.
```ts
await app.register(fastifyStatic, {
  root: config.WEB_OUT,
  ...
  setHeaders(reply, filePath) { ... }
})
```
- `fastifyStatic` is only registered when `web/out` exists (`hasStatic`, line 104). Tests skip static (`helpers.ts` `WEB_OUT: no-web-out`), so the media route must not depend on that registration. Register a second `fastifyStatic` with `root: <DATA_DIR>/media`, `serve: false`, `decorateReply: false`, or stream via `reply.sendFile(rel, root)` (check against @fastify/static 10.1.5). `preHandler: requireUser`. Allowlist variant names. Extensionless URLs (RESEARCH Pattern 7, Pitfall 10: never cache 404s as immutable).
- The not-found handler (`app.ts:120-128`) returns JSON only for `/api`. A `/media` miss must return its own 404 inside the route.

### `server/src/push/sender.ts`

**Analog:** `server/src/rtc/turn.ts` (external-service wrapper exporting a `TurnError` with a `code`, deps injected for tests: `fetch`, `timeoutMs`). Follow the same shape: an injectable `send` function (default `webpush.sendNotification`) passed through `AppDeps` (`app.ts:28-37`) so tests do not hit the network. Delete the subscription row on 404/410.

### `server/src/app.ts` (registration)

**Analog:** itself, lines 88-93
```ts
await app.register(usersRoutes)
await app.register(authRoutes)
await app.register(rtcRoutes, { fetch: deps.fetch ?? globalThis.fetch, timeoutMs: deps.turnTimeoutMs ?? 5000 })
await app.register(wsRoutes)
```
- Add one line per plan (`chatRoutes`, `pushRoutes`, `mediaRoutes`, `uploadRoutes`) to limit wave-2 merge conflicts (RESEARCH plan breakdown note).
- New test injection points go on `AppDeps` with a JSDoc line each (`webPushSend?`, `mediaProcess?`).
- Boot-time config log, as at lines 96-100: `app.log.info({ evt: "push_config", configured })`.
- Error handler (lines 59-70) already maps `FST_ERR_CTP_*` to `invalid_body` with a <500 status (413 for oversized bodies).

### `server/src/config.ts` (VAPID)

**Analog:** itself, CF_TURN pair (lines 45-49, 62-68, 95-98)
```ts
CF_TURN_KEY_ID: z.string().min(1).optional(),
...
if (Boolean(env.CF_TURN_KEY_ID) !== Boolean(env.CF_TURN_KEY_API_TOKEN)) { ctx.addIssue(...) }
```
- Add `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT` (must be `mailto:` or `https:`, RESEARCH Pitfall 4) as optional set-together keys. **Also add each key to the `keys` array in `loadConfig` (lines 86-99)**, otherwise it is silently dropped. Document them in `.env.example` with the same comment style as the TURN block.

### Server tests (`server/test/chat.test.ts`, `push.test.ts`, `media.test.ts`)

**Analog:** `server/test/ws.test.ts` lines 1-31, `users.test.ts`
```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { loginCookie, makeTestApp, openWs, TEST_ORIGIN, type TestApp, type WsTestClient } from "./helpers"
let t: TestApp
beforeAll(async () => {
  t = await makeTestApp({ seed: true, logStream })
  aliceCookie = await loginCookie(t.app, "alice")
  bobCookie = await loginCookie(t.app, "bob")
})
afterAll(async () => { await t.close() })
```
- Non-GET injects must send `headers: { origin: TEST_ORIGIN, cookie }` (see `users.test.ts` POST). WS: `openWs(app, cookie)` and `client.next()`/`collect(ms)` (`helpers.ts:109-143`). Log assertions use a `Writable` logStream (`ws.test.ts:10-17`). Fixture env pattern: `TURN_TEST_ENV` in `helpers.ts:21-24`, so add a `VAPID_TEST_ENV` the same way.
- Add new `MakeTestAppOptions` fields (`helpers.ts:49-57`) when `AppDeps` grows.

### `Dockerfile`

**Analog:** itself. Build stage apt (lines 8-10) shows the style. Add `apt-get install -y --no-install-recommends ffmpeg libheif-examples && rm -rf /var/lib/apt/lists/*` (heif-convert per RESEARCH Pattern 6) to the **runtime** stage after line 24 and **before `USER node` (line 32)**.

### `web/lib/chat/realtime.ts`

**Analog:** `web/lib/ws.ts` (whole file)
```ts
export function signalingUrl(): string {
  if (process.env.NODE_ENV === "development") return "ws://localhost:3100/ws"
  ...
}
const parsed = ServerFrame.safeParse(raw)
if (!parsed.success) { console.warn("signaling: dropped an unknown frame"); return }
```
- Reuse `SignalingClient` (one instance = one socket, `onFrame`/`onClose` return unsubscribe functions). Wrap it in a reconnecting manager: backoff 0.5 s -> 8 s with jitter, ping/pong check on `visibilitychange`/`pageshow`, `/api/sync` on every (re)connect, close code `WS_CLOSE_LOGGED_OUT` (4401) -> logged-out callback (RESEARCH Pitfalls 8, 16). Call test (`call-test.tsx:332-337`) shows wiring and the 4401 toast.

### `web/lib/chat/store.ts`, `upload.ts`, `push.ts`

**Analog:** `web/lib/api.ts` lines 3-54
```ts
export class ApiError extends Error { constructor(readonly status: number, readonly code: string) ... }
export function apiPost<S extends z.ZodType>(path: string, body: unknown, schema: S): Promise<z.output<S>>
```
- All JSON calls go through `apiGet`/`apiPost` with a shared zod response schema. Add `apiPut`/`apiDelete` in the same file if needed, following the `request()` helper. Chunk uploads need raw `fetch` (binary body) but must keep `credentials: "same-origin"` and the same `ApiError` mapping. For per-chunk progress use XHR or chunk-count progress.
- `push.ts`: subscribe inside the tap handler (RESEARCH Pattern 10). SW registration is in `sw-register.tsx:11` (`navigator.serviceWorker.register("/sw.js", { scope: "/", updateViaCache: "none" })`). Use `navigator.serviceWorker.ready`, do not register again.

### `web/public/sw.js`

**Analog:** itself (10 lines). Keep the install/activate listeners. Add `push` (always `showNotification`, with `tag: "duet-chat"`, `renotify: true`) and `notificationclick` (focus or open `/`). **Never add a `fetch` listener** (the comment on lines 1-3 is the rule). Code template: RESEARCH Pattern 8.

### `web/next.config.ts` and `web/app/layout.tsx`

- `next.config.ts` line 16: append `{ source: "/media/:path*", destination: "http://localhost:3100/media/:path*" }`.
- `layout.tsx` lines 24-28: add `interactiveWidget: "resizes-content"` to `viewport`.

### `web/app/page.tsx` (A2HS gate)

**Analog:** itself, lines 14-19 discriminated `State` union and lines 57-110 centered layout.
```ts
type State =
  | { kind: "loading" }
  | { kind: "error" }
  | { kind: "tiles"; users: UserSummary[] }
  ...
```
- Add an A2HS check before the tiles (iOS Safari, not standalone, no `sessionStorage` flag) per UI-SPEC section 4. The guide page follows the `<main className="flex min-h-dvh items-center justify-center p-6"><div className="flex w-full max-w-sm flex-col gap-6">` wrapper and the `<h1 ...>duet</h1>` wordmark (line 60).

### `web/components/app/shell.tsx` and chat components

**Analog:** `web/components/app/shell.tsx` (whole file)
Imports (lines 1-18):
```tsx
"use client"
import { useState } from "react"
import { toast } from "sonner"
import { ChatCircleIcon, DotsThreeVerticalIcon, PhoneCallIcon, SignOutIcon } from "@phosphor-icons/react"
import { OkResponse, type MeResponse } from "@duet/shared"
import { Button } from "@/components/ui/button"
import { ApiError, apiPost } from "@/lib/api"
```
Menu item (lines 64-67), the shape for the new "Notifications" item with `BellIcon`:
```tsx
<DropdownMenuItem onClick={() => window.location.assign("/debug/call/")}>
  <PhoneCallIcon />
  Call test
</DropdownMenuItem>
```
- Change the root `min-h-dvh` (line 43) to `h-dvh overflow-hidden` (Pitfall 13). Replace the `<main>` `Empty` (lines 77-91) with `<ChatView>`, keeping the `Empty` block for the empty state with updated copy. Keep the single `<Toaster theme="dark" position="top-center" />` (line 93), and don't add another.
- `initials()` lives in `web/components/app/login-tiles.tsx`.
- Async action with pending state and an `ApiError` branch: `password-step.tsx` lines 14-22 (`loginErrorMessage`) and `shell.tsx` lines 25-40 (`handleLogout`). Copy this for the notification card's Enable/Test buttons and for retrying.
- Trigger with `render` prop (Base UI): `<DropdownMenuTrigger render={<Button variant="ghost" size="icon" aria-label="Menu" />}>`. Same idiom for `PopoverTrigger render={<div/>} nativeButton={false}` (Pitfall 12).

### `web/components/app/recorder.tsx`, `voice-note.tsx`

**Partial analog:** `web/components/app/call-test.tsx` (getUserMedia / track cleanup in `useEffect` cleanup, around lines 124 and 176, plus error toasts). MediaRecorder MIME selection and the waveform have no analog. Use RESEARCH Pattern 11.

## Shared Patterns

### Authentication
**Source:** `server/src/auth/session.ts:104` (`requireUser`), `:114` (`requireUserNoRenew` for WS only)
**Apply to:** every new `/api/*` and `/media/*` route. `request.user!.id`, `request.session!.id`.

### CSRF / Origin
**Source:** `server/src/http/guards.ts:29-37` (global onRequest). Every non-GET request is already covered, so new routes don't need their own check. Tests must send `origin: TEST_ORIGIN`.

### Error responses
**Source:** `rtc/routes.ts:87`, `app.ts:59-70`, `web/lib/api.ts:35-41`. Always `{ error: "snake_code" }`. The client maps it to `ApiError(status, code)`.

### Logging
`request.log.info({ evt: "<name>", userId, ... })`, never message text, captions, push endpoints or keys (`rtc/routes.ts:59`, `hub.ts:20` comment).

### Validation
Zod schemas in `@duet/shared`, `safeParse` on the server, schema passed to `apiGet`/`apiPost` on the client.

### UI
Only `@/components/ui/*` (added with `npx shadcn add`) plus `@phosphor-icons/react` `*Icon` exports. `toast` from `sonner`. Client components start with `"use client"`.

## No Analog Found

| File | Role | Data Flow | Reason |
|---|---|---|---|
| `server/src/media/process.ts` | service | batch | No child_process / ffmpeg / sharp usage yet. Use RESEARCH Pattern 6 (verified commands) and Pitfalls 5-7 |
| `shared/src/chat-logic.ts` | utility | transform | No pure shared logic yet. Use RESEARCH "Shared pure helpers" |
| `web/lib/chat/outbox.ts` | utility | event-driven | No offline queue yet. Use RESEARCH Pattern 3 |
| `web/components/app/voice-note.tsx` waveform | component | - | Custom SVG `role="slider"` (UI-SPEC section 3) |
| `web/components/app/recorder.tsx` gestures | component | streaming | No MediaRecorder or gesture code yet. Use RESEARCH Pattern 11 / Pitfall 11 |
| swipe/long-press gesture handling in `message-row.tsx` | component | - | Use UI-SPEC thresholds and RESEARCH Pitfalls 11-12 |

## Metadata

**Analog search scope:** `server/src`, `server/test`, `shared/src`, `web/lib`, `web/components/app`, `web/app`, `web/public`, `Dockerfile`, `compose.yaml`, `.env.example`
**Files scanned:** 30
**Pattern extraction date:** 2026-10-10
