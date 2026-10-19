# Phase 3: Voice & Video Calls - Pattern Map

**Mapped:** 2026-10-16
**Files analyzed:** 24 (12 new, 12 modified)
**Analogs found:** 22 / 24

Binding reminders: D-03 revised (pre-negotiated transceivers + `replaceTrack`, `call.media` frame), **D-05 DROPPED** (no speaker toggle; 4 controls on both phones), D-05a (iOS 18.4+, wake lock planned normally). No new npm packages. The client uses no react-query: stores are `useSyncExternalStore` modules.

## File Classification

| New/Modified File | Role | Data Flow | Closest Analog | Match Quality |
|---|---|---|---|---|
| `shared/src/ws.ts` (mod) | model/protocol | request-response + event | itself (existing ClientFrame/ServerFrame) | exact |
| `shared/src/push.ts` (mod) | model | event | itself (`PushPayload`) | exact |
| `shared/src/call.ts` (new, optional) | model | request-response | `shared/src/push.ts` response schemas | role-match |
| `server/src/calls/registry.ts` (new) | service (state machine) | event-driven | `server/src/ws/hub.ts` (`createHub` factory, injected timers) | role-match |
| `server/src/calls/routes.ts` (new) | controller | request-response | `server/src/rtc/routes.ts` | exact |
| `server/src/ws/hub.ts` (mod) | service | event-driven | itself | exact |
| `server/src/push/sender.ts` (mod) | service | event (push) | itself (`notifyMessage`, `sendTest`) | exact |
| `server/src/push/routes.ts` (mod, expose sender / session-viewing gate) | controller | event | itself lines 81-95 | exact |
| `server/src/app.ts` (mod) | config/wiring | — | itself lines 93-98, 129-134 | exact |
| `server/test/calls.test.ts` (new) | test | event-driven | `server/test/ws.test.ts` + `server/test/helpers.ts` | exact |
| `web/lib/rtc/peer.ts` (mod) | utility | streaming | itself | exact |
| `web/lib/rtc/stats.ts` (mod) | utility | transform | itself | exact |
| `web/lib/chat/realtime.ts` (mod: expose sendFrame/onFrame/onLive) | service | event-driven | itself | exact |
| `web/lib/call/store.ts` (new) | store | event-driven | `web/lib/chat/store.ts` | exact |
| `web/lib/call/session.ts` (new) | service (framework-free class) | streaming | `web/lib/chat/realtime.ts` (class + timers + cleanups) and `web/components/app/call-test.tsx` (peer wiring) | role-match |
| `web/lib/call/media.ts` (new) | utility | request-response | `web/lib/chat/recorder.ts` (getUserMedia + error mapping) | partial |
| `web/lib/call/tones.ts` (new) | utility | streaming | none | no analog |
| `web/lib/call/wake-lock.ts` (new) | utility | event-driven | none (RESEARCH Pattern 8) | no analog |
| `web/components/app/shell.tsx` (mod) | component | — | itself lines 170-247 | exact |
| `web/components/app/call-provider.tsx` (new) | provider | event-driven | `shell.tsx` (startRealtime effects) + `chatStore`/`useChat` | role-match |
| `web/components/app/call-screen.tsx` (new) | component | streaming | `web/components/app/call-test.tsx`, `viewer.tsx` (full-screen dialog) | role-match |
| `web/components/app/incoming-call.tsx` (new) | component | event | `call-test.tsx` / `notifications-drawer.tsx` | role-match |
| `web/components/app/on-call-bar.tsx` (new) | component | — | `notifications-card.tsx` (slim bar under header) | role-match |
| `web/components/app/permission-drawer.tsx` (new) | component | — | `web/components/app/notifications-drawer.tsx` + `blockedInstructions()` | exact |
| `web/public/sw.js` (mod) | config/worker | event | itself | exact |
| `web/lib/chat/push.ts` (mod: bridge `open-call`) | utility | event | itself lines 178-185 | exact |
| `scripts/smoke-calls.mjs` + `.sh` (new) | test (E2E) | streaming | `scripts/smoke-call.mjs` + `scripts/smoke-call.sh` | exact |

## Pattern Assignments

### `shared/src/ws.ts` (protocol, modify)

