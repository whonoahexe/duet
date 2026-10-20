---
phase: 261021-4qu
plan: 01
subsystem: server/media
status: complete
tags: [security, media, encryption, at-rest, aes-gcm, range]
requires: []
provides:
  - DUETENC v1 chunked AES-256-GCM media-at-rest format (server/src/media/crypto.ts)
  - decrypting /media Range handler (200/206/304/416, ETag, If-Range, HEAD)
  - encrypted write path (upload parts, originals, variants) with plaintext only in media/work scratch
  - idempotent boot migration encryptMediaAtRest (server/src/media/migrate.ts)
  - media-key / media-check scripts, read-only key mount in compose
affects: [server/src/app.ts, server/src/config.ts, server/src/media/process.ts, server/src/media/routes.ts, server/src/media/uploads.ts, Dockerfile, compose.yaml, README.md]
tech-stack:
  added: []
  patterns:
    - "node:crypto AES-256-GCM per 64 KiB chunk, AAD = header || chunk index"
    - "sharp/ffmpeg run in media/work/<id>-XXXXXX scratch; outputs encrypted into media/<id>"
key-files:
  created:
    - server/src/media/crypto.ts
    - server/src/media/migrate.ts
    - server/test/media-crypto.test.ts
    - server/scripts/media-key.ts
    - server/scripts/media-check.ts
  modified:
    - server/src/config.ts
    - server/src/app.ts
    - server/src/media/process.ts
    - server/src/media/routes.ts
    - server/src/media/uploads.ts
    - server/test/helpers.ts
    - server/test/media.test.ts
    - server/test/uploads.test.ts
    - server/test/video.test.ts
    - server/test/voice.test.ts
    - server/package.json
    - Dockerfile
    - compose.yaml
    - README.md
decisions:
  - "DUETENC v1 on-disk layout: 36-byte header (magic, version 1, chunk size, u64 plain size, 16-byte file id), 64 KiB chunks of nonce|ciphertext|tag, AAD binds header + index; the file id doubles as the strong ETag"
  - "Media key loads before the DB is used and closes SQLite on MediaKeyError, so a refused boot leaks no handle"
  - "/media no longer uses @fastify/static; Range/If-Range/If-None-Match are parsed in routes.ts over the chunk index"
  - "Boot migration restores the mtime of media/tmp/<id> dirs after encrypting parts, so the 24 h stale-upload cleanup keeps its clock"
  - "media-check --compare counts a present-but-unverifiable file as mismatched (not missing)"
metrics:
  duration: 10min
  completed: 2026-10-21
  tasks: 3
  files: 19
actuals:
  tokens: 20400
  tasks: 3
  commits: 3
plan_head_before: 971a8a7e5705ad74c8959f961e7ba906499ed17d
plan_head_after: 65a6056e23eff830455711b6d72a9bf84a73ab7f
---

# Phase 261021-4qu Plan 01: Encrypt media at rest on the server Summary

Every photo, video, voice note and upload part under data/media is now stored as DUETENC v1 ciphertext: AES-256-GCM in 64 KiB chunks, with the header and chunk index bound in as AAD. The key lives in `~/.config/duet/media.key` (mode 600). `/media` decrypts on the fly with full Range/206/416, ETag/304 and If-Range support, and a Range request decrypts only the chunks it covers. sharp and ffmpeg see plaintext only in `media/work` scratch dirs. An idempotent boot migration encrypts files left over from before this change, and the container reads the key only through a read-only bind mount.

> **IMPORTANT: back up `~/.config/duet/media.key` off this machine (for example in a password manager) as soon as the rollout has created it. Without it, every stored photo, video and voice note is unreadable. The server will refuse to boot rather than mint a new key over encrypted media.**

## Tasks

| Task | Name | Commit | Status |
|------|------|--------|--------|
| 1 | Tracer: variants stored encrypted, /media serves them decrypted with Range | bed0d9f | done |
| 2 | Originals and upload parts encrypted, plaintext only in scratch, boot migration | 726bc77 | done |
| 3 (steps 1-6) | media-key / media-check scripts, package.json scripts, Dockerfile ENV, compose read-only mount, README | 65a6056 | done |
| 3 (step 7) | Live rollout (create host key, backup, `docker compose up -d --build duet`, verify, delete backup) | — | done 2026-10-21 by orchestrator |

## Verification run

- `npm test` (whole server suite): 26 files, 450 passed, 1 skipped (HEIC, no heif-convert on the host). The baseline before the change was 417 passed.
- `npm --prefix server run typecheck`: clean.
- `MEDIA_KEY_FILE=<mktemp -d>/media.key bash scripts/smoke-chat.sh photo video voice`: `scenario photo ok`, `scenario video ok`, `scenario voice ok`, `smoke-chat ok`. Real Chrome loaded the poster and reached video readyState >= 1 through the decrypting Range handler. The smoke used a throwaway key and a throwaway DATA_DIR.
- `git diff --quiet HEAD -- package-lock.json`: no lockfile change, no package added. server/package.json changed in Task 3 only, to add the two scripts.
- Script exercise on a throwaway DATA_DIR and MEDIA_KEY_FILE in the scratchpad (since deleted):
  - media-check with no key exits 1 and creates no key.
  - media-key prints "created ... (mode 600)" and the mode is 600; a second run prints "reused".
  - media-check on plaintext lists the file and exits 1.
  - After encryptMediaAtRest, `media-check --compare <backup>` prints `media-check ok`.
  - A flipped ciphertext byte is reported as corrupt and mismatched, exit 1.
  - With the key removed and encrypted media present, media-key refuses with MediaKeyError and creates nothing.
