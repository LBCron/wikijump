import type { Action } from "svelte/action"

/**
 * Wikidot's page init (retained WIKIDOT.combined.js) runs
 * `WIKIDOT.page.fixers.fixMenuList("top-bar")`, then `fixMenu("top-bar")`
 * and `fixMenu("side-bar")`. Its server HTML leaves a top-bar item's text
 * bare (`<li>About <ul>…`); the script wraps every item's leading text
 * node in a `javascript:;` anchor, which theme CSS such as `#top-bar
 * .top-bar > ul > li > a` targets, and toggles `sfhover` on hovered
 * items.
 */

/**
 * Wrap the first child of each list item in a `javascript:;` anchor when
 * that child is a text node, as fixMenuList does (whitespace-only text
 * included).
 */
export const wrapWikidotMenuListText = (root: Element) => {
  for (const item of root.getElementsByTagName("li")) {
    const first = item.firstChild
    if (first?.nodeType !== Node.TEXT_NODE) continue
    const link = document.createElement("a")
    item.insertBefore(link, first)
    link.append(first)
    // eslint-disable-next-line no-script-url -- fixMenuList's exact inert href.
    link.href = "javascript:;"
  }
}

const addHover = (event: Event) =>
  (event.currentTarget as Element).classList.add("sfhover")
const removeHover = (event: Event) =>
  (event.currentTarget as Element).classList.remove("sfhover")

const addMenuHover = (root: Element, hovered: WeakSet<Element>) => {
  for (const item of root.getElementsByTagName("li")) {
    if (hovered.has(item)) continue
    hovered.add(item)
    item.addEventListener("mouseover", addHover)
    item.addEventListener("mouseout", removeHover)
  }
}

/**
 * Apply Wikidot's menu fixers to `#top-bar` (`list: true`) or `#side-bar`,
 * and again whenever the bar's content is replaced.
 */
export const wikidotMenu: Action<Element, { list?: boolean } | undefined> = (
  root,
  options
) => {
  const list = options?.list ?? false
  const hovered = new WeakSet<Element>()
  const apply = () => {
    if (list) wrapWikidotMenuListText(root)
    addMenuHover(root, hovered)
  }
  apply()

  const observer = new MutationObserver(apply)
  observer.observe(root, { childList: true, subtree: true })

  return {
    destroy() {
      observer.disconnect()
      for (const item of root.getElementsByTagName("li")) {
        item.removeEventListener("mouseover", addHover)
        item.removeEventListener("mouseout", removeHover)
      }
    }
  }
}
