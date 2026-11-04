import defaults from "$lib/defaults"
import {
  ACCOUNT_PASSWORD_TOO_SHORT,
  accountPasswordMeetsMinimum
} from "$lib/account-password-policy.js"

import { isUserExistsError } from "$lib/server/deepwell/public-error"
import { translate } from "$lib/server/deepwell/translate"
import { userCreate } from "$lib/server/deepwell/user"
import {
  clearRegisterPasswords,
  redactAuthActionPayload
} from "$lib/server/load/auth-form-redaction"
import { failForActionError, normalizeActionError } from "$lib/server/load/action-error"
import { isRegistrationHoneypotTripped } from "$lib/server/load/register-honeypot"
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

    "cancel": {},
    "register": {},

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

    "register.legal-notice": {},
    "register.legal-terms": {},
    "register.legal-conjunction": {},
    "register.legal-privacy": {},
    "register.legal-suffix": {},

    "error-form.password-mismatch": {},
    "error-form.password-too-short": {},
    "error-form.email-invalid": {},

    "dashboard-account.language": {}
  }

  const internationalization = await translate(locales, translateKeys)

  const registerForm = await superValidate(valibot(registerSchema))

  return {
    isLoggedIn,
    internationalization,
    registerForm,
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

    return redactAuthActionPayload(
      { form: clearRegisterPasswords(form), res, isRegistered: true },
      submittedPasswords
    )
  } catch (error) {
    if (isUserExistsError(error)) {
      return fail(
        400,
        redactAuthActionPayload(
          { form: clearRegisterPasswords(form), ...normalizeActionError(error) },
          submittedPasswords
        )
      )
    }

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
