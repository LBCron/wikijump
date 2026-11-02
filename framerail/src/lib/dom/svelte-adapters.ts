import {
  FocusGroup,
  FocusObserver,
  type FocusGroupDirection,
  type FocusOpts
} from "./focus"
import { HeldObserver, type WhileHeldOpts } from "./held"
import { HoverObserver, type HoverOpts } from "./hover"
import { KeyObserver, type InputHandler } from "./key-handling"
import { SwipeObserver, type SwipeOpts } from "./swipe"
import { UserLocaleObserver } from "./user-locale"

/**
 * Starts an event listener that will recognize swipes on the specified
 * element. Works natively with Svelte elements, if used as an
 * `use:onSwipe` action. For basic usage, provide `direction` and
 * `callback` properties in the options object.
 *
 * @example
 *   ;```svelte
 *   ;<div use:onSwipe={{ callback: callback, direction: "up" }} />
 *   ```
 */
export function onSwipe(target: HTMLElement, opts: Partial<SwipeOpts>) {
  const observer = new SwipeObserver(target, opts)
  return {
    update: (opts: Partial<SwipeOpts>) => observer.update(opts),
    destroy: () => observer.destroy()
  }
}

export function focusGroup(node: HTMLElement, direction: FocusGroupDirection) {
  const observer = new FocusGroup(node, direction)
  return {
    update: (direction: FocusGroupDirection) => observer.update(direction),
    destroy: () => observer.destroy()
  }
}

export function keyHandle(target: HTMLElement, handlers: InputHandler[]) {
  const observer = new KeyObserver(target, handlers)
  return {
    update: (handlers: InputHandler[]) => observer.update(handlers),
    destroy: () => observer.destroy()
  }
}

export function userLocale(target: HTMLElement, opts: App.PageData) {
  const observer = new UserLocaleObserver(target, opts)
  return {
    update: (opts: App.PageData) => observer.update(opts),
    destroy: () => observer.destroy()
  }
}

export function whileHeld(target: HTMLElement, opts: WhileHeldOpts) {
  const observer = new HeldObserver(target, opts)
  return {
    update: (opts: WhileHeldOpts) => observer.update(opts),
    destroy: () => observer.destroy()
  }
}

export function onHover(target: HTMLElement, opts: HoverOpts) {
  const observer = new HoverObserver(target, opts)
  return {
    update: (opts: HoverOpts) => observer.update(opts),
    destroy: () => observer.destroy()
  }
}

export function onFocus(target: HTMLElement, opts: FocusOpts) {
  const observer = new FocusObserver(target, opts)
  return {
    update: (opts: FocusOpts) => observer.update(opts),
    destroy: () => observer.destroy()
  }
}