- `docker compose config --quiet`: exit 0. Compose does not check bind sources at config time, so it passes even though the host key does not exist yet. `docker compose up` will refuse to start until `npm --prefix server run media-key` has created it, because `create_host_path: false` is set.
- The real key `~/.config/duet/media.key` was NOT created. The live `data/media` and the running container were NOT touched, per the scope override.

## Migration counts

Not available yet: the live migration is part of the pending orchestrator rollout (Task 3 step 7). After the deploy, the container log line `"evt":"media_at_rest"` should show `failed: 0` and `encrypted` close to 57. In tests, the migration fixture reported `encrypted 3, alreadyEncrypted 1, removed 2, failed 0`, and a second boot reported `encrypted 0, alreadyEncrypted 4`.

## Plaintext backup

Not taken yet, because that is part of rollout step 7b. The rollout must take the backup with `BACKUP="$(mktemp -d)"; cp -a data/media/. "$BACKUP/"` before deploying, and delete it only after `npm --prefix server run media-check -- --compare "$BACKUP"` prints `media-check ok` and `media-selftest ok` passes in the container.

## Pending orchestrator rollout (Task 3 step 7)

1. `npm --prefix server run media-key`: expect "created", then check `stat -c %a ~/.config/duet/media.key` = 600.
2. Take the plaintext backup outside data/: `BACKUP="$(mktemp -d)"; cp -a data/media/. "$BACKUP/"`.
3. `docker compose config --quiet && docker compose up -d --build duet`.
4. Poll `docker inspect -f '{{.State.Health.Status}}' duet-duet-1` until it reports healthy (up to about 90 s).
5. Check the logs: `media_key` with path `/run/duet/media.key` and `created:false`, and `media_at_rest` with `failed:0`.
6. `npm --prefix server run media-check -- --compare "$BACKUP"` must print `media-check ok`.
7. `docker compose exec -T duet node --import tsx server/scripts/media-selftest.ts` must print `media-selftest ok`.
8. Only then run `rm -rf "$BACKUP"`.

## Manual checklist for the user (human-check)

On the iPhone and the Pixel:
- [ ] Open the chat and scroll back. Old photos load, both as thumbnails and in the full viewer.
- [ ] An old video plays, and scrubbing works (this exercises Range).
- [ ] An old voice note plays.
- [ ] Send one new photo and one voice note, and check that they arrive on the other phone.
- [ ] **Back up `~/.config/duet/media.key` off this machine.**

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 2 - Correctness] SQLite handle closed when the key load refuses the boot**
- **Found during:** Task 1
- **Issue:** buildApp opens SQLite before the media key is loaded, so a MediaKeyError would have left the DB handle open.
- **Fix:** The loadMediaKey call in app.ts is wrapped so that a failure runs `sqlite.close()` and then rethrows.
- **Files modified:** server/src/app.ts
- **Commit:** bed0d9f

**2. [Rule 1 - Bug] Boot migration would have reset the stale-upload clock**
- **Found during:** Task 2
- **Issue:** Renaming an encrypted part over `media/tmp/<id>/<n>.part` bumps the directory's mtime. cleanupStale uses that mtime for orphaned chunk dirs, so the migration would have delayed their cleanup by 24 h.
- **Fix:** encryptMediaAtRest now restores the directory's atime and mtime after it rewrites the parts.
- **Files modified:** server/src/media/migrate.ts
- **Commit:** 726bc77

**3. [Rule 2 - Correctness] Partially written key file removed**
- **Found during:** Task 1
- **Issue:** If the write failed after `open(wx)` had succeeded, a truncated key file would have been left behind, and every later boot would reject it as malformed.
- **Fix:** In that case loadMediaKey removes the file it just created.
- **Files modified:** server/src/media/crypto.ts
- **Commit:** bed0d9f

**4. [Plan refinement] media-check --compare and corrupt files**
- A file that exists under media/ but is plaintext or corrupt counts as `mismatched`, not `missing`, so one bad file is never counted twice.
- **Commit:** 65a6056

### Process note

- All three commits are on `master`. GSD's protected-branch check reports master as protected. The project uses `branching_strategy: none`, every earlier quick task committed straight to master, and the orchestrator dispatched this run sequentially onto the main working tree, so I committed there. I made no changes to the config.

### Scope override

- Task 3 step 7 (live rollout) was intentionally not performed. See "Pending orchestrator rollout".

## Known Stubs

None.

## Threat Flags

None beyond the plan's threat model. The new surface (the /media Range parser and the key file) is covered by T-4qu-03 through T-4qu-06.

## Follow-ups

- **Message text in `data/duet.sqlite` is not encrypted.** That was out of scope for this task (the todo said "consider"), and the README now says so. It is a possible follow-up.
- This resolves the todo `.planning/todos/pending/2026-10-20-encrypt-media-at-rest.md`, once the rollout is done.

## Self-Check: PASSED

- FOUND: server/src/media/crypto.ts, server/src/media/migrate.ts, server/test/media-crypto.test.ts, server/scripts/media-key.ts, server/scripts/media-check.ts
- FOUND commits: bed0d9f, 726bc77, 65a6056 (all ancestors of HEAD)

## Rollout result (2026-10-21, orchestrator)

- `media-key`: created `~/.config/duet/media.key` (mode 600).
- Plaintext backup: 57 files / 63 MB in a mktemp dir, taken before deploy.
- `docker compose up -d --build duet` → healthy.
- Logs: `media_key` path `/run/duet/media.key`, `created:false`; `media_at_rest` `encrypted:57, alreadyEncrypted:0, removed:0, failed:0` (422 ms).
- `media-check --compare <backup>`: encrypted 57, plaintext 0, corrupt 0, missing 0, mismatched 0 → `media-check ok`.
- In-container `media-selftest ok`.
- Backup deleted after both checks passed.
- Remaining: on-phone human check, and backing up the key off the machine.
