import { describe, expect, it } from "vitest"
import {
  CallId,
  callRoom,
  CALL_RING_TIMEOUT_MS,
  formatCallDuration,
  POOR_LOSS_FRACTION,
  POOR_OFF_SAMPLES,
  POOR_ON_SAMPLES,
  POOR_RTT_MS,
  QUALITY_START,
  qualityStep,
  RoomId,
} from "@duet/shared"

describe("formatCallDuration", () => {
  it.each([
    [0, "0:00"],
    [999, "0:00"],
    [5000, "0:05"],
    [134000, "2:14"],
    [3599000, "59:59"],
    [3600000, "1:00:00"],
    [3729000, "1:02:09"],
    [-5, "0:00"],
  ])("formats %d ms as %s", (ms, text) => {
    expect(formatCallDuration(ms)).toBe(text)
  })
})

describe("call contract", () => {
  it("rings for 45 s (D-07)", () => {
    expect(CALL_RING_TIMEOUT_MS).toBe(45_000)
  })

  it("names call rooms call-<id>, a valid RoomId", () => {
    const id = "6f1e2b9a-1c2d-4e5f-8a9b-0c1d2e3f4a5b"
    expect(callRoom(id)).toBe(`call-${id}`)
    expect(RoomId.safeParse(callRoom(id)).success).toBe(true)
  })

  it("accepts lowercase uuids only as call ids", () => {
    expect(CallId.safeParse("6f1e2b9a-1c2d-4e5f-8a9b-0c1d2e3f4a5b").success).toBe(true)
    expect(CallId.safeParse("6F1E2B9A-1C2D-4E5F-8A9B-0C1D2E3F4A5B").success).toBe(false)
    expect(CallId.safeParse("call-x").success).toBe(false)
  })
})

describe("qualityStep (D-20 Poor connection badge)", () => {
  const start = QUALITY_START
  const bad = { lossFraction: 0.06 }
  const good = { lossFraction: 0.01, rttMs: 80 }
  const run = (samples: Array<{ lossFraction?: number; rttMs?: number }>) => samples.reduce((s, x) => qualityStep(s, x), start)

  it("uses the UI-SPEC thresholds", () => {
    expect(POOR_LOSS_FRACTION).toBe(0.05)
    expect(POOR_RTT_MS).toBe(400)
    expect(POOR_ON_SAMPLES).toBe(2)
    expect(POOR_OFF_SAMPLES).toBe(3)
  })

  it("stays not poor after one bad sample", () => {
    expect(run([bad]).poor).toBe(false)
  })

  it("turns poor on the second consecutive bad sample", () => {
    expect(run([bad, bad]).poor).toBe(true)
  })

  it("counts RTT above 400 ms alone as bad", () => {
    expect(run([{ rttMs: 401 }, { rttMs: 401 }]).poor).toBe(true)
  })

  it("counts RTT 400 and loss 0.05 as good", () => {
    expect(run([{ rttMs: 400, lossFraction: 0.05 }, { rttMs: 400, lossFraction: 0.05 }]).poor).toBe(false)
  })

  it("keeps poor through two good samples and turns it off on the third", () => {
    const poor = run([bad, bad])
    expect(poor.poor).toBe(true)
    const twoGood = qualityStep(qualityStep(poor, good), good)
    expect(twoGood.poor).toBe(true)
    expect(qualityStep(twoGood, good).poor).toBe(false)
  })

  it("resets the bad count when a good sample comes between two bad ones", () => {
    expect(run([bad, good, bad]).poor).toBe(false)
    expect(run([bad, good, bad, bad]).poor).toBe(true)
  })

  it("counts a sample without loss and RTT as good", () => {
    expect(run([bad, {}, bad]).poor).toBe(false)
    const poor = run([bad, bad])
    expect(run([bad, bad, {}, {}, {}]).poor).toBe(false)
    expect(poor.poor).toBe(true)
  })
})
