export interface DisplayOpts {
  visible?: () => void
  hidden?: () => void
}

/**
 * Observer that watches for if an element is being displayed in the DOM.
 * This isn't about the viewport, it's only about the DOM. This state is
 * effected by the `display` CSS property, among other things.
 */
export class DisplayObserver {
  declare private opts: DisplayOpts

  declare private observer: ResizeObserver

  private last: boolean | null = null

  declare target: HTMLElement

  /**
   * @param target - The element to observe.
   * @param opts - Options for the observer.
   */
  constructor(target: HTMLElement, opts: DisplayOpts = {}) {
    this.target = target
    this.opts = opts
    this.observer = new ResizeObserver(this.handler.bind(this))
    this.observer.observe(target)

    if (!this.visible) this.handler()
  }

  get visible() {
    // per the spec, this value is `null` if the element is not being displayed
    return this.target.offsetParent !== null
  }

  private handler() {
    const state = this.visible

    if (state === this.last) return

    this.last = state

    if (state) this.opts.visible?.()
    else this.opts.hidden?.()


    if (state) {
      this.target.style.minHeight = ""
      this.target.style.minWidth = ""
      this.opts.visible?.()
    } else {
      this.target.style.minHeight = "1px"
      this.target.style.minWidth = "1px"
      this.opts.hidden?.()
    }
  }

  update(opts: DisplayOpts = {}) {
    this.opts = opts
  }

  destroy() {
    this.observer.disconnect()
  }
}
