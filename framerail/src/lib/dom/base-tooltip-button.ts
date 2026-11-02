import { clearTimeout, timeout, Timeout } from "$lib/util"
import * as Popper from "@popperjs/core"
import { BaseButton } from "./base-button"
import { HoverObserver } from "./hover"


export abstract class BaseTooltipButton extends BaseButton {
  abstract get parent(): HTMLElement

  abstract get tooltip(): HTMLElement

  protected whenHovered?(): void | boolean

  protected whenUnhovered?(): void

  declare private onTimer?: Timeout

  declare private offTimer?: Timeout

  declare private popperInstance?: Popper.Instance

  declare private hoverObserver: HoverObserver

  private baseWhenHovered() {
    if (this.disabled) return

    if (this.whenHovered) {
      const result = this.whenHovered()
      if (result === false) return
    }

    this.tooltip.classList.add("is-hovered")

    if (!this.popperInstance) {
      // @ts-ignore Popper has some bad typings (Element !== HTMLElement)
      this.popperInstance = Popper.createPopper(this.parent, this.tooltip, {
        placement: "bottom"
      })
    }
  }

  private baseWhenUnhovered() {
    if (this.disabled && !this.tooltip.classList.contains("is-hovered")) return

    if (this.whenUnhovered) this.whenUnhovered()

    this.tooltip.classList.remove("is-hovered")

    if (this.popperInstance) {
      this.offTimer = timeout(100, () => {
        this.popperInstance!.destroy()
        this.popperInstance = undefined
      })
    }
  }

  connectedCallback() {
    super.connectedCallback()

    this.hoverObserver = new HoverObserver(this.parent, {
      on: () => {
        clearTimeout(this.offTimer)
        this.onTimer = timeout(50, () => this.baseWhenHovered())
      },
      off: () => {
        clearTimeout(this.onTimer)
        this.offTimer = timeout(50, () => this.baseWhenUnhovered())
      }
    })
  }

  disconnectedCallback() {
    this.hoverObserver.destroy()
    clearTimeout(this.onTimer)
    clearTimeout(this.offTimer)
  }
}