**Analog:** itself. Header rule (lines 4-8): client frames `z.strictObject`, server frames plain `z.object` (older PWA tolerates added fields).

ClientFrame union to extend (lines 45-55):
```ts
export const ClientFrame = z.discriminatedUnion("t", [
  z.strictObject({ t: z.literal("room.join"), room: RoomId }),
  ...
  z.strictObject({ t: z.literal("typing") }),
])
```
ServerFrame union to extend (lines 68-83); add `call.ring/accepted/stop-ringing/ended/media/state` here or `web/lib/ws.ts` drops them as unknown. Closed error enum at line 65:
```ts
export const WsErrorCode = z.enum(["bad_frame", "not_in_room", "too_many_rooms"])
```
Add `"room_reserved"`, `"no_such_call"`. `RoomId` (line 19) already allows `call-<uuid>`. Use RESEARCH Pattern 2 frame list verbatim; IDs via `z.uuid()` like `Peer` (lines 59-62).

### `shared/src/push.ts` (modify)
Current (lines 42-46):
```ts
export interface PushPayload {
  t: "chat" | "test"
  title: string
  body: string
}
```
Extend `t` with `"call" | "call-missed"`, add optional `callId?: string; kind?: "voice" | "video"`. Response schema style for `CallStatusResponse` (if `shared/src/call.ts` is created) copies `PushTestResponse` (line 38): `z.object({...})` + `export type X = z.infer<typeof X>`; re-export from the shared barrel like the others.

---

### `server/src/calls/registry.ts` (service, event-driven, new)

**Analog:** `server/src/ws/hub.ts` — factory returning an interface, closure state, injected options, DB-free.

Factory + injected options shape (hub.ts lines 58-73):
```ts
export interface HubOptions {
  log: FastifyBaseLogger
  heartbeatMs: number
  isSessionLive: (sessionId: string) => boolean
}
export function createHub({ log, heartbeatMs, isSessionLive }: HubOptions): Hub {
  const conns = new Map<string, Conn>()
  const rooms = new Map<string, Set<string>>()
```
Copy as `createCallRegistry({ log, ringTimeoutMs = 45_000, absentGraceMs, transport, push, peerOf(userId) })`. Timers `.unref()` like hub.ts line 223 (`heartbeat.unref()`). Logging style: `log.info({ evt: "call_ring", callId, ... })` structured `evt` keys only, never SDP/candidates (hub.ts lines 19-22, 253, 263). Transitions table: RESEARCH Pattern 1.

### `server/src/ws/hub.ts` (modify)

- Dispatch point: `switch (frame.t)` in `onMessage` (lines 162-190) — add `case "call.invite": ... registry.onFrame(connId, conn.userId, frame); return`.
- Reserve rooms in `case "room.join"` (lines 163-165): refuse `frame.room.startsWith("call-")` with `send(conn, { t: "error", code: "room_reserved" })`.
- Server-side join: reuse `join(connId, conn, room)` (lines 96-119); eviction reuses `leave()` (lines 121-128) — needed for Pitfall 1 (`ROOM_CAPACITY` line 15, full check lines 108-110).
- Attach hook: after `send(conn, { t: "hello", ... })` (line 264) call `registry.onAttach(...)` (ring-on-attach).
- Close hook: in `socket.on("close")` (lines 256-261) call `registry.onClose(connId)`.
- New `isSessionViewing(sessionId)` copies `isViewing` (lines 282-289) with `conn.sessionId === sessionId`.
- `sendToUser` copies `broadcast` (lines 278-280) filtered by `conn.userId`, like `typing` (lines 184-189).

### `server/src/push/sender.ts` (modify)

**Analog:** `notifyMessage` / `sendTest` (lines 196-222).
- Make TTL a parameter of `sendOne` (lines 157-163; currently `TTL: PUSH_TTL_SECONDS` constant at line 27). Keep: no Topic header, `urgency: "high"`, 404/410 prune, sanitized logging.
- `buildPayload` (lines 135-144) must carry `callId`/`kind`; extend signature with an optional extra object.
- New methods on `PushSender` interface (lines 112-125): `notifyCall(recipientId, call, callerName, skipSession?)`, `notifyMissedCall(...)`. Query pattern:
```ts
const subs = db.select().from(pushSubscriptions).where(eq(pushSubscriptions.userId, recipientId)).all()
if (subs.length === 0) return 0
```
Filter out subs whose `sessionId` `hub.isSessionViewing()` (RESEARCH Pattern 6). Copy: `"📞 Incoming voice call"` / `"🎥 Incoming video call"` / `"📞 Missed voice call"` / `"🎥 Missed video call"`, title = caller display name.

