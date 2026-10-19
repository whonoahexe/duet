---
phase: 02-chat-media-push
plan: 05
subsystem: media
tags: [ffmpeg, ffprobe, libx264, zscale, tonemap, aac, mediarecorder, waveform, react, base-ui, shadcn, playwright, docker]

requires:
  - phase: 02-chat-media-push
    provides: "02-04: createMediaProcessor (fast/slow lanes, KindHandler map), runTool, chunked uploads + complete, /media VARIANTS (poster, video, audio), uploadFile, sendMedia + media outbox, album/viewer/preview-drawer, media-selftest.ts, ffmpeg 5.1.9 in the image; 02-01: attachments.duration_ms/waveform columns, MessageKind voice, messageLabel for voice"
provides:
  - "shared/src/media.ts: VIDEO_MAX_DURATION_MS (200 000), VIDEO_PICK_MAX_SECONDS (180), VOICE_WAVEFORM_BARS (40), formatDuration (m:ss / h:mm:ss)"
  - "server/src/media/probe.ts: probeMedia (ffprobe with -protocol_whitelist file and -format_whitelist), VIDEO_FORMATS, VOICE_FORMATS, inputFormatFor"
  - "server/src/media/video.ts: processVideo (H.264 High/AAC faststart MP4 <=1280 px, HLG/PQ tone-map, no metadata, poster.jpg <=640 px)"
  - "server/src/media/audio.ts: processAudio (AAC 64k mono .m4a faststart, output duration, 40 streamed peaks)"
  - "runTool onStdout streaming option (exec.ts)"
  - "Processor lanes: video on slow, audio on fast; complete-time probe gate answering 422 unsupported_media / too_long"
  - "sendMessage: kind voice for exactly one audio attachment without body; bad_attachment for any other audio mix"
  - "web/lib/chat/recorder.ts startRecording (MIME candidates, no timeslice, guaranteed track stop); web/lib/chat/playback.ts one-at-a-time registry"
  - "web/components/app/recorder.tsx (useVoiceRecorder, MicButton, RecordingStatus), voice-note.tsx (VoiceNote); store.sendVoice"
  - "Video tiles, processing/failed tiles, viewer video slides; picker accept image/*,video/*; pick-time 200 MB / 3 min checks"
  - "smoke-chat scenarios video and voice; video.test.ts, voice.test.ts; media-selftest video ok / voice ok; README Media section"
affects: [03]

actuals:
  tokens: 25600
  tasks: 3
  commits: 4
plan_head_before: 4d20aa3495efabcac069ad7354348a0c89c781c0
plan_head_after: 80747118e83d5930716848053ac62c651aec7f5c

tech-stack:
  added: []
  patterns:
    - "Every ffprobe/ffmpeg call opens only local files (-protocol_whitelist file) with an allowlisted demuxer: ffprobe through -format_whitelist, ffmpeg through an explicit -f taken from inputFormatFor"
    - "Complete-time gate per kind (PROBE_GATES): rejected uploads are failed, their bytes deleted, and repeated completes answer the same 422"
    - "Large tool output is folded while it streams (runTool onStdout), never buffered: the waveform of an hour-long note needs 40 numbers of memory"
    - "Media elements register with lib/chat/playback.ts so only one voice note or video plays at a time"
    - "Voice notes reuse the media outbox (MediaEntry.voice) so failures share the 'Not sent. Tap to retry.' path"

key-files:
  created:
    - server/src/media/probe.ts
    - server/src/media/video.ts
    - server/src/media/audio.ts
    - server/test/video.test.ts
    - server/test/voice.test.ts
    - web/lib/chat/recorder.ts
    - web/lib/chat/playback.ts
    - web/components/app/recorder.tsx
    - web/components/app/voice-note.tsx
  modified:
    - shared/src/media.ts
    - server/src/media/exec.ts
    - server/src/media/process.ts
    - server/src/media/uploads.ts
    - server/src/chat/service.ts
    - server/scripts/media-selftest.ts
    - server/test/uploads.test.ts
    - web/lib/chat/store.ts
    - web/components/app/composer.tsx
    - web/components/app/preview-drawer.tsx
    - web/components/app/album.tsx
    - web/components/app/viewer.tsx
    - web/components/app/message-row.tsx
    - web/components/app/chat-view.tsx
    - scripts/smoke-chat.mjs
    - README.md

