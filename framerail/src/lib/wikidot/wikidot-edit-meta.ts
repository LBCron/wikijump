const EDIT_META_MODULE = "edit/EditMetaModule"

const requireOkResponse = (value: unknown): { status: string; body?: unknown } => {
  if (
    !value ||
    typeof value !== "object" ||
    !("status" in value) ||
    value.status !== "ok"
  ) {
    throw new Error("Edit Meta request failed.")
  }
  return value as { status: string; body?: unknown }
}

export const parseWikidotEditMetaRows = (
  body: string,
  Parser: typeof DOMParser = DOMParser
) => {
  const document = new Parser().parseFromString(body, "text/html")
  return [...document.querySelectorAll('div[style="padding-left:3em;"] > div')].map(
    (row) => {
      const encodedMeta = row.textContent?.replace(/^\s*remove\s*/u, "") ?? ""
      const metaDocument = new Parser().parseFromString(encodedMeta, "text/html")
      const meta = metaDocument.querySelector("meta[name][content]")
      if (!meta) throw new Error("Edit Meta response row is malformed.")
      return {
        name: meta.getAttribute("name") ?? "",
        content: meta.getAttribute("content") ?? "",
        all_pages: /\(all pages\)\s*$/u.test(encodedMeta)
      }
    }
  )
}

const requestEditMeta = async (
  fetchImplementation: typeof fetch,
  fields: URLSearchParams
) => {
  const response = await fetchImplementation("/ajax-module-connector.php", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: fields.toString()
  })
  return requireOkResponse(await response.json())
}

export const loadWikidotEditMetaRows = async (
  fetchImplementation: typeof fetch,
  pageId: number
) => {
  const response = await requestEditMeta(
    fetchImplementation,
    new URLSearchParams({ moduleName: EDIT_META_MODULE, pageId: String(pageId) })
  )
  if (typeof response.body !== "string") {
    throw new Error("Edit Meta response body is malformed.")
  }
  return parseWikidotEditMetaRows(response.body)
}

export const saveWikidotMetaTag = (
  fetchImplementation: typeof fetch,
  input: {
    pageId: number
    name: string
    content: string
    allPages: boolean
  }
) =>
  requestEditMeta(
    fetchImplementation,
    new URLSearchParams({
      action: "WikiPageAction",
      event: "saveMetaTag",
      pageId: String(input.pageId),
      metaName: input.name,
      metaContent: input.content,
      ...(input.allPages ? { allPages: "true" } : {}),
      moduleName: EDIT_META_MODULE
    })
  )

export const deleteWikidotMetaTag = (
  fetchImplementation: typeof fetch,
  input: { pageId: number; name: string; allPages: boolean }
) =>
  requestEditMeta(
    fetchImplementation,
    new URLSearchParams({
      action: "WikiPageAction",
      event: "deleteMetaTag",
      pageId: String(input.pageId),
      metaName: input.name,
      ...(input.allPages ? { allPages: "true" } : {}),
      moduleName: EDIT_META_MODULE
    })
  )
