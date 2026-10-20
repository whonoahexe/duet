---
created: 2026-10-20T12:09:13.550Z
title: Add synthesised sound effects
area: ui
severity: cosmetic
order: 6
files:
  - web/lib/call/tones.ts
notes:
  - .planning/notes/2026-10-20-sound-effects.md
---

## Problem

The only sounds are the call ringback/ringtone; sending, receiving, reactions, call connect/end and recording are silent.

## Solution

WebAudio-synthesised sounds reusing tones.ts's AudioContext/unlockAudio: send pop, receive chime while the chat is open (throttled during rapid back-and-forth), call connected / ended / dropped, reaction tick, voice-note record start/stop, reminder chime and missed-call sound (after the calls/reminders todo). Sounds on/off toggle in the ⋮ menu. Limits: iPhone silent switch mutes it; nothing when duet is closed; audio only after the first tap.
