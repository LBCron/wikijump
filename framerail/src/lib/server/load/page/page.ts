import { resolveHeadImageUrls } from "$lib/head-metadata"
import { buildAnonymousArticleResponseCacheMetadata } from "$lib/server/cache/article-response/index.js"
import {
  resolveShellLayoutValue,
  WIKIDOT_LAYOUT
} from "$lib/layout/wikidot-shell-decision"
import { articleRouteWithQueryNoRender } from "$lib/server/page-norender-query"
import { resolvePageRedirect } from "$lib/server/page-redirect"
import { authGetSession } from "$lib/server/auth/get-session"
import {
  pageCreatePermission,
  pageDeletedGet,
  pageScore
} from "$lib/server/deepwell/page"
import { pageErrorStatus } from "$lib/server/load/page/page-error-status.js"
import { translate } from "$lib/server/deepwell/translate"
import { articleView } from "$lib/server/deepwell/views"
import { buildPageLoadData } from "$lib/server/load/page-data"
import { buildPageErrorForms, buildPageForms } from "$lib/server/load/page/page-forms"
import {
  buildPageTranslateKeys,
  buildWikidotPagePresentation
} from "$lib/server/load/page/page-presentation"
import {
  finalizePreloadData,
  getPreloadBackendLocales,
  getPreloadRequestLocales
} from "$lib/server/load/preload"
import { resolvePageMutationUserId } from "$lib/server/load/local-authoring-actor"
import {
  collectThemeSiteFileReferences,
  createSiteFilePresenceCache,
  resolveSiteFilePresence
} from "$lib/server/load/site-file-presence"
import { loadSiteInfo } from "$lib/server/load/site-info"
import { getRequestContext } from "$lib/server/request-context"
import {
  buildWikidotRequestInfo,
  requestHostFromRequest
} from "$lib/server/wikidot-request-info"
import { error, redirect } from "@sveltejs/kit"

import type { PageView } from "$lib/server/deepwell/views"
import type { Optional } from "$lib/types"
import type { Cookies } from "@sveltejs/kit"

export async function loadPage(
  slug: Optional<string>,
  extra: Optional<string>,
  request: Request,
  cookies: Cookies,
  locals?: App.Locals
) {
  const { siteId, siteSlug } = loadSiteInfo(request.headers)
  const route = slug || extra ? { slug, extra } : null
  const sessionToken = cookies.get("wikijump_token")

  const requestLocales = getPreloadRequestLocales(request)
  const backendLocales = getPreloadBackendLocales(requestLocales)
  const articleRoute = articleRouteWithQueryNoRender(route, new URL(request.url).search)
  const articleResponse = await articleView(
    siteId,
    backendLocales,
    articleRoute,
    sessionToken
  )
  const { page: articlePage, ...preloadResponse } = articleResponse
  const response = gateMissingPageCreateSource(
    await applyLocalAuthoringCreateGrant(articlePage, {
      siteId,
      siteSlug,
      slug,
      sessionToken
    })
  )
  const parentData = finalizePreloadData(preloadResponse, requestLocales)
  const locales = parentData.locales
  const siteLocale = parentData.site.locale
  if (locals) locals.siteLocale = siteLocale

  if (locals && response.type === "found") {
    const requestHost = requestHostFromRequest(request)
    locals.wikidotRequestInfo = buildWikidotRequestInfo({
      domain: requestHost,
      site: parentData.site,
      page: response.data.page
    })
    const metadata = buildAnonymousArticleResponseCacheMetadata({
      siteId,
      siteSlug,
      requestHost,
      requestLocales,
      backendLocales,
      deepwellArticlePageCacheKey: articleResponse.article_page_cache_key,
      publicContentFence: articleResponse.public_content_cache_fence,
      permissionFence: articleResponse.anonymous_permission_cache_fence
    })
    if (metadata) {
      locals.anonymousArticleResponseCacheMetadata = metadata
    }
  }

  const internationalization = await translate(
    locales,
    buildPageTranslateKeys(response, {
      licenseName: parentData.license_name,
      licenseUrl: parentData.license_url,
      locales
    })
  )
  let combinedRating: number | null = null
  if (response.type === "found" && response.data.page_rating.enabled) {
    try {
      const score = await pageScore({
        siteId,
        page: response.data.page.page_id,
        sessionToken
      })
      if (typeof score?.score === "number" && Number.isFinite(score.score)) {
        combinedRating = score.score
      }
    } catch {
      combinedRating = null
    }
  }
  const presentation = buildWikidotPagePresentation(response, {
    hasSession: !!parentData.user_session,
    siteLocale,
    combinedRating
  })

  if (response.type !== "found") {
    const errorForms = await buildPageErrorForms(request, response)
    let restoreAvailable = false
    if (response.type === "missing" && sessionToken) {
      try {
        const requestContext = locals ? getRequestContext(locals) : undefined
        const deletedPages = await pageDeletedGet({
          ...(requestContext ?? {}),
          siteId,
          page: slug ?? parentData.site.default_page
        })
        restoreAvailable = deletedPages.length > 0
      } catch {}
    }
    const errorViewData = {
      ...response.data,
      view: response.type,
      restore_available: restoreAvailable,
      internationalization,
      ...presentation
    }
    const errorData = buildPageLoadData(parentData, errorViewData, errorForms)
    if (locals) {
      locals.wikidotDocument = resolveShellLayoutValue(errorData) === WIKIDOT_LAYOUT
    }
    error(pageErrorStatus(response.type, slug), errorData)
  }

  let siteFilePresence: string[] = []
  if (response.type === "found") {
    try {
      const references = collectThemeSiteFileReferences(
        response.data.theme,
        parentData.site
      )
      if (references.length > 0) {
        const requestContext = locals ? getRequestContext(locals) : undefined
        const present = await resolveSiteFilePresence(references, {
          siteId,
          requestContext,
          cache: createSiteFilePresenceCache()
        })
        siteFilePresence = [...present]
      }
    } catch {
      siteFilePresence = []
    }
  }

  const metaTags =
    response.type === "found"
      ? resolveHeadImageUrls(
          response.data.meta_tags,
          parentData.site,
          new URL(request.url).origin
        )
      : undefined

  const viewData = {
    ...response.data,
    ...(metaTags !== undefined ? { meta_tags: metaTags } : {}),
    view: response.type,
    internationalization,
    ...presentation,
    site_file_presence: siteFilePresence
  }
  runRedirect(response.data, slug, extra, request.url)

  const loadData = buildPageLoadData(parentData, viewData, await buildPageForms(request))
  if (locals) {
    locals.wikidotDocument = resolveShellLayoutValue(loadData) === WIKIDOT_LAYOUT
  }
  return loadData
}

