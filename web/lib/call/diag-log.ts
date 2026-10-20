"use client"

import {
  CALL_DIAG_MAX_EVENTS,
  CallDiagEnv,
  CallDiagEvent,
  CallDiagGumName,
  CallDiagNetworkType,
  CandidateType,
  RelayProtocol,
  type CallDiagBatch,
} from "@duet/shared"
import { isIos, isStandalone } from "@/lib/platform"
import type { CallSample, VideoStat } from "@/lib/rtc/stats"

/**
 * This phone's log of a call (quick task 261020-oj7). On 2026-10-20 three calls in eight minutes
 * ended in a hangup and an immediate redial, and nothing said who hung up, whether media went
 * peer-to-peer or through the relay, or when ICE failed. The call path hands its events here; they
 * are batched to POST /api/calls/diag and land in the server log as call_diag lines under the callId,
 * next to the server's own lines for the same call.
 *
 * Privacy: only values of the shared CallDiagEvent/CallDiagEnv schemas leave this module (enums,
 * bounded ints, booleans and the callId). Every event is validated before it is buffered, and the UA
 * string is reduced to enums and ints here and never sent.
 *
 * Never blocks or breaks a call: every export swallows its errors, nothing is awaited by the call
 * path, the buffer is bounded (the oldest entries are dropped) and a failed post is silent.
 * Nothing touches window, document or navigator at module top level (the static export prerenders).
 */

type DistOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never
type PhaseEvent = Extract<CallDiagEvent, { k: "phase" }>

/** An event as the call path logs it: no `at` (stamped here), and a phase without `ms` (filled here). */
export type CallLogEvent = DistOmit<Exclude<CallDiagEvent, { k: "phase" }>, "at"> | Pick<PhaseEvent, "k" | "phase">

type Role = CallDiagBatch["role"]

interface Entry {
  callId: string
  role: Role
  event: CallDiagEvent
}

/** Buffer cap across calls; when full the oldest entry goes. */
const MAX_BUFFER = 300
const FLUSH_EVERY_MS = 10_000
/** Leftovers of ended calls are discarded this long after the last endCallLog. */
const DISCARD_AFTER_MS = 120_000
const ENDPOINT = "/api/calls/diag"

let active: { callId: string; role: Role; startedAt: number } | null = null
let buffer: Entry[] = []
const seqs = new Map<string, number>()
const drops = new Map<string, number>()
let inFlight = 0
let timer: ReturnType<typeof setInterval> | null = null
let discardAt: number | null = null
let listening = false
let env: CallDiagEnv | null = null

function countDrop(callId: string): void {
  drops.set(callId, (drops.get(callId) ?? 0) + 1)
}

function push(entry: Entry): void {
  buffer.push(entry)
  while (buffer.length > MAX_BUFFER) {
    const old = buffer.shift()!
    countDrop(old.callId)
  }
}

function clampInt(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.round(value)))
}

/** Start the log of call `callId` on this phone (a different active call's log is ended first). */
export function startCallLog(callId: string, role: Role): void {
  try {
    if (active?.callId === callId) return
    if (active) endCallLog()
    active = { callId, role, startedAt: performance.now() }
    discardAt = null
    resetSample()
    listen()
    ensureTimer()
  } catch {
    // never break a call
  }
}

/** Log one event to the active call's log; a no-op without one. */
export function callLog(input: CallLogEvent): void {
  try {
    if (!active) return
    const at = Date.now()
    const raw =
      input.k === "phase"
        ? { ...input, at, ms: clampInt(performance.now() - active.startedAt, 0, 86_400_000) }
        : { ...input, at }
    const parsed = CallDiagEvent.safeParse(raw)
    if (!parsed.success) {
      // One bad value must never make the server reject a whole batch.
      countDrop(active.callId)
      return
    }
    push({ callId: active.callId, role: active.role, event: parsed.data })
  } catch {
    // never break a call
  }
}

/** The active call is over on this phone: flush now, keep leftovers for a while. */
export function endCallLog(): void {
  try {
    if (!active) return
    active = null
    discardAt = Date.now() + DISCARD_AFTER_MS
    flush(false)
  } catch {
    // never break a call
  }
}

function ensureTimer(): void {
  if (timer !== null) return
  timer = setInterval(tick, FLUSH_EVERY_MS)
}

