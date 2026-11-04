export class Timeout<T = void> {
  declare private timeout: ReturnType<typeof setTimeout> | undefined

  declare private promiseResolve: (resolved: T) => void

  declare delay: number

  declare ends: Date

  declare started: Date

  declare promise: Promise<T>

  declare value?: T

  declare private cb?: () => void

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

  extend(delay: number) {
    if (this.expired()) return
    this.reset(this.remaining() + delay)
  }

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

export function timeout<T>(delay: number, cb?: () => T) {
  return new Timeout(delay, cb)
}

export function tick<T>(cb?: () => T) {
  return new Timeout(0, cb)
}

function clearTimeoutClass(timeout: Timeout | undefined | null) {
  if (!timeout) return
  timeout.clear()
}

export { clearTimeoutClass as clearTimeout }

export const TIMED_OUT_SYMBOL = Symbol("timedout")

export async function timedout<T>(promise: Promise<T>, time: number) {
  const timer = timeout<typeof TIMED_OUT_SYMBOL>(time, () => TIMED_OUT_SYMBOL)
  const result = await Promise.race([promise, timer.promise])
  if (result !== TIMED_OUT_SYMBOL) timer.clear()
  return result
}
