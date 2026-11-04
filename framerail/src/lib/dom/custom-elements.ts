export type CustomElement = typeof HTMLElement & { tag: string }

export function addElement<E extends CustomElement>(element: E, global?: string) {
  if (!customElements.get(element.tag)) customElements.define(element.tag, element)

  if (global) (globalThis as Record<string, unknown>)[global] = element
}

export function upgrade(root: HTMLElement, to: CustomElement) {
  const elements = root.querySelectorAll(to.tag)
  for (let i = 0; i < elements.length; i++) {
    if (!(elements[i] instanceof to)) customElements.upgrade(elements[i])
  }
}
