/**
 * Style half of the Wikidot interwiki frame runtime.
 *
 * This is a source-equivalent port of the `requestStyleChange` contract in
 * https://interwiki.scpwiki.com/interwiki.js (retrieved 2026-10-11): each
 * `styleFrame.html` query declares a `priority`, an optional `theme`
 * stylesheet, and optional inline `css`. The interwiki frame merges every
 * declaration into its own document head in ascending priority order, a
 * theme before inline CSS of the same priority, ignoring exact duplicates.
 * Style frames push their query when the interwiki frame is already
 * initialized; the interwiki frame pulls from style frames that loaded
 * first. Nothing is ever applied to the parent frameDocument.
 *
 * The function is serialized into the frame document with
 * `Function.prototype.toString`, so it must stay self-contained: no
 * imports and no references to module scope. `localizeThemeUrl` is passed
 * in the same way.
 */
export const installWikidotInterwikiStyleRuntime = (
  frameWindow: Window & {
    requestStyleChange?: (search: string) => void
    isInterwikiFrame?: boolean
    DOMException: typeof DOMException
    Event: typeof Event
  },
  config: { siteUrl: string },
  localizeThemeUrl: (themeUrl: string, origin: string | null | undefined) => string
): void => {
  const frameDocument = frameWindow.document

  const queryParameter = (search: string, name: string): string => {
    const query = search.indexOf("?") === 0 ? search.substring(1) : search
    const parts = query.split("&").reverse()
    const part = parts.find((candidate) => candidate.indexOf(`${name}=`) === 0)
    return part === undefined ? "" : decodeURIComponent(part.substring(name.length + 1))
  }

  const customStyles = (selector: string): HTMLElement[] =>
    Array.prototype.slice.call(frameDocument.head.querySelectorAll(selector))

  const sameDeclaration = (priority: number, value: string) => (element: HTMLElement) => {
    if (Number(element.getAttribute("data-priority")) !== priority) return false
    if (element.tagName === "LINK") return element.getAttribute("href") === value
    if (element.tagName === "STYLE") return element.textContent === value
    return false
  }

  const insertByPriority = (priority: number, element: HTMLElement) => {
    element.classList.add("custom-style")
    element.dataset.priority = String(priority)
    const tagName = element.tagName
    const inserted = customStyles("link.custom-style, style.custom-style").some(
      (existing) => {
        const existingPriority = Number(existing.dataset.priority)
        if (priority > existingPriority) return false
        if (
          existingPriority === priority &&
          existing.tagName === "LINK" &&
          tagName === "STYLE"
        ) {
          return false
        }
        frameDocument.head.insertBefore(element, existing)
        return true
      }
    )
    if (!inserted) frameDocument.head.appendChild(element)
  }

  const addTheme = (priority: number, href: string) => {
    if (customStyles("link.custom-style").some(sameDeclaration(priority, href))) return
    const link = frameDocument.createElement("link")
    link.rel = "stylesheet"
    link.href = href
    insertByPriority(priority, link)
  }

  const addCss = (priority: number, css: string) => {
    if (customStyles("style.custom-style").some(sameDeclaration(priority, css))) return
    const style = frameDocument.createElement("style")
    style.textContent = css
    insertByPriority(priority, style)
  }

  const resolveTheme = (theme: string): string => {
    if (theme.indexOf("http") === 0 || theme.indexOf("//") === 0) return theme
    if (!config.siteUrl) return ""
    if (theme.indexOf("/") === -1) return `${config.siteUrl}/local--code/${theme}/1`
    const parts = theme.split("/")
    return parts.length >= 3 && parts[1] === "code"
      ? `${config.siteUrl}/local--code/${parts[0]}/${parts[2]}`
      : ""
  }

  const requestStyleChange = (search: string): void => {
    const rawPriority = queryParameter(search, "priority")
    const priority = Number(rawPriority)
    if (Number.isNaN(priority)) return
    const theme = queryParameter(search, "theme")
    if (theme) {
      const href = resolveTheme(theme)
      if (href) addTheme(priority, localizeThemeUrl(href, frameWindow.location.origin))
    }
    const css = queryParameter(search, "css")
    if (css) addCss(priority, css)
  }
  frameWindow.requestStyleChange = requestStyleChange

  const pullStyleFrames = () => {
    Array.prototype.slice
      .call(frameWindow.parent)
      .forEach((frame: { isStyleFrame?: unknown; location: { search: string } }) => {
        try {
          if (frame.isStyleFrame) requestStyleChange(frame.location.search)
        } catch (error) {
          if (!(error instanceof frameWindow.DOMException)) throw error
        }
      })
  }

  const hideUntilThemesSettle = () => {
    const pendingStyle = frameDocument.createElement("style")
    pendingStyle.textContent = ".side-block{display:none}"
    pendingStyle.dataset.wikijumpThemePending = "true"
    frameDocument.head.appendChild(pendingStyle)
    return pendingStyle
  }

  const releaseWhenThemesSettle = (pendingStyle: HTMLStyleElement) => {
    let remaining = 0
    let released = false
    const release = () => {
      if (released) return
      released = true
      pendingStyle.textContent = ""
      if (typeof frameWindow.dispatchEvent === "function") {
        frameWindow.dispatchEvent(new frameWindow.Event("wikijump-themes-settled"))
      }
    }
    const settled = () => {
      remaining -= 1
      if (remaining <= 0) release()
    }
    const waiting = customStyles("link.custom-style").filter(
      (link) => !(link as HTMLLinkElement).sheet
    )
    remaining = waiting.length
    if (remaining === 0) {
      release()
      return
    }
    waiting.forEach((link) => {
      link.addEventListener("load", settled)
      link.addEventListener("error", settled)
    })
    if (typeof frameWindow.setTimeout === "function") {
      frameWindow.setTimeout(release, 5000)
    }
  }

  const initialize = () => {
    const pendingStyle = hideUntilThemesSettle()
    pullStyleFrames()
    frameWindow.isInterwikiFrame = true
    releaseWhenThemesSettle(pendingStyle)
  }
  if (frameDocument.readyState === "loading") {
    frameWindow.addEventListener("DOMContentLoaded", initialize)
  } else {
    initialize()
  }
}