function tick(): void {
  try {
    if (!active && discardAt !== null && Date.now() >= discardAt) {
      buffer = []
      seqs.clear()
      drops.clear()
      discardAt = null
    }
    if (!active && buffer.length === 0) {
      if (timer !== null) clearInterval(timer)
      timer = null
      return
    }
    flush(false)
  } catch {
    // never break a call
  }
}

/**
 * Post buffered events: grouped by callId, at most CALL_DIAG_MAX_EVENTS per request. One request in
 * flight at a time, except a page-hide flush (`all`), which sends everything at once. fetch with
 * keepalive, not sendBeacon: Chrome refuses a sendBeacon Blob of type application/json (not
 * CORS-safelisted). Same-origin POSTs carry Origin (the server's guard) and the session cookie.
 */
function flush(all: boolean): void {
  if (buffer.length === 0) return
  if (!all && inFlight > 0) return
  do {
    const callId = buffer[0]!.callId
    const chunk: Entry[] = []
    const rest: Entry[] = []
    for (const e of buffer) {
      if (e.callId === callId && chunk.length < CALL_DIAG_MAX_EVENTS) chunk.push(e)
      else rest.push(e)
    }
    buffer = rest
    send(callId, chunk)
  } while (all && buffer.length > 0)
}

function send(callId: string, chunk: Entry[]): void {
  const seq = seqs.get(callId) ?? 0
  seqs.set(callId, seq + 1)
  const batch: CallDiagBatch = {
    callId,
    role: chunk[0]!.role,
    seq: Math.min(seq, 100_000),
    dropped: Math.min(drops.get(callId) ?? 0, 1_000_000),
    sentAt: Date.now(),
    env: getEnv(),
    events: chunk.map((e) => e.event),
  }
  inFlight += 1
  const requeue = () => {
    buffer = [...chunk, ...buffer]
    while (buffer.length > MAX_BUFFER) countDrop(buffer.shift()!.callId)
  }
  let request: Promise<Response>
  try {
    request = fetch(ENDPOINT, {
      method: "POST",
      keepalive: true,
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(batch),
    })
  } catch {
    inFlight -= 1
    requeue()
    return
  }
  request
    .then((res) => {
      inFlight -= 1
      // Retry later on a rate limit or a server error; a 4xx (bad body, no session) drops the chunk.
      if (res.status === 429 || res.status >= 500) requeue()
      else if (buffer.length > 0) flush(false)
    })
    .catch(() => {
      inFlight -= 1
      requeue()
    })
}

/** Page lifecycle listeners, installed once on the first call log. */
function listen(): void {
  if (listening || typeof document === "undefined") return
  listening = true
  const pageEvent = (what: "visible" | "hidden" | "pagehide" | "pageshow" | "freeze" | "resume" | "online" | "offline", persisted?: boolean) =>
    callLog(persisted === undefined ? { k: "page", what } : { k: "page", what, persisted })
  const flushAll = () => {
    try {
      flush(true)
    } catch {
      // never break a call
    }
  }
  document.addEventListener("visibilitychange", () => {
    const hidden = document.visibilityState === "hidden"
    pageEvent(hidden ? "hidden" : "visible")
    if (hidden) flushAll()
  })
  window.addEventListener("pagehide", (e) => {
    pageEvent("pagehide", (e as PageTransitionEvent).persisted)
    flushAll()
  })
  window.addEventListener("pageshow", (e) => pageEvent("pageshow", (e as PageTransitionEvent).persisted))
  document.addEventListener("freeze", () => {
    pageEvent("freeze")
    flushAll()
  })
  document.addEventListener("resume", () => pageEvent("resume"))
  window.addEventListener("online", () => {
    pageEvent("online")
    try {
      flush(false)
    } catch {
      // never break a call
    }
  })
  window.addEventListener("offline", () => pageEvent("offline"))
}

// --- coarse environment ---------------------------------------------------------------------------

interface UaData {
  brands?: { brand: string; version: string }[]
  mobile?: boolean
  platform?: string
  getHighEntropyValues?: (hints: string[]) => Promise<{ platformVersion?: string }>
}

const FALLBACK_ENV: CallDiagEnv = { browser: "other", os: "other", mobile: false, standalone: false }