key-decisions:
  - "Video and voice originals are kept after a successful transcode (planner resolution of research Open Q1, reversible); a rejected upload (playlist, too long) has its bytes deleted"
  - "ffprobe itself runs with -protocol_whitelist file and -format_whitelist (the union of the allowlisted demuxers), so a playlist demuxer never starts even while probing; any probe failure is 422 unsupported_media"
  - "Transcoded video and voice carry no container metadata (-map_metadata -1): an iPhone .MOV stores the recording location, the same reason photos drop EXIF/GPS"
  - "processVideo also fails with too_long when the transcoded output exceeds 200 s, which covers inputs whose container states no duration (streamed WebM)"
  - "A video upload is accepted at complete only by format and duration; codec problems surface as status failed / transcode_failed from the slow lane and show 'Couldn't process this video' to both people"
  - "The voice play button shows a Spinner while the note is still uploading/processing and while buffering after Play, not before the first tap: iOS ignores preload, so waiting for canplay up front would spin forever"
  - "A finger released while the first-time permission prompt is up (or any tap under 300 ms) continues the recording in locked mode; a pointercancel during a hold also locks rather than losing the recording"
  - "In locked mode, Send ignores clicks for 400 ms after locking, so the click that ends a tap cannot land on the Send button that replaced the mic"
  - "formatDuration lives in @duet/shared (used by tiles, the recorder timer and voice bubbles, and unit-tested on the server)"

patterns-established:
  - "Media kinds plug into PROBE_GATES (uploads.ts) and the handler map (process.ts); nothing else changes"
  - "E2E tests that need to prove the mic is released instrument getUserMedia with page.addInitScript and assert every track ended"

requirements-completed: [MDIA-03, MDIA-04]

coverage:
  - id: D1
    description: "ffprobe gate (T-02-30): HLS and ffconcat files named like videos are refused by probeMedia; complete answers 422 unsupported_media without processing and deletes the bytes; a 210 s clip answers 422 too_long; FLAC and JPEG sent as voice answer 422 unsupported_media; video and audio accepted up to 200 MB, 413 above"
    requirement: MDIA-03
    verification:
      - kind: integration
        ref: "server/test/video.test.ts#probeMedia (T-02-30) + video uploads (MDIA-03, D-08)"
        status: pass
      - kind: integration
        ref: "server/test/voice.test.ts#audio uploads (D-11 backstop, T-02-30)"
        status: pass
    human_judgment: false
  - id: D2
    description: "Video transcode: a 1920x1080 clip with a 90-degree display matrix becomes a 720x1280 H.264 High / AAC stereo MP4 with no rotation side data, moov before mdat, a <=640 px portrait poster, durationMs within 100 ms; 10-bit HLG HEVC comes out bt709; zeroed media data fails with transcode_failed; original byte-identical; /media video Range 206 and poster served"
    requirement: MDIA-03
    verification:
      - kind: integration
        ref: "server/test/video.test.ts#processVideo through the slow lane (MDIA-03, D-08)"
        status: pass
      - kind: other
        ref: "docker compose exec -T duet node --import tsx server/scripts/media-selftest.ts (video ok: 720x1280 h264 bt709, moov@36 < mdat)"
        status: pass
    human_judgment: false
  - id: D3
    description: "Voice normalization: WebM/Opus without container duration and fragmented MP4/AAC become mono AAC .m4a with durationMs within 150 ms and 40 integer peaks 0..100; audio/mp4 with Accept-Ranges and 206"
    requirement: MDIA-04
    verification:
      - kind: integration
        ref: "server/test/voice.test.ts#processAudio through the fast lane (MDIA-04, D-12)"
        status: pass
      - kind: other
        ref: "container media-selftest (voice ok: aac 3008 ms, 40 peaks)"
        status: pass
    human_judgment: false
  - id: D4
    description: "Message kinds: image+video mix as kind media in order; one audio without body is kind voice; audio with an image, two audio notes, or audio with a caption are 400 bad_attachment"
    requirement: MDIA-04
    verification:
      - kind: integration
        ref: "server/test/video.test.ts#mixed albums (D-07); server/test/voice.test.ts#voice messages (MDIA-04)"
        status: pass
    human_judgment: false
  - id: D5
    description: "Video in the browser: picker accepts image/*,video/*; '1 video' / 'Send video'; the other browser sees 'Processing…' or the poster, then the poster from /media/ with its duration chip; the viewer's native video (controls, playsInline, paused, no autoplay) loads metadata from /media/"
    requirement: MDIA-03
    verification:
      - kind: e2e
        ref: "bash scripts/smoke-chat.sh photo video"
        status: pass
    human_judgment: false
  - id: D6
    description: "Voice in the browser: holding 'Record voice note' 2.5 s sends a note whose 'Seek voice note' slider carries a 1..4 s server duration and plays; slide-left cancel, too-short hold (toast), tap-to-lock discard and tap-to-lock send all work; every getUserMedia track has ended after each path (T-02-32)"
    requirement: MDIA-04
    verification:
      - kind: e2e
        ref: "bash scripts/smoke-chat.sh video voice"
        status: pass
    human_judgment: false
  - id: D7
    description: "Production at https://duet.brkn.me runs every Phase 2 feature: rebuilt and healthy, container self-test heic/video/voice/media-selftest ok, smoke-public ok, live-db ok, all 13 e2e scenarios (send..voice, a2hs, drawer) ok, server suite 280 passed / 1 skipped, typecheck, preset ok, no raw HTML rendering"
    verification:
      - kind: other
        ref: "bash scripts/smoke-chat.sh && SKIP_BUILD=1 SMOKE_SCRIPT=scripts/smoke-onboarding.mjs bash scripts/smoke-chat.sh && bash scripts/smoke-public.sh && bash scripts/check-live-db.sh --existing ./data"
        status: pass
    human_judgment: false
  - id: D8
    description: "End-of-phase device UAT on the installed iPhone and Pixel (one on cellular): text/typing/read/reactions/replies, offline and background catch-up, push incl. collapse and tap-through, HEIC and camera photos, a 10-item mixed album ('1 / 10'..'10 / 10', no autoplay, same scroll position on close), an iPhone HEVC HDR portrait .MOV upright with normal colours on the Pixel and a Pixel clip on the iPhone with seeking, hold/slide/lock/tap voice notes with waveform seeking and the iOS mic indicator turning off, and the iPhone keyboard keeping header and composer visible"
    verification: []
    human_judgment: true
    rationale: "Real iPhone HEVC/HDR clips, Safari's MediaRecorder (audio/mp4), touch gestures in the installed PWA, the iOS microphone indicator, push delivery and cellular networks can only be judged on the two phones"

