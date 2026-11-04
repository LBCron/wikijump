export const NEW_SITE_PLATFORM_SLUG = "www"
export const NEW_SITE_PAGE_SLUG = "new-site"

export const NEW_SITE_DEFAULT_TEMPLATE = "default"
export const NEW_SITE_DEFAULT_PRIVACY = "open"

export const NEW_SITE_DEFAULT_LICENSE = "cc0"

export const newSiteRedirectTarget = (origin: unknown): string => {
  if (typeof origin !== "string" || !/^https:\/\/[^/?#]+$/u.test(origin)) {
    throw new NewSiteSubmissionError(
      "Site creation completed but the new address is invalid."
    )
  }
  return `${origin}/`
}

export class NewSiteSubmissionError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "NewSiteSubmissionError"
  }
}

const fieldText = (fields: Record<string, unknown>, key: string): string => {
  const value = fields[key]
  return typeof value === "string" ? value.trim() : ""
}

export const parseNewSiteSubmission = (
  fields: Record<string, unknown> | undefined | null
): { slug: string; name: string; tagline: string; locale: string } => {
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
