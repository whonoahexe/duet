---
date: "2026-10-20 03:55"
promoted: true
---

Show calls in the chat history (like WhatsApp). Today calls leave no trace in the chat — the end only goes to the server log (calls/registry.ts call_end: callId, caller, callee, kind, reason, durationMs). Want: when a call ends, the server inserts a "call" message (new kind in the messages table enum + migration) so it syncs to both phones like any message. Rendered as a centred system line, not a bubble: "📞 Voice call · 3:44" / "🎥 Video call · 12:05"; not answered → caller sees "No answer", the other side sees "Missed voice call" (highlighted); "Declined"; "Call dropped · 1:20". Tap the line to call back (same kind). Missed calls count as unread. Glare-merged calls produce one line. Batch with reminders — same centred system-line design.