duration: 30min
completed: 2026-10-13
status: complete
---

# Phase 2 Plan 05: Video Clips and Voice Notes Summary

**Video clips and voice notes now work end to end. An ffprobe allowlist gate means playlists never reach ffmpeg. Videos go through a slow-lane libx264 transcode with HLG/PQ tone-mapping, autorotation, faststart and a poster frame. Voice notes are normalized to AAC .m4a, with the duration and a 40-bar waveform computed on the server. On the client there are hold/slide/lock/tap recording that always releases the mic, and a scrubbable voice bubble. The whole phase is deployed to https://duet.brkn.me, and the container self-test proves HEIC, HDR video and Opus voice.**

## Performance

- **Duration:** about 30 min of active work. Started 2026-10-12T11:43Z. A rate limit cut the first run off before any edit; work resumed 2026-10-13 around 09:00Z and finished at 09:28Z.
- **Tasks:** 3 (Task 1 tracer, Task 2 TDD, Task 3 ship)
- **Files modified:** 25 (9 created, 16 modified)

## Accomplishments
- **Gate.**
  - `probeMedia` runs ffprobe with only the `file` protocol and only the allowlisted demuxers.
  - `POST /api/uploads/:id/complete` refuses anything else with 422 `unsupported_media`, and a clip over 200 s with 422 `too_long`. A refused upload is marked failed and its bytes are deleted.
  - Video and audio uploads open up to 200 MB.
- **Video.**
  - `processVideo` on the slow lane: H.264 High (veryfast, CRF 23) with AAC 128k stereo, at most 1280 px, yuv420p, autorotated, `+faststart`, and no container metadata.
  - HLG and PQ are tone-mapped to bt709 with zscale/tonemap.
  - `poster.jpg` is at most 640 px.
  - A failure stores `transcode_failed`.
- **Voice.**
  - `processAudio` on the fast lane makes AAC 64k mono `.m4a` with faststart.
  - `durationMs` comes from the output file.
  - 40 peaks are folded from streamed 8 kHz PCM.
  - One audio attachment with no body is message kind `voice`.
