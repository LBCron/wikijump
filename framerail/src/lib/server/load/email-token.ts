import defaults from "$lib/defaults"

import { authGetSession } from "$lib/server/auth/get-session"
import {
  accountDeleteComplete,
  accountDeleteIssue,
  accountDeleteRedeem,
  emailVerifyIssue,
  emailVerifyRedeem,
  passwordResetComplete,
  passwordResetIssue,
  passwordResetRedeem
} from "$lib/server/deepwell/email-token"
import { translate } from "$lib/server/deepwell/translate"
import { resolveClientIp } from "$lib/server/client-ip"
import { getRequestContext } from "$lib/server/request-context"
import {
  failForActionError,
  failForMissingSession,
  requireActionSession
} from "$lib/server/load/action-error"
import {
  clearRegisterPasswords,
  redactAuthActionPayload
} from "$lib/server/load/auth-form-redaction"
import {
  isEmailTokenWellFormed,
  normalizeLookupEmail
} from "$lib/server/load/email-token-validation"
import { loadSiteInfo } from "$lib/server/load/site-info"
import { fail, redirect } from "@sveltejs/kit"
import { superValidate } from "sveltekit-superforms"
import { valibot } from "sveltekit-superforms/adapters"
import {
  email as emailRule,
  forward,
  minLength,
  object,
  partialCheck,
  pipe,
  string,
  transform
} from "valibot"

import type { PreloadDataAsync } from "$lib/server/deepwell/views"
import type { TranslateKeys } from "$lib/types"
import type { RequestEvent } from "@sveltejs/kit"

function failForMalformedToken(token: unknown, buildBody: () => Record<string, unknown>) {
  if (!isEmailTokenWellFormed(token)) {
    return fail(400, {
      ...buildBody(),
      message: "The email token is invalid or expired"
    })
  }
  return null
}

// The backend trims surrounding whitespace before lookup, so the form
// accepts a pasted padded address and normalizes it the same way.
const emailSchema = object({
  email: pipe(
    string(),
    transform((value) => value.trim()),
    emailRule(),
    minLength(1)
  )
})

const tokenSchema = object({
  token: pipe(string(), minLength(1))
})

const newPasswordSchema = pipe(
  object({
    grant: pipe(string(), minLength(1)),
    password: pipe(string(), minLength(1)),
    confirmPassword: pipe(string(), minLength(1))
  }),
  forward(
    partialCheck(
      [["password"], ["confirmPassword"]],
      ({ password, confirmPassword }) => password === confirmPassword,
      "Passwords do not match"
    ),
    ["confirmPassword"]
  )
)

async function loadEmailTokenCopy(
  request: Request,
  preloadData: PreloadDataAsync,
  translateKeys: TranslateKeys
) {
  loadSiteInfo(request.headers)

  const parentData = await preloadData()
  const internationalization = await translate(parentData.locales, {
    ...defaults.translateKeys,
    ...translateKeys
  })

  return { internationalization }
}

export async function loadForgotPage(request: Request, preloadData: PreloadDataAsync) {
  const copy = await loadEmailTokenCopy(request, preloadData, {
    "password-recovery": {},
    "password-recovery.email-sent": {},
    "email": {},
    "send": {}
  })
  const forgotForm = await superValidate(valibot(emailSchema))
  return { ...copy, forgotForm, sent: false }
}

export async function forgotAction({ request, getClientAddress }: RequestEvent) {
  const ipAddress: string = resolveClientIp(request, getClientAddress())
  const form = await superValidate(request, valibot(emailSchema))

  if (!form.valid) {
    return fail(400, { form })
  }

  // The backend answers identically whether or not an account holds the
  // address, so success here never signals account existence.
  try {
    await passwordResetIssue(
      { email: normalizeLookupEmail(form.data.email), ipAddress },
      {}
    )
    return { form, sent: true }
  } catch (error) {
    return failForActionError(error, { form }, 500)
  }
}

export async function loadVerifyPage(request: Request, preloadData: PreloadDataAsync) {
  const copy = await loadEmailTokenCopy(request, preloadData, {
    "wiki-auth-verify-email": {},
    "wiki-auth-verify-email.intro": {},
    "wiki-auth-verify-email.email-sent": {},
    "wiki-auth-verify-email.resend-email": {},
    "email": {},
    "send": {}
  })
  const verifyForm = await superValidate(valibot(emailSchema))
  return { ...copy, verifyForm, sent: false }
}

