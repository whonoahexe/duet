---
phase: 261021-5zd
plan: 01
subsystem: media, profile, push, web-ui
status: complete
tags: [profile-photo, gallery, viewer, push, encryption-at-rest, websocket]
requires:
  - QT-4qu DUETENC media at rest (encryptFile / decryptToFile / readEncHeader / decryptChunks)
  - chunked upload pipeline and media processor lanes
provides:
  - users.photo_id + PUT /api/users/:id/photo (shared photos, encrypted 192/640 square crops)
  - GET /media/:id/avatar-sm|avatar-lg
  - WS frame { t: "profile", userId, photoId } and /api/me photoId
  - PushPayload.avatar + service-worker notification icon
  - GET /api/media (shared gallery paging)
  - PersonAvatar, ProfilePhotoDrawer, Gallery, windowed Viewer with onNearEnd
affects:
  - server/src/chat/service.ts (sendMessage refuses an attachment that is someone's photo)
  - web header (PeerHeader button), call screens, incoming call
tech-stack:
  added: []
  patterns:
    - processor.settled(id) to await one attachment's job
    - narrow useSyncExternalStore selectors (useMe / usePeer) for always-mounted consumers
    - viewer slide windowing (radius 2) with same-size empty CarouselItems
key-files:
  created:
    - server/drizzle/0002_profile_photo.sql
    - server/drizzle/meta/0002_snapshot.json
    - server/src/media/avatar.ts
    - server/src/media/gallery.ts
    - server/test/profile.test.ts
    - server/test/gallery.test.ts
    - web/components/app/person-avatar.tsx
    - web/components/app/profile-photo-drawer.tsx
    - web/components/app/gallery.tsx
  modified:
    - server/src/db/schema.ts
    - server/drizzle/meta/_journal.json
    - shared/src/api.ts
    - shared/src/ws.ts
    - shared/src/media.ts
    - shared/src/push.ts
    - server/src/media/image.ts
    - server/src/media/process.ts
    - server/src/media/routes.ts
    - server/src/auth/routes.ts
    - server/src/chat/service.ts
    - server/src/app.ts
    - server/src/push/sender.ts
    - server/src/push/routes.ts
    - server/test/auth.test.ts
    - server/test/push.test.ts
    - server/test/call-push.test.ts
    - server/test/sw.test.ts
    - web/lib/chat/store.ts
    - web/lib/chat/realtime.ts
    - web/components/app/shell.tsx
    - web/components/app/viewer.tsx
    - web/components/app/call-screen.tsx
    - web/components/app/incoming-call.tsx
    - web/public/sw.js
    - scripts/smoke-chat.mjs
decisions:
  - "A failed (but finished) image upload passes the PUT photo pre-check so it is answered 422 with its own error code; only an unfinished (uploading) upload is 400 bad_attachment."
  - "sendMessage refuses any attachment that is currently someone's profile photo (T-5zd-02: an avatar never becomes message media)."
  - "Code commits were made on branch gsd/quick-261021-5zd, not master: the executor's commit guard treats master as protected and config has no allow_default_branch_commits override."
metrics:
  duration: "~461 min wall clock including a rate-limit interruption mid-Task 1; active work well under that"
  completed: 2026-10-21
  tasks: 3
  files: 35
estimate:
  tokens: 150000
  tasks: 3
actuals:
  tokens: 30800
  tasks: 3
  commits: 3
plan_head_before: 1a5a3449285ad073b4f567cbdb09bed23013fa5c
plan_head_after: 1f2977ec2913ca0d7956f935ae1ec890533263b9
---

# Phase 261021-5zd Plan 01: Shared Media Gallery and Profile Photos Summary

Shared per-person profile photos (set or removed by either of you from Menu > Profile photo). The server stores them as DUETENC-encrypted 192 and 640 px centre-cropped WebP files, pushes changes live over WS, and shows them in the header, call screens, gallery and Android push icon. A WhatsApp-style month-grouped gallery opens from the chat header, and its viewer swipes across the whole gallery.

This resolves the todo `.planning/todos/pending/2026-10-20-media-gallery-and-profile-photos.md`.

## Branch note (orchestrator action needed)

The three code commits are on **`gsd/quick-261021-5zd`**, branched from master at `1a5a344`. The executor's pre-commit guard reports `master` as protected (`git.base-branch --is-protected master` = true, and `.planning/config.json` has no `git.allow_default_branch_commits`). The guard's documented remedy is to move the work onto its own branch, so that is what I did. Master has not changed, so this is a clean fast-forward: `git checkout master && git merge --ff-only gsd/quick-261021-5zd`, or set `git.allow_default_branch_commits: true` if direct-to-master commits are intended for quick tasks.

## Tasks

| Task | Name | Commit |
| ---- | ---- | ------ |
| 1 | Tracer: profile photo drawer, encrypted square crops, live header update | 39fa68f |
| 2 | Photo on incoming-call / in-call screens and as the Pixel push icon | e48a8ea |
| 3 | Shared media gallery from the header, viewer swiping across the whole gallery | 1f2977e |

Tracer gate (Task 1): auto mode is off and human_verify_mode is end-of-phase. All of the `<verify>` checks are automated, and they were re-run end to end before expanding: the server suites, both typechecks, lint, the preset check, the lockfile check and smoke `profile`. They passed, so there was no checkpoint.

## What was built

- **DB:** `users.photo_id` (nullable, no FK on purpose). The migration is the drizzle-kit generated `0002_profile_photo.sql`, a single `ALTER TABLE users ADD photo_id text`.
- **PUT /api/users/:id/photo:**
  - Uses requireUser and `no-store`. An unknown or non-uuid user gives 404. A body that fails the strict check gives 400 invalid_body.
  - A photo must be the requester's own unattached image, not still uploading, and not already someone's photo. Otherwise it gives 400 bad_attachment.
  - The route waits on `processor.settled(id)` for up to 60 s. A job still running then gives 409 not_ready, and a failed job gives 422 with the row's error.
  - It crops `display.webp` in a `media/work` mkdtemp scratch dir, then encrypts `avatar-sm.webp` and `avatar-lg.webp` into `media/<id>/`. The swap happens in a sync transaction with re-checks.
  - It broadcasts the `profile` frame, then cleans up the previous avatar. That row and its dir are deleted only when the row has no message and no user references it.
- **GET /media/:id/avatar-sm|avatar-lg** go through the existing session gate, ready check and decrypting Range path.
- **/api/me** now includes `photoId` for both people. The public `/api/users` is unchanged and still has exactly 3 keys.
- **Web:**
  - `chatStore.applyProfile` and `refreshProfiles`, which runs on every hello.
  - A `useMe`/`usePeer` selector pair and `PersonAvatar` (Base UI Avatar with initials as the fallback).
  - `ProfilePhotoDrawer`: whose photo, Choose photo, Take photo (`capture="user"`), Remove photo.
  - `PeerHeader`, which is also the gallery button.
- **Calls:** `CallIdentity` shows the photo. When the PiP is swapped and the peer's camera is off, the PiP shows the peer's avatar-lg photo.
- **Push:** `avatar` is added to chat, incoming and missed call payloads only when there is a photo. `sw.js` builds `/media/<id>/avatar-sm` only from an id matching `^[A-Za-z0-9_-]{22}$`. Anything else gets `/icons/icon-192.png`. It still has exactly four listeners.
- **Gallery:**
  - `GET /api/media?before&limit` uses key = seq*10 + position, a default page of 60 and a max of 120. It returns ready image/video items joined to messages only.
  - `Gallery` dialog: the peer's avatar and name at the top, a month heading for each month, a 3-column grid, a duration pill on video tiles, and an IntersectionObserver sentinel for infinite scroll. It also has skeleton, empty, error/Retry and load-more-error states.
  - The viewer opens at the tapped tile and calls `onNearEnd` to load more.
- **Viewer:** only mounts slides within 2 of the current one. Opening resets the carousel API and the current index.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 2 - Security] sendMessage accepted an attachment that is currently a profile photo**
- **Found during:** Task 1
- **Issue:** The photo route refuses message media (`messageSeq` not null). However, `POST /api/messages` would accept the uploader's current avatar attachment, because it is unattached, ready and their own. That breaks T-5zd-02 ("an avatar can never be swapped onto a message") and would put the avatar in the gallery.
- **Fix:** sendMessage now throws 400 bad_attachment when any `users.photo_id` matches one of the requested attachment ids. This is covered in profile.test.ts.
- **Files modified:** server/src/chat/service.ts
- **Commit:** 39fa68f