- **Client, video.**
  - The picker accepts `image/*,video/*`.
  - Pick-time checks drop videos over 200 MB or 3 minutes, with the UI-SPEC toasts.
  - Drawer video thumbnails show the camera icon and the duration. The labels read "1 video", "n videos" or "n items".
  - Album video tiles: the poster with a 40px play button and a duration chip; "Processing…"; "Couldn't process this video".
  - Viewer video slides: native controls, playsInline, preload metadata, poster, no autoplay. A clip pauses when you swipe away, and a failed load retries on tap.
- **Client, voice.**
  - The mic replaces Send while the field is empty.
  - Hold to record. Slide left 96 px to cancel (with a haptic). Slide up 64 px, or tap under 300 ms, to lock.
  - A hold of 300 ms to 1 s is discarded with "Too short…".
  - Locked mode shows discard and "Send voice note".
  - The timer runs m:ss, then h:mm:ss from one hour on.
  - A denied microphone shows the toast.
- **Voice bubble.**
  - Accent play/pause button.
  - The 40-bar SVG waveform is a `role="slider"` scrubber: pointer capture, arrows move 5 s, and `aria-valuetext` reads "0:12 of 0:42".
  - The duration shows the total while idle and the elapsed time once started.
  - Errors show "Couldn't load" and retry on tap.
  - Only one note or video plays at a time.
- **Shipped.**
  - Rebuilt and redeployed.
  - The container self-test prints `heic ok`, `video ok`, `voice ok` and `media-selftest ok`.
  - smoke-public, live-db, all 13 e2e scenarios, the 280-test server suite, typecheck and the preset check pass.
  - The README has a Media section.

## Task Commits

1. **Task 1: tracer, a video clip end to end** - `ede3913` (feat)
2. **Task 2: voice notes** - `d7e0daa` (test, RED), `4d595e7` (feat, GREEN)
3. **Task 3: self-test, README, deploy** - `8074711` (feat)

**Plan metadata:** the docs commit for this SUMMARY

## TDD Gate Compliance (Task 2)

- **RED** `d7e0daa`: `server/test/voice.test.ts`, 7 cases. All 7 failed for the intended reason: audio had no lane, so `POST /api/uploads {kind: "audio"}` answered 422. Five failures were "create upload returned 422", one was "expected 422 to be 200", and one was a 404 that followed from it.
- **GREEN** `4d595e7`:
  - Server: the audio lane, the audio gate and the voice rules in `sendMessage`. With them, 7/7 pass and the full suite has 280 passed and 1 skipped (the HEIC test on the host).
  - The client half is covered by the e2e scenario `voice`.
- **REFACTOR:** not needed.

## Files Created/Modified
- `shared/src/media.ts`: duration caps, waveform size, `formatDuration`
- `server/src/media/{probe,video,audio}.ts`: the gate and the two new processing lanes. `exec.ts` gets `onStdout`, and `process.ts` and `uploads.ts` get the wiring and the 422s.
- `server/src/chat/service.ts`: the `voice` kind and `bad_attachment` for audio mixes
- `server/scripts/media-selftest.ts`: video ok / voice ok, with exact `<name> ok` lines
- `server/test/{video,voice}.test.ts` (new); `uploads.test.ts` (video and audio now accepted)
- `web/lib/chat/{recorder,playback}.ts` (new); `store.ts` (`sendVoice`, `MediaEntry.voice`)
- `web/components/app/{recorder,voice-note}.tsx` (new); `composer`, `preview-drawer`, `album`, `viewer`, `message-row`, `chat-view`
- `scripts/smoke-chat.mjs`: scenarios `video` and `voice`
- `README.md`: the Media section

## Decisions Made
See `key-decisions` in the frontmatter.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 2 - Missing critical] ffprobe itself had to be fenced, not only ffmpeg**
- **Found during:** Task 1
- **Issue:** The plan allowlists `format_name` after probing. Probing an unknown file with every demuxer enabled already opens playlist demuxers (concat, HLS), which is the LFI the gate exists to prevent.
- **Fix:** ffprobe runs with `-protocol_whitelist file -format_whitelist mov,matroska,ogg,wav,mp3,aac`, and ffmpeg also gets `-protocol_whitelist file`. Any probe failure is `unsupported_media`.
- **Verification:** `video.test.ts` refuses an `#EXTM3U` and an ffconcat file (manually confirmed: "Format not on whitelist").
- **Committed in:** ede3913

