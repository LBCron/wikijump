export class Timeout<T = void> {
  declare private timeout: ReturnType<typeof setTimeout> | undefined

  declare private promiseResolve: (resolved: T) => void

  declare delay: number

  declare ends: Date

  declare started: Date

  declare promise: Promise<T>

  declare value?: T

  declare private cb?: () => void

  /**
   * @param delay - The delay for the timer. Set to `null` for an immediate
   *   timer.
   * @param cb - The callback that will be fired when the timeout expires.
   *   Is optional.
   * @param immediate - If true, the callback will be fired immediately.
   *   Defaults to true.
   */
  constructor(delay?: number | null, cb?: (() => T) | null, immediate = true) {
    this.reset(delay, cb)
    if (!immediate) this.clear()
  }

  get running() {
    return this.timeout !== undefined
  }

  then(resolve?: (value: T) => T | PromiseLike<T>) {
    return this.promise.then(resolve)
  }

  remaining() {
    if (!this.ends || !this.started) return 0
    const remaining = this.ends.getTime() - new Date().getTime()
    return remaining > 0 ? remaining : 0
  }

  expired(): this is { value: T } {
    return this.timeout === undefined
  }

  clear() {
    if (!this.timeout) return
    clearTimeout(this.timeout)
    this.timeout = undefined
  }

  /**
   * Extends the timeout, adding the given delay to the current time
   * remaining. Does nothing if the timeout has already expired.
   *
   * @param delay - The delay to add to the current time remaining.
   */
  extend(delay: number) {
    if (this.expired()) return
    this.reset(this.remaining() + delay)
  }

  /**
   * Resets the timeout. Optionally allows changing the delay and callback.
   *
   * @param delay - The delay between now and when the callback should be
   *   fired. Set to `null` to have a "tick" timer.
   * @param cb - The callback that will be fired when the timeout expires.
   *   Provide `null` to get rid of the current callback.
   * @throws If `cb` is provided but is not a function.
   */
  reset(delay?: number | null, cb?: (() => T) | null) {
    if (cb && typeof cb !== "function") {
      console.error("Rejected non-function timeout callback")
      throw new Error("Timeout callback must be a function")
    }

    if (this.expired() || !this.promise) {
      this.promise = new Promise<T>((resolve) => {
        this.promiseResolve = resolve
      })
    }

    if (typeof delay === "number") this.delay = delay
    else if (delay === null) this.delay = 0

    if (cb) {
      this.cb = () => {
        const out = cb()
        this.value = out
        this.promiseResolve(out)
      }
    } else if (cb === null) {
      this.cb = undefined
    }

    if (this.expired()) this.started = new Date()
    this.ends = new Date(this.started.getTime() + this.delay)
    this.value = undefined
    this.clear()

    this.timeout = setTimeout(() => {
      if (this.cb) this.cb()
      this.timeout = undefined
    }, this.delay)
  }
}

/**
 * Creates a new {@link Timeout}.
 *
 * @param delay - The delay between now and when the callback should be
 *   fired.
 * @param cb - The callback that will be fired when the timeout expires.
 */
export function timeout<T>(delay: number, cb?: () => T) {
  return new Timeout(delay, cb)
}

/**
 * Creates a new {@link Timeout} that resolves as soon as possible.
 *
 * @param cb - The callback that will be fired when the timeout expires.
 */
export function tick<T>(cb?: () => T) {
  return new Timeout(0, cb)
}

/**
 * Clears a {@link Timeout}.
 *
 * @param timeout - The timeout to clear.
 */
function clearTimeoutClass(timeout: Timeout | undefined | null) {
  if (!timeout) return
  timeout.clear()
}

export { clearTimeoutClass as clearTimeout }

export const TIMED_OUT_SYMBOL = Symbol("timedout")

/**
 * Utility for handling promise timeouts. If the {@link TIMED_OUT_SYMBOL}
 * symbol is returned, the promise timed out.
 *
 * @param promise - The promise to wrap.
 * @param time - The duration to use.
 */
export async function timedout<T>(promise: Promise<T>, time: number) {
  const timer = timeout<typeof TIMED_OUT_SYMBOL>(time, () => TIMED_OUT_SYMBOL)
  const result = await Promise.race([promise, timer.promise])
  if (result !== TIMED_OUT_SYMBOL) timer.clear()
  return result
}