export async function verifyIssueAction({ request, getClientAddress }: RequestEvent) {
  const ipAddress: string = resolveClientIp(request, getClientAddress())
  const form = await superValidate(request, valibot(emailSchema))

  if (!form.valid) {
    return fail(400, { form })
  }

  try {
    await emailVerifyIssue(
      { email: normalizeLookupEmail(form.data.email), ipAddress },
      {}
    )
    return { form, sent: true }
  } catch (error) {
    return failForActionError(error, { form }, 500)
  }
}

export async function loadVerifyTokenPage(
  request: Request,
  preloadData: PreloadDataAsync,
  token: string
) {
  const copy = await loadEmailTokenCopy(request, preloadData, {
    "wiki-auth-verify-email-link": {},
    "wiki-auth-verify-email-link.waiting": {},
    "wiki-auth-verify-email-link.please-interact": {},
    "wiki-auth-verify-email-link.instructions": {},
    "wiki-auth-verify-email-link.success": {}
  })
  const verifyTokenForm = await superValidate({ token }, valibot(tokenSchema))
  return { ...copy, verifyTokenForm, verified: false }
}

// Redemption happens on POST (the visitor's click/tap/keypress), never on
// page load: prefetchers and link scanners must not consume single-use
// links, and the bundle's verify-link copy promises exactly this gate.
export async function verifyRedeemAction({ request, getClientAddress }: RequestEvent) {
  const ipAddress: string = resolveClientIp(request, getClientAddress())
  const form = await superValidate(request, valibot(tokenSchema))

  if (!form.valid) {
    return fail(400, { form })
  }

  const malformed = failForMalformedToken(form.data.token, () => ({ form }))
  if (malformed) {
    return malformed
  }

  try {
    await emailVerifyRedeem({ token: form.data.token, ipAddress }, {})
    return { form, verified: true }
  } catch (error) {
    return failForActionError(error, { form }, 500)
  }
}

export async function loadResetTokenPage(
  request: Request,
  preloadData: PreloadDataAsync,
  token: string
) {
  const copy = await loadEmailTokenCopy(request, preloadData, {
    "password-recovery": {},
    "reset-password": {},
    "login": {},
    "password": {},
    "confirm-password": {},
    "send": {}
  })
  const tokenForm = await superValidate({ token }, valibot(tokenSchema))
  const resetForm = await superValidate(valibot(newPasswordSchema))
  return { ...copy, tokenForm, resetForm, grant: null as string | null }
}

export async function resetRedeemAction({ request, getClientAddress }: RequestEvent) {
  const ipAddress: string = resolveClientIp(request, getClientAddress())
  const form = await superValidate(request, valibot(tokenSchema))

  if (!form.valid) {
    return fail(400, { form })
  }

  const malformed = failForMalformedToken(form.data.token, () => ({ form }))
  if (malformed) {
    return malformed
  }

  try {
    const { grant } = await passwordResetRedeem({ token: form.data.token, ipAddress }, {})
    return { form, grant }
  } catch (error) {
    return failForActionError(error, { form }, 500)
  }
}

const deleteConfirmSchema = pipe(
  object({
    grant: pipe(string(), minLength(1)),
    password: pipe(string(), minLength(1)),
    confirmPassword: pipe(string(), minLength(1))
  }),
  forward(
    partialCheck(
      [["password"], ["confirmPassword"]],
      ({ password, confirmPassword }) => password === confirmPassword,
      "Passwords do not match"
    ),
    ["confirmPassword"]
  )
)

const clearDeletePasswords = <T extends { data: Record<string, string> }>(form: T) => {
  form.data.password = ""
  form.data.confirmPassword = ""
  return form
}

// --- Delete account (authenticated termination) ---
//
// Documented Wikidot flow (account-lifecycle spec P1/P3/P7): settings entry
// requests a confirmation email, the link lands on a confirmation state, and
// only the terminal password step deletes. The settings-page entry itself is
// owned by the site-settings lane; these routes are the link target and the
// confirmation screens, reachable once the entry links here.

export async function loadDeleteAccountPage(
  request: Request,
  preloadData: PreloadDataAsync
) {
  const parentData = await preloadData()
  if (!parentData.user_session?.user.user_id) {
    redirect(303, "/-/login")
  }

  const copy = await loadEmailTokenCopy(request, preloadData, {
    password: {},
    "confirm-password": {},
    login: {},
    send: {},
    email: {}
  })
  const deleteForm = await superValidate(valibot(object({})))
  return { ...copy, deleteForm, sent: false }
}

