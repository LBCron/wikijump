export type ScrollDirection = "vertical" | "horizontal" | "both"

export function scrollsVertically(element: HTMLElement) {
  // @ts-ignore - only works in Firefox
  if (element.scrollTopMax !== undefined) return element.scrollTopMax > 0

  if (element.clientHeight === 0) return false

  if (element.scrollHeight > element.clientHeight) {
    const overflow = window.getComputedStyle(element).overflowY
    if (overflow === "scroll" || overflow === "auto") return true
  }

  return false
}

export function scrollsHorizontally(element: HTMLElement) {
  // @ts-ignore - only works in Firefox
  if (element.scrollLeftMax !== undefined) return element.scrollLeftMax > 0

  if (element.clientWidth === 0) return false

  if (element.scrollWidth > element.clientWidth) {
    const overflow = window.getComputedStyle(element).overflowX
    if (overflow === "scroll" || overflow === "auto") return true
  }

  return false
}

export function scrolls(element: HTMLElement, dir: ScrollDirection = "both") {
  // prettier-ignore
  switch (dir) {
    case "both":       return scrollsVertically(element) || scrollsHorizontally(element)
    case "vertical":   return scrollsVertically(element)
    case "horizontal": return scrollsHorizontally(element)
  }
}

export function scrollElement(element: HTMLElement, dir: ScrollDirection = "vertical") {
  let node: HTMLElement | null = element
  while (node) {
    if (scrolls(node, dir)) return node
    node = node.parentElement
  }
  return null
}
