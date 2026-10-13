---
phase: 02-chat-media-push
review: 02-REVIEW.md
updated: 2026-10-13T09:39:20Z
---

# Phase 02 Code Review Disposition

open: 13 of 13 (critical 0, warning 6, info 7)

| ID | Severity | Title | Disposition |
|----|----------|-------|-------------|
| WR-01 | warning | A permanently rejected text message gets stuck in the outbox and can never be removed | open |
| WR-02 | warning | An album or voice note whose attachment failed before the send can never be sent | open |
| WR-03 | warning | Your own album or voice note is shown twice, and can show "Not sent" after it was delivered | open |
| WR-04 | warning | No request timeouts, so one stalled request blocks every text send or wedges an album | open |
| WR-05 | warning | A probe timeout or missing ffprobe during upload completion returns 500 and leaves the upload stuck | open |
| WR-06 | warning | Orphaned attachments and media files are never cleaned up | open |
| IN-01 | info | The video duration cap is applied only after a full transcode when the container has no duration | open |
| IN-02 | info | Shutdown waits for a running transcode instead of stopping it | open |
| IN-03 | info | A failed voice note's retry button can never succeed | open |
| IN-04 | info | Quote thumbnails have no load-error fallback | open |
| IN-05 | info | Duplicated helpers | open |
| IN-06 | info | Unused `Geist` import | open |
| IN-07 | info | The media self-test leaks its temp dir on failure | open |
