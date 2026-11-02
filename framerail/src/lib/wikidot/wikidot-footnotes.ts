const LEGACY_SCROLL_HANDLER =
  /^\s*WIKIDOT\.page\.utils\.scrollToReference\s*\(\s*(['"])([^'"]+)\1\s*\)\s*;?\s*$/u
const REFERENCE_TARGET_ID = /^(?:footnote(?:ref)?|bibitem|equation)-[A-Za-z0-9_-]+$/u

export function legacyReferenceTargetId(onclick: string | null) {
  if (!onclick) return null

  const match = LEGACY_SCROLL_HANDLER.exec(onclick)
  const targetId = match?.[2]
  return targetId && REFERENCE_TARGET_ID.test(targetId) ? targetId : null
}

function legacyFootnoteTarget(link: HTMLAnchorElement) {
  return legacyReferenceTargetId(link.getAttribute("onclick"))
}

function initializeFootnoteLinks(
  node: HTMLElement,
  targets: WeakMap<HTMLAnchorElement, string>
) {
  for (const link of node.querySelectorAll<HTMLAnchorElement>("a[onclick]")) {
    const targetId = legacyFootnoteTarget(link)
    if (!targetId) continue

    targets.set(link, targetId)
    link.removeAttribute("onclick")
  }
}

function findFootnoteLink(
  node: HTMLElement,
  target: EventTarget | null,
  targets: WeakMap<HTMLAnchorElement, string>
) {
  if (!(target instanceof Element)) return null

  const link = target.closest<HTMLAnchorElement>("a")
  const targetId = link && node.contains(link) ? targets.get(link) : undefined
  return link && targetId ? { link, targetId } : null
}

function revealHiddenFootnoteTarget(node: HTMLElement, target: HTMLElement) {
  const ancestors: HTMLElement[] = []
  for (
    let parent = target.parentElement;
    parent && parent !== node;
    parent = parent.parentElement
  ) {
    ancestors.push(parent)
  }

  for (const ancestor of ancestors.reverse()) {
    if (ancestor.classList.contains("collapsible-block")) {
      const unfolded = Array.from(ancestor.children).find((child) =>
        child.classList.contains("collapsible-block-unfolded")
      )
      if (unfolded?.contains(target) && !target.getClientRects().length) {
        const folded = Array.from(ancestor.children).find((child) =>
          child.classList.contains("collapsible-block-folded")
        )
        folded?.querySelector<HTMLAnchorElement>("a.collapsible-block-link")?.click()
      }
    }

    if (ancestor.classList.contains("yui-content")) {
      const panels = Array.from(ancestor.children)
      const panel = panels.find((child) => child.contains(target))
      if (panel && !target.getClientRects().length) {
        const panelIndex = panels.indexOf(panel)
        const tabView = ancestor.closest<HTMLElement>(".yui-navset")
        const tabLinks = tabView?.querySelectorAll<HTMLAnchorElement>(
          ":scope > .yui-nav > li > a"
        )
        tabLinks?.[panelIndex]?.click()
      }
    }
  }

  return target.getClientRects().length > 0
}

function revealFootnoteTarget(target: HTMLElement) {
  const prefersReducedMotion = window.matchMedia(
    "(prefers-reduced-motion: reduce)"
  ).matches
  target.scrollIntoView({
    behavior: prefersReducedMotion ? "auto" : "smooth",
    block: "center"
  })

  if (prefersReducedMotion || typeof target.animate !== "function") return

  target.animate(
    [
      { outline: "0 solid transparent" },
      { outline: "3px solid rgba(255, 190, 0, 0.95)", offset: 0.15 },
      { outline: "3px solid transparent" }
    ],
    { duration: 1600, easing: "ease-out" }
  )
}

export function wikidotFootnotes(node: HTMLElement) {
  const targets = new WeakMap<HTMLAnchorElement, string>()
  const controller = new AbortController()
  const initialize = () => initializeFootnoteLinks(node, targets)

  initialize()

  node.addEventListener(
    "click",
    (event) => {
      const footnoteLink = findFootnoteLink(node, event.target, targets)
      if (!footnoteLink) return

      event.preventDefault()
      const target = Array.from(node.querySelectorAll<HTMLElement>("[id]")).find(
        (element) => element.id === footnoteLink.targetId
      )
      if (target && revealHiddenFootnoteTarget(node, target)) revealFootnoteTarget(target)
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
