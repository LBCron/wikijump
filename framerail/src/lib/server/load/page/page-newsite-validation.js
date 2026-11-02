/**
 * Refs #2052. Server-side validation for the www/new-site special-page
 * creation form (Title, Tagline, Web address, Language, Template, Access
 * policy, Terms of Service acceptance, per the Community howto:first-site
 * dimensions and the rendered authenticated NewSite state).
 *
 * Only the evidenced default combination (Standard wiki template, Open
 * access) is accepted: Deepwell's site service cannot represent template
 * or access-policy selection yet (bootstrap is a later slice), so anything
 * else fails loudly instead of silently creating a differently-shaped
 * site. Client-supplied identity never crosses this boundary: the creator
 * is derived from the authenticated session by the action and service
 * layers.
 *
 * Pure module: no framework imports, directly runnable under `node
 * --test`.
 */

// The special-page contract mirrors Deepwell's www runtime
// (`render_www_special_system_module`): creation is only offered on the
// platform site's new-site page, never on ordinary wiki pages.
export const NEW_SITE_PLATFORM_SLUG = "www"
export const NEW_SITE_PAGE_SLUG = "new-site"

// The only evidenced creation shape: the rendered form's checked defaults.
export const NEW_SITE_DEFAULT_TEMPLATE = "default"
export const NEW_SITE_DEFAULT_PRIVACY = "open"

export const NEW_SITE_DEFAULT_LICENSE = "cc0"

/**
 * Build the post-creation landing target from a resolved site origin. Only
 * absolute HTTPS origins (exactly what the deployment's canonical domain
 * source yields) are accepted, so a compromised or unexpected origin value
 * can never turn the success redirect into an open redirect.
 *
 * @param {unknown} origin The site's canonical HTTPS origin, no path
 * @returns {string} The new site's default page address
 * @throws {NewSiteSubmissionError} When the origin is not a plain origin
 */
export const newSiteRedirectTarget = (origin) => {
  if (typeof origin !== "string" || !/^https:\/\/[^/?#]+$/u.test(origin)) {
    throw new NewSiteSubmissionError(
      "Site creation completed but the new address is invalid."
    )
  }
  return `${origin}/`
}

export class NewSiteSubmissionError extends Error {
  constructor(message) {
    super(message)
    this.name = "NewSiteSubmissionError"
  }
}

/** @param {Record<string, unknown>} fields @param {string} key */
const fieldText = (fields, key) => {
  const value = fields[key]
  return typeof value === "string" ? value.trim() : ""
}

/**
 * @param {Record<string, unknown> | undefined | null} fields Submitted
 *   form fields
 * @returns {{
 *   slug: string
 *   name: string
 *   tagline: string
 *   locale: string
 * }}
 * @throws {NewSiteSubmissionError} On any missing/rejected creation
 *   dimension
 */
export const parseNewSiteSubmission = (fields) => {
  const source = fields ?? {}

  const tos = fieldText(source, "tos").toLowerCase()
  if (tos !== "1" && tos !== "on") {
    throw new NewSiteSubmissionError(
      "Creating a site requires accepting the Terms of Service."
    )
  }

  const name = fieldText(source, "name")
  if (name === "") {
    throw new NewSiteSubmissionError("A Title is required to create a site.")
  }

  const slug = fieldText(source, "unixname")
  if (slug === "") {
    throw new NewSiteSubmissionError("A Web address is required to create a site.")
  }

  const template = fieldText(source, "template") || NEW_SITE_DEFAULT_TEMPLATE
  if (template !== NEW_SITE_DEFAULT_TEMPLATE) {
    throw new NewSiteSubmissionError(
      `Unknown site template '${template}': only the Standard wiki template is supported.`
    )
  }

  const privacy = fieldText(source, "privacy") || NEW_SITE_DEFAULT_PRIVACY
  if (privacy !== NEW_SITE_DEFAULT_PRIVACY) {
    throw new NewSiteSubmissionError(
      `Unsupported access policy '${privacy}': only Open sites can be created yet.`
    )
  }

  return {
    slug,
    name,
    tagline: fieldText(source, "subtitle"),
    locale: fieldText(source, "language")
  }
}
