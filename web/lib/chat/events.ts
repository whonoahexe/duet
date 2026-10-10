/**
 * Window event that asks the chat to scroll to the newest message. Plan 02-03 dispatches it when a
 * notification tap focuses an already open duet window (the service worker posts "open-chat").
 */
export const OPEN_CHAT_EVENT = "duet:open-chat"
