import defaults from "$lib/defaults"
import {
  ACCOUNT_PASSWORD_TOO_SHORT,
  accountPasswordMeetsMinimum
} from "$lib/account-password-policy.js"

import { emailVerifyIssue } from "$lib/server/deepwell/email-token"
import { translate } from "$lib/server/deepwell/translate"
import { userCreate } from "$lib/server/deepwell/user"
import {
  clearRegisterPasswords,
  redactAuthActionPayload
} from "$lib/server/load/auth-form-redaction.js"
import { failForActionError } from "$lib/server/load/action-error"
import { isRegistrationHoneypotTripped } from "$lib/server/load/register-honeypot.js"
import { legalDestinations } from "$lib/server/legal-links"
import { loadSiteInfo } from "$lib/server/load/site-info"
import { fail } from "@sveltejs/kit"
import { superValidate } from "sveltekit-superforms"
import { valibot } from "sveltekit-superforms/adapters"
import {
  array,
  check,
  email,
  forward,
  minLength,
  object,
  optional,
  partialCheck,
  pipe,
  string
} from "valibot"

import type { PreloadDataAsync } from "$lib/server/deepwell/views"
import { UserType, type TranslateKeys } from "$lib/types"
import type { RequestEvent } from "@sveltejs/kit"
import {
  areSupportedUserInterfaceLocales,
  USER_INTERFACE_LOCALES
} from "$lib/user-interface-locales"

export async function loadRegisterPage(request: Request, preloadData: PreloadDataAsync) {
  loadSiteInfo(request.headers)

  const parentData = await preloadData()
  const locales = parentData.locales

  const isLoggedIn = Boolean(parentData.user_session)

  const translateKeys: TranslateKeys = {
    ...defaults.translateKeys,

    // Page actions
    "cancel": {},
    "register": {},

    // misc
    "username": {},
    "username.placeholder": {},
    "username.info": {},
    "email": {},
    "email.placeholder": {},
    "email.info": {},
    "password": {},
    "password.placeholder": {},
    "confirm-password": {},
    "register.toast": {},
    "create-account": {},
    "login": {},

    // Account-creation legal disclosure
    "register.legal-notice": {},
    "register.legal-terms": {},
    "register.legal-conjunction": {},
    "register.legal-privacy": {},
    "register.legal-suffix": {},

    // errors
    "error-form.password-mismatch": {},
    "error-form.password-too-short": {},
    "error-form.email-invalid": {},

    // The locale selector label reuses the same advertised-language wording
    // as the account display settings, so registration and settings never
    // disagree about the deployment's supported interface locales.
    "dashboard-account.language": {}
  }

  const internationalization = await translate(locales, translateKeys)

  // superform
  const registerForm = await superValidate(valibot(registerSchema))

  // Return to page for rendering
  return {
    isLoggedIn,
    internationalization,
    registerForm,
    // The disclosure shown at the Create Account action boundary must name
    // the same authoritative Terms and Privacy the instance actually
    // publishes, so the destinations come from the instance source of truth
    // rather than from the wiki being viewed.
    legalDestinations: legalDestinations(),
    userInterfaceLocales: USER_INTERFACE_LOCALES
  }
}

export async function registerAction({ request, getClientAddress }: RequestEvent) {
  const form = await superValidate(request, valibot(registerSchema))
  const submittedPasswords = [form.data.password, form.data.confirmPassword]

  if (!form.valid) {
    return fail(
      400,
      redactAuthActionPayload({ form: clearRegisterPasswords(form) }, submittedPasswords)
    )
  }

  // #2074 anti-bot honeypot: the off-screen blank checkbox must stay empty.
  // Reject before userCreate so a tripped gate creates no user, session, or
  // verification state. The failure is intentionally indistinguishable from
  // ordinary invalid input: no classification detail is returned.
  if (isRegistrationHoneypotTripped(form.data.leaveBlank)) {
    return fail(
      400,
      redactAuthActionPayload({ form: clearRegisterPasswords(form) }, submittedPasswords)
    )
  }

  const ipAddress = getClientAddress()
  const { data } = form

  try {
    const res = await userCreate({
      userType: UserType.Regular,
      name: data.username,
      email: data.email,
      locales: data.locale,
      password: data.password,
      ipAddress
    })

    // #2130: registration owns the first verification email. The quiet
    // issue path is safe here — the address was just submitted by the
    // registrant, and unknown/imported/deleted addresses stay silent.
    // A failed issue must not fail the registration itself: the account
    // already exists, and the resend page remains the recovery path.
    try {
      await emailVerifyIssue({ email: data.email, ipAddress })
    } catch {
      // The pending-verification notice still links the resend page.
    }

    return redactAuthActionPayload(
      { form: clearRegisterPasswords(form), res, isRegistered: true },
      submittedPasswords
    )
  } catch (error) {
    return failForActionError(
      error,
      { form: clearRegisterPasswords(form) },
      500,
      (payload) => redactAuthActionPayload(payload, submittedPasswords)
    )
  }
}

const registerSchema = pipe(
  object({
    username: pipe(string(), minLength(1)),
    email: pipe(string(), email(), minLength(1)),
    password: pipe(
      string(),
      check(accountPasswordMeetsMinimum, ACCOUNT_PASSWORD_TOO_SHORT)
    ),
    confirmPassword: pipe(string(), minLength(1)),
    // #2074 honeypot carrier: an unchecked checkbox submits nothing, so the
    // field stays optional and never fails validation on its own. The trip
    // decision lives in register-honeypot.js and is enforced above.
    leaveBlank: optional(string()),
    locale: pipe(
      optional(array(string()), ["en"]),
      minLength(1),
      check(areSupportedUserInterfaceLocales, "Choose a supported display language.")
    )
  }),
  forward(
    partialCheck(
      [["password"], ["confirmPassword"]],
      ({ password, confirmPassword }) => password === confirmPassword
    ),
    ["confirmPassword"]
  )
)
