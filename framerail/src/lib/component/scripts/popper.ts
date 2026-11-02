import * as Popper from "@popperjs/core"

export interface PopoverOpts {
  when?: boolean
  placement?: Popper.Placement
  target?: Element | null
}

export function popover(elem: Element, opts: PopoverOpts) {
  let instance: Popper.Instance | undefined

  const destroy = () => {
    if (instance) {
      instance.destroy()
      instance = undefined
    }
  }

  const update = ({
    when = true,
    placement = "auto",
    target = elem.parentElement
  }: PopoverOpts) => {
    if ((!when && instance) || (instance && !target)) {
      destroy()
    } else if (when && target) {
      if (instance) destroy()
      if (target) {
        instance = Popper.createPopper(target, elem as HTMLElement, {
          placement: placement
        })
      }
    }
  }

  update(opts)

  return { update, destroy }
}
