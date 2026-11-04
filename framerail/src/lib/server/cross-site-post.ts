import { csrfTrustedOrigins } from "./deployment-environment.ts"

const STATE_CHANGING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"])

/**
 * Cross-site guard for state-changing `+server.ts` handlers.
 *
 * SvelteKit's origin check protects page actions and remote functions, but
 * a `+server.ts` handler receives the request without it. This applies the
 * same rule to those handlers. A request is refused with SvelteKit's 403
 * message when its `Origin` is present and is neither the request's own
 * origin nor a trusted origin, or when the browser marks it
 * `Sec-Fetch-Site: cross-site`. A request without `Origin` is not refused
 * on that basis, because browsers always send `Origin` on a cross-origin
 * POST and scripted clients send none.
 *
 * The on/off switch is SvelteKit's (`FRAMERAIL_CSRF_CHECK_ORIGIN` through
 * `csrfTrustedOrigins`), so endpoints and page actions agree.
 *
 * @returns The 403 response to return from the handler, or `null` to
 *   continue
 */
export const crossSitePostResponse = (request: Request): Response | null => {
  if (!STATE_CHANGING_METHODS.has(request.method)) return null

  const trustedOrigins = csrfTrustedOrigins()
  // "*" is how the deployment switch turns SvelteKit's origin check off.
  if (trustedOrigins.includes("*")) return null

  const origin = request.headers.get("origin")
  const crossOrigin =
    origin !== null &&
    origin !== new URL(request.url).origin &&
    !trustedOrigins.includes(origin)
  const crossSite = request.headers.get("sec-fetch-site") === "cross-site"
  if (!crossOrigin && !crossSite) return null

  const message = `Cross-site ${request.method} form submissions are forbidden`
  if (request.headers.get("accept") === "application/json") {
    return new Response(JSON.stringify({ message }), {
      status: 403,
      headers: { "content-type": "application/json" }
    })
  }
  return new Response(message, { status: 403 })
}