// Request the confirmation email. The backend binds the link to the session
// actor, so no account identity leaves framerail in this action.
export async function deleteIssueAction({
  request,
  cookies,
  getClientAddress,
  locals
}: RequestEvent) {
  const ipAddress: string = resolveClientIp(request, getClientAddress())
  const sessionToken = cookies.get("wikijump_token")
  if (!sessionToken) return failForMissingSession()

  try {
    requireActionSession(await authGetSession(sessionToken))
    await accountDeleteIssue({ ipAddress }, getRequestContext(locals))
    return { sent: true }
  } catch (error) {
    return failForActionError(error, {}, 500)
  }
}

// The link landing shows the confirmation state, never deletion controls.
// Redemption happens on POST, never on page load, so prefetchers and link
// scanners cannot consume the single-use link.
export async function loadDeleteTokenPage(
  request: Request,
  preloadData: PreloadDataAsync,
  token: string
) {
  const copy = await loadEmailTokenCopy(request, preloadData, {
    password: {},
    "confirm-password": {},
    login: {},
    send: {}
  })
  const tokenForm = await superValidate({ token }, valibot(tokenSchema))
  const deleteForm = await superValidate(valibot(deleteConfirmSchema))
  return { ...copy, tokenForm, deleteForm, grant: null as string | null, done: false }
}

export async function deleteRedeemAction({
  request,
  cookies,
  getClientAddress,
  locals
}: RequestEvent) {
  const ipAddress: string = resolveClientIp(request, getClientAddress())
  const form = await superValidate(request, valibot(tokenSchema))

  if (!form.valid) {
    return fail(400, { form })
  }

  const malformed = failForMalformedToken(form.data.token, () => ({ form }))
  if (malformed) {
    return malformed
  }

  const sessionToken = cookies.get("wikijump_token")
  if (!sessionToken) return failForMissingSession({ form })

  try {
    requireActionSession(await authGetSession(sessionToken))
    const { grant } = await accountDeleteRedeem(
      { token: form.data.token, ipAddress },
      getRequestContext(locals)
    )
    return { form, grant }
  } catch (error) {
    return failForActionError(error, { form }, 500)
  }
}

export async function deleteCompleteAction({
  request,
  cookies,
  getClientAddress,
  locals
}: RequestEvent) {
  const ipAddress: string = resolveClientIp(request, getClientAddress())
  const form = await superValidate(request, valibot(deleteConfirmSchema))
  const secrets = [form.data.password, form.data.confirmPassword]

  if (!form.valid) {
    return fail(
      400,
      redactAuthActionPayload({ form: clearDeletePasswords(form) }, secrets)
    )
  }

  const malformed = failForMalformedToken(form.data.grant, () => ({
    form: clearDeletePasswords(form)
  }))
  if (malformed) {
    return redactAuthActionPayload(malformed, secrets)
  }

  const sessionToken = cookies.get("wikijump_token")
  if (!sessionToken) {
    return failForMissingSession(
      redactAuthActionPayload({ form: clearDeletePasswords(form) }, secrets)
    )
  }

  try {
    requireActionSession(await authGetSession(sessionToken))
    const { sessions_revoked } = await accountDeleteComplete(
      {
        grant: form.data.grant,
        password: form.data.password,
        ipAddress
      },
      getRequestContext(locals)
    )
    return redactAuthActionPayload(
      { form: clearDeletePasswords(form), done: true, sessions_revoked },
      secrets
    )
  } catch (error) {
    return failForActionError(
      error,
      { form: clearDeletePasswords(form) },
      500,
      (payload) => redactAuthActionPayload(payload, secrets)
    )
  }
}

export async function resetCompleteAction({ request, getClientAddress }: RequestEvent) {
  const ipAddress: string = resolveClientIp(request, getClientAddress())
  const form = await superValidate(request, valibot(newPasswordSchema))
  const secrets = [form.data.password, form.data.confirmPassword]

  if (!form.valid) {
    return fail(
      400,
      redactAuthActionPayload({ form: clearRegisterPasswords(form) }, secrets)
    )
  }

  const malformed = failForMalformedToken(form.data.grant, () => ({
    form: clearRegisterPasswords(form)
  }))
  if (malformed) {
    return redactAuthActionPayload(malformed, secrets)
  }

  try {
    const { sessions_revoked } = await passwordResetComplete(
      {
        grant: form.data.grant,
        newPassword: form.data.password,
        ipAddress
      },
      {}
    )
    return redactAuthActionPayload(
      { form: clearRegisterPasswords(form), done: true, sessions_revoked },
      secrets
    )
  } catch (error) {
    return failForActionError(
      error,
      { form: clearRegisterPasswords(form) },
      500,
      (payload) => redactAuthActionPayload(payload, secrets)
    )
  }
}
