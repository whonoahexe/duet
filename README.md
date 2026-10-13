# duet

A private, self-hosted chat app for exactly two people: text, images, short clips, voice notes and 1:1 calls, delivered as an installable PWA. One Node process (Fastify) serves the static Next.js export, the JSON API and the media files, with SQLite on local disk. It runs in Docker on this box and is reachable only through a Cloudflare Tunnel.

## Layout

| Path | What |
|---|---|
| `web/` | Next.js App Router UI (locked shadcn preset `b51GFhBEQ`), built as a static export to `web/out` |
| `server/` | Fastify server: `/healthz`, `/api/*`, static `web/out`; SQLite (WAL) via Drizzle, migrations applied at boot |
| `shared/` | zod schemas shared by web and server |
| `deploy/cloudflared/` | Tunnel setup script; generated `config.yml` / `credentials.json` (gitignored) |
| `scripts/` | smoke and check scripts |
| ~~`ops/sfu/`~~ | Not used: the SFU was dropped on 2026-10-09 (home is CGNAT). Calls are P2P WebRTC with Cloudflare TURN |

## Local development

Two terminals:

```bash
npm install
npm run dev:server   # Fastify on http://localhost:3100 (tsx watch)
npm run dev:web      # next dev on http://localhost:3000, /api proxied to :3100
```

Local full stack, one process serving the built export:

```bash
npm run build && npm start   # http://127.0.0.1:3100
```

Tests and checks:

```bash
npm test                         # server test suite (vitest)
npm run typecheck
bash scripts/smoke-local.sh      # boots the real server on a temp DATA_DIR
bash scripts/check-preset.sh     # preset lock guard
```

## Secrets

Secrets live outside the repo in `${DUET_SECRETS_DIR:-~/.config/duet}`, mode 600:

| File | Used by |
|---|---|
| `cloudflare.ini` (`dns_cloudflare_api_token = ...`) | tunnel setup and TURN key creation (`deploy/cloudflared/setup.sh`, `deploy/cloudflare/turn-key.sh`) |
| `cloudflare.env` (`CF_ACCOUNT_ID=...`) | `setup.sh` (the account that owns the tunnel) |
| `seed-users.json` | one-off seeding; shred it afterwards |

In the repo, `.env` (copied from `.env.example`) holds `APP_ORIGIN`, `COOKIE_SECURE`, `LOG_LEVEL` and the TURN variables `CF_TURN_KEY_ID` / `CF_TURN_KEY_API_TOKEN` (optional: `TURN_CREDENTIAL_TTL_SECONDS`). They reach the container only through the compose `env_file`. The public domain lives only there. `.env`, `data/` and the tunnel credentials are gitignored and dockerignored.

## Deploy

```bash
cp .env.example .env                 # once; set APP_ORIGIN to the public origin
bash deploy/cloudflared/setup.sh     # once (idempotent): tunnel "duet" + the single proxied CNAME
docker compose up -d --build         # services: duet (no published port) + cloudflared
```

`setup.sh` uses the Cloudflare API only. It never touches `~/.cloudflared`, creates or reuses a locally managed tunnel named `duet`, and writes `deploy/cloudflared/credentials.json` (0400) and `config.yml`. It changes exactly one DNS record, the `APP_ORIGIN` host as a proxied CNAME to `<tunnel-id>.cfargotunnel.com`, and it fails if a before/after zone diff shows any other change.

All data (`duet.sqlite`, `media/`) lives in `./data`, bind-mounted at `/data`. Backup is a copy of that directory, best taken with the stack stopped or via SQLite `.backup`.

The duet service publishes no host port on purpose. Only cloudflared reaches `duet:3100`, so the `CF-Connecting-IP` header the login rate limit keys on cannot be forged from the LAN.

## Accounts: seeding and password reset

Exactly two accounts, with passwords of at least 12 characters. The seed is idempotent. Re-running it with a new password is the password reset, and it revokes that person's sessions.

```bash
# interactive (passwords typed twice, hidden)
docker compose exec -it duet node --import tsx server/scripts/seed-users.ts

# from a JSON file: [{"username","displayName","password"}, ...]
docker compose exec -T duet node --import tsx server/scripts/seed-users.ts --stdin < ~/.config/duet/seed-users.json
shred -u ~/.config/duet/seed-users.json
```

## Calls: TURN and the call test

Calls are 1:1 peer-to-peer WebRTC. Signaling (offer/answer/ICE) rides duet's own `/ws` socket, and Cloudflare TURN relays the media when no direct path works (the home connection is CGNAT). The media is DTLS-SRTP encrypted end to end, and the duet server never carries it.

```bash
bash deploy/cloudflare/turn-key.sh   # once (idempotent): create or reuse the Cloudflare TURN key "duet"
docker compose up -d --build         # the container reads the TURN vars from the env file
```

