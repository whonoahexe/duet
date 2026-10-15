import { describe, expect, it } from "vitest"
import { CallId, callRoom, CALL_RING_TIMEOUT_MS, formatCallDuration, RoomId } from "@duet/shared"

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
