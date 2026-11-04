const SITE_TOOLS_REQUESTS = new Map([
  ["sitetools/SiteToolsModule", { callbackIndex: 1 }],
  ["sitetools/WantedPagesModule", { callbackIndex: 2 }],
  ["sitetools/OrphanedPagesModule", { callbackIndex: 3 }],
  ["list/ListDraftsModule", { callbackIndex: 4, location: "sitetools" }]
])

export const requestWikidotSiteToolsModule = async (
  fetcher: typeof fetch,
  moduleName: string,
  callbackIndex: number
) => {
  const shape = SITE_TOOLS_REQUESTS.get(moduleName)
  if (shape?.callbackIndex !== callbackIndex) {
    throw new TypeError("Unsupported Site Tools module request")
  }

  const form = new URLSearchParams({
    moduleName,
    callbackIndex: String(callbackIndex)
  })
  if (shape.location) form.set("location", shape.location)
  const response = await fetcher("/ajax-module-connector.php", {
    method: "POST",
    credentials: "same-origin",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: form.toString()
  })
  return response.json()
}
