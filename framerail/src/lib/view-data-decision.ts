export type CanonicalViewDataFields = {
  site?: { locale?: string | null } | null
  license_name?: string | null
  license_url?: string | null
  license_kind?: string | null
  license_html?: string | null
  wikidot_snapshot?: { source_site?: string | null } | null
}

export const resolveCanonicalViewData = (errorData: any, pageData: any): any =>
  errorData ?? pageData ?? null

export const resolveCanonicalViewMetadata = (errorData: any, pageData: any): any => {
  const viewData = resolveCanonicalViewData(errorData, pageData)
  const fields = viewData as CanonicalViewDataFields | null
  return {
    viewData,
    locale: fields?.site?.locale,
    licenseName: fields?.license_name,
    licenseUrl: fields?.license_url,
    licenseKind: fields?.license_kind,
    licenseHtml: fields?.license_html,
    sourceSite: fields?.wikidot_snapshot?.source_site
  }
}
