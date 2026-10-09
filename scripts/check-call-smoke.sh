#!/usr/bin/env bash
# INFR-04 cellular gate: reads the deployed duet log for call-test reports (evt "call_smoke") and decides
# whether a real two-device call passed off the home network, in normal mode AND in forced-relay mode.
#
#   bash scripts/check-call-smoke.sh                      look back 24 h
#   SINCE=2h bash scripts/check-call-smoke.sh             shorter window
#   HOME_EGRESS_IP=<ip> bash scripts/check-call-smoke.sh  skip the Cloudflare trace lookup
#
# Per mode it needs ONE room whose pass=true reports come from at least two distinct clientIds, with at
# least one report from a client IP other than the home egress IP. In forced-relay mode every pass report
# in that room must also have localType "relay".
# Prints counts, rooms and candidate types only: never IP addresses or user agents. Last line: "call-smoke ok".
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
die() { echo "check-call-smoke: $*" >&2; exit 1; }

home_ip="${HOME_EGRESS_IP:-}"
if [ -z "$home_ip" ]; then
  home_ip="$(curl -fsS -m 10 https://www.cloudflare.com/cdn-cgi/trace | sed -n 's/^ip=//p' | tr -d '[:space:]')" || true
fi
[ -n "$home_ip" ] || die "could not determine the home egress IP (set HOME_EGRESS_IP)"

reports="$(docker compose logs --no-log-prefix --since "${SINCE:-24h}" duet 2>/dev/null \
  | jq -cR 'fromjson? | select(type == "object" and .evt == "call_smoke")' \
  | jq -cs '.')" || die "could not read the duet logs (is the compose stack running?)"

total="$(jq 'length' <<<"$reports")"
echo "call_smoke reports in window: $total"

# check MODE(false|true) -> prints a JSON verdict for that mode (no IPs in it).
check() {
  jq -c --argjson relay "$1" --arg home "$home_ip" '
    [ .[] | select(.forceRelay == $relay and .pass == true) ] as $pass
    | ($pass | group_by(.room)) as $rooms
    | [ $rooms[]
        | { room: .[0].room,
            time: (map(.time // 0) | max),
            clients: (map(.clientId) | unique | length),
            offHome: (map(select(.cfIp != $home)) | length > 0),
            allRelay: (all(.[]; .localType == "relay")),
            localTypes: (map(.localType // "unknown") | unique) } ] as $summary
    | ($summary | map(select(.clients >= 2))) as $two
    | ($two | map(select(.offHome))) as $off
    | ($off | map(select(($relay | not) or .allRelay))) as $ok
    | { passReports: ($pass | length),
        rooms: ($summary | length),
        roomsWithTwoClients: ($two | length),
        roomsOffHome: ($off | length),
        best: ($ok | sort_by(.time) | last) }' <<<"$reports"
}

fail=""
for mode in false true; do
  label="normal"; [ "$mode" = "true" ] && label="relay"
  res="$(check "$mode")"
  pass_n="$(jq '.passReports' <<<"$res")"
  rooms_n="$(jq '.rooms' <<<"$res")"
  two_n="$(jq '.roomsWithTwoClients' <<<"$res")"
  off_n="$(jq '.roomsOffHome' <<<"$res")"
  if jq -e '.best != null' <<<"$res" >/dev/null; then
    room="$(jq -r '.best.room' <<<"$res")"
    if [ "$mode" = "false" ]; then
      echo "call-smoke normal ok (room $room, local types $(jq -r '.best.localTypes | join(",")' <<<"$res"))"
    else
      echo "call-smoke relay ok (room $room)"
    fi
    continue
  fi
  echo "call-smoke $label: $pass_n PASS reports in $rooms_n rooms; $two_n with two clients; $off_n with a client off the home egress IP" >&2
  if [ "$pass_n" = "0" ]; then
    fail="$fail; $label mode: no PASS reports"
  elif [ "$two_n" = "0" ]; then
    fail="$fail; $label mode: no room has PASS reports from two distinct clients"
  elif [ "$off_n" = "0" ]; then
    fail="$fail; $label mode: no two-client room has a PASS report from off the home egress IP (cellular)"
  else
    fail="$fail; relay mode: a PASS report in every qualifying room has a local candidate other than relay"
  fi
done

[ -z "$fail" ] || die "INFR-04 gate not met${fail}"
echo "call-smoke ok"
