> **⚠ 2026-10-09: media plane superseded.** Home is CGNAT, so the user dropped the SFU (see `.planning/phases/01-foundation-auth-media-plane/01-CONTEXT.md` D-16). Calls are now 1:1 peer-to-peer WebRTC with Cloudflare TURN, with TURN credentials minted by the duet server and signaling over duet's WebSocket. Anything below about the self-hosted SFU, coturn, `@sideby-me/rtc`, mediasoup-client, SFU join tokens, router port-forwards or sfu./turn. DNS is historical; ignore it when planning. Everything else stands.

# Pitfalls Research

**Domain:** Self-hosted 2-user chat + 1:1 voice/video calling PWA (iPhone Safari standalone + Pixel Chrome), media via an existing mediasoup SFU + coturn (`sideby-me/sfu.sideby.me`)
**Researched:** 2026-10-08
**Confidence:** MEDIUM overall. SFU-repo findings and the infra probes were checked directly against code and the live network (HIGH). iOS WebKit behavior is mostly from bug reports and forum threads that agree with each other across several sources (MEDIUM). Single-source items are marked LOW.

---

## Pitfall 0 (BLOCKER, found during research): the domain and the SFU are not live

Direct probes on 2026-10-08 (HIGH confidence, observed):

- **`sideby.me` has expired.** WHOIS shows `Registry Expiry Date: 2026-08-20` and `Domain Status: redemptionPeriod`. Public DNS (1.1.1.1) returns **NXDOMAIN** for `sideby.me`, `sfu.sideby.me`, `turn.sideby.me` and `duet.sideby.me`. Every assumption in PROJECT.md that depends on `*.sideby.me` (PWA origin, push, WSS, TURN TLS certs, the SFU URL) is currently broken.
- **The documented SFU host doesn't respond.** The README places the SFU on GCP VM-B at `35.208.41.166`. TCP connections to `:443` and `:44443` time out.
- **This machine is not that VM.** Host `cinedise` is on Wi-Fi (`wlp0s20f3`, `192.168.0.132/24`) behind a residential NAT (egress IP `103.198.98.196`). It also runs Tailscale, which already holds `:443` on the tailnet IP. Running `docker ps` shows only `sideby-staging` sync/lens/redis and no SFU, coturn or nginx-sni.
- **The SFU's media path has never been proven.** Its own README says the media gates (`bytesReceived > 0` across networks, forced relay over `turns:443`) are **"UNPROVEN"** on the deployed topology. The browser harness that used to test them was deleted.

**How to avoid:** Phase 1 has to be a dedicated infra phase that finishes before any call UI work:
1. Pick a domain: renew `sideby.me` while it is still in redemption (expect a redemption fee), or use a different domain.
2. Choose where the SFU will actually run. The options are this home machine (needs port forwarding, a static or DDNS IP, and no CGNAT) or a VPS.
3. Deploy SFU + coturn.
4. Pass **both** README gates from a phone on cellular before Phase "Calls" starts.

**Warning signs:** `getaddrinfo ENOTFOUND`; ICE reaches `connected` while `bytesReceived` stays at 0; certbot fails.

**Phase:** Phase 1 (Infra/Foundation). This blocks the call phases and gates PWA install and push as well.

---

## Critical Pitfalls

### Pitfall 1: Hosting the SFU on a home NAT box without planning for NAT and hairpinning

**What goes wrong:** On a home machine mediasoup must announce the public IP (`MEDIASOUP_ANNOUNCED_IP`). This causes three problems:
- **Dynamic IP.** If the ISP changes the IP, every ICE candidate silently goes stale.
- **CGNAT.** If the ISP uses carrier-grade NAT, inbound UDP can't reach the box at all.
- **No hairpin NAT.** When both phones are on the *home Wi-Fi*, they dial the public IP from inside the LAN. Routers without NAT loopback drop that traffic, so calls work on cellular and fail at home. This is the most common place two partners will actually call from.

The coturn relay range (`49152-65535/udp`, about 16k ports) is also more than most consumer routers can forward.

**Why it happens:** The SFU was designed for a cloud VM with a 1:1 NAT (see the README: `MEDIASOUP_LISTEN_IP` / `ANNOUNCED_IP` split and the `sfu0` dummy interface). None of that is tuned for a residential router.

**How to avoid:**
- Before committing to "this machine", check that the router's WAN IP equals `103.198.98.196`. If it doesn't, you are behind CGNAT and need a VPS.
- If you stay at home: set up DDNS, forward `44444-44463` udp/tcp, cut coturn to a small range (e.g. `min-port=49160`, `max-port=49260`), and forward that range.
- Test a call with **both phones on home Wi-Fi** as an explicit gate.
- If hairpinning fails, make sure TURN over TLS on 443 still gets through. A cheap VPS for SFU + coturn is the low-risk choice.

**Warning signs:** Calls connect on cellular but not on Wi-Fi, or the reverse; calls break after a router reboot.

**Phase:** Phase 1 (Infra).

---

### Pitfall 2: The SFU's TURN URLs on :443 only work over `turns:` (UDP TURN is effectively dead)

**What goes wrong:** `src/turn/ice-servers.ts` hands clients these servers:
- `stun:host:443`
- `turn:host:443?transport=udp`
- `turn:host:443?transport=tcp`
- `turns:host:443?transport=tcp`

But `nginx-sni.conf` only listens on **TCP** 443 and routes by TLS SNI, and coturn listens on `3478` and `5349`. As a result:
- **UDP 443 has no listener**, so STUN and UDP TURN fail.
- **Plain TCP TURN to 443 carries no TLS ClientHello**, so `ssl_preread` finds no SNI and falls through to `default sfu_wss`. That TURN connection fails as well.

The only working relay path is `turns:` (TURN over TLS over TCP). Relayed media from cellular will therefore run over TCP, with head-of-line blocking and noticeably worse audio and video on lossy links.

**Why it happens:** The URLs were all put on 443 "to look like HTTPS", but only the TLS variant can pass through an SNI router.

**How to avoid:** Patch the SFU (the user owns it) to also advertise `turn:host:3478?transport=udp` and `?transport=tcp`, with 3478 opened in the firewall, and keep `turns:host:443` as the fallback. Then confirm with `chrome://webrtc-internals` on the Pixel that the selected candidate pair is `relay` / `udp` on cellular.

**Warning signs:** The `relayProtocol` of the selected local candidate is always `tls`; calls over cellular sound choppy while Wi-Fi calls sound fine.