function num(s: string | undefined, max: number): number | undefined {
  if (s === undefined) return undefined
  const n = Number.parseInt(s, 10)
  return Number.isFinite(n) && n >= 0 && n <= max ? n : undefined
}

/** Browser, OS and versions as enums and small ints, computed once. */
function getEnv(): CallDiagEnv {
  if (env) return env
  try {
    env = computeEnv()
  } catch {
    env = FALLBACK_ENV
  }
  return env
}

function computeEnv(): CallDiagEnv {
  const nav = navigator as Navigator & { userAgentData?: UaData }
  const ua = nav.userAgent || ""
  const out: CallDiagEnv = { ...FALLBACK_ENV }
  let m: RegExpExecArray | null

  // The UA string first (Safari has no userAgentData).
  if (isIos()) {
    out.os = "ios"
    if ((m = /(?:iPhone|CPU) OS (\d+)[_.](\d+)/.exec(ua))) {
      out.osMajor = num(m[1], 99)
      out.osMinor = num(m[2], 99)
    }
  } else if ((m = /Android (\d+)/.exec(ua))) {
    out.os = "android"
    out.osMajor = num(m[1], 99)
  } else if (/Android/.test(ua)) out.os = "android"
  else if (/Mac OS X/.test(ua)) out.os = "macos"
  else if (/Windows/.test(ua)) out.os = "windows"
  else if (/Linux|X11/.test(ua)) out.os = "linux"

  if ((m = /(?:Edg|EdgA|EdgiOS)\/(\d+)/.exec(ua))) [out.browser, out.browserMajor] = ["edge", num(m[1], 999)]
  else if ((m = /SamsungBrowser\/(\d+)/.exec(ua))) [out.browser, out.browserMajor] = ["samsung", num(m[1], 999)]
  else if ((m = /CriOS\/(\d+)/.exec(ua))) [out.browser, out.browserMajor] = ["chrome", num(m[1], 999)]
  else if ((m = /(?:FxiOS|Firefox)\/(\d+)/.exec(ua))) [out.browser, out.browserMajor] = ["firefox", num(m[1], 999)]
  else if ((m = /Chrome\/(\d+)/.exec(ua))) [out.browser, out.browserMajor] = ["chrome", num(m[1], 999)]
  else if ((m = /Version\/(\d+)[^ ]* (?:Mobile\/\S+ )?Safari/.exec(ua))) [out.browser, out.browserMajor] = ["safari", num(m[1], 999)]
  else if (/Safari/.test(ua)) out.browser = "safari"
  out.mobile = /Mobi|Android|iPhone|iPad|iPod/.test(ua) || out.os === "ios"

  // UA client hints where present (Chromium): brands and the real platform.
  const data = nav.userAgentData
  if (data) {
    const brands = data.brands ?? []
    const pick = (name: string) => brands.find((b) => b.brand === name)
    const brand =
      (pick("Microsoft Edge") && (["edge", pick("Microsoft Edge")] as const)) ||
      (pick("Samsung Internet") && (["samsung", pick("Samsung Internet")] as const)) ||
      (pick("Google Chrome") && (["chrome", pick("Google Chrome")] as const)) ||
      (pick("Chromium") && (["chrome", pick("Chromium")] as const)) ||
      null
    if (brand) {
      out.browser = brand[0]
      out.browserMajor = num(brand[1]!.version, 999)
    }
    if (typeof data.mobile === "boolean") out.mobile = data.mobile
    const platform = data.platform ?? ""
    if (platform === "Android") out.os = "android"
    else if (platform === "macOS") out.os = "macos"
    else if (platform === "Windows") out.os = "windows"
    else if (platform === "Linux") out.os = "linux"
    // Chrome freezes "Android 10" in the UA string; the high-entropy hint has the real version.
    if (out.os === "android" && typeof data.getHighEntropyValues === "function") {
      data
        .getHighEntropyValues(["platformVersion"])
        .then((v) => {
          const major = num(v.platformVersion?.split(".")[0], 99)
          if (major !== undefined && env) {
            const next = CallDiagEnv.safeParse({ ...env, osMajor: major })
            if (next.success) env = next.data
          }
        })
        .catch(() => {})
    }
  }
  out.standalone = isStandalone()
  for (const k of ["browserMajor", "osMajor", "osMinor"] as const) if (out[k] === undefined) delete out[k]
  const parsed = CallDiagEnv.safeParse(out)
  return parsed.success ? parsed.data : FALLBACK_ENV
}