**2. [Rule 1 - Bug] The plan's pre-check would have made the "garbage image gives 422" behaviour impossible**
- **Found during:** Task 1 (test RED)
- **Issue:** The action told the route to require status processing|ready before waiting, which turns an already-failed upload into 400 instead of the 422 that <behavior> requires.
- **Fix:** The pre-check now refuses only `uploading`. A failed row reaches the settled/422 branch with `row.error`.
- **Files modified:** server/src/media/avatar.ts
- **Commit:** 39fa68f

**3. [Rule 3 - Blocking] The gallery smoke hit a strict-mode locator violation**
- **Found during:** Task 3
- **Issue:** With radius-2 windowing, several `viewer-image` elements are mounted at once.
- **Fix:** The scenario now picks the viewer image by the tapped tile's attachment id.
- **Files modified:** scripts/smoke-chat.mjs
- **Commit:** 1f2977e

**4. [Process] Commits are on branch gsd/quick-261021-5zd instead of master.** See the branch note above.

### TDD note
The tasks were marked `tdd="true"`, but they were not split into separate RED and GREEN commits. Each task's tests and its implementation went into one atomic commit, because the quick-task constraint was one commit per task. In Task 1 the test run did go RED first (the failed-upload 422 case), and that failure drove deviation 2.

## Verification

