# API Coverage: Web Push (VAPID) via `web-push` 3.6.7 + browser Push/Notifications API

> Full coverage by default. Every opt-out below is an explicit, reasoned decision.
> Scope: plan 02-03 (NOTF-01..03, SHEL-03). Surfaces: the push services the phones subscribe with
> (`web.push.apple.com` for the iPhone PWA, `fcm.googleapis.com` for the Pixel PWA) reached through the
> `web-push` library on the server, and the browser `PushManager` / service-worker notification APIs on
> the client. No other external API is integrated in Phase 2 (media processing uses local ffmpeg,
> ffprobe, heif-convert and sharp; Cloudflare is only the existing tunnel, with no new API calls).

| capability | decision | reason |
|---|---|---|
| webpush.sendNotification with an encrypted payload (aes128gcm, RFC 8291) | INTEGRATE | |
| VAPID authentication (setVapidDetails, RFC 8292) | INTEGRATE | |
| generateVAPIDKeys (one-time keypair via deploy/vapid-keys.sh) | INTEGRATE | |
| TTL header (86400 for chat and test pushes) | INTEGRATE | |
| Urgency header (high) | INTEGRATE | |
| Topic header (duet-chat / duet-test, coalesces undelivered pushes) | INTEGRATE | |
| request timeout option (10 s) | INTEGRATE | |
| expired-subscription handling (404/410 -> delete row) | INTEGRATE | |
| PushManager.subscribe (userVisibleOnly true, applicationServerKey) | INTEGRATE | |
| PushManager.getSubscription + re-POST on every launch | INTEGRATE | |
| showNotification (title, body, icon, tag, renotify, data) | INTEGRATE | |
| getNotifications + Notification.close (collapse, tray clearing) | INTEGRATE | |
| notificationclick -> clients.matchAll / focus / postMessage / openWindow | INTEGRATE | |
| Notification.requestPermission inside the user gesture | INTEGRATE | |
| setGCMAPIKey (legacy FCM server key) | OPT-OUT | not needed: FCM accepts VAPID; the legacy key API is obsolete |
| contentEncoding aesgcm (legacy draft encoding) | OPT-OUT | not needed: iOS 16.4+ Safari and current Chrome use aes128gcm |
| proxy / agent / custom headers options | OPT-OUT | not needed: the server reaches the push services directly |
| getVapidHeaders with a cached JWT | OPT-OUT | not needed yet: one JWT per send is fine at two users' volume (research A9); revisit only if Apple returns 429 or 403 |
| pushsubscriptionchange event | OPT-OUT | not needed: iOS never fires it; the launch-time re-POST covers both phones |
| PushSubscription.unsubscribe from the page | OPT-OUT | not needed: logout deletes the subscription server-side (session cascade); turning notifications off is done in the phone's settings |
| notification actions (Answer/Reply buttons) | OPT-OUT | explicitly out of scope (REQUIREMENTS: notification action buttons are unsupported on iOS) |
| notification badge, image, vibrate, silent, requireInteraction options | OPT-OUT | not needed: UI-SPEC omits badge; message previews stay text-only; silent pushes are forbidden (iOS revokes permission) |
| notificationclose event | OPT-OUT | not needed: nothing to track when a notification is dismissed |
| Declarative Web Push (iOS 18.4+) | OPT-OUT | not needed: the service-worker path works on every supported phone |
| App Badging API (setAppBadge) | OPT-OUT | explicitly out of scope: unread icon badge is v2 (CHAT-11) |
