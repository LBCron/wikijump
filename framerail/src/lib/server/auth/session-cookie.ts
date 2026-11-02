import { parseDeploymentEnvironment } from "$lib/server/deployment-environment.js"
import { platformDomains } from "$lib/server/platform-domains.js"

import type { Cookies } from "@sveltejs/kit"

const SESSION_COOKIE = "wikijump_token"

const baseSessionCookieOptions = () => ({
  path: "/",
  httpOnly: true,
  secure: true,
  sameSite: "lax" as const
})

export function sessionCookieDomain(
  requestUrl: string,
  deploymentEnvironment = parseDeploymentEnvironment()
): string | undefined {
  let hostname: string
  try {
    hostname = new URL(requestUrl).hostname.toLowerCase()
  } catch {
    return undefined
  }

  const domain = platformDomains({ deploymentEnvironment }).main
  return hostname === domain || hostname.endsWith(`.${domain}`) ? domain : undefined
}

export function sessionCookieOptions(requestUrl: string) {
  const domain = sessionCookieDomain(requestUrl)
  return {
    ...baseSessionCookieOptions(),
    ...(domain ? { domain } : {})
  }
}

export function setSessionCookie(
  cookies: Cookies,
  sessionToken: string,
  expiresAt: string,
  requestUrl: string
) {
  cookies.set(SESSION_COOKIE, sessionToken, {
    ...sessionCookieOptions(requestUrl),
    expires: new Date(expiresAt)
  })
}

export function deleteSessionCookie(cookies: Cookies, requestUrl: string) {
  const sharedDomain = sessionCookieDomain(requestUrl)
  if (sharedDomain) {
    cookies.delete(SESSION_COOKIE, {
      ...baseSessionCookieOptions(),
      domain: sharedDomain
    })
  }

  cookies.delete(SESSION_COOKIE, {
    path: "/",
    httpOnly: true,
    secure: true,
    sameSite: "lax"
  })
}
