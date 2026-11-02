import defaults from "$lib/defaults"

import { parseAcceptLangHeader } from "$lib/locales"
import { authLogout } from "$lib/server/auth/logout"
import { deleteSessionCookie } from "$lib/server/auth/session-cookie"
import { isInvalidSessionTokenError } from "$lib/server/deepwell/public-error.js"
import { translate } from "$lib/server/deepwell/translate"
import { failForActionError } from "$lib/server/load/action-error"
import { loadSiteInfo } from "$lib/server/load/site-info"
import { fail } from "@sveltejs/kit"

import type { PreloadDataAsync } from "$lib/server/deepwell/views"
import type { TranslateKeys } from "$lib/types"
import type { RequestEvent } from "@sveltejs/kit"

export async function loadLogoutPage(request: Request, preloadData: PreloadDataAsync) {
  loadSiteInfo(request.headers)

  const parentData = await preloadData()
  const locales = parentData.locales

  const isLoggedIn = Boolean(parentData.user_session)

  const translateKeys: TranslateKeys = {
    ...defaults.translateKeys,

    "cancel": {},
    "logout": {},

    "logout.toast": {}
  }

  const internationalization = await translate(locales, translateKeys)

  return { isLoggedIn, internationalization }
}

export async function logoutAction({ cookies, request }: RequestEvent) {
  const sessionToken = cookies.get("wikijump_token")

  if (!sessionToken) {
    const locales = parseAcceptLangHeader(request)
    if (!locales.includes(defaults.fallbackLocale)) {
      locales.push(defaults.fallbackLocale)
    }
    const translateStrings = await translate(locales, {
      "error-api.NOT_LOGGED_IN": {}
    })
    return fail(400, {
      message: translateStrings?.["error-api.NOT_LOGGED_IN"]
    })
  }

  try {
    await authLogout(sessionToken)
  } catch (error) {
    if (!isInvalidSessionTokenError(error)) {
      return failForActionError(error)
    }
  }

  deleteSessionCookie(cookies, request.url)

  return { success: true }
}
