import { WIKIDOT_LAYOUT } from "../layout/wikidot-shell-decision.ts"

export { WIKIDOT_LAYOUT }

export interface ManageSiteTakeoverView {
  view?: unknown
  manage_site_takeover?: unknown
}

/**
 * Whether the saved page view is a live-Wikidot `ManageSite` page
 * takeover.
 *
 * Deepwell marks a found page whose source has a standalone executable
 * `[[module ManageSite]]`; live Wikidot serves the site-manager document
 * for the whole page in that case. The takeover only applies to
 * Wikidot-layout pages, because the manager document is Wikidot's
 * admin-panel layout.
 */
export const shouldRenderManageSiteTakeover = (
  layout: unknown,
  view: ManageSiteTakeoverView | null | undefined
): boolean =>
  layout === WIKIDOT_LAYOUT &&
  view?.view === "found" &&
  view?.manage_site_takeover === true