### `server/src/push/routes.ts` + `server/src/app.ts` (wiring)

The sender is currently local to `pushRoutes`; caller-name lookup pattern (push/routes.ts lines 81-95):
```ts
const people = app.db.select({ id: users.id, displayName: users.displayName }).from(users).all()
const senderName = people.find((p) => p.id === senderId)?.displayName ?? "duet"
...
if (app.hub.isViewing(id)) { app.log.info({ evt: "push_suppressed", userId: id, seq: message.seq }); return }
```
The registry needs the sender: decorate it (`app.decorate("push", sender)`) the same way `app.decorate("hub", hub)` / `app.decorate("chatEvents", ...)` (app.ts lines 93-103), and declare it in the FastifyInstance augmentation (app.ts ~line 31). Inject `ringTimeoutMs`/`absentGraceMs` through `deps` like `heartbeatMs: deps.heartbeatMs ?? 25_000` (app.ts line 95). Register `callsRoutes` next to `rtcRoutes` (line 131).

### `server/src/calls/routes.ts` (controller, new)

**Analog:** `server/src/rtc/routes.ts`.
```ts
import type { FastifyInstance } from "fastify"
import { requireUser } from "../auth/session"
export async function rtcRoutes(app: FastifyInstance, opts: RtcRoutesOptions) {
  app.post("/api/rtc/ice-servers", { preHandler: requireUser, config: perIpLimit() }, async (request, reply) => {
    const userId = request.user!.id
    ...
    reply.header("Cache-Control", "no-store")
```
`GET /api/calls/:id`: `requireUser`, `no-store`, party-only (404 for non-party or unknown), returns `CallStatusResponse` from registry `current`/`recent`.

### `server/test/calls.test.ts` (test, new)

**Analog:** `server/test/ws.test.ts` lines 1-60 + `server/test/helpers.ts` (`makeTestApp`, `loginCookie`, `openWs`, `TEST_ORIGIN`, `webPushSend` injection line 68).
```ts
beforeAll(async () => {
  t = await makeTestApp({ seed: true, logStream })
  aliceCookie = await loginCookie(t.app, "alice")
  alice2Cookie = await loginCookie(t.app, "alice")
  bobCookie = await loginCookie(t.app, "bob")
})
async function connect(cookie: string) {
  const c = await openWs(t.app, cookie, TEST_ORIGIN)
  const hello = await c.next()
  expect(hello.t).toBe("hello")
  return Object.assign(c, { connId: hello.connId as string, userId: hello.userId as string })
}
```
Pure registry unit tests can call `createCallRegistry` directly with fake transport and short timers. Push assertions: copy fake `WebPushSend` usage from `server/test/push.test.ts` (line 7 imports). Also extend `server/test/sw.test.ts` for the SW call branch.

---

### `web/lib/rtc/peer.ts` (modify)

Keep `/debug/call` behaviour when no role is passed. Seams:
- Options (lines 3-12): add `role?: "caller" | "callee"`, `setup?(pc)`, `beforeAnswer?(pc)`, `onTrack?(track)`.
- Unconditional `addTrack` (line 74) → only when no `setup` given; caller `setup` does the two `addTransceiver`s.
- `beforeAnswer` hook goes between `setRemoteDescription` and `setLocalDescription` (lines 84-88):
```ts
await pc.setRemoteDescription(description)
isSettingRemoteAnswerPending = false
if (description.type === "offer") {
  await pc.setLocalDescription()
  sendDescription()
}
```
- `ontrack` (lines 66-68) → per-kind callback. Restart already at lines 70-72. Add a rollback helper (RESEARCH Code Examples).

### `web/lib/rtc/stats.ts` (modify)
Extend `CallSample` (lines 2-13) with `packetsLost`/`packetsReceived` summed in the same `report.forEach` inbound-rtp branch (line 27). Thresholds: loss > 5 % or rtt > 400 ms for 2 samples, off after 3 good.

