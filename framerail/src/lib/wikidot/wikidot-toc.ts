function tocControl(node: HTMLElement, target: EventTarget | null) {
  if (!(target instanceof Element)) return null

  const link = target.closest<HTMLAnchorElement>("#toc-action-bar a")
  if (!link || !node.contains(link)) return null

  const toc = link.closest<HTMLElement>("div#toc")
  const controls = toc
    ? Array.from(toc.querySelectorAll<HTMLAnchorElement>("#toc-action-bar a"))
    : []
  const action = controls[0] === link ? "fold" : controls[1] === link ? "unfold" : null
  const list = toc?.querySelector<HTMLElement>("#toc-list")
  if (!action || controls.length !== 2 || !toc || !list) return null

  return { action, controls, list }
}

function initializeTocControls(node: HTMLElement) {
  for (const link of node.querySelectorAll<HTMLAnchorElement>(
    'div#toc-action-bar a[onclick*="foldToc"]'
  )) {
    link.removeAttribute("onclick")
  }
}

export function wikidotToc(node: HTMLElement) {
  const controller = new AbortController()

  const initialize = () => initializeTocControls(node)
  initialize()

  node.addEventListener(
    "click",
    (event) => {
      const control = tocControl(node, event.target)
      if (!control) return

      const folding = control.action === "fold"
      control.list.style.display = folding ? "none" : "block"
      control.controls[0].style.display = folding ? "none" : ""
      control.controls[1].style.display = folding ? "" : "none"
      event.preventDefault()
    },
    { signal: controller.signal }
  )

  const observer = new MutationObserver(initialize)
  observer.observe(node, { childList: true, subtree: true })

  return {
    destroy() {
      observer.disconnect()
      controller.abort()
    }
  }
}
