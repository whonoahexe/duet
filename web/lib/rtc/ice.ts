import { IceServersResponse } from "@duet/shared"
import { apiPost } from "@/lib/api"

/**
 * Fresh Cloudflare TURN credentials for the logged-in user (INFR-03). A 401, 502 or 503 surfaces
 * as ApiError: there is deliberately no fallback ICE list (Pitfall M3, never STUN-only).
 */
export function fetchIceServers(): Promise<IceServersResponse> {
  return apiPost("/api/rtc/ice-servers", {}, IceServersResponse)
}
