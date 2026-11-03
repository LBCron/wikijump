const NORENDER_KEY = "norender"
const ACTIVATING_VALUES: ReadonlySet<string> = new Set(["true", "t", "1", "false"])

export function queryNoRenderSelected(search: string): boolean {
  const params = new URLSearchParams(search)
  for (const [key, value] of params) {
    if (key.toLowerCase() !== NORENDER_KEY) continue
    return ACTIVATING_VALUES.has(value)
  }
  return false
}

export function articleRouteWithQueryNoRender<T extends { extra?: string | null }>(
  route: T | null,
  search: string
): T | null {
  if (!route || !queryNoRenderSelected(search)) return route
  const extra = route.extra ?? ""
  const selector = `${NORENDER_KEY}/true`
  return { ...route, extra: extra === "" ? selector : `${extra}/${selector}` }
}