**Confidence:** MEDIUM-HIGH. This is inferred from the committed config; a host iptables redirect outside the repo could change it, so verify on the live box.

**Phase:** Phase 1 (Infra), checked again in Phase "Calls".

---

### Pitfall 3: Rejoin is rejected with `participant_already_active` after iOS suspends the app

**What goes wrong:** `verifyJoin` and `handleJoin` reject a join if the token's `participantId` is still in `room.peers`. The gateway only removes a peer on WebSocket `close`, and **the SFU has no ping/pong heartbeat** (`gateway.ts` has no `ws.ping` or liveness timer).

When iOS suspends the PWA, or the phone moves between Wi-Fi and cellular, the TCP connection often goes half-open, so the server never sees `close`. When the app comes back, the client opens a new WS with a token for the same participantId, and the SFU closes it with **1008 "join rejected"**. The user is locked out of the call until TCP keepalive gives up, which can take minutes.

**Why it happens:** The SFU was built on the assumption that "a normal reconnect is safe because the prior peer is torn down on WS close". That assumption doesn't hold on mobile.

**How to avoid:** Do one or both of the following:
- **(a) duet side, no SFU change:** mint a **fresh participantId for every join attempt**, e.g. `HMAC(callId:userId:attemptNonce)`. participantId is opaque to the SFU. duet's own signaling maps participantId to user, and the client treats a `new-producer` from the other user's newest participantId as replacing the old one.
- **(b) SFU patch:** add a 15–20 s `ws.ping` heartbeat that terminates sockets that don't answer.

Also keep `PARTICIPANT_CAP` in mind: ghost peers count toward it (default 8, so not a problem for 2 users).

**Warning signs:** Reconnect after backgrounding fails with close code 1008; SFU logs show `join_rejected` right after `ws_connect`.

**Confidence:** HIGH (read directly from `auth.ts`, `handlers.ts`, `gateway.ts`).

**Phase:** Phase "Calls" (design the call/reconnect state machine around this from the start).

---

### Pitfall 4: iOS kills the call when the PWA is backgrounded or the screen locks

**What goes wrong:**
- An installed (standalone) iOS web app loses the microphone as soon as it is backgrounded or the screen locks. Video stops as well.
- Unlike a native app with CallKit, there is no background audio entitlement.
- After the interruption the audio track can come back "live" but silent. Re-calling `getUserMedia` sometimes returns a track that carries no signal.

**Why it happens:** WebKit suspends standalone web apps, and this is by design. Apple has not shipped background WebRTC for web apps (there is an open forum feature request).

**How to avoid:**
- Accept it as a product constraint (PROJECT.md already rules out CallKit) and **design for it** rather than fight it:
  - Hold a Screen Wake Lock (`navigator.wakeLock.request('screen')`) for the whole call so auto-lock doesn't end it. Wake Lock in home-screen apps reportedly only works reliably from iOS 18.4, so verify on the target device.
  - Show a "call paused, return to app" state.
  - On `visibilitychange`, check `track.readyState` and `track.muted`. If the track is dead, re-acquire it with `getUserMedia` and call `producer.replaceTrack()`.
  - Call `restartIce` if the transport state is `disconnected` or `failed`.
- Show the peer a "partner left the app" indicator, driven by the `producer-paused` notification or an app-level presence signal.

**Warning signs:** The remote side hears silence after the iPhone user opens Photos or Messages mid-call.

**Confidence:** MEDIUM (consistent WebKit bug and forum reports from 2021–2025; no Apple statement for iOS 26).

**Phase:** Phase "Calls".

---

### Pitfall 5: iOS web push quietly stops working

**What goes wrong:** Several iOS rules each cause pushes to stop without any error:
- Push only works from the **home-screen-installed** app on iOS 16.4+. A subscription made in a Safari tab never fires.
- `Notification.requestPermission()` / `pushManager.subscribe()` must be called **directly from a user tap**.
- **Every push must display a notification** (`userVisibleOnly`). If the SW returns early ("user is already in the chat, skip it") or is missing `event.waitUntil(showNotification(...))`, Safari **revokes the subscription after about 3 silent pushes**. The only recovery is for the user to re-grant permission.
- `pushsubscriptionchange` does not fire on iOS. Subscriptions also disappear after reinstalling, clearing data or long inactivity, and the server only finds out from a **404/410** at send time.
- A VAPID `sub` of `mailto:admin@localhost`, anything with spaces or angle brackets, or a JWT `exp` more than 24 h out makes **web.push.apple.com return 403 BadJwtToken**. Android keeps working at the same time, so this slips through testing.

**Why it happens:** Developers test on Android or in desktop Chrome first. Those platforms are lenient, while Apple enforces each of these rules strictly.

**How to avoid:**
- Show an explicit "Enable notifications" button that only appears in standalone mode (`matchMedia('(display-mode: standalone)')` or `navigator.standalone`).
- In the push handler: always `event.waitUntil(self.registration.showNotification(...))`, with no early returns. Suppress on the **server** instead, by not sending when the recipient is foreground-visible according to a fresh app heartbeat.
- On every app launch, call `getSubscription()` and upsert it on the server (keyed per device). Delete subscriptions that return 404/410.
- Use `VAPID_SUBJECT=mailto:<real address on a real domain>`.
- For calls, send `Urgency: high` and a short `TTL` (about 30–45 s) so stale "incoming call" pushes never show up late.
- Add a "test push" button in settings for each device.

**Warning signs:** The iPhone gets pushes for a few days and then stops; 403 errors appear in server logs only for `web.push.apple.com` endpoints.

