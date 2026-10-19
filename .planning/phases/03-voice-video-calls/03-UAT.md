---
status: complete
phase: 03-voice-video-calls
source: [03-VERIFICATION.md]
started: 2026-10-19T07:21:34Z
updated: 2026-10-19T08:27:01Z
---

## Current Test

number: 1
name: CR-01 caller iPhone locked while ringing
expected: |
  Call connects or resumes after accept; never ends as "cancelled"/"Missed call".
awaiting: none (user approved all 8 on 2026-10-19)

## Tests

### 1. CR-01 — lock caller's iPhone while ringing, accept on the other phone
expected: call connects/resumes; never "cancelled" + "Missed call"
result: pass

### 2. WR-06 — log out mid-call
expected: other phone shows "Call ended" immediately; iPhone mic indicator turns off
result: pass

### 3. WR-03 — hang up during "Connecting…"
expected: both show "Call ended · 0:00", not "Couldn't connect"
result: pass

### 4. WR-04 — cancel vs timeout with callee app open
expected: cancel → no toast; 45 s timeout → "Missed call from …" with Call back
result: pass

### 5. WR-01 — accept on two of Bob's devices at once
expected: loser shows "Answered on another device", mic off
result: pass

### 6. WR-05 — both start a call at the same moment
expected: calls merge into one
result: pass

### 7. WR-08 — callee setup fails after Accept
expected: caller sees "Couldn't connect" + Retry, not "Declined"
result: pass

### 8. Timer past one hour
expected: "1:02:09" on one line, no layout shift
result: pass

## Summary

total: 8
passed: 8
issues: 0
pending: 0
skipped: 0
blocked: 0

## Gaps
