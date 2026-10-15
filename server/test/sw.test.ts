import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import vm from "node:vm"
import { describe, expect, it, vi } from "vitest"

/** web/public/sw.js, resolved from this file (server/test -> ../../web/public). */
const SW_PATH = fileURLToPath(new URL("../../web/public/sw.js", import.meta.url))
const SW_SOURCE = readFileSync(SW_PATH, "utf8")

type Listener = (event: any) => void

interface FakeWindow {
  focus: ReturnType<typeof vi.fn>
  postMessage: ReturnType<typeof vi.fn>
}

/** Load sw.js in a fresh VM context with a fake `self` that records listeners and calls. */
function loadSw({
  open = [] as Array<{ close: ReturnType<typeof vi.fn> }>,
  getNotificationsThrows = false,
  windows = [] as FakeWindow[],
} = {}) {
  const listeners = new Map<string, Listener[]>()
  const self = {
    addEventListener: (type: string, fn: Listener) => {
      listeners.set(type, [...(listeners.get(type) ?? []), fn])
    },
    skipWaiting: vi.fn(),
    registration: {
      getNotifications: vi.fn(async () => {
        if (getNotificationsThrows) throw new Error("not supported")
        return open
      }),
      showNotification: vi.fn(async () => undefined),
    },
    clients: {
      claim: vi.fn(async () => undefined),
      matchAll: vi.fn(async () => windows),
      openWindow: vi.fn(async () => null),
    },
  }
  vm.runInNewContext(SW_SOURCE, { self }, { filename: SW_PATH })
  return { self, listeners }
}

/** Dispatch an event to every listener of `type` and await everything passed to waitUntil. */
async function dispatch(listeners: Map<string, Listener[]>, type: string, init: Record<string, unknown>) {
  const pending: Promise<unknown>[] = []
  const event = { ...init, waitUntil: (p: Promise<unknown>) => pending.push(p) }
  for (const fn of listeners.get(type) ?? []) fn(event)
  await Promise.all(pending)
}

function pushData(value: unknown) {
  return {
    json: () => {
      if (typeof value === "string") return JSON.parse(value)
      return value
    },
  }
}

describe("service worker push (NOTF-01, D-14, Pitfall 3)", () => {
  it("closes open notifications, then shows one collapsed chat notification", async () => {
    const open = [{ close: vi.fn() }, { close: vi.fn() }]
    const { self, listeners } = loadSw({ open })
    await dispatch(listeners, "push", { data: pushData({ t: "chat", title: "A", body: "b" }) })
    expect(open[0]!.close).toHaveBeenCalledTimes(1)
    expect(open[1]!.close).toHaveBeenCalledTimes(1)
    expect(self.registration.showNotification).toHaveBeenCalledTimes(1)
    expect(self.registration.showNotification).toHaveBeenCalledWith("A", {
      body: "b",
      tag: "duet-chat",
      renotify: true,
      icon: "/icons/icon-192.png",
      badge: "/icons/badge-96.png",
      data: { url: "/" },
    })
  })

  it("tags a test push duet-test", async () => {
    const { self, listeners } = loadSw()
    await dispatch(listeners, "push", { data: pushData({ t: "test", title: "duet", body: "Test" }) })
    expect(self.registration.showNotification).toHaveBeenCalledWith("duet", expect.objectContaining({ tag: "duet-test", badge: "/icons/badge-96.png" }))
  })

  it.each([
    ["no data", undefined],
    ["non-JSON data", pushData("not json")],
    ["an empty object", pushData({})],
    ["a JSON null", pushData(null)],
  ])("shows duet / New message for %s", async (_name, data) => {
    const { self, listeners } = loadSw()
    await dispatch(listeners, "push", { data })
    expect(self.registration.showNotification).toHaveBeenCalledTimes(1)
    expect(self.registration.showNotification).toHaveBeenCalledWith(
      "duet",
      expect.objectContaining({ body: "New message", tag: "duet-chat", badge: "/icons/badge-96.png" }),
    )
  })

  it("still shows the notification when getNotifications throws", async () => {
    const { self, listeners } = loadSw({ getNotificationsThrows: true })
    await dispatch(listeners, "push", { data: pushData({ t: "chat", title: "A", body: "b" }) })
    expect(self.registration.showNotification).toHaveBeenCalledTimes(1)
  })
})

