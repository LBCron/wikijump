import { fieldValue } from "./request.js"
import { jsonResponse } from "./response.js"

const MAIL_FORM_ACTION = "wiki/MailFormAction"
const MAIL_FORM_SEND_EVENT = "sendForm"
const MAIL_FORM_FIELDS = new Set([
  "action",
  "event",
  "moduleName",
  "wikidot_token7",
  "callbackIndex",
  "formdata",
  "formdef"
])

/**
 * Wikidot's MailFormModule script posts two fields under action
 * wiki/MailFormAction, event sendForm, moduleName "Empty": formdata (the
 * JSON encoding of OZONE.utils.formToArray -- a flat field-name-to-value
 * object) and formdef (the definition handle rendered into the page). Its
 * callback consumes exactly a "form_errors" status with an errors map
 * keyed by field name, or an "ok" status with successMsg and an optional
 * successPage redirect. Returns null when the request is not a MailForm
 * send.
 *
 * @param {{
 *   fields: Map<string, string>
 *   moduleName: string
 *   siteId: number
 *   submitMailForm?: (input: {
 *     siteId: number
 *     formdef: string
 *     values: Record<string, string>
 *   }) => Promise<{
 *     status: string
 *     errors?: { field: string; message: string }[]
 *     success_msg?: string | null
 *     success_page?: string | null
 *   }>
 * }} input
 */
export async function handleMailFormAction({
  fields,
  moduleName,
  siteId,
  submitMailForm
}) {
  if (
    fields.get("action") !== MAIL_FORM_ACTION ||
    fields.get("event") !== MAIL_FORM_SEND_EVENT
  ) {
    return null
  }
  const callbackIndex = fields.has("callbackIndex")
    ? fieldValue(fields, "callbackIndex")
    : null
  const formdef = fieldValue(fields, "formdef")
  let values
  try {
    values = JSON.parse(fieldValue(fields, "formdata"))
  } catch {
    values = undefined
  }
  const supportedShape =
    moduleName === "Empty" &&
    formdef.length > 0 &&
    [...fields.keys()].every((field) => MAIL_FORM_FIELDS.has(field)) &&
    values !== undefined &&
    typeof values === "object" &&
    values !== null &&
    !Array.isArray(values) &&
    Object.values(values).every((value) => typeof value === "string")
  if (!supportedShape || !submitMailForm) {
    return jsonResponse({
      status: "not_ok",
      callbackIndex,
      CURRENT_TIMESTAMP: Math.floor(Date.now() / 1000)
    })
  }
  try {
    const output = await submitMailForm({ siteId, formdef, values })
    if (output.status === "form_errors") {
      const errors = {}
      for (const error of output.errors ?? []) {
        errors[error.field] = error.message
      }
      return jsonResponse({
        status: "form_errors",
        errors,
        callbackIndex,
        CURRENT_TIMESTAMP: Math.floor(Date.now() / 1000)
      })
    }
    if (output.status !== "ok") {
      return jsonResponse({
        status: "not_ok",
        callbackIndex,
        CURRENT_TIMESTAMP: Math.floor(Date.now() / 1000)
      })
    }
    return jsonResponse({
      status: "ok",
      successMsg: output.success_msg ?? "",
      ...(output.success_page ? { successPage: output.success_page } : {}),
      callbackIndex,
      CURRENT_TIMESTAMP: Math.floor(Date.now() / 1000)
    })
  } catch (error) {
    console.error("AJAX MailForm submission failed", error)
    return jsonResponse({
      status: "not_ok",
      callbackIndex,
      CURRENT_TIMESTAMP: Math.floor(Date.now() / 1000)
    })
  }
}
