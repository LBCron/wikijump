export const wikidotSearchPath = (query: string): string =>
  `/search:site/q/${encodeURIComponent(query)}`

export const submitWikidotTopSearch = (
  event: SubmitEvent,
  windowObject: Window
): boolean => {
  const input = (
    event.currentTarget as {
      elements?: {
        namedItem?: (name: string) => { value?: unknown } | null
      }
    } | null
  )?.elements?.namedItem?.("query")
  if (typeof input?.value !== "string") return false
  event.preventDefault()
  windowObject.location.href = wikidotSearchPath(input.value)
  return true
}

export const wikidotSearchAllPath = (query: string, area: string): string =>
  `/search:all/a/${area}/q/${encodeURIComponent(query)}`

export const installWikidotSearchAll = (windowObject: Window): (() => void) => {
  const submit = (event: Event) => {
    const form = event.target as {
      id?: string
      elements: { namedItem: (name: string) => { value: string } }
    } | null
    if (form?.id !== "search-form-all") return
    event.preventDefault()
    const query = form.elements.namedItem("query").value
    const area = form.elements.namedItem("area").value
    windowObject.location.href = wikidotSearchAllPath(query, area)
  }

  windowObject.document.addEventListener("submit", submit, true)
  return () => windowObject.document.removeEventListener("submit", submit, true)
}
