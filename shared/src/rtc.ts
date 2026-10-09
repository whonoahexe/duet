import { z } from "zod"

/** One RTCIceServer entry as handed to `new RTCPeerConnection({ iceServers })`. */
export const IceServer = z.object({
  urls: z.array(z.string()).min(1),
  username: z.string().optional(),
  credential: z.string().optional(),
})
export type IceServer = z.infer<typeof IceServer>

/**
 * POST /api/rtc/ice-servers: Cloudflare TURN credentials minted for the logged-in user (INFR-03).
 * Always holds at least one turn:/turns: entry; the server never answers with a STUN-only list.
 */
export const IceServersResponse = z.object({
  iceServers: z.array(IceServer).min(1),
  ttlSeconds: z.number().int().positive(),
})
export type IceServersResponse = z.infer<typeof IceServersResponse>
