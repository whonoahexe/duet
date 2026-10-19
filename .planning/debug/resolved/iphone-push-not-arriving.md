---
status: resolved
trigger: "notifications are not working on iphone but pass on android"
created: 2026-10-14T00:00:00Z
updated: 2026-10-19T00:00:00Z
goal: find_root_cause_only
symptoms_prefilled: true
---

## Current Focus

hypothesis: web.push.apple.com rejects every duet push with 400 {"reason":"BadWebPushTopic"} because sender.ts always sends an RFC 8030 Topic header (duet-chat / duet-test), and Apple's service has refused any Topic header since ~mid-September 2026. FCM accepts the same header, so Android works.
test: (for the fix plan) log WebPushError.body on push_failed, then send a test push from the iPhone: expect reason BadWebPushTopic before the fix and 201 + a visible notification after dropping `topic`
expecting: BadWebPushTopic confirms; any other reason (e.g. VapidPkHashMismatch, BadWebPushRequest) means a second cause is in play
next_action: hand diagnosis to gap-closure planning (goal find_root_cause_only; no fix applied)
bug_class: bohrbug  # deterministic: 100% of Apple sends 400 (test + chat, ~25 in a row, several re-subscriptions), 0% of FCM sends fail
reasoning_checkpoint:
  hypothesis: "Apple returns 400 for every duet push because every request carries a Topic header (web-push option topic: duet-chat / duet-test, set unconditionally in sender.ts sendOne), and web.push.apple.com has answered any Topic header with 400 BadWebPushTopic since ~mid-Sep 2026 regardless of value"
  confirming_evidence:
    - "docker logs: every web.push.apple.com send -> push_failed code 400 (test pushes and all message pushes), never 403/410/413; every FCM send ok"
    - "push_subscriptions: the iPhone row (web.push.apple.com) has last_ok_at NULL; FCM row has last_ok_at set"
    - "generateRequestDetails: Topic: duet-chat is the only non-baseline header besides Urgency/TTL; JWT aud/exp/sub comply (a JWT fault would be 403 BadJwtToken)"
    - "sender.ts passes topic on BOTH notifyMessage (PUSH_TOPIC_CHAT) and sendTest (PUSH_TOPIC_TEST): no duet push to Apple has ever been sent without Topic"
    - "3 independent projects (Ruchoir#62 merged 2026-09-24 with Apple's reason logged; kukuroo#9 2026-09-25 topic 'daily'; Elarion#166 merged 2026-09-30) observed 400 BadWebPushTopic for ANY Topic value on web.push.apple.com, and the same send without Topic delivered"
  falsification_test: "With the reason body logged, an iPhone test push returns a reason other than BadWebPushTopic, OR a push to the iPhone endpoint with no Topic header still returns 400"
  fix_rationale: "Not applied (diagnose-only). Dropping the Topic header removes the only request element that Apple rejects; the D-14 collapse still happens on-device through the SW's close-before-show, and the title already carries the unread count"
  blind_spots: "Apple's reason string for duet's own requests was NOT observed directly: sending to the real iPhone endpoint outside the app's /api/push/test was out of scope, and the app logs only the status code. A fake-token probe cannot reach header validation (Apple answers BadDeviceToken first). After Topic is removed, a latent second Apple-only issue (e.g. A9 per-send JWT refresh > 1/hour, which Apple's doc discourages) could surface; that would show as a different reason/status"
  candidate_causes:
    - "code: Topic header always sent (sender.ts sendOne topic) -> BadWebPushTopic [CONFIRMED by elimination + external evidence]"
    - "environment: Apple push service behaviour change (~mid-Sep 2026) rejecting any Topic header, contrary to its own docs and RFC 8030 [CONFIRMED external, co-cause]"
    - "config: VAPID_SUBJECT shape / key pair mismatch [ELIMINATED]"
    - "data: endpoint or subscription keys corrupted in storage (BadDeviceToken / BadWebPushRequest) [ELIMINATED]"
    - "code: Urgency 'high' / TTL 86400 invalid (BadUrgency / BadTtl) [ELIMINATED: values are in Apple's allowed set; no external reports since 2022]"
  and_gate: "yes: requires (a) duet sending a Topic header on every push AND (b) Apple's service rejecting Topic. FCM tolerates (a); Apple accepts pushes without (a). Both causes recorded"
tdd_checkpoint: null

## Symptoms

