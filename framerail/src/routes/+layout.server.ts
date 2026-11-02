import { readNativeFooterDestinationOverrides } from "$lib/platform-footer-links"
import { platformFooterDestinations } from "$lib/server/legal-links"
import { loadPreload, pageRouteProvidesPreload } from "$lib/server/load/preload"

import type { PreloadData } from "$lib/server/deepwell/views"
import type { LayoutServerLoad } from "./$types"

export const load: LayoutServerLoad<PreloadData> = async ({
  request,
  cookies,
  route,
  locals
}) => {
  const overrides = readNativeFooterDestinationOverrides(process.env)
  const nativeFooterDestinations = {
    ...platformFooterDestinations(),
    ...Object.fromEntries(
      Object.entries(overrides).filter(([, value]) => value !== undefined && value !== "")
    )
  }

  if (pageRouteProvidesPreload(route.id)) {
    return { native_footer_destinations: nativeFooterDestinations } as PreloadData
  }

  const preload = await loadPreload(request, cookies)
  locals.siteLocale = preload.site.locale
  return { ...preload, native_footer_destinations: nativeFooterDestinations }
}
