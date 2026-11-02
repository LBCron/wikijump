import { client } from "$lib/server/deepwell"

import type { RequestContext } from "../request-context"

export interface MailFormFieldError {
  field: string
  message: string
}

export interface MailFormSubmitInput {
  siteId: number
  formdef: string
  values: Record<string, string>
}

/**
 * Deepwell's answer to a MailForm submission. `status` is Wikidot's
 * connector vocabulary: `form_errors` carries one message per failing
 * field; `ok` carries the reader-facing success fields. The remaining
 * fields are the internal no-delivery record (Wikijump sends no email) and
 * are not forwarded to the browser.
 */
export interface MailFormSubmitOutput {
  status: string
  errors?: MailFormFieldError[]
  success_msg?: string | null
  success_page?: string | null
  delivery?: string | null
  message?: {
    recipients: string
    title: string
    body: string
  } | null
}

export async function mailFormSubmit(
  input: MailFormSubmitInput,
  requestContext: RequestContext = {}
): Promise<MailFormSubmitOutput> {
  return client.request(
    "mail_form_submit",
    {
      site_id: input.siteId,
      formdef: input.formdef,
      values: input.values
    },
    requestContext
  )
}
