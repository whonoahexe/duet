# Phase 2: Chat, Media & Push - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md. This log keeps the alternatives that were considered.

**Date:** 2026-10-10
**Phase:** 02-chat-media-push
**Areas discussed:** Chat feel & gestures, Sending photos & videos, Voice notes, Push & onboarding

---

## Chat feel & gestures

| Question | Options | Selected |
|---|---|---|
| React/reply gesture | Both (swipe reply + long-press menu) / Long-press only / Double-tap ❤️ + long-press | Both |
| Read receipts | Under last message (iMessage) / Ticks on every bubble | Under last message |
| Timestamps | Day separators + gap times / Time on every bubble / You decide | You decide |
| Reactions | Fixed six ❤️😂😮😢👍🔥 / Fixed six + more | Other: fixed 6 = 💕💔😋😝😘😭 |

## Sending photos & videos

| Question | Options | Selected |
|---|---|---|
| After picking | Preview + optional caption / Send immediately | Preview + caption |
| Multiple at once | Up to ~10 as separate messages / One at a time / Album grid | Album grid |
| Album contents | Up to 10 mixed / Up to 10 photos only | Up to 10 mixed |
| Video cap | ~3 min/200 MB / ~1 min/100 MB / ~1 GB | ~3 min/200 MB |
| Attach UI | One + button → OS picker / Separate camera + gallery | One + button |
| Photo quality | Original + display copy / Resize to ~2048px | Original + display copy |

## Voice notes

| Question | Options | Selected |
|---|---|---|
| Record gesture | Tap start/stop / Hold-to-record / Both | Both |
| Max length | 5 min / 15 min / No limit | No limit |
| Playback | Waveform scrubber / Plain slider | Waveform scrubber |

**Notes:** No length limit, but the server upload size cap stays as a backstop.

## Push & onboarding

| Question | Options | Selected |
|---|---|---|
| Notification content | Name + text / Name only | Name + text |
| Stacking | One notification, updated / One per message | One, updated |
| Onboarding | Until done, both phones / iPhone only, once | Until done, both phones |

## Claude's Discretion

- Timestamp style, typing indicator look, Enter-to-send, bubble grouping, offline queue UX, transcode presets, image and thumbnail sizes, presence tracking for NOTF-03, and onboarding copy.

## Deferred Ideas

- Voice note extras (playback speed, auto-play of the next note, a played indicator).