expected: The in-app guide steps match Safari's Add to Home Screen flow. Enable -> Allow -> a test push arrives. With duet closed, new messages raise a notification on both the iPhone and the Pixel. Several messages collapse into a single '{name} · n new messages' notification. Tapping it opens the chat. While actively viewing the chat, no notification appears.
actual: "notifications are not working on iphone but pass on android" (user, verbatim)
errors: none reported by the user
reproduction: Test 7 in .planning/phases/02-chat-media-push/02-UAT.md
started: discovered during end-of-phase device UAT on 2026-10-13; Android Chrome push works end to end

## Eliminated

- hypothesis: iPhone never subscribes (A2HS/permission/client flow broken on iOS)
  evidence: 5 push_subscribed events from web.push.apple.com for Puri (11:32Z-16:45Z) and a stored web.push.apple.com row bound to the iPhone session; the server attempts every send
  timestamp: 2026-10-14T00:06Z

- hypothesis: service worker fails to show the notification on iOS (tag/renotify/getNotifications quirk)
  evidence: Apple rejects the HTTP request with 400 before anything is delivered, so the SW push handler is never invoked on the iPhone
  timestamp: 2026-10-14T00:06Z

- hypothesis: VAPID JWT rejected (subject/aud/exp/wrong key)
  evidence: those are 403 BadJwtToken per Apple's doc; observed status is 400. Subject is https://duet.brkn.me, aud https://web.push.apple.com, exp +12h; FCM accepts the same key pair
  timestamp: 2026-10-14T00:10Z

- hypothesis: VapidPkHashMismatch (iPhone subscribed with a different applicationServerKey)
  evidence: client subscribes with the key from /api/push/vapid-public-key = config.VAPID_PUBLIC_KEY, the same key web-push puts in k=; no key rotation since 02-03 (FCM works with it); no pre-existing Apple subscription before 2026-10-13
  timestamp: 2026-10-14T00:14Z

- hypothesis: endpoint/keys corrupted in storage (BadDeviceToken / BadWebPushRequest)
  evidence: endpoint is a single base64url segment (171 chars, starts 'Q'), no query/whitespace; p256dh 65 bytes 0x04; auth 16 bytes; zod schema does not transform the endpoint
  timestamp: 2026-10-14T00:18Z

