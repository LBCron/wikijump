import { clearTimeout, Timeout, timeout } from "$lib/util"
import { Gesture, GestureObserver, type Direction } from "./gesture"

export interface SwipeOpts {
  condition?: () => boolean
  callback: (target: HTMLElement, gesture: Gesture) => void
  eventCallback?: (target: HTMLElement, gesture: Gesture) => void
  direction: Direction | Direction[]
  threshold: number
  minThreshold: number
  immediate?: boolean
  timeout?: number | false
}

const SWIPE_DEFAULT_OPTS: SwipeOpts = {
  callback: () => null,
  direction: "up",
  immediate: true,
  threshold: 35,
  minThreshold: 10,
  timeout: 250
}

export class SwipeObserver {
  declare private opts: SwipeOpts

  declare private directions: Direction[]

  declare private observer: GestureObserver

  private gesture: Gesture | null = null

  private timeout: Timeout | null = null

  private running = false

  private ended = false

  declare target: HTMLElement

  /**
   * @param target - The target element to track.
   * @param opts - Swipe recognition configuration.
   */
  constructor(target: HTMLElement, opts: Partial<SwipeOpts> = {}) {
    this.target = target
    this.opts = { ...SWIPE_DEFAULT_OPTS, ...opts }

    this.directions = Array.isArray(this.opts.direction)
      ? this.opts.direction
      : [this.opts.direction]

    this.observer = new GestureObserver(target, (gesture) => {
      this.gesture = gesture
      this.handler()
    })
  }

  private checkCondition() {
    if (!this.opts.condition) return true
    return this.opts.condition()
  }

  private fireCallback() {
    if (this.gesture && this.opts.callback) {
      this.opts.callback(this.target, this.gesture)
    }
  }

  private fireEventCallback() {
    if (this.gesture && this.opts.eventCallback) {
      this.opts.eventCallback(this.target, this.gesture)
    }
  }

  private reset() {
    clearTimeout(this.timeout)
    this.timeout = null
    this.ended = false
    this.running = false
  }

  private cancel() {
    clearTimeout(this.timeout)
    this.ended = true
    if (this.running && this.gesture) {
      this.gesture = this.gesture.replace({ type: "cancel" })
      this.fireEventCallback()
    }
  }

  private handler() {
    const gst = this.gesture!

    if (gst.is("start")) this.reset()

    if (this.ended || (!this.running && !this.checkCondition())) return

    const valid = gst.same(this.directions)
    const overMinThreshold = gst.over(this.opts.minThreshold)

    if (!valid && overMinThreshold) {
      this.cancel()
      return
    }

    if (valid && !this.running && overMinThreshold) this.running = true

    if (this.running) {
      const overThreshold = gst.over(this.opts.threshold)
      const canFire = valid && ((gst.is("move") && this.opts.immediate) || gst.is("end"))

      this.fireEventCallback()

      if (overThreshold && canFire) {
        this.fireCallback()
        this.ended = true
        clearTimeout(this.timeout)
        return
      }

      if (this.opts.timeout && !this.timeout) {
        this.timeout = timeout(this.opts.timeout, () => this.cancel())
      }
    }
  }

  update(opts: Partial<SwipeOpts>) {
    this.opts = { ...SWIPE_DEFAULT_OPTS, ...opts }
    this.directions = Array.isArray(this.opts.direction)
      ? this.opts.direction
      : [this.opts.direction]
  }

  destroy() {
    this.observer.destroy()
    this.reset()
  }
}
