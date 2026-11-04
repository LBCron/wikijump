export interface WhileHeldOpts {
  pressed?: (node: HTMLElement) => void
  released?: (node: HTMLElement) => void
}

export class HeldObserver {
  private held = false

  constructor(
    private target: HTMLElement,
    private opts: WhileHeldOpts
  ) {
    target.addEventListener("pointerdown", this.pressed)
    target.addEventListener("pointerup", this.released)
    target.addEventListener("pointercancel", this.released)
  }

  private pressed = () => {
    if (this.held) return
    this.held = true
    if (this.opts.pressed) this.opts.pressed(this.target)
  }

  private released = () => {
    if (!this.held) return
    this.held = false
    if (this.opts.released) this.opts.released(this.target)
  }

  update(opts: WhileHeldOpts) {
    this.opts = opts
  }

  destroy() {
    this.target.removeEventListener("pointerdown", this.pressed)
    this.target.removeEventListener("pointerup", this.released)
    this.target.removeEventListener("pointercancel", this.released)
  }
}
