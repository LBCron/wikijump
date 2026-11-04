import { csrfTrustedOrigins } from "./deployment-environment.ts"

const STATE_CHANGING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"])

export const crossSitePostResponse = (request: Request): Response | null => {
  if (!STATE_CHANGING_METHODS.has(request.method)) return null

  const trustedOrigins = csrfTrustedOrigins()
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
