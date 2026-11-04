export type NewPageHelperResponse = {
  status?: string
  goToUrl?: string
  unixName?: string
  templateId?: string
  pageTitle?: string
  tags?: string
  parentPage?: string
  message?: string
}

export type NewPageHelperModule = {
  listeners: Record<string, (event: Event) => false>
  callbacks: Record<string, (data: NewPageHelperResponse) => void>
}

export type WikidotNewPageRoot = Window &
  typeof globalThis & {
    WIKIDOT?: {
      modules?: {
        NewPageHelperModule?: NewPageHelperModule
      }
    }
    __wikijumpNewPageHelperSubmitListenerInstalled?: boolean
  }

const ensureWikidotNamespace = (root: WikidotNewPageRoot): NewPageHelperModule => {
  const wikidot = (root.WIKIDOT ??= {})
  const modules = (wikidot.modules ??= {})
  return (modules.NewPageHelperModule ??= { listeners: {}, callbacks: {} })
}

const eventTarget = (event: Event | undefined): Element | null =>
  event && "target" in event && event.target instanceof Element ? event.target : null

const containingForm = (target: Element | null): HTMLFormElement | null => {
  let cursor = target
  while (cursor && !(cursor instanceof HTMLFormElement)) {
    cursor = cursor.parentElement
  }
  return cursor instanceof HTMLFormElement ? cursor : null
}

const cookieValue = (root: WikidotNewPageRoot, name: string): string => {
  const cookie = root.document?.cookie ?? ""
  for (const part of cookie.split(";")) {
    const [rawName, ...rawValue] = part.trim().split("=")
    if (rawName === name) return rawValue.join("=")
  }
  return ""
}

const formToUrlSearchParams = (
  root: WikidotNewPageRoot,
  form: HTMLFormElement
): URLSearchParams => {
  const params = new URLSearchParams()
  for (const control of Array.from(form.elements)) {
    if (
      !(control instanceof HTMLInputElement) &&
      !(control instanceof HTMLSelectElement) &&
      !(control instanceof HTMLTextAreaElement)
    ) {
      continue
    }
    if (!control.name || control.disabled) continue
    if (
      control instanceof HTMLInputElement &&
      ["checkbox", "radio"].includes(control.type) &&
      !control.checked
    ) {
      continue
    }
    params.set(control.name, control.value)
  }
  params.set("action", "misc/NewPageHelperAction")
  params.set("event", "createNewPage")
  params.set("moduleName", "Empty")
  const wikidotToken7 = cookieValue(root, "wikidot_token7")
  if (wikidotToken7) params.set("wikidot_token7", wikidotToken7)
  return params
}

const navigateToSameOriginPath = (root: WikidotNewPageRoot, path: string): boolean => {
  let target: URL
  try {
    target = new URL(path, root.location.href)
  } catch {
    return false
  }
  if (target.origin !== root.location.origin) return false

  root.location.href = path
  return true
}

const redirectFromNewPageResponse = (
  root: WikidotNewPageRoot,
  data: NewPageHelperResponse
): void => {
  if (data.goToUrl) {
    if (data.goToUrl === ".") {
      root.location.reload()
      return
    }
    navigateToSameOriginPath(root, `/${data.goToUrl}`)
    return
  }

  let path = `/${data.unixName ?? ""}/edit/true`
  if (data.templateId) path += `/t/${data.templateId}`
  if (data.pageTitle) path += `/title/${encodeURIComponent(data.pageTitle)}`
  if (data.tags) path += `/tags/${encodeURIComponent(data.tags)}`
  if (data.parentPage) path += `/parentPage/${encodeURIComponent(data.parentPage)}`
  navigateToSameOriginPath(root, path)
}

const handleNewPageError = (
  root: WikidotNewPageRoot,
  data: NewPageHelperResponse
): void => {
  const message = data.message || data.status || "NewPage request failed"
  root.alert(message)
}

const isNewPageHelperForm = (form: HTMLFormElement) => {
  return (
    form.getAttribute("onsubmit")?.includes("NewPageHelperModule.listeners.create") ||
    form.closest(".new-page-box") !== null
  )
}

export const installWikidotNewPageHelper = (
  root: WikidotNewPageRoot = globalThis as WikidotNewPageRoot
) => {
  const helper = ensureWikidotNamespace(root)
  helper.listeners ??= {}
  helper.callbacks ??= {}

  helper.callbacks.create = (data) => {
    if (data?.status !== "ok") {
      handleNewPageError(root, data ?? {})
      return
    }
    redirectFromNewPageResponse(root, data)
  }

  helper.listeners.create = (event) => {
    event?.preventDefault()
    event?.stopPropagation()

    const form = containingForm(eventTarget(event))
    if (!form) return false

    const templateSelect = form.querySelector("select[name='template']")
    if (templateSelect instanceof HTMLSelectElement && templateSelect.value === "") {
      root.alert("Please select a template.")
      return false
    }

    void fetch("/ajax-module-connector.php", {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded"
      },
      body: formToUrlSearchParams(root, form),
      credentials: "same-origin"
    })
      .then((response) => response.json())
      .then((data) => helper.callbacks.create(data))
      .catch(() => {
        root.alert("NewPage request failed")
      })

    return false
  }

  if (!root.__wikijumpNewPageHelperSubmitListenerInstalled) {
    root.document?.addEventListener(
      "submit",
      (event) => {
        if (
          event.target instanceof HTMLFormElement &&
          isNewPageHelperForm(event.target)
        ) {
          helper.listeners.create(event)
        }
      },
      true
    )
    root.__wikijumpNewPageHelperSubmitListenerInstalled = true
  }

  return helper
}
