import { fail, redirect } from "@sveltejs/kit"

import { siteCreate, siteOrigin } from "$lib/server/deepwell/site"
import type { NewSiteCreateOutcome } from "$lib/server/deepwell/site"
import { failForActionError } from "$lib/server/load/action-error"
import { executePageAction } from "$lib/server/load/page/page-action-execution"
import { resolvePageActionRequestContext } from "$lib/server/load/page/page-action-context"
import {
  NEW_SITE_PAGE_SLUG,
  NEW_SITE_PLATFORM_SLUG,
  NewSiteSubmissionError,
  newSiteRedirectTarget,
  parseNewSiteSubmission
} from "$lib/server/load/page/page-newsite-validation"

import type { RequestContext } from "$lib/server/request-context"
import type { RequestEvent } from "@sveltejs/kit"

/**
 * Refs #2052. Handle the www/new-site special-page creation form
 * (`?/newSite`).
 *
 * The special-page scope is enforced server-side on the trusted
 * request-host site identity plus the page route: this action refuses to
 * create sites from any ordinary wiki page. Authentication is required
 * before any validation or mutation, and slug conflicts/reservations
 * remain Deepwell's atomic authority (`SiteService::check_conflicts`).
 *
 * On success the browser is sent to the new site's canonical origin and
 * default page, as Wikidot does (SCP-JP creation guide). The origin comes
 * from the deployment's own domain source of truth, never from
 * request-host surgery, and the session cookie already spans platform
 * subdomains, so the creator stays authenticated there. 303 is transport
 * mechanics for POST-to-GET, not an observed Wikidot status.
 */
export function newSitePageAction(event: RequestEvent) {
  return (async () => {
    let outcome: NewSiteCreateOutcome | undefined
    let requestContext: Exclude<RequestContext, void> | undefined

    const result = await executePageAction(async () => {
      const context = await resolvePageActionRequestContext(event, {
        session: "required"
      })

      if (
        context.siteSlug !== NEW_SITE_PLATFORM_SLUG ||
        event.params.slug !== NEW_SITE_PAGE_SLUG
      ) {
        throw new NewSiteSubmissionError(
          "Site creation is only available on the www/new-site special page."
        )
      }

      const fields = Object.fromEntries(await event.request.formData())
      const input = parseNewSiteSubmission(fields)
      const created = await siteCreate(
        input,
        event.getClientAddress(),
        context.requestContext
      )

      outcome = created
      requestContext = context.requestContext

      return { slug: created.slug, site_id: created.site_id }
    }, failForNewSiteError)

    if (outcome === undefined) return result

    // A redirect throw must escape executePageAction's catcher, so resolve
    // the landing target separately; if origin resolution fails, fall back
    // to the plain success payload instead of breaking creation.
    let target: string
    try {
      target = newSiteRedirectTarget(await siteOrigin(outcome.site_id, requestContext))
    } catch {
      return result
    }
    throw redirect(303, target)
  })()
}

function failForNewSiteError(error: unknown) {
  if (error instanceof NewSiteSubmissionError) {
    return fail(400, { message: error.message })
  }
  return failForActionError(error)
}
