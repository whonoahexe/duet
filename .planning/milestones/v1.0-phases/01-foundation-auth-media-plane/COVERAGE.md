# API Coverage: Cloudflare Realtime TURN

> Full coverage by default. Every opt-out below is an explicit, reasoned decision.
> Scope: the media track (plans 01-04 and 01-05; D-16: 1:1 P2P WebRTC with Cloudflare TURN relay).
> Surfaces: the Cloudflare v4 account API (`api.cloudflare.com/client/v4/accounts/{account_id}/calls/turn_keys`,
> called only by `deploy/cloudflare/turn-key.sh` with the host-side account token) and the TURN credential API
> (`rtc.live.cloudflare.com/v1/turn/keys/{key_id}/credentials/...`, called by the duet server with the TURN key bearer).

| capability | decision | reason |
|---|---|---|
| turn_keys.create (POST /accounts/{id}/calls/turn_keys) | INTEGRATE | |
| turn_keys.list (GET /accounts/{id}/calls/turn_keys) | INTEGRATE | |
| turn_keys.delete (DELETE /accounts/{id}/calls/turn_keys/{key_id}) | INTEGRATE | |
| turn_keys.get (GET /accounts/{id}/calls/turn_keys/{key_id}) | OPT-OUT | not needed: list already returns uid and name, and get cannot return the bearer either |
| turn_keys.update (PUT /accounts/{id}/calls/turn_keys/{key_id}) | OPT-OUT | not needed: the only mutable field is the name, which is fixed to "duet" |
| credentials.generate-ice-servers (POST .../credentials/generate-ice-servers) | INTEGRATE | |
| credentials.generate-ice-servers ttl parameter | INTEGRATE | |
| stun.cloudflare.com:3478 (STUN entry of the minted iceServers) | INTEGRATE | |
| turn/turns transports (udp 3478 and 443, tcp 3478 and 80, tls 5349 and 443) | INTEGRATE | |
| port-53 TURN URLs | OPT-OUT | browsers block port 53 (Cloudflare's own guidance); filtered server-side in mintIceServers |
| credentials.generate (POST .../credentials/generate, legacy shape) | OPT-OUT | not needed: generate-ice-servers mints the same credential in the browser-ready iceServers array |
| credentials.revoke (POST .../credentials/{username}/revoke) | OPT-OUT | not needed yet: credentials expire with their TTL (default 24 h); Phase 3 may revoke on hang-up or logout |
| customIdentifier (per-user analytics tag on minted credentials) | OPT-OUT | not needed: two users; per-user TURN analytics have no consumer |
| TURN usage analytics (GraphQL Analytics API) | OPT-OUT | not needed yet: the 1,000 GB/month free tier dwarfs two people's usage; Phase 3 may add a usage check |
| Realtime SFU apps (/accounts/{id}/calls/apps, /v1/apps) | OPT-OUT | explicitly out of scope: D-16 is peer-to-peer with TURN relay only, no SFU |
| Account billing / plan settings | OPT-OUT | explicitly out of scope: never changed by automation; a billing error stops at a user decision (01-04 Task 1) |
