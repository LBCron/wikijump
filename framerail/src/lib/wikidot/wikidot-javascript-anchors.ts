const JAVASCRIPT_URL_ANCHOR = 'a[href="javascript:;"]'

export function installJavascriptAnchorGuard(
  root: Pick<EventTarget, "addEventListener" | "removeEventListener">
): () => void {
  const guard = (event: Event) => {
    if (event.defaultPrevented) return
    const target = event.target as {
      closest?: (selector: string) => unknown
    } | null
    if (typeof target?.closest !== "function") return
    if (target.closest(JAVASCRIPT_URL_ANCHOR)) event.preventDefault()
  }

  root.addEventListener("click", guard)
  return () => root.removeEventListener("click", guard)
}
