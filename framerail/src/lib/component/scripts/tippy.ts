import tippy, { followCursor, inlinePositioning, roundArrow, type Props } from "tippy.js"

export const DEFAULT_TIPPY_OPTS: Partial<Props> = {
  ignoreAttributes: true,
  theme: "wikijump",
  arrow: roundArrow,
  animation: "scale",
  touch: ["hold", 600],
  duration: [50, 100],
  delay: [400, 50],
  inlinePositioning: true,
  plugins: [followCursor, inlinePositioning]
}

export function parseTipOpts(elem: Element, opts: Partial<Props> | string) {
  if (opts) {
    if (typeof opts === "string") {
      opts = { content: opts }
    } else if (!opts.content) {
      opts.content = elem.getAttribute("aria-label") ?? ""
    }
  } else {
    opts = { content: elem.getAttribute("aria-label") ?? "" }
  }

  if (!opts.appendTo) {
    const dialog = elem.closest("dialog")
    if (dialog) {
      opts.appendTo = dialog
      opts.popperOptions = {
        ...opts?.popperOptions,
        strategy: "fixed"
      }
    }
  }

  return { ...DEFAULT_TIPPY_OPTS, ...opts }
}

export function tip(elem: Element, opts: Partial<Props> | string = "") {
  opts = parseTipOpts(elem, opts)
  const tp = tippy(elem, opts)
  const setState = (content: unknown) => {
    if (!content) tp.disable()
    else tp.enable()
  }
  setState(opts.content)
  return {
    update(opts: Partial<Props> | string = "") {
      opts = parseTipOpts(elem, opts)
      tp.setProps(opts)
      setState(opts.content)
    },
    destroy() {
      tp.destroy()
    }
  }
}