// --- names and stats samples ----------------------------------------------------------------------

/** A getUserMedia error name as the schema knows it ("other" for anything else, never the message). */
export function gumName(name: string | undefined): CallDiagGumName {
  const parsed = CallDiagGumName.safeParse(name)
  return parsed.success ? parsed.data : "other"
}

/** Every STATS_EVERY-th 2 s sample (about 6 s) becomes a stats event. */
const STATS_EVERY = 3

interface SampleWindow {
  t: number
  inBytes: number
  outBytes: number | undefined
  lost: number
  received: number
}

let window0: SampleWindow | null = null
let samples = 0
let lastPair: string | null = null

function resetSample(): void {
  window0 = null
  samples = 0
  lastPair = null
}

/** Round and clamp to [min, max]; undefined when the value is missing or not finite. */
function bounded(value: number | undefined, min: number, max: number): number | undefined {
  if (value === undefined || !Number.isFinite(value)) return undefined
  return clampInt(value, min, max)
}

/** Copy only the defined values (the schema's optional fields must be absent, not undefined). */
function defined<T extends object>(o: T): T {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T
}

function videoFields(prefix: "videoIn" | "videoOut", v: VideoStat | undefined): Record<string, number | undefined> {
  return {
    [`${prefix}Fps`]: bounded(v?.fps, 0, 240),
    [`${prefix}Width`]: bounded(v?.width, 0, 8192),
    [`${prefix}Height`]: bounded(v?.height, 0, 8192),
  }
}

/**
 * One 2 s getStats sample of the active call: a pair event whenever the selected candidate pair
 * changes (types and transports only), and every STATS_EVERY-th sample a stats event over the window
 * since the previous one (RTT, loss %, jitter, in/out kbps, video fps and size).
 */
export function callLogSample(sample: CallSample): void {
  try {
    if (!active) return
    const local = CandidateType.safeParse(sample.localType)
    const remote = CandidateType.safeParse(sample.remoteType)
    if (local.success && remote.success) {
      const protocol: "udp" | "tcp" | undefined =
        sample.protocol === "udp" || sample.protocol === "tcp" ? sample.protocol : undefined
      const relay = RelayProtocol.safeParse(sample.relayProtocol)
      const network =
        sample.networkType === undefined
          ? undefined
          : (CallDiagNetworkType.safeParse(sample.networkType).data ?? ("unknown" as const))
      const pair = defined({
        k: "pair" as const,
        local: local.data,
        remote: remote.data,
        protocol,
        relayProtocol: relay.success ? relay.data : undefined,
        networkType: network,
      })
      const signature = JSON.stringify(pair)
      if (signature !== lastPair) {
        lastPair = signature
        callLog(pair)
      }
    }

    const now: SampleWindow = {
      t: performance.now(),
      inBytes: sample.inboundBytes,
      outBytes: sample.outboundBytes,
      lost: sample.packetsLost,
      received: sample.packetsReceived,
    }
    const prev = window0
    if (!prev) {
      window0 = now
      return
    }
    samples += 1
    if (samples % STATS_EVERY !== 0) return
    window0 = now
    const elapsed = now.t - prev.t
    const kbps = (bytes: number | undefined, before: number | undefined) =>
      bytes === undefined || before === undefined || elapsed <= 0 || bytes < before
        ? undefined
        : bounded(((bytes - before) * 8) / elapsed, 0, 1_000_000)
    const lost = now.lost - prev.lost
    const received = now.received - prev.received
    const lossPct = lost >= 0 && received >= 0 && lost + received > 0 ? bounded((lost / (lost + received)) * 100, 0, 100) : undefined
    callLog(
      defined({
        k: "stats" as const,
        state: sample.state,
        rttMs: bounded(sample.rttMs, 0, 600_000),
        lossPct,
        jitterMs: bounded(sample.jitterMs, 0, 60_000),
        inKbps: kbps(now.inBytes, prev.inBytes),
        outKbps: kbps(now.outBytes, prev.outBytes),
        ...videoFields("videoIn", sample.videoIn),
        ...videoFields("videoOut", sample.videoOut),
      }),
    )
  } catch {
    // never break a call
  }
}
