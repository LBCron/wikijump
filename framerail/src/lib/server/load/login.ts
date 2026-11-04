import defaults from "$lib/defaults"

import { authGetSession } from "$lib/server/auth/get-session"
import { authLogin } from "$lib/server/auth/login"
import { authLogout } from "$lib/server/auth/logout"
import { authMfaVerify } from "$lib/server/auth/mfa"
import { setSessionCookie } from "$lib/server/auth/session-cookie"
import { translate } from "$lib/server/deepwell/translate"
import { userView } from "$lib/server/deepwell/user"
import {
  clearLoginPassword,
  redactAuthActionPayload
} from "$lib/server/load/auth-form-redaction"
import { resolveClientIp } from "$lib/server/client-ip"
import { failForActionError, requireActionSession } from "$lib/server/load/action-error"
import { loadSiteInfo } from "$lib/server/load/site-info"
import {
  getPreloadBackendLocales,
  getPreloadRequestLocales
} from "$lib/server/load/preload"
import { translateMfaCodeLabel } from "./login-translation"
import { fail } from "@sveltejs/kit"
import { superValidate } from "sveltekit-superforms"
import { valibot } from "sveltekit-superforms/adapters"
import { minLength, object, pipe, string } from "valibot"

import { UserType } from "$lib/types"

import type { PreloadDataAsync } from "$lib/server/deepwell/views"
import type { TranslateKeys } from "$lib/types"
import type { Cookies, RequestEvent } from "@sveltejs/kit"

export async function loadLoginPage(request: Request, preloadData: PreloadDataAsync) {
  loadSiteInfo(request.headers)

  const parentData = await preloadData()
  const locales = parentData.locales

  const isLoggedIn = Boolean(parentData.user_session)

  const translateKeys: TranslateKeys = {
    ...defaults.translateKeys,

    "cancel": {},
    "login": {},

    "specifier": {},
    "password": {},
    "login.toast": {},
    "forgot-password": {},
    "forgot-password.question": {},
    "wiki-auth-verify-email.resend-email": {},
    "remember-me": {},
    "create-account": {}
  }

  const internationalization = await translate(locales, translateKeys)
  internationalization["mfa-code"] = await translateMfaCodeLabel(locales, translate)

  const loginForm = await superValidate(valibot(loginSchema))

  return { isLoggedIn, internationalization, loginForm }
}

export async function loginAction({ request, getClientAddress, cookies }: RequestEvent) {
  const userAgent: string = request.headers.get("User-Agent") ?? ""
  const ipAddress: string = resolveClientIp(request, getClientAddress())
  const formData = await request.formData()
  const mfaSessionToken = formData.get("mfaSessionToken")
  const totpOrCode = formData.get("totpOrCode")

  if (mfaSessionToken !== null || totpOrCode !== null) {
    const form = await superValidate(formData, valibot(loginSchema))
    const submittedPassword = form.data.password

    if (
      typeof mfaSessionToken !== "string" ||
      mfaSessionToken.length === 0 ||
      typeof totpOrCode !== "string" ||
      totpOrCode.trim().length === 0
    ) {
      return fail(
        400,
        redactAuthActionPayload(
          {
            form: clearLoginPassword(form),
            message: "MFA code is required"
          },
          [submittedPassword]
        )
      )
    }

    try {
      const sessionToken = await authMfaVerify(
        mfaSessionToken,
        totpOrCode,
        ipAddress,
        userAgent
      )
      const refusal = await refuseUnverifiedLogin(
        sessionToken,
        request,
        form,
        submittedPassword
      )
      if (refusal) return refusal

      await setAuthenticatedSessionCookie(cookies, sessionToken, request.url)

      return redactAuthActionPayload(
        {
          form: clearLoginPassword(form),
          session_token: undefined,
          needsMfa: false,
          isLoggedIn: true
        },
        [submittedPassword]
      )
    } catch (error) {
      return failForActionError(
        error,
        { form: clearLoginPassword(form) },
        500,
        (payload) => redactAuthActionPayload(payload, [submittedPassword])
      )
    }
  }

  const form = await superValidate(formData, valibot(loginSchema))
  const submittedPassword = form.data.password

  if (!form.valid) {
    return fail(
      400,
      redactAuthActionPayload({ form: clearLoginPassword(form) }, [submittedPassword])
    )
  }

  try {
    const { data } = form
    const res = await authLogin(data.nameOrEmail, data.password, ipAddress, userAgent)

    if (res.session_token && !res.needs_mfa) {
      const refusal = await refuseUnverifiedLogin(
        res.session_token,
        request,
        form,
        submittedPassword
      )
      if (refusal) return refusal

      await setAuthenticatedSessionCookie(cookies, res.session_token, request.url)
    }

    return redactAuthActionPayload(
      {
        form: clearLoginPassword(form),
        session_token: res.needs_mfa ? res.session_token : undefined,
        needsMfa: res.needs_mfa,
        isLoggedIn: !res.needs_mfa
      },
      [submittedPassword]
    )
  } catch (error) {
    return failForActionError(error, { form: clearLoginPassword(form) }, 500, (payload) =>
      redactAuthActionPayload(payload, [submittedPassword])
    )
  }
}

const EMAIL_VERIFICATION_REQUIRED_MESSAGE =
  "Your e-mail address has not been verified. Verify your e-mail address to log in."

async function loginBlockedForUnverifiedEmail(
  sessionToken: string,
  request: Request
): Promise<boolean> {
  const { siteId } = loadSiteInfo(request.headers)
  const locales = getPreloadBackendLocales(getPreloadRequestLocales(request))
  const response = await userView(siteId, locales, sessionToken)
  if (response.type !== "user_found") return false

  const user = response.data.user
  return user.user_type === UserType.Regular && user.email_verified_at === null
}

async function refuseUnverifiedLogin<T extends { data: { password?: string } }>(
  sessionToken: string,
  request: Request,
  form: T,
  submittedPassword: string
) {
  if (!(await loginBlockedForUnverifiedEmail(sessionToken, request))) return null

  await authLogout(sessionToken).catch(() => undefined)
  return fail(
    403,
    redactAuthActionPayload(
      {
        form: clearLoginPassword(form),
        message: EMAIL_VERIFICATION_REQUIRED_MESSAGE,
        emailVerificationRequired: true
      },
      [submittedPassword]
    )
  )
}

const loginSchema = object({
  nameOrEmail: pipe(string(), minLength(1)),
  password: pipe(string(), minLength(1))
})

async function setAuthenticatedSessionCookie(
  cookies: Cookies,
  sessionToken: string,
  requestUrl: string
) {
  const session = requireActionSession(await authGetSession(sessionToken))
  setSessionCookie(cookies, sessionToken, session.expires_at, requestUrl)
}