- `turn-key.sh` uses the Cloudflare API only, with the `cloudflare.ini` token. It writes `CF_TURN_KEY_ID` / `CF_TURN_KEY_API_TOKEN` into `.env` and never prints them. Exit code 3 means Cloudflare refused for a billing or plan reason. To rotate the key, remove those two lines from `.env` and re-run: a new key is created and the old key named `duet` is deleted.
- `POST /api/rtc/ice-servers` mints short-lived TURN credentials for a logged-in user (30/min, `Cache-Control: no-store`). With no key configured it answers 503 `turn_unconfigured`; it never falls back to a STUN-only list.
- **Call test:** header menu → "Call test" (works inside the installed app, which has no URL bar), or open `/debug/call/` directly. Open it on both devices with the same room, tap Start on both, and wait for PASS: a connected peer with growing inbound bytes. `?room=<id>` presets the room and `?relay=1` turns on "Force relay (TURN only)", which only passes when the selected local candidate is `relay`. Each run reports its first PASS and its final state to `POST /api/debug/call-report`, which writes one `call_smoke` line to the server log.

```bash
TURN_SMOKE=1 bash scripts/smoke-local.sh   # local server mints real TURN credentials
bash scripts/smoke-call.sh                  # two headless Chrome peers, normal + forced relay, real TURN
bash scripts/check-call-smoke.sh            # INFR-04 gate: reads call_smoke lines from the deployed log
```

`check-call-smoke.sh` passes when, in normal mode and in forced-relay mode, one room has PASS reports from two distinct clients and at least one of them comes from an IP other than the home egress IP (a phone on cellular). In forced-relay mode every PASS report must have local candidate `relay`. It prints rooms, counts and candidate types, never IP addresses.

## Push notifications

New messages raise a Web Push notification on the other person's phone when they are not looking at the chat (one collapsed notification per sender, tap opens the chat). It needs a VAPID keypair, created once:

```bash
bash deploy/vapid-keys.sh            # once (idempotent): create or reuse VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY
docker compose up -d --build         # the container reads the VAPID vars from the env file
```

- **Never rotate the keypair.** A new pair invalidates every phone's push subscription; both phones would have to turn notifications on again. The script reuses an existing pair and never prints a key. `VAPID_SUBJECT` defaults to the https `APP_ORIGIN`.
- Without the pair the app still runs; `GET /api/push/vapid-public-key` answers 503 `push_unconfigured` and nothing is pushed.
- **iPhone:** web push only works in the installed app. Open duet in Safari, follow the "Add duet to your Home Screen" guide, open duet from the Home Screen, log in there, then tap "Enable notifications". The Pixel shows the same card in the installed app. "Send test notification" pushes to this phone only.
- Logging out removes that phone's subscriptions. The header menu → "Notifications" shows the state and re-enables or re-tests.

```bash
SMOKE_SCRIPT=scripts/smoke-onboarding.mjs bash scripts/smoke-chat.sh   # Add to Home Screen guide + drawer e2e
```

## Media

Photos, short video clips and voice notes are uploaded to duet and normalized on the server, so whatever one phone records plays on the other.

- **Photos** keep their original and are served as 2048 px WebP display copies (plus 640 px thumbnails), autorotated and without EXIF/GPS. iPhone HEIC goes through `heif-convert` first.
- **Videos** (about 3 minutes / 200 MB per clip; the server refuses more than 200 s) are transcoded by ffmpeg to H.264 High + AAC MP4, at most 1280 px on the long side, with faststart and a JPEG poster frame. iPhone HDR (HLG/PQ) is tone-mapped to bt709. A clip shows "Processing…" on both phones until the transcode finishes.
- **Voice notes** (hold the mic, slide left to cancel, slide up or tap to lock; no length limit) are normalized to AAC `.m4a` (64 kbps mono) with the duration and a 40-bar waveform computed on the server, so iPhone (AAC) and Chrome (Opus) recordings play on both phones.
- Every video and voice upload is probed with `ffprobe` first: only allowlisted containers (MP4/MOV, Matroska/WebM, and for voice also Ogg, WAV, MP3, AAC) are processed, with an explicit input format, no shell and a kill timeout. A playlist disguised as a video is refused with 422.
- Uploads are chunked in 8 MiB parts, because Cloudflare rejects request bodies over 100 MB.
- Originals live in `data/media/<id>/original` and are never served; `/media/<id>/<variant>` only serves the generated copies, to a logged-in session, with Range support. Video and voice originals are kept too (to reclaim space later, delete `original` for ready video/audio attachments; nothing reads them again).

Container toolchain self-test (prints `heic ok`, `video ok`, `voice ok` and `media-selftest ok`):

```bash
docker compose exec -T duet node --import tsx server/scripts/media-selftest.ts
```

## Smoke scripts

```bash
bash scripts/smoke-public.sh          # via APP_ORIGIN: /healthz, dark login, /api/me 401, 2 users, headers,
                                      #   ice-servers / call-report / vapid-public-key 401, /ws upgrade 401 (Origin) / 403 (no Origin)
DUET_SEED_FILE=~/.config/duet/seed-users.json bash scripts/smoke-public.sh   # + real login/me/logout
bash scripts/smoke-persistence.sh     # docker compose down/up keeps users, sessions and a sentinel
bash scripts/check-live-db.sh --existing ./data   # schema/WAL/migrations check on the live volume
```

The scripts never print passwords or cookies.
