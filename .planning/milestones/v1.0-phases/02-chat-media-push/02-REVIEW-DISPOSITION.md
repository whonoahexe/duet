---
phase: 02-chat-media-push
review: 02-REVIEW.md
updated: 2026-10-15T14:50:00Z
---

# Phase 02 Code Review Disposition

open: 20 of 20 (critical 0, warning 9, info 11)

## Incremental review: plan 02-06 (diff 5cf446e..HEAD, current 02-REVIEW.md)

| ID | Severity | Title | Disposition |
|----|----------|-------|-------------|
| 06/WR-01 | warning | `pushFailureReason` redaction misses query-string tokens (WNS) and skips redaction on the identifier fast path | open |
| 06/WR-02 | warning | Test-push catch-all toast blames the connection for 503, 429 and 401 responses | open |
| 06/WR-03 | warning | The sent-0 toast's advice ("Reopen duet") cannot recover a pruned subscription | open |
| 06/IN-01 | info | Composer asks for a scroll even when the store silently drops the send | open |
| 06/IN-02 | info | Network-level push failures (`code: 0`) still log no cause | open |
| 06/IN-03 | info | The sanitizer keeps bidi overrides and C1 controls | open |
| 06/IN-04 | info | The blanket topic removal also drops FCM coalescing | open |

## Prior full-phase review (report at 5cf446e, superseded in git history)

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
