/**
 * Window event that asks the chat to scroll to the newest message. Plan 02-03 dispatches it when a
 * notification tap focuses an already open duet window (the service worker posts "open-chat").
 */
export const OPEN_CHAT_EVENT = "duet:open-chat"

/**
 * Window event for "the user just sent something: jump to the newest message, even when scrolled up"
 * (G-02-42). The composer dispatches it after every local send (text, reply, photos/videos, voice
 * note); ScrollFollower, which lives inside the scroller provider, scrolls to the end.
 */
export const SCROLL_TO_LATEST_EVENT = "duet:scroll-to-latest"

/** Ask the open chat to jump to the newest message (no-op outside the browser). */
export function requestScrollToLatest(): void {
  if (typeof window === "undefined") return
  window.dispatchEvent(new Event(SCROLL_TO_LATEST_EVENT))
}
