function directChildWithClass(parent: Element, className: string): Element | null {
  return (
    Array.from(parent.children).find((child) => child.classList.contains(className)) ??
    null
  )
}

function activateTab(link: HTMLAnchorElement): boolean {
  const item = link.parentElement
  const tabList = item?.parentElement
  const tabView = tabList?.parentElement

  if (
    item?.tagName !== "LI" ||
    tabList?.tagName !== "UL" ||
    !tabList.classList.contains("yui-nav") ||
    !tabView?.classList.contains("yui-navset")
  ) {
    return false
  }

  const items = Array.from(tabList.children).filter((child) => child.tagName === "LI")
  const selectedIndex = items.indexOf(item)
  const content = directChildWithClass(tabView, "yui-content")
  const panels = content ? Array.from(content.children) : []

  if (selectedIndex < 0 || selectedIndex >= panels.length) {
    return false
  }

  for (const [index, tabItem] of items.entries()) {
    const selected = index === selectedIndex
    tabItem.classList.toggle("selected", selected)
    if (selected) tabItem.setAttribute("title", "active")
    else tabItem.removeAttribute("title")
  }

  for (const [index, panel] of panels.entries()) {
    if (panel instanceof HTMLElement) {
      panel.style.display = index === selectedIndex ? "block" : "none"
    }
  }

  return true
}

export function wikidotTabviews(node: HTMLElement) {
  const controller = new AbortController()
  let cancelled = false
  let observer: MutationObserver | null = null

  const activateInitialTabviews = () => {
    for (const tabView of node.querySelectorAll<HTMLElement>(".yui-navset")) {
      tabView.classList.add("yui-navset-top")
      tabView
        .querySelector<HTMLElement>(":scope > .yui-nav > li.selected")
        ?.setAttribute("title", "active")
    }
  }

  const activateWhenWikidotReady = () => {
    if (cancelled) return
    if (
      document.readyState !== "loading" &&
      document.body &&
      document.getElementById("dummy-ondomready-block")
    ) {
      activateInitialTabviews()
      if (!observer) {
        observer = new MutationObserver(activateInitialTabviews)
        observer.observe(node, { childList: true, subtree: true })
      }
      return
    }
    window.setTimeout(activateWhenWikidotReady, 200)
  }

  activateWhenWikidotReady()

  node.addEventListener(
    "click",
    (event) => {
      if (!(event.target instanceof Element)) return

      const link = event.target.closest<HTMLAnchorElement>(
        ".yui-navset > .yui-nav > li > a"
      )
      if (!link || !node.contains(link) || !activateTab(link)) return

      event.preventDefault()
    },
    { signal: controller.signal }
  )

  return {
    destroy() {
      cancelled = true
      observer?.disconnect()
      controller.abort()
    }
  }
}
