const AJAX_MODULE_CONNECTOR_HEADERS = {
  "cache-control": "no-store",
  "content-type": "text/plain; charset=UTF-8"
}

const isValidAjaxModuleStatus = (status: unknown) =>
  typeof status === "string" && status.length > 0

export const jsonResponse = (
  body: Record<string, unknown>,
  status = 200,
  extraHeaders: HeadersInit = {}
) =>
  new Response(
    JSON.stringify(
      isValidAjaxModuleStatus(body.status) ? body : { ...body, status: "not_ok" }
    ),
    {
      status,
      headers: { ...AJAX_MODULE_CONNECTOR_HEADERS, ...extraHeaders }
    }
  )
