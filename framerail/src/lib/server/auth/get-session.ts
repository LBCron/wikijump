import { client } from "$lib/server/deepwell"
import { isInvalidSessionTokenError } from "$lib/server/deepwell/public-error"
import { deleteSessionCookie } from "$lib/server/auth/session-cookie"

import type { Cookies } from "@sveltejs/kit"

export async function authGetSession(sessionToken: string | undefined): Promise<{
  session_token: string
  user_id: number
  created_at: string
  expires_at: string
  ip_address: string
  user_agent: string
  restricted: boolean
} | null> {
  return client.request("session_get", [sessionToken ?? ""])
}

export async function withAnonymousSessionFallback<T>(
  sessionToken: string | undefined,
  call: (sessionToken: string | undefined) => PromiseLike<T>
): Promise<T> {
  try {
    return await call(sessionToken)
  } catch (error) {
    if (!sessionToken || !isInvalidSessionTokenError(error)) throw error
    return call(undefined)
  }
}

export async function resolveCookieSessionToken(
  cookies: Cookies,
  requestUrl: string
): Promise<string | undefined> {
  const sessionToken = cookies.get("wikijump_token")
  if (!sessionToken) return undefined

  try {
    const session = await authGetSession(sessionToken)
    if (session) return sessionToken
  } catch (error) {
    if (!isInvalidSessionTokenError(error)) throw error
  }

  deleteSessionCookie(cookies, requestUrl)
  return undefined
}