describe("service worker call pushes (D-09, D-12)", () => {
  const callId = "0b9d3c4e-6f1a-4c2b-9d8e-7a6b5c4d3e2f"

  it("closes open notifications, then shows the incoming call tagged duet-call with a /?call= link", async () => {
    const open = [{ close: vi.fn() }]
    const { self, listeners } = loadSw({ open })
    await dispatch(listeners, "push", {
      data: pushData({ t: "call", title: "Ada", body: "📞 Incoming voice call", callId, kind: "voice" }),
    })
    expect(open[0]!.close).toHaveBeenCalledTimes(1)
    expect(self.registration.showNotification).toHaveBeenCalledTimes(1)
    expect(self.registration.showNotification).toHaveBeenCalledWith("Ada", {
      body: "📞 Incoming voice call",
      tag: "duet-call",
      renotify: true,
      icon: "/icons/icon-192.png",
      badge: "/icons/badge-96.png",
      data: { url: `/?call=${callId}`, callId },
    })
  })

  it("links a call push whose call id is not a uuid to / only", async () => {
    const { self, listeners } = loadSw()
    await dispatch(listeners, "push", {
      data: pushData({ t: "call", title: "Ada", body: "📞 Incoming voice call", callId: "../../evil?x=1" }),
    })
    expect(self.registration.showNotification).toHaveBeenCalledWith("Ada", expect.objectContaining({ tag: "duet-call", data: { url: "/" } }))
  })

  it("keeps chat and test pushes on duet-chat and duet-test", async () => {
    const { self, listeners } = loadSw()
    await dispatch(listeners, "push", { data: pushData({ t: "chat", title: "A", body: "b", callId }) })
    await dispatch(listeners, "push", { data: pushData({ t: "test", title: "duet", body: "Test" }) })
    expect(self.registration.showNotification).toHaveBeenNthCalledWith(1, "A", expect.objectContaining({ tag: "duet-chat", data: { url: "/" } }))
    expect(self.registration.showNotification).toHaveBeenNthCalledWith(2, "duet", expect.objectContaining({ tag: "duet-test", data: { url: "/" } }))
  })
})

describe("service worker notificationclick (NOTF-02)", () => {
  it("focuses an open window and posts open-chat", async () => {
    const win: FakeWindow = { focus: vi.fn(async () => undefined), postMessage: vi.fn() }
    const { self, listeners } = loadSw({ windows: [win] })
    const notification = { close: vi.fn() }
    await dispatch(listeners, "notificationclick", { notification })
    expect(notification.close).toHaveBeenCalledTimes(1)
    expect(win.focus).toHaveBeenCalledTimes(1)
    expect(win.postMessage).toHaveBeenCalledWith({ t: "open-chat" })
    expect(self.clients.openWindow).not.toHaveBeenCalled()
  })

  it("opens / when no window is open", async () => {
    const { self, listeners } = loadSw()
    const notification = { close: vi.fn() }
    await dispatch(listeners, "notificationclick", { notification })
    expect(notification.close).toHaveBeenCalledTimes(1)
    expect(self.clients.openWindow).toHaveBeenCalledWith("/")
  })
})

describe("service worker scope (T-02-20)", () => {
  it("registers no fetch listener, only install, activate, push and notificationclick", () => {
    const { listeners } = loadSw()
    expect(listeners.has("fetch")).toBe(false)
    expect([...listeners.keys()].sort()).toEqual(["activate", "install", "notificationclick", "push"])
  })
})
