const MAX_AJAX_MODULE_CONNECTOR_BODY_BYTES = 131_072
export const CONTROL_FIELDS = new Set([
  "moduleName",
  "module_body",
  "wikidot_token7",
  "callbackIndex",
  "eventSource"
])
const FORUM_POSITIVE_DECIMAL_FIELDS = new Set(["pageId", "c", "p", "t", "pageNo", "page"])

export const isSupportedPageReadShape = (
  moduleName: string,
  parameters: Record<string, string>
) => {
  if (moduleName === "pagerate/WhoRatedPageModule") {
    return isPositiveSafeDecimal(parameters.pageId)
  }
  if (
    moduleName === "viewsource/ViewSourceModule" ||
    moduleName === "files/PageFilesModule"
  ) {
    return isPositiveSafeDecimal(parameters.page_id)
  }
  if (moduleName === "history/PageRevisionListModule") {
    return (
      isPositiveSafeDecimal(parameters.page_id) &&
      parameters.options === "{'all': True}" &&
      parameters.perpage === "100000000"
    )
  }
  return isPositiveSafeDecimal(parameters.revision_id)
}

/**
 * Throws a TypeError or RangeError if the request is not a bounded, valid
 * URL-encoded UTF-8 form body.
 */
export const readUrlEncodedForm = async (
  request: Request
): Promise<{ fields: Map<string, string>; duplicateFields: Set<string> }> => {
  const contentType = request.headers.get("content-type")?.split(";", 1)[0].trim()
  if (contentType !== "application/x-www-form-urlencoded") {
    throw new TypeError("AJAX Module Connector requires URL-encoded form data")
  }

  const contentLength = request.headers.get("content-length")
  if (contentLength !== null) {
    const normalized = contentLength.trim()
    if (!/^\d+$/.test(normalized)) {
      throw new TypeError("AJAX Module Connector content length is invalid")
    }
    if (Number.parseInt(normalized, 10) > MAX_AJAX_MODULE_CONNECTOR_BODY_BYTES) {
      throw new RangeError("AJAX Module Connector request body is too large")
    }
  }

  const reader = request.body?.getReader()
  if (reader === undefined) {
    return { fields: new Map<string, string>(), duplicateFields: new Set<string>() }
  }

  const chunks: Uint8Array[] = []
  let byteLength = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      byteLength += value.byteLength
      if (byteLength > MAX_AJAX_MODULE_CONNECTOR_BODY_BYTES) {
        throw new RangeError("AJAX Module Connector request body is too large")
      }
      chunks.push(value)
    }
  } finally {
    reader.releaseLock()
  }

  const bytes = new Uint8Array(byteLength)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  const body = new TextDecoder("utf-8", { fatal: true }).decode(bytes)
  const form = new URLSearchParams(body)
  const values = new Map<string, string>()
  const duplicateFields = new Set<string>()
  for (const [key, value] of form) {
    if (values.has(key)) duplicateFields.add(key)
    values.set(key, value)
  }
  return { fields: values, duplicateFields }
}

export const fieldValue = (fields: Map<string, string>, name: string) =>
  fields.get(name) ?? ""

/**
 * Selected public token from the request cookie jar. Live Wikidot binds
 * the ListPages `wikidot_token7` form field to the presented cookie by
 * exact echo: any echoed value is accepted and any mismatch fails with
 * `wrong_token7`, without a server-issued allowlist. Duplicate cookie
 * names keep the first value, matching the observed Wikidot cookie
 * parser.
 */
export const requestWikidotTokenCookie = (request: Request) => {
  const header = request.headers.get("cookie")
  if (header === null) return undefined
  let selected: string | undefined
  for (const part of header.split(";")) {
    const separator = part.indexOf("=")
    if (separator === -1) continue
    if (part.slice(0, separator).trim() !== "wikidot_token7") continue
    if (selected === undefined) selected = part.slice(separator + 1).trim()
  }
  return selected
}

const isCanonicalPositiveDecimal = (value: string) => /^[1-9][0-9]*$/u.test(value)

export const isCanonicalNonNegativeDecimal = (value: string) =>
  /^(?:0|[1-9][0-9]*)$/u.test(value) && Number.isSafeInteger(Number.parseInt(value, 10))

export const isPositiveSafeDecimal = (value: string) => {
  if (!isCanonicalPositiveDecimal(value)) return false
  return Number.isSafeInteger(Number.parseInt(value, 10))
}

export const forumNumericParametersAreCanonical = (
  parameters: Record<string, string>
) => {
  for (const field of FORUM_POSITIVE_DECIMAL_FIELDS) {
    const value = parameters[field]
    if (value !== undefined && !isCanonicalPositiveDecimal(value)) return false
  }
  const categoryId = parameters.categoryId
  return (
    categoryId === undefined ||
    categoryId === "" ||
    isCanonicalPositiveDecimal(categoryId)
  )
}