### `web/lib/chat/realtime.ts` (modify)
Private `send` (lines 76-78) and `onFrame` switch (lines 160-178, `default: return`) are the seams. Add module exports next to `sendTyping` (lines 259-262):
```ts
export function sendTyping(): void {
  current?.sendTyping()
}
```
→ `sendFrame(frame)`, `onFrame(listener)` (listener set invoked from `onFrame` default branch / for `call.*`, `rtc.signal`, `room.*`), `onLive(listener)` fired in `onHello()` (lines 150-158) so the call session sends `call.rejoin`.

### `web/lib/call/store.ts` (store, new)

**Analog:** `web/lib/chat/store.ts`.
```ts
const listeners = new Set<() => void>()
function set(patch: Partial<ChatState>): void {
  state = { ...state, ...patch }
  for (const l of listeners) l()
}
export const chatStore = {
  subscribe(listener: () => void): () => void { listeners.add(listener); return () => listeners.delete(listener) },
  getSnapshot(): ChatState { return state },
  ...
}
export function useChat(): ChatState {
  return useSyncExternalStore(chatStore.subscribe, chatStore.getSnapshot, chatStore.getServerSnapshot)
}
```
(lines 119, 230-233, 263-270, 615-617). Mirror as `callStore` / `useCall()`.

### `web/lib/call/session.ts` (service class, new)

**Analog:** `web/lib/chat/realtime.ts` class structure (lines 29-70): private timers as `ReturnType<typeof setTimeout> | null`, `stopped` flag, `cleanups: Array<() => void>`, `listen(target, type, fn)` helper, `clearX()` helpers. Peer wiring reference: `web/components/app/call-test.tsx` (fetchIceServers → createPeer → room signals), but **do not** copy its `startPeer → dropPeer` on `room.peer-joined` (lines ~198-199); keep the PC and ICE-restart. ICE fetch:
```ts
export function fetchIceServers(): Promise<IceServersResponse> {
  return apiPost("/api/rtc/ice-servers", {}, IceServersResponse)
}
```
(`web/lib/rtc/ice.ts`). Roles fixed caller=impolite, callee=polite.

### `web/lib/call/media.ts` (utility, new)
**Analog (partial):** `web/lib/chat/recorder.ts` (existing getUserMedia + permission errors). Flip logic verbatim from RESEARCH Pattern 5. Permission copy helper copies `blockedInstructions()` in `web/lib/chat/push.ts` lines 188-192 with `isIos()` from `@/lib/platform`.

### `web/components/app/shell.tsx` (modify)

- Header row (lines 172-208): insert voice/video `Button variant="ghost" size="icon" aria-label=...` before `<DropdownMenu>`, same as the menu trigger:
```tsx
<DropdownMenuTrigger render={<Button variant="ghost" size="icon" aria-label="Menu" />}>
  <DotsThreeVerticalIcon weight="bold" />
</DropdownMenuTrigger>
```
Icons from `@phosphor-icons/react` (`PhoneIcon`, `VideoCameraIcon`), existing import at line 5.
- On-call bar slot: between `</header>` and `<NotificationsCard>` (lines 209-217).
- Mount `<CallProvider>` wrapping the root `div` (line 171) so state survives minimize; Toaster already at line 245 (`toast` from `sonner` for D-10 "Missed call" + Call back action).

### `web/components/app/call-provider.tsx` (provider, new)
Effects pattern from shell.tsx (`startRealtime({ onLoggedOut: sessionGone })` line 133; `bridgeServiceWorkerMessages()`). Always-mounted `<audio>` sink lives here, not inside the Dialog (DialogContent portals; RESEARCH anti-pattern). Read `?call=`/`?missed=` and strip with `history.replaceState`.

### `web/components/app/call-screen.tsx` / `incoming-call.tsx` (components, new)
Imports convention (shell.tsx lines 1-31): `"use client"`, phosphor icons, `@/components/ui/*` (`dialog`, `avatar` + `AvatarFallback` with `initials()` from `@/components/app/login-tiles`, `button`, `badge`, `spinner`). Full-screen dialog analog: `web/components/app/viewer.tsx`. Only preset components; add missing ones via `npx shadcn add`.

