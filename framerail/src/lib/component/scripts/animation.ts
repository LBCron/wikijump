import * as easings from "svelte/easing"
import { Media } from "./media"

export interface AnimOpts {
  delay?: number
  duration?: number
  easing?: keyof typeof easings
  forceReduced?: boolean
  css: (t: number, u: number) => string | string[]
}

/**
 * Svelte `transition`, `in`, or `out` function for creating CSS-based
 * animations.
 *
 * @example
 *   ```svelte
 *   <!-- Scales the element in and out -->
 *   <div
 *   transition:anim={{
 *   duration: 250,
 *   css: t => `transform: scale(${t})`
 *   }}
 *   />
 *   ```
 */
export function anim(
  node: Element,
  { delay = 0, duration = 500, easing = "quintInOut", forceReduced, css }: AnimOpts
) {
  if (!forceReduced && Media.reducedMotion) return {}

  const cb = (t: number, u: number) => {
    const result = css(t, u)
    return typeof result === "string" ? result : result.join(";")
  }

  return {
    delay,
    duration,
    easing: easings[easing],
    css: cb
  }
}

export function unfold(node: Element, opts: Omit<AnimOpts, "css">) {
  const height = node.getBoundingClientRect().height
  const css = (t: number) => `max-height: ${t * height}px`
  return anim(node, { ...opts, css })
}
