import { timeout } from "$lib/util/timeout"
import { writable } from "svelte/store"

interface Toast {
  type: "success" | "danger" | "warning" | "info"
  message: string
  remove: () => void
}

export const toasts = writable<Set<Toast>>(new Set())

/**
 * Displays a 'toast' notification to the user.
 *
 * @param type - The type of notification to display.
 * @param message - The message to display.
 * @param time - The time in milliseconds to display the notification. Pass
 *   `0` to prevent the notification from closing.
 */
export function toast(
  type: "success" | "danger" | "warning" | "info",
  message: string,
  time = 5000
) {
  const remove = () => {
    toasts.update((cur) => {
      cur.delete(toastData)
      return new Set(cur)
    })
  }
  const toastData = { type, message, remove }
  toasts.update((cur) => new Set(cur.add(toastData)))
  if (time) timeout(time, remove)
}
