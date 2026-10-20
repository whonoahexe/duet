---
date: "2026-10-20 04:02"
promoted: true
---

Sound effects. Decided: all of these — message sent "pop"; message received chime while the chat is open (not on every message during rapid back-and-forth); call connected blip; call ended / dropped tone; reaction tick; voice-note record start/stop clicks; reminder chime and missed-call sound (once the reminders and calls-in-chat notes land). Decided: synthesised with WebAudio in code, same approach as web/lib/call/tones.ts (no asset files, no licences) — reuse its AudioContext/unlockAudio rather than a second context. Suggested: a Sounds on/off toggle in the ⋮ menu. Limits: iPhone silent switch mutes web audio; sounds only play while duet is open (closed app → OS default notification sound, web push can't set a custom sound); audio only after the first tap in a session, so the first incoming message after opening may be silent.
