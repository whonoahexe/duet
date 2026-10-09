import { z } from "zod"
import type { IceServer, IceServersResponse } from "@duet/shared"

/** What Cloudflare's generate-ice-servers answers; validated before anything reaches a client. */
const CfIceServers = z.object({
  iceServers: z
    .array(
      z.object({
        urls: z.union([z.string(), z.array(z.string())]),
        username: z.string().optional(),
        credential: z.string().optional(),
      }),
    )
    .min(1),
})

export type TurnErrorCode = "turn_unconfigured" | "turn_unavailable"

export class TurnError extends Error {
  override name = "TurnError"
  constructor(readonly code: TurnErrorCode) {
    super(code)
  }
}

export interface TurnDeps {
  fetch: typeof fetch
  apiBase: string
  keyId?: string
  apiToken?: string
  ttlSeconds: number
  timeoutMs: number
}

/** Pitfall M5: browsers block port 53, so a ":53" URL only stalls ICE gathering. ":5349" survives. */
const PORT_53 = /:53(\?|$)/

const isTurnUrl = (url: string) => url.startsWith("turn:") || url.startsWith("turns:")

/**
 * Mint short-lived Cloudflare TURN credentials (D-16, INFR-03).
 * Never returns a STUN-only list (Pitfall M3): a missing key is turn_unconfigured, and any
 * Cloudflare failure, timeout or unexpected body is turn_unavailable.
 */
export async function mintIceServers(deps: TurnDeps): Promise<IceServersResponse> {
  if (!deps.keyId || !deps.apiToken) {
    throw new TurnError("turn_unconfigured")
  }

  const url = `${deps.apiBase.replace(/\/+$/, "")}/v1/turn/keys/${encodeURIComponent(deps.keyId)}/credentials/generate-ice-servers`
  let body: unknown
  try {
    const res = await deps.fetch(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${deps.apiToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ ttl: deps.ttlSeconds }),
      signal: AbortSignal.timeout(deps.timeoutMs),
    })
    if (!res.ok) {
      throw new TurnError("turn_unavailable")
    }
    body = await res.json()
  } catch {
    // fetch rejected, aborted (timeout), non-2xx, or the body was not JSON.
    throw new TurnError("turn_unavailable")
  }

  const parsed = CfIceServers.safeParse(body)
  if (!parsed.success) {
    throw new TurnError("turn_unavailable")
  }

  const iceServers: IceServer[] = []
  for (const entry of parsed.data.iceServers) {
    const urls = (Array.isArray(entry.urls) ? entry.urls : [entry.urls]).filter((u) => !PORT_53.test(u))
    if (urls.length === 0) continue
    const server: IceServer = { urls }
    if (entry.username !== undefined) server.username = entry.username
    if (entry.credential !== undefined) server.credential = entry.credential
    iceServers.push(server)
  }

  if (!iceServers.some((s) => s.urls.some(isTurnUrl))) {
    throw new TurnError("turn_unavailable")
  }

  return { iceServers, ttlSeconds: deps.ttlSeconds }
}
