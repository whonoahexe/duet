---
status: testing
phase: 03-voice-video-calls
source: [03-VERIFICATION.md]
started: 2026-10-19T07:21:34Z
updated: 2026-10-19T07:21:34Z
---

## Current Test

number: 1
name: CR-01 caller iPhone locked while ringing
expected: |
  Call connects or resumes after accept; never ends as "cancelled"/"Missed call".
awaiting: user response

## Tests

### 1. CR-01 — lock caller's iPhone while ringing, accept on the other phone
expected: call connects/resumes; never "cancelled" + "Missed call"
result: [pending]

### 2. WR-06 — log out mid-call
expected: other phone shows "Call ended" immediately; iPhone mic indicator turns off
result: [pending]

### 3. WR-03 — hang up during "Connecting…"
expected: both show "Call ended · 0:00", not "Couldn't connect"
result: [pending]

### 4. WR-04 — cancel vs timeout with callee app open
expected: cancel → no toast; 45 s timeout → "Missed call from …" with Call back
result: [pending]

### 5. WR-01 — accept on two of Bob's devices at once
expected: loser shows "Answered on another device", mic off
result: [pending]

### 6. WR-05 — both start a call at the same moment
expected: calls merge into one
result: [pending]

### 7. WR-08 — callee setup fails after Accept
expected: caller sees "Couldn't connect" + Retry, not "Declined"
result: [pending]

### 8. Timer past one hour
expected: "1:02:09" on one line, no layout shift
result: [pending]

## Summary

total: 8
passed: 0
issues: 0
pending: 8
skipped: 0
blocked: 0

## Gaps