### `web/components/app/permission-drawer.tsx` (new)
**Analog:** `web/components/app/notifications-drawer.tsx` imports (lines 3-9):
```tsx
import { Button } from "@/components/ui/button"
import { Drawer, DrawerContent, DrawerFooter, DrawerHeader, DrawerTitle } from "@/components/ui/drawer"
import { isIos, isStandalone } from "@/lib/platform"
```
Controlled `open` / `onOpenChange` props like `NotificationsDrawer` (shell.tsx lines 218-222).

### `web/components/app/on-call-bar.tsx` (new)
Analog: `notifications-card.tsx` (bar mounted under header). Timer text "On call · m:ss".

### `web/public/sw.js` (modify)
Keep only the four listeners (lines 1-3 comment). Close-before-show (lines 26-32) stays. Branch the options at lines 33-41:
```js
await self.registration.showNotification(title, {
  body,
  tag: d.t === "test" ? "duet-test" : "duet-chat",
  renotify: true,
  icon: "/icons/icon-192.png",
  badge: "/icons/badge-96.png",
  data: { url: "/" },
})
```
→ `tag: "duet-call"`, `data: { url: "/?call=" + callId, callId }` for `t === "call"`; `"/?missed=" + callId` for `call-missed`. `notificationclick` (lines 48-65): post `{ t: "open-call", callId }` instead of `open-chat` when `event.notification.data.callId`, `openWindow(data.url)` otherwise.

### `web/lib/chat/push.ts` (modify)
Bridge (lines 178-185):
```ts
navigator.serviceWorker.addEventListener("message", (event: MessageEvent) => {
  const data = event.data as { t?: unknown } | null
  if (data && data.t === "open-chat") window.dispatchEvent(new Event(OPEN_CHAT_EVENT))
})
```
Add `open-call` → dispatch an `OPEN_CALL_EVENT` (constant in `web/lib/chat/events.ts`, same as `OPEN_CHAT_EVENT`). `clearNotifications()` (lines 164-173) reused when incoming screen shows/ends.

### `scripts/smoke-calls.mjs` / `.sh` (E2E, new)
**Analog:** `scripts/smoke-call.mjs` lines 1-40 (playwright-core `chromium.launch` with fake media flags, two contexts, login via `context.request.post(`${BASE}/api/login`, ...)` with `Origin`, print verdicts only, never credentials) and `scripts/smoke-call.sh` (TURN key read from `.env`, never printed; `SKIP_BUILD`, `SMOKE_PORT`, `CHROME`). Add `--use-fake-device-for-media-stream=device-count=2` for flip, `page.routeWebSocket` for the drop test.

## Shared Patterns

### Auth on HTTP
**Source:** `server/src/auth/session.ts` `requireUser`, used as `{ preHandler: requireUser }` (chat/routes.ts line 38, rtc/routes.ts). Apply to `GET /api/calls/:id`. Responses `Cache-Control: no-store`.

### WS frame validation / error replies
**Source:** hub.ts lines 146-160 — `ClientFrame.safeParse` → `send(conn, { t: "error", code: "bad_frame" })`. Registry errors use the same `{ t: "error", code }` with new codes.

### Logging / privacy
Structured `{ evt: "...", ... }` keys; never log SDP, candidates, ICE creds, push endpoints/keys (hub.ts lines 19-22; sender.ts lines 178-182).

### Injected timers for tests
`deps.heartbeatMs ?? 25_000` (app.ts line 95) → same for ring/absent timers.

### Client state
`useSyncExternalStore` module store (chat/store.ts); no react-query.

### UI
Preset only: `@/components/ui/*`, `@phosphor-icons/react`, `toast` from `sonner`, always dark (`<Toaster theme="dark" />`).

## No Analog Found

| File | Role | Data Flow | Reason |
|---|---|---|---|
| `web/lib/call/tones.ts` | utility | streaming | No WebAudio code exists; use RESEARCH Pattern 8 (oscillator, context resumed in tap) |
| `web/lib/call/wake-lock.ts` | utility | event-driven | No wake-lock code; use RESEARCH Pattern 8 snippet |

## Metadata

**Analog search scope:** `shared/src`, `server/src/{ws,push,rtc,chat}`, `server/test`, `web/lib/{rtc,chat}`, `web/components/app`, `web/public`, `scripts`
**Files scanned:** ~25
**Pattern extraction date:** 2026-10-16
