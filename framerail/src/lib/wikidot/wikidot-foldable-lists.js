/* eslint-disable no-script-url -- Preserve the source-compatible foldable link value. */

export function wikidotFoldableLists(node) {
  const controller = new AbortController()
  const containers = new WeakSet()
  const originalDisplays = new WeakMap()
  const pendingFocus = new Map()
  const cancelFocus = (owner) => pendingFocus.get(owner)?.()
  const focusRevealedDialog = (owner) => {
    cancelFocus(owner)
    const close = owner.querySelector(".close-credits")
    if (!close) return
    let frame
    const cleanup = () => {
      cancelAnimationFrame(frame)
      owner.removeEventListener("transitionend", attempt)
      owner.removeEventListener("animationend", attempt)
      pendingFocus.delete(owner)
    }
    const attempt = () => {
      if (
        controller.signal.aborted ||
        !node.contains(owner) ||
        !owner.classList.contains("unfolded")
      ) {
        cleanup()
        return
      }
      if (
        getComputedStyle(close).visibility !== "visible" ||
        close.getClientRects().length === 0
      ) {
        return
      }
      if (!close.closest(".modalcontainer")?.contains(document.activeElement)) {
        close.focus()
      }
      cleanup()
    }
    pendingFocus.set(owner, cleanup)
    owner.addEventListener("transitionend", attempt)
    owner.addEventListener("animationend", attempt)
    frame = requestAnimationFrame(attempt)
  }
  const initializeFoldableList = (list) => {
    if (originalDisplays.has(list)) return
    let parent = list.parentElement
    while (parent && !parent.classList.contains("foldable-list-container")) {
      if (parent.tagName === "LI") break
      parent = parent.parentElement
    }
    if (parent?.tagName !== "LI") return
    originalDisplays.set(list, list.style.display)
    if (!parent.classList.contains("folded") && !parent.classList.contains("unfolded")) {
      parent.classList.add("folded")
    }
    list.style.display = parent.classList.contains("unfolded")
      ? (originalDisplays.get(list) ?? "")
      : "none"
    const first = parent.firstChild
    if (first && !(first instanceof HTMLAnchorElement)) {
      const link = document.createElement("a")
      link.href = "javascript:;"
      parent.insertBefore(link, first)
      link.append(first)
    }
  }
  const initialize = () => {
    for (const container of node.querySelectorAll("div.foldable-list-container")) {
      let owner = container.parentElement
      while (owner && owner.tagName !== "LI") owner = owner.parentElement
      const ownedList = owner?.querySelector("ul")
      if (ownedList) initializeFoldableList(ownedList)
      for (const list of container.querySelectorAll("ul")) {
        initializeFoldableList(list)
      }
      const dialogOwner = container.closest("li")
      const dialog = dialogOwner?.querySelector(
        "#credit-view, #u-credit-view, .modalcontainer"
      )
      if (dialog) {
        dialog.setAttribute("role", "dialog")
        dialog.setAttribute("aria-modal", "true")
        dialog.setAttribute(
          "aria-hidden",
          String(!dialogOwner.classList.contains("unfolded"))
        )
      }
      for (const control of container.matches(".creditButton, .fader, .close-credits")
        ? [container]
        : container.querySelectorAll(".creditButton, .fader, .close-credits")) {
        control.setAttribute("role", "button")
        control.setAttribute("tabindex", "0")
        control.setAttribute(
          "aria-label",
          control.classList.contains("creditButton") ? "Info" : "Close Info"
        )
      }
      for (const control of dialogOwner?.querySelectorAll(".creditButton") ?? []) {
        control.setAttribute(
          "aria-expanded",
          String(dialogOwner.classList.contains("unfolded"))
        )
      }
      for (const link of container.querySelectorAll("a")) {
        const target = link.href.replace(/^[a-z]*:\/\/[^/]+\/([^/]+).*/, "/$1")
        if (target !== window.location.pathname) continue
        let parent = link.parentElement
        while (parent && !parent.classList.contains("foldable-list-container")) {
          if (parent.tagName === "LI" && parent.classList.contains("folded")) {
            parent.classList.replace("folded", "unfolded")
            const list = parent.querySelector("ul")
            if (list) list.style.display = originalDisplays.get(list) ?? ""
          }
          parent = parent.parentElement
        }
      }
      if (containers.has(container)) continue
      containers.add(container)
      container.addEventListener(
        "click",
        (event) => {
          let target =
            event.target instanceof Element ? event.target : event.target?.parentElement
          if (!target) return
          cancelFocus(target)
          const infoAction = target.closest(".creditButton, .fader, .close-credits")
          if (
            target.tagName === "A" &&
            target.href !== "#" &&
            target.href !== "javascript:;" &&
            !infoAction
          ) {
            return
          }
          while (
            target &&
            (target.tagName !== "LI" ||
              (!target.classList.contains("folded") &&
                !target.classList.contains("unfolded")))
          ) {
            target = target.parentElement
          }
          if (!target) return
          const list = target.querySelector("ul")
          const folded = target.classList.contains("folded")
          target.classList.replace(
            folded ? "folded" : "unfolded",
            folded ? "unfolded" : "folded"
          )
          if (list) {
            list.style.display = folded ? (originalDisplays.get(list) ?? "") : "none"
          }
          const dialog = target.querySelector(
            "#credit-view, #u-credit-view, .modalcontainer"
          )
          if (dialog) dialog.setAttribute("aria-hidden", String(!folded))
          for (const control of target.querySelectorAll(".creditButton")) {
            control.setAttribute("aria-expanded", String(folded))
          }
          if (folded) {
            focusRevealedDialog(target)
          } else if (
            event.target instanceof Element &&
            event.target.closest(".fader, .close-credits")
          ) {
            target.querySelector(".creditButton")?.focus()
          }
          event.preventDefault()
        },
        { signal: controller.signal }
      )
    }
  }
  initialize()
  const observer = new MutationObserver(initialize)
  observer.observe(node, { childList: true, subtree: true })

  const keydown = (event) => {
    const target = event.target instanceof Element ? event.target : null
    const control = target?.closest(".creditButton, .fader, .close-credits")
    if (control) {
      control.setAttribute("role", "button")
      control.setAttribute("tabindex", "0")
      control.setAttribute(
        "aria-label",
        control.classList.contains("creditButton") ? "Info" : "Close Info"
      )
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault()
        control.click()
        return
      }
    }

    const dialog = target?.closest(".modalcontainer")
    if (!dialog) return
    const owner = dialog.closest("li.folded, li.unfolded")
    if (!owner) return
    if (event.key === "Escape") {
      event.preventDefault()
      cancelFocus(owner)
      const opener = owner.querySelector(".creditButton")
      const list = owner.querySelector("ul")
      owner.classList.replace("unfolded", "folded")
      if (list) list.style.display = "none"
      const panel = dialog.closest("#credit-view, #u-credit-view") ?? dialog
      panel.setAttribute("aria-hidden", "true")
      opener?.setAttribute("aria-expanded", "false")
      opener?.focus()
      return
    }
    if (event.key !== "Tab") return
    const focusable = [
      ...dialog.querySelectorAll(
        'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
      )
    ].filter((element) => element.getAttribute("aria-hidden") !== "true")
    if (focusable.length === 0) {
      event.preventDefault()
      dialog.querySelector(".close-credits")?.focus()
      return
    }
    const first = focusable[0]
    const last = focusable.at(-1)
    if (
      event.shiftKey &&
      (document.activeElement === first || !dialog.contains(document.activeElement))
    ) {
      event.preventDefault()
      last.focus()
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault()
      first.focus()
    }
  }
  node.addEventListener("keydown", keydown, { signal: controller.signal })
  return {
    destroy() {
      observer.disconnect()
      for (const cancel of pendingFocus.values()) cancel()
      controller.abort()
    }
  }
}
