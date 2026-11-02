/* eslint-disable @typescript-eslint/unbound-method */
export interface HoverOpts {
  alsoOnFocus?: boolean
  on?: () => void
  off?: () => void
  move?: () => void
}

const HoverMediaQuery =
  typeof globalThis.matchMedia === "function"
    ? matchMedia("(any-hover: hover), (hover: hover)")
    : ({ matches: true } as MediaQueryList)

export class HoverObserver {
  private hovered = false

  private focused = false

  /**
   * @param target - The element to observe.
   * @param opts - Options for the observer.
   */
  constructor(
    private target: HTMLElement,
    private opts: HoverOpts
  ) {
    this.pointerover = this.pointerover.bind(this)
    this.pointerout = this.pointerout.bind(this)
    this.focusin = this.focusin.bind(this)
    this.focusout = this.focusout.bind(this)
    this.move = this.move.bind(this)

    target.addEventListener("pointerover", this.pointerover, { passive: true })
    target.addEventListener("pointerout", this.pointerout, { passive: true })
    target.addEventListener("focusin", this.focusin, { passive: true })
    target.addEventListener("focusout", this.focusout, { passive: true })
    target.addEventListener("pointermove", this.move, { passive: true })
  }

  private pointerover(evt: PointerEvent) {
    if (!HoverMediaQuery.matches) return
    if (this.sameTree(evt)) return
    this.hovered = true
    if (this.opts.on && !this.focused) this.opts.on()
  }

  private pointerout(evt: PointerEvent) {
    if (!this.hovered && !HoverMediaQuery.matches) return
    if (this.sameTree(evt)) return
    this.hovered = false
    if (this.opts.off && !this.focused) this.opts.off()
  }

  private focusin(evt: FocusEvent) {
    if (!this.opts.alsoOnFocus) return
    if (this.focused && this.sameTree(evt)) return
    this.focused = true
    if (this.opts.on && !this.hovered) this.opts.on()
  }

  private focusout(evt: FocusEvent) {
    if (!this.opts.alsoOnFocus) return
    if (this.sameTree(evt)) return
    this.focused = false
    if (this.opts.off && !this.hovered) this.opts.off()
  }

  private move() {
    if (this.opts.move) this.opts.move()
  }

  private sameTree(evt: FocusEvent | PointerEvent) {
    return this.target.contains(evt.relatedTarget as HTMLElement)
  }

  /**
   * Update observer configuration.
   *
   * @param opts - New options for the observer.
   */
  update(opts: HoverOpts) {
    this.opts = opts
  }

  destroy() {
    this.target.removeEventListener("pointerover", this.pointerover)
    this.target.removeEventListener("pointerout", this.pointerout)
    this.target.removeEventListener("focusin", this.focusin)
    this.target.removeEventListener("focusout", this.focusout)
    this.target.removeEventListener("pointermove", this.move)
  }
}