/**
 * Missing-page create decision for the anonymous local-authoring seam.
 * Deepwell reports can_create=false for anonymous viewers; when this
 * request itself resolves to the local admin actor, ask Deepwell honestly
 * (marker-bound create permission for the same actor the save would use)
 * and adopt a grant. Anything else — including a Deepwell refusal or
 * failure — keeps the denial (fail closed). Template and data-form sources
 * below are then gated on the adopted decision like any other grant.
 */
async function applyLocalAuthoringCreateGrant(
  articlePage: PageView,
  options: {
    siteId: number
    siteSlug: string
    slug: Optional<string>
    sessionToken: string | undefined
  }
): Promise<PageView> {
  const { siteId, siteSlug, slug, sessionToken } = options
  if (articlePage.type !== "missing" || articlePage.data.can_create === true) {
    return articlePage
  }
  if (!slug) return articlePage
  const session = sessionToken ? await authGetSession(sessionToken) : null
  if (resolvePageMutationUserId(session?.user_id, siteSlug, siteId, siteId) !== -1) {
    return articlePage
  }
  try {
    const grant = await pageCreatePermission(
      { page: slug },
      { siteId, localPageMutationActor: true }
    )
    if (!grant.can_create) return articlePage
    return { ...articlePage, data: { ...articlePage.data, can_create: true } }
  } catch {
    return articlePage
  }
}

/**
 * Template wikitext, data-form definitions, and template selections are
 * create source. They reach the browser only for a viewer Deepwell reports
 * may create the missing page. Fail closed: a missing or false
 * `can_create` strips them.
 */
function gateMissingPageCreateSource(response: PageView): PageView {
  if (response.type !== "missing" || response.data.can_create === true) return response
  return {
    ...response,
    data: {
      ...response.data,
      new_page_wikitext: null,
      page_templates: [],
      selected_template_page_id: null,
      data_form: null
    }
  }
}

function runRedirect(
  viewData: PageView["data"],
  originalSlug: Optional<string>,
  extra: Optional<string>,
  requestUrl: string
): void {
  const resolved = resolvePageRedirect(viewData, originalSlug, extra, requestUrl)
  if (resolved) {
    redirect(resolved.status, resolved.location)
  }
}
