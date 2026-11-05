import type { Reroute } from "@sveltejs/kit/hooks"

const PRINTER_FRIENDLY_ROUTE = "/printer--friendly/"

/**
 * Live Wikidot links the printer-friendly child window with a doubled
 * slash (`/printer--friendly//<page>`). Resolve that exact public URL onto
 * the single-slash route without changing the address bar.
 */
export const reroute: Reroute = ({ url }) => {
  if (url.pathname.startsWith(`${PRINTER_FRIENDLY_ROUTE}/`)) {
    return url.pathname.replace(/^\/printer--friendly\/+/u, PRINTER_FRIENDLY_ROUTE)
  }
}
