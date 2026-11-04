/**
 * Project Deepwell viewer data onto the explicit browser-visible preload
 * DTO. New internal fields added to the backend response stay server-only
 * unless they are deliberately added here.
 */
export const buildPublicPreloadData = <Site, SiteSettings, PromotedSites, UserSession>(
  response: {
    site: Site
    site_settings: SiteSettings
    promoted_sites: PromotedSites
    site_file_domain: string
    license_name: string
    license_url: string
    license_kind: "standard" | "other" | "copyright"
    license_html: string | null
  },
  userSession: UserSession,
  locales: string[]
) => ({
  site: response.site,
  site_settings: response.site_settings,
  promoted_sites: response.promoted_sites,
  site_file_domain: response.site_file_domain,
  license_name: response.license_name,
  license_url: response.license_url,
  license_kind: response.license_kind,
  license_html: response.license_html,
  user_session: userSession,
  locales
})
