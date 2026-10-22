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

describe("service worker push icon (QT-5zd-push-icon, T-5zd-05)", () => {
  it("shows the sender's avatar-round circle as the icon for a valid 22-character id", async () => {
    const { self, listeners } = loadSw()
    await dispatch(listeners, "push", { data: pushData({ t: "chat", title: "A", body: "b", avatar: "AbCdEfGhIjKlMnOpQrStUv" }) })
    expect(self.registration.showNotification).toHaveBeenCalledWith(
      "A",
      expect.objectContaining({ icon: "/media/AbCdEfGhIjKlMnOpQrStUv/avatar-round", badge: "/icons/badge-96.png" }),
    )
  })

  it.each([
    ["a traversal string", "../../api/logout"],
    ["a 23-character id", "AbCdEfGhIjKlMnOpQrStUvW"],
    ["a number", 12345],
  ])("keeps the app icon for %s", async (_name, avatar) => {
    const { self, listeners } = loadSw()
    await dispatch(listeners, "push", { data: pushData({ t: "call", title: "A", body: "b", avatar }) })
    expect(self.registration.showNotification).toHaveBeenCalledWith("A", expect.objectContaining({ icon: "/icons/icon-192.png" }))
  })
})

describe("service worker call pushes (D-09, D-12)", () => {
  const callId = "0b9d3c4e-6f1a-4c2b-9d8e-7a6b5c4d3e2f"

  it("closes an open call notification, then shows the incoming call tagged duet-call with a /?call= link", async () => {
    const open = [{ tag: "duet-call", close: vi.fn() }]
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

  it("WR-07: a chat push leaves Incoming call and Missed call open, and closes the chat ones", async () => {
    const call = { tag: "duet-call", close: vi.fn() }
    const chat = { tag: "duet-chat", close: vi.fn() }
    const test = { tag: "duet-test", close: vi.fn() }
    const { self, listeners } = loadSw({ open: [call, chat, test] })
    await dispatch(listeners, "push", { data: pushData({ t: "chat", title: "Ada", body: "pick up!" }) })
    expect(call.close).not.toHaveBeenCalled()
    expect(chat.close).toHaveBeenCalledTimes(1)
    expect(test.close).toHaveBeenCalledTimes(1)
    expect(self.registration.showNotification).toHaveBeenCalledWith("Ada", expect.objectContaining({ tag: "duet-chat" }))
  })

  it("WR-07: a missed-call push replaces the ring and leaves the chat notification open", async () => {
    const ring = { tag: "duet-call", close: vi.fn() }
    const chat = { tag: "duet-chat", close: vi.fn() }
    const { self, listeners } = loadSw({ open: [ring, chat] })
    await dispatch(listeners, "push", {
      data: pushData({ t: "call-missed", title: "Ada", body: "Missed voice call", callId, kind: "voice" }),
    })
    expect(ring.close).toHaveBeenCalledTimes(1)
    expect(chat.close).not.toHaveBeenCalled()
    expect(self.registration.showNotification).toHaveBeenCalledWith(
      "Ada",
      expect.objectContaining({ tag: "duet-call", data: { url: `/?missed=${callId}`, callId } }),
    )
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

describe("service worker reminder pushes (QT-nw9-reminder-fire, T-nw9-10)", () => {
  it("shows a reminder tagged duet-reminder with the fixed link and closes no open notification", async () => {
    const call = { tag: "duet-call", close: vi.fn() }
    const chat = { tag: "duet-chat", close: vi.fn() }
    const older = { tag: "duet-reminder", close: vi.fn() }
    const { self, listeners } = loadSw({ open: [call, chat, older] })
    await dispatch(listeners, "push", {
      data: pushData({ t: "reminder", title: "⏰ Drink water", body: "Reminder · from Ada", url: "https://evil.test/" }),
    })
    expect(call.close).not.toHaveBeenCalled()
    expect(chat.close).not.toHaveBeenCalled()
    expect(older.close).not.toHaveBeenCalled()
    expect(self.registration.showNotification).toHaveBeenCalledWith("⏰ Drink water", {
      body: "Reminder · from Ada",
      tag: "duet-reminder",
      renotify: true,
      icon: "/icons/icon-192.png",
      badge: "/icons/badge-96.png",
      data: { url: "/" },
    })
  })

  it("a chat push leaves an open reminder alone and still closes the other non-call notifications", async () => {
    const reminder = { tag: "duet-reminder", close: vi.fn() }
    const call = { tag: "duet-call", close: vi.fn() }
    const chat = { tag: "duet-chat", close: vi.fn() }
    const test = { tag: "duet-test", close: vi.fn() }
    const { listeners } = loadSw({ open: [reminder, call, chat, test] })
    await dispatch(listeners, "push", { data: pushData({ t: "chat", title: "Ada", body: "Message" }) })
    expect(reminder.close).not.toHaveBeenCalled()
    expect(call.close).not.toHaveBeenCalled()
    expect(chat.close).toHaveBeenCalledTimes(1)
    expect(test.close).toHaveBeenCalledTimes(1)
  })

  it("a call push leaves an open reminder alone", async () => {
    const reminder = { tag: "duet-reminder", close: vi.fn() }
    const { listeners } = loadSw({ open: [reminder] })
    await dispatch(listeners, "push", {
      data: pushData({ t: "call", title: "Ada", body: "📞 Incoming voice call", callId: "0b6f4a8e-1d2c-4b3a-9f8e-7d6c5b4a3921" }),
    })
    expect(reminder.close).not.toHaveBeenCalled()
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

describe("service worker notificationclick on a call notification (D-09, D-10)", () => {
  const callId = "0b9d3c4e-6f1a-4c2b-9d8e-7a6b5c4d3e2f"

  it("focuses an open window and posts open-call with the call id", async () => {
    const win: FakeWindow = { focus: vi.fn(async () => undefined), postMessage: vi.fn() }
    const { self, listeners } = loadSw({ windows: [win] })
    const notification = { close: vi.fn(), data: { url: `/?call=${callId}`, callId } }
    await dispatch(listeners, "notificationclick", { notification })
    expect(notification.close).toHaveBeenCalledTimes(1)
    expect(win.focus).toHaveBeenCalledTimes(1)
    expect(win.postMessage).toHaveBeenCalledWith({ t: "open-call", callId })
    expect(self.clients.openWindow).not.toHaveBeenCalled()
  })

  it.each([
    ["incoming", `/?call=${callId}`],
    ["missed", `/?missed=${callId}`],
  ])("opens the %s link when no window is open", async (_name, url) => {
    const { self, listeners } = loadSw()
    await dispatch(listeners, "notificationclick", { notification: { close: vi.fn(), data: { url, callId } } })
    expect(self.clients.openWindow).toHaveBeenCalledWith(url)
  })

  it("still posts open-chat for a chat notification", async () => {
    const win: FakeWindow = { focus: vi.fn(async () => undefined), postMessage: vi.fn() }
    const { listeners } = loadSw({ windows: [win] })
    await dispatch(listeners, "notificationclick", { notification: { close: vi.fn(), data: { url: "/" } } })
    expect(win.postMessage).toHaveBeenCalledWith({ t: "open-chat" })
  })
})

describe("service worker scope (T-02-20)", () => {
  it("registers no fetch listener, only install, activate, push and notificationclick", () => {
    const { listeners } = loadSw()
    expect(listeners.has("fetch")).toBe(false)
    expect([...listeners.keys()].sort()).toEqual(["activate", "install", "notificationclick", "push"])
  })
})
