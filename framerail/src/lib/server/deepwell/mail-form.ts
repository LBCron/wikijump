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