- `npm test`: 28 files, 468 passed, 1 skipped. The baseline was 26 files, 450 passed, 1 skipped, and the new and extended tests are on top of that.
- `npm --prefix server run typecheck` and `npm --prefix web run typecheck`: clean.
- `npm --prefix web run lint -- components/app/gallery.tsx components/app/viewer.tsx components/app/person-avatar.tsx components/app/profile-photo-drawer.tsx components/app/incoming-call.tsx lib/chat/store.ts lib/chat/realtime.ts`: clean. Full-repo lint error count is 11, the same as the baseline.
- `bash scripts/check-preset.sh`: preset ok. `git diff --quiet HEAD -- package-lock.json`: unchanged (no package added).
- `MEDIA_KEY_FILE="$(mktemp -d)/media.key" bash scripts/smoke-chat.sh photo album back profile gallery`: all five scenarios ok, then smoke-chat ok. The browser console logged 503s from the push endpoints because VAPID is not set up in smoke. That already happens without this change and does not affect the result.

## Pending rollout (orchestrator, not run by the executor)

1. Fast-forward master onto `gsd/quick-261021-5zd` (see the branch note).
2. `docker compose config --quiet && docker compose up -d --build duet`
3. Poll `docker inspect -f '{{.State.Health.Status}}' duet-duet-1` until it is `healthy`.
4. In `docker compose logs duet`, confirm that boot applied migration 0002 with no migrate error, and that `evt: "media_key"` shows `created: false`.

## User's manual checklist (real iPhone + Pixel, after rollout)

- On the iPhone, open Menu > Profile photo, pick your person and Choose photo (a HEIC from the library). The Pixel header shows it within a few seconds, with no reload.
- On the Pixel, Take photo for yourself with the front camera. The iPhone header updates.
- Call from one phone. The incoming-call screen and the in-call screen show the caller's photo.
- With the Pixel app closed, send a message from the iPhone. The Pixel notification shows the iPhone person's photo as its icon. iOS keeps the app icon by design.
- Tap the name in the header. The gallery shows months, a 3-column grid, and durations on video tiles. Scroll far back and older items keep loading. Open a photo and swipe across items from different messages. Play a video from the gallery.
- Remove a photo. Both phones fall back to initials.

## Out of scope (by the todo's decision)

A voice-notes tab, "jump to message" from the gallery, a drag-to-crop editor, and photos on the login tiles (/media is session-gated).

## Known Stubs

None.

## Threat Flags

None beyond the plan's threat model. The new surfaces are PUT /api/users/:id/photo, GET /api/media, the avatar variants and the SW icon URL, and all of them are covered by T-5zd-01..09.

## Self-Check: PASSED

- All 9 created files are present (checked with `test -f`).
- Commits 39fa68f, e48a8ea and 1f2977e are ancestors of HEAD.
