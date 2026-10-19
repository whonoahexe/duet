# Phase 3: Voice & Video Calls - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md. This log keeps the alternatives that were considered.

**Date:** 2026-10-15
**Phase:** 03-voice-video-calls
**Areas discussed:** Call screen & controls, Ringing & answering, Busy / decline / end states, Reconnect & failure

---

## Call screen & controls

| Question | Options | Selected |
|---|---|---|
| Call entry | Two header icons (rec) / One icon → choose / Composer button | Two header icons |
| Video layout | Full remote + PiP (rec) / Same + tap to swap / Split screen | Same + tap to swap |
| Voice → video | Camera toggle in any call (rec) / Voice stays voice | Camera toggle in any call |
| Voice look | Avatar + name + timer (rec) / Same + speaker toggle | Same + speaker toggle |
| Minimize | Minimize to call bar (rec) / Full-screen until hang-up | Minimize to call bar |
| Speaker where unsupported | Hide (rec) / Always show, best effort | Hide where unsupported |

## Ringing & answering

| Question | Options | Selected |
|---|---|---|
| Ring timeout | 45 s (rec) / 30 s / 60 s | 45 s |
| Foreground ring | Ringtone + vibrate + ringback (rec) / Ringtone only / Silent | Ringtone + vibrate + ringback |
| Push copy | "Name — Incoming video call" (rec) / "📞 Name is calling" | Name + Incoming voice/video call |
| Stale push tap | Chat + "Missed call" toast (rec) / Just open chat | Chat + toast |
| Multi-device | All ring, first wins (rec) / Assume one device | All ring, first wins |
| Ring cleanup | Replace with "Missed call" push (rec; pulls part of CALL-10) / Leave it | Replace with missed-call push |

## Busy / decline / end states

| Question | Options | Selected |
|---|---|---|
| Decline | "Declined" briefly (rec) / Generic "Unavailable" | "Declined" briefly |
| Glare | Auto-merge (rec) / Earlier wins | Auto-merge |
| End screen | "Call ended · m:ss" ~1.5 s (rec) / Close instantly | "Call ended · m:ss" |
| Unreachable callee | Ring until timeout (rec) / Fail fast | Ring until timeout |

## Reconnect & failure

| Question | Options | Selected |
|---|---|---|
| Give-up window | 30 s (rec) / 15 s / 60 s | 30 s |
| iOS background | Best effort + one-time tip (rec) / No tip | Best effort + tip |
| Failures | Clear message + action (rec) / Generic toast | Clear message + action |
| Quality | "Poor connection" only when bad (rec) / None | "Poor connection" when bad |

## Claude's Discretion

- Call-state protocol and server call registry, routing push taps to the call, ringtone generation, quality thresholds, auto-hide timing, glare with mismatched media kinds, what happens to `/debug/call`.

## Deferred Ideas

- Timeline call log / missed-call entries (CALL-10, v2). Native ringing (out of scope).