- hypothesis: payload too large / empty payload
  evidence: payload is capped at 3072 bytes JSON (413 would be returned, not 400); every push carries a body (Ruchoir's empty-body 400 does not apply)
  timestamp: 2026-10-14T00:20Z

## Evidence

- timestamp: 2026-10-14T00:05Z
  checked: live DB push_subscriptions (read-only)
  found: 2 rows. Noah (98dba257) fcm.googleapis.com, last_ok_at 2026-10-13T12:07:27Z. Puri (a1403894) web.push.apple.com, session 51e5e072 (iPhone OS 18_7 Safari UA), created 2026-10-13T16:45:47Z, last_ok_at NULL
  implication: the iPhone DOES subscribe and the server stores it; no Apple send has ever succeeded

- timestamp: 2026-10-14T00:06Z
  checked: docker logs duet-duet-1, all push_* events
  found: every send to web.push.apple.com (test pushes + ~25 message pushes, 11:32Z-12:07Z) -> push_failed code 400, pruned false; push_test sent 0. Every FCM send ok 1. No 403, no 410, no 413
  implication: Apple rejects the request itself (400 = bad request reason), not auth (403) or token expiry (410). Client/SW side is not reached at all

- timestamp: 2026-10-14T00:08Z
  checked: VAPID config shape inside container + web-push 3.6.7 generateRequestDetails (throwaway keys, fake endpoint, no network)
  found: VAPID_SUBJECT=https://duet.brkn.me (https, no trailing slash/ws), pub key 87 chars, priv 43. Request headers TTL 86400, Content-Encoding aes128gcm, Urgency high, Topic duet-chat, Authorization vapid t=..,k=..; JWT aud https://web.push.apple.com, exp now+12h, sub https URL
  implication: JWT claims comply with Apple rules (and a JWT problem would be 403 BadJwtToken, not 400)

- timestamp: 2026-10-14T00:10Z
  checked: Apple doc "Sending web push notifications in web apps and browsers" (.md)
  found: 400 reasons: BadTtl, BadUrgency, BadWebPushRequest, BadWebPushTopic, VapidPkHashMismatch, BadAuthorizationHeader, BadVapidPublicKey, BadPath. BadJwtToken is under 403. Topic rule: "max 32 characters from the URL or filename-safe Base64 character sets". sender.ts logs only status code, so Apple's JSON reason body is discarded
  implication: candidate set for the 400 is narrowed to header/encryption/key-hash problems; need Apple's reason string to discriminate

- timestamp: 2026-10-14T00:14Z
  checked: web/lib/chat/push.ts enablePush/syncSubscription
  found: applicationServerKey = base64url-decoded server key fetched from /api/push/vapid-public-key (same config value web-push signs with); subscription saved verbatim via sub.toJSON()
  implication: VapidPkHashMismatch unlikely (key pair consistent: FCM accepts the same JWT/k)

- timestamp: 2026-10-14T00:16Z
  checked: probe of web.push.apple.com from inside the container with a FABRICATED token + throwaway VAPID/subscription keys (no secrets, no real device), header variants prod/noTopic/topicNoHyphen/noUrgency/TTL-only
  found: all variants -> 400 {"reason":"BadDeviceToken"}
  implication: Apple validates the device token before headers, so a fake-token probe cannot discriminate header reasons. Also: BadDeviceToken is itself a 400 reason (not in the web-push doc list)

- timestamp: 2026-10-14T00:18Z
  checked: shape of the stored Apple endpoint and keys (no values printed)
  found: path is one segment, 171 chars, base64url charset (alnum + 7 '_' + 5 '-'), starts 'Q' like real Apple tokens; p256dh 65 bytes 0x04 prefix; auth 16 bytes
  implication: endpoint/keys are not mangled in transit or storage; BadDeviceToken from corruption is unlikely

- timestamp: 2026-10-14T00:25Z
  checked: web search + gh pr view of Ruchoir/ruchoir#62 (merged 2026-09-24), saiday/kukuroo#9 (2026-09-25), swimmesberger/Elarion#166 (merged 2026-09-30)
  found: all three independently report web.push.apple.com answering ANY request with a Topic header with 400 {"reason":"BadWebPushTopic"}, for short RFC-conforming values ("daily"); Ruchoir found it by logging Apple's response body; Elarion: "the same send without a Topic header was delivered"; "since mid-September 2026". Apple's doc still lists Topic as allowed
  implication: Apple-side behaviour change makes duet's unconditional Topic header fatal on iOS only; matches 400-on-every-send exactly

- timestamp: 2026-10-14T00:28Z
  checked: grep topic in server/src, shared/src, server/test, phase research
  found: shared/src/push.ts PUSH_TOPIC_CHAT="duet-chat", PUSH_TOPIC_TEST="duet-test"; sender.ts sendOne always passes `topic` (notifyMessage + sendTest); push.test.ts:105 and :266 assert the topic is present; 02-RESEARCH.md:514 adopted Topic for Apple coalescing based on Apple docs/RFC
  implication: no duet push to Apple has ever been sent without Topic, so the test push (Enable -> test) fails the same way as message pushes; unit tests mock webPushSend, so no test could see Apple's response

- timestamp: 2026-10-14T00:30Z
  checked: sender.ts sendOne catch block
  found: logs only statusCode + host; WebPushError.body (Apple's JSON reason) is discarded
  implication: observability gap that hid the reason string; it is why the 400 was not self-explanatory during UAT

- timestamp: 2026-10-14T00:32Z
  checked: web/lib/chat/push.ts sendTestPush
  found: sent 0 -> toast "Couldn't send the test. Check your connection and try again."
  implication: secondary UX issue: the iPhone user was told to check the connection when the real failure was a push-service refusal

## Resolution

root_cause: "Two causes together. (1) Code: server/src/push/sender.ts sendOne sends every Web Push with the RFC 8030 `topic` option (PUSH_TOPIC_CHAT 'duet-chat' for messages, PUSH_TOPIC_TEST 'duet-test' for the test push, both from shared/src/push.ts), so every request has a `Topic:` header. (2) Environment: since ~mid-September 2026, web.push.apple.com answers any request carrying a Topic header with 400 {\"reason\":\"BadWebPushTopic\"}, whatever the value. That contradicts its own docs, and three independent projects confirm it. FCM accepts the header, so the Pixel works. All ~25 iPhone sends on 2026-10-13, test pushes included, got 400 and the iPhone subscription never recorded a success (last_ok_at NULL). Contributing gap: push_failed logs only the status code and discards WebPushError.body, which would have named the reason."
fix: "not applied (goal: find_root_cause_only)"
verification: "not applied"
oracle_type:
files_changed: []
