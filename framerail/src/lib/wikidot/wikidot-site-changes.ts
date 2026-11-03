const SITE_CHANGES_MODULE = "changes/SiteChangesListModule"
const UPDATE_LIST_ONCLICK = "WIKIDOT.modules.SiteChangesModule.listeners.updateList(null)"

export type SiteChangesActionParameters = { pageId: number | string }

export type SiteChangesRoot = Window & typeof globalThis

/**
 * Return only the request options whose browser meaning is already
 * established. The category-refresh slice does not infer the semantics of
 * checkbox mixtures.
 */
const observedRevisionOptions = (box: ParentNode) => {
  const all = box.querySelector<HTMLInputElement>("#rev-type-all")
  const source = box.querySelector<HTMLInputElement>("#rev-type-source")
  const files = box.querySelector<HTMLInputElement>("#rev-type-files")
  const others = [
    "#rev-type-new",
    "#rev-type-title",
    "#rev-type-move",
    "#rev-type-tags",
    "#rev-type-meta"
  ].map((selector) => box.querySelector<HTMLInputElement>(selector))
  if (!all || !source || !files || others.some((control) => !control)) return null

  const checkedOthers = others.some((control) => control?.checked)
  if (all.checked && !source.checked && !files.checked && !checkedOthers) {
    return '{"all":true}'
  }
  if (!all.checked && source.checked && !files.checked && !checkedOthers) {
    return '{"source":true}'
  }
  if (!all.checked && !source.checked && files.checked && !checkedOthers) {
    return '{"files":true}'
  }
  return null
}

/**
 * Bridge the renderer-owned SiteChanges Update list control to its
 * existing read-only module endpoint. Unsupported revision checkbox
 * combinations remain inert until their Wikidot semantics are
 * established.
 */
export const wikidotSiteChanges = (
  root: HTMLElement,
  parameters: SiteChangesActionParameters
) => {
  let pageId = parameters.pageId

  const updateList = (event: Event) => {
    const target = event.target
    if (!(target instanceof Element)) return
    const control = target.closest(
      '.site-changes-box input[type="button"][value="Update list"]'
    )
    if (
      !control ||
      !root.contains(control) ||
      control.getAttribute("onclick") !== UPDATE_LIST_ONCLICK
    ) {
      return
    }

    event.preventDefault()
    event.stopPropagation()
    event.stopImmediatePropagation?.()

    const box = control.closest(".site-changes-box")
    const category = box?.querySelector<HTMLInputElement | HTMLSelectElement>(
      "#rev-category"
    )
    const perpage = box?.querySelector<HTMLInputElement | HTMLSelectElement>(
      "#rev-perpage"
    )
    const list = box?.querySelector("#site-changes-list.changes-list")
    const options = box && observedRevisionOptions(box)
    const normalizedPageId = String(pageId)
    if (
      !box ||
      !category ||
      !perpage ||
      !list ||
      !options ||
      !/^[1-9][0-9]*$/u.test(normalizedPageId) ||
      !Number.isSafeInteger(Number(normalizedPageId))
    ) {
      return
    }

    const form = new URLSearchParams({
      moduleName: SITE_CHANGES_MODULE,
      page: "1",
      perpage: perpage.value,
      pageId: normalizedPageId,
      categoryId: category.value,
      options
    })
    const window = root.ownerDocument.defaultView
    if (!window) return
    void window
      .fetch("/ajax-module-connector.php", {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: form.toString()
      })
      .then((response) => (response.ok ? response.json() : null))
      .then((response) => {
        if (response?.status === "ok" && typeof response.body === "string") {
          list.innerHTML = response.body
        }
      })
      .catch(() => {})
  }

  root.addEventListener("click", updateList, true)
  return {
    update(nextParameters: SiteChangesActionParameters) {
      pageId = nextParameters.pageId
    },
    destroy() {
      root.removeEventListener("click", updateList, true)
    }
  }
}