**Confidence:** MEDIUM. The three-silent-push limit comes from a WebKit commit plus several field reports. BadJwtToken causes are HIGH (Apple's own documentation).

**Phase:** Phase "Push notifications".

---

### Pitfall 6: A notification tap on iOS doesn't open the call

**What goes wrong:** On iOS, `clients.openWindow(deepLink)` from `notificationclick` frequently opens the **root URL**, or simply restores the **page that was last open**. This happens when the app was backgrounded, and also when it was killed. The window client can also be unresponsive for a short time after launch. Tapping "Incoming call from X" may therefore land on the chat list with no ringing UI, while the caller is still waiting.

**Why it happens:** Long-standing WebKit bugs (263687, 252544) affect notification activation for home-screen apps.

**How to avoid:** **Never rely on the URL to carry call state.**
- Keep the call state on the server (`ringing`, `callId`, `expiresAt`).
- On launch, `visibilitychange` to visible, and WS (re)connect, the client asks "is anything ringing for me?" and shows the incoming-call screen if so.
- In the SW: run `clients.matchAll({type:'window', includeUncontrolled:true})`. If a client exists, `focus()` it and `postMessage({type:'open-call', callId})`; otherwise call `openWindow(url)`. Treat the URL as a hint only.

**Warning signs:** A notification tap opens the app, but the user has to look for the call; this only shows up on iOS.

**Phase:** Phase "Push notifications" and Phase "Calls" (shared call state machine).

---

### Pitfall 7: Remote audio doesn't play on iOS (autoplay policy)

**What goes wrong:** You attach `consumer.track` to an `<audio>` element after an `await` chain, `play()` rejects with `NotAllowedError`, and there is no sound. Audio elements created after the first gesture can also stay blocked.

A related trap is markup like `<audio muted="false">`. `muted` is a boolean attribute, so its presence mutes the element regardless of the value.

**Why it happens:** iOS only allows audible MediaStream playback that a user gesture started. Push-to-answer has no gesture until the user taps inside the app.

**How to avoid:**
- Make **"Answer" and "Call" real buttons**. In their click handler, before any `await`:
  - create or obtain one persistent `<audio autoplay playsinline>` element;
  - call `audioEl.play()` on it, using an empty `MediaStream` if needed;
  - resume a shared `AudioContext`.
- Later, set `srcObject` on that same, already unlocked element.
- Render remote video in `<video playsinline autoplay muted>`. Without `playsinline` iOS goes fullscreen. Video carries no audio, so it can stay muted.
- Show a fallback "Tap to enable audio" button if `play()` rejects.

**Warning signs:** Video works and audio is silent, on iOS only.

**Confidence:** MEDIUM (webrtcHacks, mediasoup discourse, Agora docs).

**Phase:** Phase "Calls".

---

### Pitfall 8: Promising a speaker/earpiece toggle that iOS web can't deliver

**What goes wrong:** On iOS, `getUserMedia` switches the audio session to play-and-record. Whether output goes to the earpiece or the loudspeaker changes between iOS versions (iOS 15 was earpiece and very quiet; later versions differ).
- iOS has **no `setSinkId`**, and `enumerateDevices` returns no outputs, so a speaker button can't be built.
- `navigator.audioSession.type = 'play-and-record'` exists only in partial form since 16.4, and its routing effect depends on the platform.
- Playing a voice note while the mic is active also gets routed to the earpiece at low volume.

**How to avoid:**
- Don't put a speaker toggle in the iOS UI.
- Set `navigator.audioSession.type` explicitly (`'play-and-record'` during calls, `'playback'` for voice notes) where it is supported, and test the result on the actual iPhone.
- Release the mic (stop tracks) promptly after calls and recordings so voice-note playback goes back to the normal route.
- Document "use headphones/AirPods for privacy" as the workaround.

**Confidence:** MEDIUM (consistent reports; behavior on the current iOS has not been verified).

**Phase:** Phase "Calls"; also Phase "Media messages" (voice note playback).

---

### Pitfall 9: Voice notes and clips recorded on one phone don't play on the other

**What goes wrong:**
- **iOS Safari** `MediaRecorder` historically produces **`audio/mp4` (AAC)** / `video/mp4` (H.264). WebM/Opus recording only arrived in Safari 18.4, and WebM video from iOS plays back **rotated 90°** because WebM has no rotation metadata.
- **Chrome** produces **WebM/Opus**, and newer Chrome produces fragmented MP4.
- MediaRecorder output (fragmented MP4, or WebM without cues) reports `duration === Infinity` and seeks badly, so scrubbers and "0:12" labels break.
- iOS 26 had a bug where `timeslice <= 100 ms` produced empty blobs.
- Hardcoding `mimeType: 'audio/webm'` throws on older iOS. Saving with the requested type instead of `recorder.mimeType` mislabels files.

**How to avoid:**
- **Normalize on the server.** After upload, run `ffmpeg` to convert:
  - voice notes → `audio/mp4` (AAC-LC, `.m4a`, `-movflags +faststart`);
  - clips → H.264 + AAC `.mp4`, faststart, with rotation baked in, a poster frame extracted, and duration probed with `ffprobe`.
- Store `duration_ms` in the DB and render it from there, never from `audio.duration`.
- On the client, pick from a candidate list with `MediaRecorder.isTypeSupported()` (`audio/mp4`, then `audio/webm;codecs=opus`) and send `recorder.mimeType` with the upload.
- Use `start()` without a timeslice, or a timeslice of at least 1000 ms.
- Keep the original until the transcode has succeeded.

**Warning signs:** "0:00 / Infinity" in the player; a clip plays sideways; a Pixel voice note is silent on an older iPhone.

**Confidence:** MEDIUM (addpipe, WebKit bugs 290002/299164/301507, MDN).

**Phase:** Phase "Media messages".

---

### Pitfall 10: HEIC photos and HEVC .MOV clips from the iPhone

**What goes wrong:**
- **Images.** If the file input's `accept` includes `image/heic`, Safari 17+ *converts* JPEG and PNG picks into HEIC. With `accept="image/*"` the photo picker usually transcodes HEIC to JPEG, but if the user changes the picker to "Current", raw HEIC is uploaded. **Chrome on the Pixel can't display HEIC.**
- **sharp's prebuilt libvips does not decode HEVC-based HEIC.** "sharp will handle it" is wrong.
- **Video.** Clips picked from the iPhone library are QuickTime `.MOV` in **HEVC**, often 4K60. That is hundreds of MB per minute, and the Pixel may not play it.

**How to avoid:**
- Use `accept="image/*"`, never `image/heic`.
- On the server, sniff magic bytes (`ftypheic` / `ftypmif1`), not the extension. Convert HEIC to JPEG with `heif-convert` (libheif + libde265) or `ffmpeg` in the container, and use `sharp` only for JPEG/PNG/WebP thumbnails.
- Apply EXIF orientation (`sharp().rotate()`) and strip GPS EXIF.
- Run every video through the same ffmpeg normalization as Pitfall 9 (H.264 720p or 1080p with a size cap).
- Prefer recording clips **in-app** (MediaRecorder at 720p) over library picks, or cap clip length and size before upload.

**Confidence:** MEDIUM. The sharp/HEVC limitation is well known; verify it against the sharp version you install.

**Phase:** Phase "Media messages".

---

### Pitfall 11: Large uploads fail silently or on backgrounding

**What goes wrong:** Size limits and backgrounding cause these failures:
- **nginx defaults to `client_max_body_size 1m`.**
- **Next.js Server Actions default to a 1 MB body limit.**
- **Cloudflare's free proxy limits uploads to 100 MB** (relevant if a tunnel or proxy is used).
- iOS stops the upload as soon as the user leaves the PWA, and a buffered `request.formData()` in a route handler loads the whole file into memory.

The visible result is spinners that never finish, or a 413 shown as a generic error.

**How to avoid:**
- Upload through a dedicated **route handler (not a Server Action)** that streams `request.body` to disk.
- Set `client_max_body_size` (or Caddy's `request_body max_size`) explicitly, e.g. 200 MB.
- Use a client-generated `uploadId` so retries are idempotent. Use chunked or resumable upload (tus) only if needed; for a 2-user app, "cap the size + retry the whole file" is enough.
- Show progress (XHR `upload.onprogress`; `fetch` has no upload progress).
- Show the message optimistically with a "sending..." / "failed, tap to retry" state.

**Phase:** Phase "Media messages".

---

### Pitfall 12: The service worker breaks auth, realtime and media

**What goes wrong:**
- Copying a generic PWA template (next-pwa, Workbox runtime caching) caches **authenticated HTML and `/api` JSON**. Users then see stale or other-session data, and logout doesn't stick.
- The SW intercepts **media requests**. Safari needs **206 Partial Content** for `<video>`/`<audio>`, and an SW `fetch()` passthrough or a cache hit returns 200, so **clips won't play on iOS**.
- Stale app shells survive deploys. iOS only checks for SW updates when the app launches.
- With Next.js, an old client calling a renamed **Server Action ID** after a deploy fails with "Failed to find Server Action".
- (An SW can't intercept WebSockets, but caching a `/api/session` used for WS auth does break reconnects.)

**How to avoid:**
- **Write a minimal hand-written `sw.js`** that handles `push`, `notificationclick`, and optionally an offline fallback page. Don't cache navigations, `/api/*`, `/media/*` or `/ws`.
- Serve `sw.js` with `Cache-Control: no-cache`.
- Have the server send a `buildId` in the WS hello. If it doesn't match the client's, call `registration.update()` and reload when idle (never mid-call).
- Prefer explicit REST/WS endpoints over Server Actions for anything a long-lived PWA calls.

**Warning signs:** A video plays in Safari tab mode but not in the installed app; a user sees the previous message list after logout.

**Phase:** Phase "Auth & PWA shell" (decide SW scope early). Verify again in "Media messages".

---

### Pitfall 13: Private media endpoints without Range support

**What goes wrong:** Media must sit behind auth because the data is private, so it is served from a Next.js route handler with `fs.readFile` and a plain 200 response. iOS `<video>` then refuses to play, and even audio scrubbing breaks.

**How to avoid:** Either implement `Range` / `206` / `Content-Range` / `Accept-Ranges` correctly in the handler, or (simpler) have the app authorize and then hand off to the reverse proxy with `X-Accel-Redirect` (nginx) or Caddy `forward_auth` / `file_server` with an internal path. Use unguessable file IDs, and send `Cache-Control: private, max-age=31536000, immutable` because the content never changes.

**Phase:** Phase "Media messages".

---

### Pitfall 14: WebSocket "connected" but dead after resume

**What goes wrong:** After iOS suspends the PWA, `ws.readyState === OPEN` but the socket is dead. `onclose` may never fire, especially after a network change. Messages sent in the meantime are lost, typing indicators get stuck on, read receipts go out wrong, and the server's presence data says "online", so pushes are suppressed and the user **misses calls**.

**Why it happens:** iOS freezes the JS context. TCP half-open state isn't noticed without an application-level heartbeat.

**How to avoid:**
- Send an application ping/pong every ~20 s while visible. On `visibilitychange` to visible, and on `pageshow` with `persisted`, send a ping and force a reconnect if there's no pong within about 1.5 s.
- Always close the old socket before opening a new one.
- On (re)connect, send `lastSeenMessageSeq` and let the server replay what was missed (monotonic per-conversation `seq`).
- Use client-generated message IDs (UUIDv7) for idempotent sends, with a local outbox that retries.
- Expire presence on the server after about 30–45 s without a heartbeat, and base push-suppression on "visible + fresh heartbeat", never on "socket exists".
- Only mark messages read while `document.visibilityState === 'visible'`.

**Phase:** Phase "Realtime chat". The same reconnect discipline applies to the SFU signaling socket in "Calls" (see Pitfall 3).

---

### Pitfall 15: mediasoup-client codec defaults: VP8 everywhere, and H264 on iPhone needs to be chosen explicitly

**What goes wrong:** The router's `mediaCodecs` order is Opus, **VP8, H264** (`src/mediasoup/codecs.ts`). `transport.produce()` picks the **first router codec the device supports**, so the iPhone sends VP8, which is a **software** encoder on iOS. Long video calls then heat the iPhone and drain the battery.

Other mistakes in this area:
- Enabling simulcast or SVC for a 1:1 call adds CPU and bugs (iOS H264 simulcast has quirks) and gains nothing.
- Calling `device.load()` more than once per page.
- Not resuming the consumer: the SFU creates consumers **paused**, and the client must send `resume` after attaching, or the video stays frozen.

**How to avoid:**
- After `device.load({ routerRtpCapabilities })`:
  - on iOS, `produce({ track, codec: device.rtpCapabilities.codecs.find(c => c.mimeType.toLowerCase() === 'video/h264') })`;
  - on the Pixel, keep VP8, which Safari decodes fine.
- Single encoding, no simulcast. Cap at 720p / 30 fps / about 1.5 Mbps.
- Keep the `profile-level-id: 42e01f` parameters (the SFU's comment warns that removing them silently drops H264).
- Call `resume` right after `consume` and attach.
- mediasoup-client maps every iOS browser to the `Safari12` handler and Android Chrome 111+ to `Chrome111`. Pin `mediasoup-client` to `3.20.x` to match the SFU (`mediasoup 3.20.5`).

**Confidence:** HIGH for the SFU codec order and paused consumers (code). MEDIUM for iOS VP8 cost.

**Phase:** Phase "Calls".

---

### Pitfall 16: Camera and mic capture conflicts on iOS (re-prompts, single capture, camera flip)

**What goes wrong:**
- In standalone mode iOS has been reported to **revoke camera permission and stop streams on route/hash changes**, causing re-prompts or black video. Next.js client navigation during a call can trigger this.
- iOS allows **only one active capture of each kind**. Calling `getUserMedia({video})` again to flip the camera ends the existing track. Starting a voice-note `MediaRecorder` with a new mic capture during a call kills the call's mic.
- Requesting audio and video separately at different times produces two permission prompts.

**How to avoid:**
- Host the call UI in a **persistent layout-level component or overlay that never unmounts**, and don't navigate during a call.
- Flip the camera by stopping the old video track, calling `getUserMedia({ video: { facingMode } })`, and then `producer.replaceTrack()`.
- Disable voice-note recording while a call is active.
- Ask for permissions once, with an explanation screen, from a button.

**Confidence:** MEDIUM (WebKit bugs 215884 and 212040, plus 2025 forum reports).

**Phase:** Phase "Calls".

---

### Pitfall 17: TURN credentials expire in the middle of a long relayed call

**What goes wrong:** The SFU mints coturn REST credentials once per join with `TURN_CRED_TTL_SEC=3600`. coturn checks the timestamp in the username on authenticated requests, which plausibly includes allocation refreshes. A forced-relay call (cellular) may then **drop at about 60 minutes**, and partners do have multi-hour calls.

**How to avoid:** Set `TURN_CRED_TTL_SEC` to around 86400 for this deployment, *or* have the client rejoin (fresh token, which mints fresh ICE servers) before expiry. Verify with a 70-minute call using `iceTransportPolicy: 'relay'`.

**Confidence:** LOW-MEDIUM. This depends on coturn's refresh-auth behavior and needs an empirical test.

**Phase:** Phase "Calls" (QA gate).

---

### Pitfall 18: TOTP for exactly two users causes self-lockout or a trivial DoS

**What goes wrong:**
- **Hard account lockout after N failures.** Anyone who knows the username can lock the girlfriend out, and there is no admin UI to unlock her.
- No recovery codes, combined with a lost or replaced phone, means a permanent lockout.
- No replay protection: the same 30 s code works twice.
- No rate limit: 6 digits with a ±1 step window can be brute-forced.
- Enrollment shows a QR code **on the same iPhone that needs to scan it**.
- Short sessions mean re-entering TOTP every few days inside the PWA, and iOS keeps PWA storage **separate from Safari**, so logging in in Safari doesn't log in the app.

**How to avoid:**
- Use exponential backoff per account and per IP (e.g. 5 tries, then 1 min, doubling) instead of a permanent lock.
- Store the last accepted TOTP time-step to block replays. Allow a ±1 step window, and run NTP on the host.
- Generate 10 hashed one-time recovery codes at enrollment.
- Provide a **server CLI** (`docker exec duet node scripts/reset-2fa.js <user>`) as the owner's break-glass.
- At enrollment, show both a QR code and an `otpauth://` **tap link** (iOS 18+ Passwords app handles it) plus the copyable secret.
- Use long-lived (about 90-day, sliding), `httpOnly; Secure; SameSite=Lax` server-set cookies. Server-set httpOnly cookies avoid the 7-day cap on script-writable storage.
- **Log in inside the installed app.**
- Seed accounts from env or a CLI, with no sign-up route at all.
- Encrypt TOTP secrets at rest with an app key.

**Phase:** Phase "Auth & PWA shell".

---

### Pitfall 19: Breaking the locked shadcn preset

**What goes wrong:**
- Running `shadcn init` again or `shadcn apply` later **reconfigures components and CSS variables**.
- Pasting component examples written for the other primitive layer breaks the build, e.g. Radix `asChild` examples into a **Base UI** preset (`render` prop) or the reverse.
- `shadcn add` from third-party registries brings in tokens the preset doesn't have.
- Hand-editing `globals.css` tokens or `components/ui/*` to "fix" mobile issues.
- Adding hard-coded Tailwind colors (`bg-blue-500`) in place of semantic tokens.

**Why it happens:** Mobile and PWA work tempts small "fixes" such as safe-area padding, the iOS keyboard, chat bubbles and call screens, and none of these is a stock shadcn component.

**How to avoid:**
- Initialize **once** (`npx shadcn@latest create --preset b51GFhBEQ` or `init --preset b51GFhBEQ`). Run `npx shadcn preset decode b51GFhBEQ` first to learn its base library (Radix vs Base UI), icon set, fonts and radius, and write that into the project docs.
- Commit `components.json`, `globals.css` and `components/ui/` untouched, and add a CI/pre-commit check that fails on diffs to them.
- Build chat bubbles and call screens **by composing** preset components and semantic tokens (`bg-primary`, `text-muted-foreground`) in `components/app/`.
- Only add components through `npx shadcn add <name>` from the preset's own style.
- Safe-area insets (`viewport-fit=cover` plus `env(safe-area-inset-*)` padding) and `100dvh` layout are layout concerns in app wrappers, not token changes. Agree on this with the user up front.
- Never set `maximum-scale=1` to stop input zoom; the preset's `text-base` inputs already avoid it.

**Phase:** Phase "Auth & PWA shell" (scaffold). Enforce in every UI phase.

---

### Pitfall 20: Next.js can't host the chat WebSocket in route handlers

**What goes wrong:** The team builds chat on App Router route handlers and then finds they can't accept WS upgrades. Patching Next (`next-ws`) breaks on upgrades. A custom server that grabs *all* upgrade events breaks HMR in dev.

There is also a reported SSRF via crafted WS upgrade requests on self-hosted Next (CVE-2026-44578, affecting versions before 15.5.16 / 16.2.5). That is from a single secondary source (LOW confidence), so check the advisory.

**How to avoid:**
- Decide in Phase 1 on **either** a custom `server.ts` (Next + `ws` with `noServer: true`, handling only `/ws` and passing other upgrades to Next) **or** a separate small Node WS process behind the same origin path (`/ws`), so cookies still authenticate it.
- Authenticate the WS upgrade with the session cookie and check `Origin`.
- Keep Next.js patched.

**Phase:** Phase 1 (Foundation) and Phase "Realtime chat".

---

## Moderate Pitfalls

### Port 443 contention on the shared host
If SFU, coturn and nginx-sni co-locate with duet, **nginx-sni owns `:443` and does not terminate TLS**. duet must be added as a third SNI route (`duet.<domain>` → `127.0.0.1:<port>`, with duet's own TLS terminator, e.g. Caddy on a high port). Certificates need DNS-01, or HTTP-01 on `:80`. Tailscale also holds `:443` on the tailnet IP on this host. Bind only to the public or LAN IP to avoid conflicts. **Phase 1.**

### Docker bridge networking for the SFU
The README calls this "the #1 mediasoup pitfall": anything other than `network_mode: host` makes ICE advertise addresses that can't be reached, so `bytesReceived` stays at 0. duet's own app can stay on a bridge network. **Phase 1.**

### Shared secrets and private packages
- duet must mint HS256 tokens with the **same `SFU_TOKEN_SECRET`**, and the claims must include `mediaRoomId`, `participantId`, `canPublish`, `canSubscribe` and `protocolVersion`.
- The join message must *also* carry a matching `protocolVersion`, `mediaRoomId` and `participantId`.
- Keep the host clocks in sync (60 s tolerance).
- Signaling types live in `@sideby-me/rtc-types` on **GitHub Packages**. Installing them requires `NODE_AUTH_TOKEN` with `read:packages` in the Docker build. Add it as a build secret, not an `ARG` baked into a layer, or vendor the types.
- Rooms are created lazily on join (`ensureRoom`), so **duet does not need the internal admin surface** on `:44443`. Don't expose it to the public internet. **Phase "Calls".**

### iOS keyboard and viewport in a standalone chat
`100vh` includes the area under the keyboard, so the composer gets hidden or the page scrolls the header away. Use `100dvh`, `visualViewport` resize handling, and `interactive-widget=resizes-content` (Chrome) in the viewport meta. Add safe-area padding for the home indicator. **Phase "Realtime chat".**

### Rendering full-resolution 48 MP photos in the scrollback
iOS Safari runs out of memory and reloads the page. Serve server-generated thumbnails (e.g. 1080w WebP/JPEG) in the list, and the original only in a viewer. **Phase "Media messages".**

### Incoming-call timing
Push delivery takes seconds, then the user has to unlock and tap. Keep the call `ringing` server-side for about 45–60 s, show the caller "ringing...", then turn it into a "Missed call" message and send one follow-up push with the same `tag`. Don't send a push storm: every push must show a notification (Pitfall 5). **Phase "Calls".**

### Android Chrome notification click with an existing window
Use `client.focus()` plus `postMessage`. `client.navigate()` only works for controlled clients, and `openWindow` needs an in-scope URL. Set `Urgency: high` so Doze doesn't delay call pushes. **Phase "Push notifications".**

### Backups for data that is "kept forever" on a home disk
Back up the SQLite/Postgres database and the media directory nightly to a second location (restic or rsync). Without that, one disk failure loses the entire history. **Phase 1 (ops), verified in Hardening.**

---

## Minor Pitfalls

- **Notification features differ on iOS.** iOS ignores `actions`, `vibrate`, `requireInteraction` and custom sounds, so don't design "Answer/Decline" notification buttons. A tap opens the app, which shows the call screen.
- **Mid-call Wi-Fi to cellular handover.** Listen for `transport.on('connectionstatechange')`. On `disconnected`, wait about 2 s and then send `restartIce` (the SFU supports it) followed by `transport.restartIce({ iceParameters })`. On `failed`, rejoin with a fresh participantId.
- **Local preview echo.** The local preview `<video>` must be `muted` and `playsinline`.
- **Badges.** `navigator.setAppBadge` works in iOS home-screen apps (16.4+). It's a cheap unread indicator, but clear it when the conversation is opened.
- **Voice notes.** Record with `getUserMedia({audio:{echoCancellation:true,noiseSuppression:true}})`, and stop all tracks on finish so the iOS orange mic indicator goes away.
- **Time zones.** Store UTC timestamps; derive "today" and "yesterday" on the client.

---

## Technical Debt Patterns

| Shortcut | Immediate Benefit | Long-term Cost | When Acceptable |
|----------|-------------------|----------------|-----------------|
| Store voice notes and clips exactly as recorded (no ffmpeg) | Saves a day | Cross-platform playback failures, Infinity durations, sideways video | Never. Normalize from day one; it's one ffmpeg call |
| Reuse a stable participantId per user for SFU joins | Simpler mapping | Rejoin rejected after iOS suspension (Pitfall 3) | Only if the SFU gets a WS heartbeat patch |
| Workbox or next-pwa runtime caching "for offline" | Lighthouse PWA score | Stale or auth-leaking pages, broken iOS video | Never for this app; push-only SW |
| Server Actions for sending messages and uploads | Less boilerplate | 1 MB limits; stale action IDs in long-lived PWA clients | Only for rare settings forms |
| Skip recovery codes ("I own the server") | Faster auth phase | Girlfriend locked out when the owner isn't available | OK if the CLI reset exists *and* is documented |
| Polling instead of WS for chat | No custom server | Battery drain, laggy typing indicators | Never; WS is core |
| `iceTransportPolicy: 'relay'` always | Predictable connectivity | Every byte through coturn (bandwidth); TCP/TLS-only relay today (Pitfall 2) | Only as a temporary fallback after a failed direct ICE |

## Integration Gotchas

| Integration | Common Mistake | Correct Approach |
|-------------|----------------|------------------|
| SFU join token | Minting with claims that don't match the join payload, or no `protocolVersion` | Claims `{mediaRoomId, participantId, canPublish:true, canSubscribe:true, protocolVersion:1}`, HS256, short `exp` (2–5 min); the same values in the `join` message |
| SFU signaling | Expecting socket.io or a request/response library | Raw WS JSON `{type, id, payload}`, replies `${type}:response`, notifications `new-producer`, `producer-closed`, `producer-paused`/`resumed`, `audio-level` |
| SFU consumers | Not sending `resume` | Consumers are created paused; send `resume` after attaching the track |
| coturn | Plain `turn:` on 443 behind the SNI router | Only `turns:` works on 443; add `turn:` on 3478 (Pitfall 2) |
| coturn cert renewal | `SIGHUP` on renewal | `SIGUSR2` (README); otherwise TLS TURN breaks after 90 days |
| Apple Web Push | `mailto:` subject on localhost, or with spaces/brackets | `mailto:you@realdomain.tld`; JWT exp under 24 h; delete on 404/410 |
| web-push library | Ignoring send errors | Log status codes per endpoint; prune on 404/410; alert on 403 |
| `@sideby-me/rtc-types` | `npm install` fails in Docker build | GitHub Packages token as a BuildKit secret, or vendor the schemas |

## Performance Traps

Scale is fixed at two users, so the real limits come from the devices, the home network and disk growth, not user count.

| Trap | Symptoms | Prevention | When It Breaks |
|------|----------|------------|----------------|
| Full-res images in scrollback | iOS PWA reloads, jank | Thumbnails + lazy loading + list virtualization | A few hundred photos into history |
| Loading the entire history at once | Slow open, memory | Cursor pagination by `seq` (50 at a time) | After months of "kept forever" history |
| VP8 software encode on the iPhone | Hot phone, battery drain, FPS drops | H264 on iOS (Pitfall 15), cap at 720p30 | Video calls over ~15 min |
| Relay over TLS/TCP on lossy cellular | Choppy audio, rising delay | UDP TURN on 3478 (Pitfall 2) | Any relayed cellular call |
| Home upload bandwidth (if self-hosted at home) | Remote party's video stutters | Cap bitrate; consider a VPS | Residential upstream under ~10 Mbps |
| ffmpeg transcode run inline in the request | Upload request times out | Transcode in a background job; message shows "processing" | Clips longer than ~30 s |

## Security Mistakes

| Mistake | Risk | Prevention |
|---------|------|------------|
| Media served from a static public folder with guessable names | Private photos exposed | Auth-checked route + X-Accel-Redirect; random IDs |
| `SFU_ADMIN_SECRET` empty, or `:44443` reachable | Anyone creates rooms (admin is "dev-open" when the secret is empty) | Set the secret; firewall the port; duet doesn't need it |
| TURN credentials or the SFU token secret shipped to the client | Open relay, or forged joins | Mint tokens on the duet server only; TURN creds come from the SFU `join:response` |
| WS upgrade without Origin + cookie check | Cross-site WS hijack of the chat | Verify the session cookie and `Origin` on upgrade |
| Hard lockout on failed TOTP | Partner locked out by anyone | Backoff, not lockout; CLI break-glass |
| Push payloads containing message text | Plaintext in Apple/Google push infra (they're encrypted to the device, but previews show on the lock screen) | Accept it, or send "New message" only (a user setting); payloads are already encrypted end-to-end per RFC 8291 |
| GPS EXIF kept on photos | Location history stored forever | Strip EXIF GPS on ingest |

## UX Pitfalls

| Pitfall | User Impact | Better Approach |
|---------|-------------|-----------------|
| Asking for notification permission on first load | iOS rejects it (no gesture), or the user dismisses it | Onboarding step "Enable notifications" with a button, standalone only |
| No "Add to Home Screen" guidance on iOS | Partner uses the Safari tab and never gets pushes | Detect a non-standalone iOS session and show an install instructions sheet |
| A speaker toggle that does nothing on iOS | Confusing | Hide it on iOS (Pitfall 8) |
| Silent failure when the call can't connect | "It just spins" | Clear states: connecting, reconnecting, "partner's app is in background", failed + retry |
| Typing indicator stuck after suspension | Looks broken | TTL the indicator (~5 s) on the receiver |
| Read receipts sent while the app is hidden | False "read" | Only send while visible and focused |

## "Looks Done But Isn't" Checklist

- [ ] **Calls:** Tested phone-on-cellular to phone-on-Wi-Fi, **and** both on home Wi-Fi, **and** forced relay; `bytesReceived > 0` in both directions on both devices.
- [ ] **Calls:** iPhone backgrounded for 10 s mid-call, then returned: audio comes back without manual rejoin, or rejoins automatically.
- [ ] **Calls:** A 70-minute relayed call doesn't drop (TURN TTL).
- [ ] **Calls:** iPhone sends H264 (check `outbound-rtp` `codecId` in stats).
- [ ] **Push:** Works on the iPhone **after 7+ days** and after a reboot; a 410 prunes the subscription; tapping a call notification with the app killed lands on the incoming-call screen.
- [ ] **Push:** 20 consecutive pushes while the app is open don't revoke the subscription.
- [ ] **Voice notes:** iPhone recording plays on the Pixel and Pixel recording plays on the iPhone, both with the correct duration shown.
- [ ] **Clips:** A 4K HEVC library clip from the iPhone plays on the Pixel, upright.
- [ ] **Images:** A HEIC original (picker set to "Current") displays on the Pixel.
- [ ] **Uploads:** A 150 MB file either succeeds or fails with a clear retry, never an endless spinner.
- [ ] **Chat:** Airplane mode for 2 min, then back on: messages sent in the meantime arrive, nothing is duplicated, the outbox flushes.
- [ ] **Auth:** TOTP replay rejected; recovery code works once; CLI reset works; the session survives 30 days in the installed iOS app.
- [ ] **SW:** After a deploy, both phones pick up the new build without a stale-shell error; video plays in the installed iOS app.
- [ ] **UI:** `git diff` on `components/ui`, `globals.css` and `components.json` is empty since scaffold.
- [ ] **Ops:** Restoring from backup on a scratch directory works.

## Recovery Strategies

| Pitfall | Recovery Cost | Recovery Steps |
|---------|---------------|----------------|
| Domain lost (Pitfall 0) | MEDIUM | New domain → new certs → **reinstall the PWA on both phones** (the origin changes, so subscriptions, storage and login reset) |
| iOS push subscription revoked | LOW | User opens the app → "Enable notifications" → server upserts; fix the SW `waitUntil` bug |
| Media stored un-normalized | MEDIUM | Batch ffmpeg job over the media dir; update DB rows (mime, duration, poster) |
| Shadcn preset drifted | MEDIUM | `git checkout` scaffold files; refactor app components back to semantic tokens |
| Locked out of TOTP | LOW (if CLI exists) | `docker exec` reset script → re-enroll |
| Stale SW shell on iOS | LOW | Bump SW version; in the worst case delete and re-add the home-screen app |

## Pitfall-to-Phase Mapping

| Pitfall | Prevention Phase | Verification |
|---------|------------------|--------------|
| 0 Domain expired / SFU not live | Phase 1 Infra | DNS resolves; TLS valid; README gates pass from cellular |
| 1 Home NAT / hairpin / CGNAT | Phase 1 Infra | Both-on-home-Wi-Fi call + cellular call succeed |
| 2 TURN UDP dead on 443 | Phase 1 Infra (SFU patch) | webrtc-internals shows relay/udp on cellular |
| 20 Next.js WS hosting | Phase 1 Foundation | `/ws` upgrade works in prod build behind the proxy |
| Port 443 / SNI contention | Phase 1 Infra | `openssl s_client -servername duet.<domain>` reaches duet |
| 18 TOTP lockout/recovery | Auth & PWA shell | Replay, backoff, recovery code and CLI reset tests |
| 19 shadcn preset drift | Auth & PWA shell (scaffold) + all UI phases | CI diff check is empty |
| 12 SW caching | Auth & PWA shell | Logout/login, deploy-update and iOS video tests |
| 14 WS resume / missed messages | Realtime chat | Airplane-mode and background/resume tests on the iPhone |
| 9, 10, 11, 13 Media formats, HEIC, uploads, Range | Media messages | Cross-device playback matrix; 150 MB upload; 206 responses |
| 5, 6 Push revocation / deep link | Push notifications | 7-day soak; killed-app tap opens the call screen |
| 3, 4, 7, 8, 15, 16, 17 Call reliability on iOS | Calls | Checklist "Calls" items above |
| Backups | Phase 1 (setup) + Hardening | Restore drill |

## Sources

**Primary (read directly, HIGH):**
- `sideby-me/sfu.sideby.me` via `gh`: `README.md`, `src/mediasoup/codecs.ts`, `src/signaling/{auth,gateway,handlers}.ts`, `src/turn/ice-servers.ts`, `src/room-registry.ts`, `src/http/admin.ts`, `src/config.ts`, `nginx-sni.conf`, `turnserver.conf.example`, `.env.example`, `.npmrc`, `dev/README.md`
- Live probes 2026-10-08: `whois sideby.me` (redemptionPeriod, expired 2026-08-20), `dig @1.1.1.1` (NXDOMAIN), TCP probe of `35.208.41.166:443` (timeout), local `ip addr` / `ss` / `docker ps`
- [mediasoup-client Device.ts handler detection](https://raw.githubusercontent.com/versatica/mediasoup-client/v3/src/Device.ts)
- [Apple: Sending web push notifications in web apps and browsers](https://developer.apple.com/documentation/usernotifications/sending-web-push-notifications-in-web-apps-and-browsers) (BadJwtToken causes)

**Secondary (agreement across several sources, MEDIUM):**
- [WebKit: Web Push for Web Apps on iOS and iPadOS](https://webkit.org/blog/13878/web-push-for-web-apps-on-ios-and-ipados/); [Meet Declarative Web Push](https://webkit.org/?p=16535)
- [WebKit commit: enforce silent push quota](https://webkit.googlesource.com/WebKit/+/108ccb442e40e9705d212e74c1f213e3b5a0ea05); [Discourse: iOS loses push permission](https://meta.discourse.org/t/ios-notifications-can-lose-permission-to-push-if-the-user-is-currently-active/290225); [Progressier: subscriptions terminated after 3 notifications](https://dev.to/progressier/how-to-fix-ios-push-subscriptions-being-terminated-after-3-notifications-39a7)
- [WebKit bug 263687 (notificationclick deep link)](https://bugs.webkit.org/show_bug.cgi?id=263687); [Apple forum 733604](https://developer.apple.com/forums/thread/733604); [WebKit bug 273063 (pushsubscriptionchange)](https://bugs.webkit.org/show_bug.cgi?id=273063)
- [yuvomi changelog: admin@localhost causes BadJwtToken](https://newreleases.io/project/github/ulsklyc/yuvomi/release/v1.66.2)
- [Apple forum 774239: background WebRTC for web apps](https://developer.apple.com/forums/thread/774239); [WebKit bug 226620](https://bugs.webkit.org/show_bug.cgi?id=226620)
- [WebKit bug 215884: standalone camera re-prompt on hash change](https://bugs.webkit.org/show_bug.cgi?id=215884); [Apple forum 788518](https://developer.apple.com/forums/thread/788518)
- [webrtcHacks: autoplay restrictions and WebRTC](https://webrtchacks.com/autoplay-restrictions-and-webrtc/); [mediasoup discourse: iOS audio autoplay](https://mediasoup.discourse.group/t/audio-auto-play-issues-ios-safari/4782)
- [MDN Audio Session API](https://developer.mozilla.org/en-US/docs/Web/API/Audio_Session_API); [WebKit bug 230902](https://bugs.webkit.org/show_bug.cgi?id=230902)
- [addpipe MediaRecorder demo (formats per browser)](https://addpipe.com/media-recorder-api-demo/); [addpipe: MP4 duration](https://blog.addpipe.com/duration-in-mp4-files-produced-by-chrome-safari/); WebKit bugs [290002](https://bugs.webkit.org/show_bug.cgi?id=290002), [299164](https://bugs.webkit.org/show_bug.cgi?id=299164), [301507](https://bugs.webkit.org/show_bug.cgi?id=301507)
- [Apple forum 743049: Safari 17 HEIC conversion via accept](https://developer.apple.com/forums/thread/743049); [WebKit bug 303803](https://bugs.webkit.org/show_bug.cgi?id=303803)
- [WebKit bug 184447: SW + video range](https://bugs.webkit.org/show_bug.cgi?id=184447); [web.dev: SW range requests](https://web.dev/articles/sw-range-requests)
- [WebKit bug 181849: home-screen storage separate from Safari](https://bugs.webkit.org/show_bug.cgi?id=181849)
- [mediasoup discourse: codec order / preferring H264](https://mediasoup.discourse.group/t/prefer-client-side-codecs-order/2167)
- [shadcn changelog: preset commands](https://ui.shadcn.com/docs/changelog/2026-04-preset-commands); [shadcn CLI v4](https://ui.shadcn.com/docs/changelog/2026-03-cli-v4)
- [websocket.org: WebSockets with Next.js](https://websocket.org/guides/frameworks/nextjs/); [Apple forum 792842: WS in iOS 26](https://developer.apple.com/forums/thread/792842)

**LOW (single source, verify):**
- CVE-2026-44578, Next.js WS upgrade SSRF ([SonicWall blog](https://www.sonicwall.com/blog/next-js-websocket-upgrade-handler-ssrf)); exact versions unverified
- coturn rejecting allocation refresh after REST credential expiry (Pitfall 17); needs an empirical test
- Wake Lock reliability in iOS home-screen apps only from 18.4

---
*Pitfalls research for: self-hosted 2-user chat + calling PWA on an existing mediasoup SFU*
*Researched: 2026-10-08*
