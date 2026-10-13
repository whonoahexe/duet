"use client"

/**
 * One thing plays at a time (D-12, UI-SPEC "Starting a voice note pauses any other voice note or
 * video"): every voice note and viewer video calls claimPlayback when it starts, which pauses the
 * element that was playing before.
 */
let current: HTMLMediaElement | null = null

export function claimPlayback(el: HTMLMediaElement): void {
  if (current && current !== el && !current.paused) current.pause()
  current = el
}

/** The element is going away (unmount, closed viewer). */
export function releasePlayback(el: HTMLMediaElement): void {
  if (current === el) current = null
}
