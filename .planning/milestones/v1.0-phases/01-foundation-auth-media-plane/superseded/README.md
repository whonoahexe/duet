# Superseded plans: do not execute

These were the original 01-04 (home SFU + coturn stack) and 01-05 (SFU join check + cellular smoke) plans.
On 2026-10-09 the home connection was confirmed to be CGNAT (ONT PPPoE WAN 172.18.28.128, egress
103.198.98.196, no public IPv6), so a home SFU is unreachable. The user chose to drop the SFU
entirely in favour of 1:1 peer-to-peer WebRTC with Cloudflare TURN (see 01-CONTEXT.md D-16).

They are kept only as history. The plan IDs 01-04 and 01-05 are free for the replanned
P2P + TURN media track. Nothing here is current: no ops/sfu stack, no sfu./turn.brkn.me
records, no @sideby-me/rtc SDK, no GitHub Packages build secret, no router changes.
