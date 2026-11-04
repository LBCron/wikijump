export interface DisplayOpts {
  visible?: () => void
  hidden?: () => void
}

export class DisplayObserver {
  declare private opts: DisplayOpts

  declare private observer: ResizeObserver

  private last: boolean | null = null

  declare target: HTMLElement

  constructor(target: HTMLElement, opts: DisplayOpts = {}) {
    this.target = target
    this.opts = opts
    this.observer = new ResizeObserver(this.handler.bind(this))
    this.observer.observe(target)

    if (!this.visible) this.handler()
  }

  get visible() {
    return this.target.offsetParent !== null
  }

  private handler() {
    const state = this.visible

    if (state === this.last) return

    this.last = state

    if (state) this.opts.visible?.()
    else this.opts.hidden?.()

    if (state) {
      this.removeHiddenMinSize()
      this.opts.visible?.()
    } else {
      this.applyHiddenMinSize()
      this.opts.hidden?.()
    }
  }

  private applyHiddenMinSize() {
    this.target.style.minHeight = "1px"
    this.target.style.minWidth = "1px"
  }

  private removeHiddenMinSize() {
    this.target.style.minHeight = ""
    this.target.style.minWidth = ""
  }

  update(opts: DisplayOpts = {}) {
    this.opts = opts
  }

  destroy() {
    this.observer.disconnect()
  }
}
