export type WikidotChromeViewData = {
  site?: {
    slug?: string | null
    name?: string | null
    tagline?: string | null
    from_wikidot?: boolean | null
  } | null
  page?: { from_wikidot?: boolean | null } | null
  page_revision?: { from_wikidot?: boolean | null } | null
  wikidot_snapshot?: { source_site?: string | null } | null
  user_session?: {
    user?: { name?: string | null; slug?: string | null } | null
  } | null
}

export const SANDBOX_WIKIDOT_SOURCE_SITE = "sandbox-for-codex"

export const shouldUseSandboxWikidotChrome = (
  data: WikidotChromeViewData | null | undefined
): boolean => {
  const sourceSite = data?.wikidot_snapshot?.source_site
  const hasImportedPage = data?.page?.from_wikidot || data?.page_revision?.from_wikidot

  return (
    sourceSite === SANDBOX_WIKIDOT_SOURCE_SITE ||
    (data?.site?.slug === SANDBOX_WIKIDOT_SOURCE_SITE && !!hasImportedPage)
  )
}

export const resolveWikidotSiteTitle = (
  data: WikidotChromeViewData | null | undefined
): string | null | undefined => {
  if (shouldUseSandboxWikidotChrome(data)) return "Sandbox For Codex"

  return data?.site?.name
}

export const resolveWikidotSiteTagline = (
  data: WikidotChromeViewData | null | undefined
): string | null | undefined => {
  if (shouldUseSandboxWikidotChrome(data)) return null

  return data?.site?.tagline
}

export const resolveWikidotSessionUserName = (
  data: WikidotChromeViewData | null | undefined
): string | null => {
  return data?.user_session?.user?.name || data?.user_session?.user?.slug || null
}