**2. [Rule 2 - Missing critical / privacy] Transcodes drop container metadata**
- **Found during:** Task 1
- **Issue:** ffmpeg copies global metadata by default, and an iPhone .MOV carries the recording location.
- **Fix:** `-map_metadata -1` (plus `-map_chapters -1` for video). This matches what photos already do with EXIF and GPS.
- **Committed in:** ede3913 (video), 4d595e7 (audio)

**3. [Rule 1 - Bug] Container self-test lines did not match the plan's exact grep**
- **Found during:** Task 3
- **Issue:** 02-04's self-test printed `heic ok (display WxH)`. The plan counts exact lines `^heic ok$`, so the count would have been 3, not 4.
- **Fix:** Each check prints exactly `<name> ok`, with the details on an indented line after it.
- **Committed in:** 8074711

**4. [Rule 3 - Blocking] ffmpeg 5.1 has no `-display_rotation`**
- **Found during:** Task 3
- **Issue:** The container's ffmpeg 5.1.9 can't build the rotated fixture with the option the host tests use (ffmpeg 8).
- **Fix:** The self-test falls back to `-metadata:s:v:0 rotate=90`. In the container this produced a portrait 720x1280 output.
- **Committed in:** 8074711

**5. [Rule 1 - Bug] A tap-to-lock could send a near-empty note**
- **Found during:** Task 2
- **Issue:** When the mic opens before the finger lifts (permission already granted), the tap's trailing click can land on the "Send voice note" button that replaces the mic.
- **Fix:** A 400 ms guard after locking. The e2e covers both tap-to-lock discard and tap-to-lock send.
- **Committed in:** 4d595e7

**6. [Rule 3 - Blocking] One file outside the plan's list**
- **Found during:** Task 1
- **Issue:** Both the viewer's videos and the voice notes need the "one plays at a time" registry.
- **Fix:** Added `web/lib/chat/playback.ts` (claimPlayback / releasePlayback). `web/components/app/chat-view.tsx` (rows are built there, as in 02-04) carries `durationMs` and `voice`.
- **Committed in:** ede3913, 4d595e7

**7. [Coverage] The e2e proves the T-02-32 prohibition**
- **Found during:** Task 2
- **Issue:** The prohibition "MUST NOT leave the microphone open" is marked `verification: test`, but no planned test covered it.
- **Fix:** The voice scenario wraps `getUserMedia` through `addInitScript`. It asserts that every track has ended after send, slide-left cancel, a too-short hold, tap-lock discard and tap-lock send.
- **Committed in:** 4d595e7

---

**Total deviations:** 7. Breakdown: 2 missing critical (security/privacy), 2 bugs, 2 blocking, 1 coverage addition.
**Impact on plan:** No contract named in the plan changed. Every acceptance criterion holds as written.

## Issues Encountered
- Out of scope, not fixed: the existing react-hooks lint errors in `chat-view.tsx` (the ScrollFollower ref and `Date.now()` in render, from 02-01/02-02), as noted in 02-04. Every other file this plan created or edited lints clean.
- The app's existing files are not prettier-clean at the repo's `printWidth: 80`; the code uses about 120 columns. The new files were formatted at 120 columns to match. Existing files were not reformatted.
- A read-only `git stash list` was chained into a formatting check by mistake. It changed nothing (as in 02-04).
- Commits landed on `master` as dispatched, the same as every earlier plan (STATE decision 01-01).

## Known Stubs
None. The pending voice bubble's flat bars are the designed placeholder until the server's waveform arrives (D-12).

## User Setup Required
None.

## Next Phase Readiness
- Phase 2 is code-complete and live. What remains is the end-of-phase device UAT (coverage D8, plan Task 3 `<human-check>`, steps 1-7), together with the device checks still open from 02-01..02-04.
- **Flagged for the owner:**
  - Video and voice originals are kept, which is reversible. To reclaim space, delete `data/media/<id>/original` for ready video and audio attachments.
  - A clip of 180-200 s is accepted by the server but blocked by the 3-minute pick check.
  - A video without sound becomes a silent MP4.
  - A pending voice note lives only in memory. If iOS kills the app mid-upload, it is lost.
- Phase 3 (calls) can reuse `lib/chat/playback.ts` and the recorder's track-release pattern.

---
*Phase: 02-chat-media-push*
*Completed: 2026-10-13*

## Self-Check: PASSED

All 9 created files exist. Commits ede3913, d7e0daa, 4d595e7 and 8074711 are ancestors of HEAD. All acceptance criteria and plan-level verification were re-run after the deploy and pass.
