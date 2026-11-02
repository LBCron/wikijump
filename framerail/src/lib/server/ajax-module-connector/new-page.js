import { fieldValue } from "./request.js"
import { jsonResponse } from "./response.js"

const NEWPAGE_AUTOSAVE_MODES = new Set(["save-and-refresh", "save-and-go"])
const NEWPAGE_NO_NAME_MESSAGE = "You should provide a page name"
const NEWPAGE_INCORRECT_NAME_MESSAGE =
  "The page name is not correct: please fix it and try again"
const NEWPAGE_NO_PERMISSION_MESSAGE =
  'Sorry, you can not create a new page in this category. Only members of this site, site administrators and perhaps selected moderators are allowed to do it. <a href="#action:login">Sign in as Wikidot user</a>'
const NEWPAGE_GENERIC_ERROR_MESSAGE = "An error occurred while processing the request."
const MAX_WIKIDOT_PAGE_UNIX_NAME_LENGTH = 60
const MAX_NEWPAGE_PAGE_NAME_LENGTH = 128
const MAX_NEWPAGE_FORMAT_LENGTH = 512

const splitNewPageTags = (tags) => tags.split(/\s+/u).filter((tag) => tag.length > 0)

/** @param {string} value */
const escapeHtml = (value) =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")

/** @param {{ pageName: string; categoryName: string }} input */
export const toWikidotUnixName = ({ pageName, categoryName }) => {
  const normalizedCategory = categoryName === "_default" ? "" : categoryName
  const prefixed =
    normalizedCategory.length > 0 ? `${normalizedCategory}:${pageName}` : pageName
  return prefixed.slice(0, MAX_WIKIDOT_PAGE_UNIX_NAME_LENGTH)
}

/**
 * @param {string} format
 * @returns {RegExp | null}
 */
const parseDelimitedRegex = (format) => {
  if (!format.startsWith("/")) return null

  const delimiter = format.lastIndexOf("/")
  if (delimiter <= 0) return null

  const pattern = format.slice(1, delimiter)
  const rawFlags = format.slice(delimiter + 1)
  let flags = ""
  if (rawFlags.includes("i")) flags += "i"
  if (rawFlags.includes("m")) flags += "m"
  try {
    return new RegExp(pattern, flags)
  } catch {
    return null
  }
}

/**
 * Reject regex features whose backtracking cost cannot be bounded by this
 * synchronous request handler. The accepted NewPage formats are simple
 * anchored patterns; nested or sequential quantified atoms, alternation,
 * lookarounds, and backreferences are unsupported and fail closed. A
 * single quantified atom without alternation cannot cause exponential
 * backtracking on the bounded (128-character) page name. Adjacent but
 * separate quantifiers are unsafe even if no group contains two
 * quantifiers.
 *
 * @param {string} format
 */
const newPageFormatIsSafe = (format) => {
  if (format.length > MAX_NEWPAGE_FORMAT_LENGTH) return false
  if (!format.startsWith("/")) return true

  const delimiter = format.lastIndexOf("/")
  if (delimiter <= 0) return true

  const pattern = format.slice(1, delimiter)
  const groups = [{ hasQuantifier: false, hasAlternation: false }]
  let escaped = false
  let inCharacterClass = false
  let previousWasQuantifier = false
  let quantifierCount = 0
  let hasAlternation = false

  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index]
    if (escaped) {
      if (/^[1-9]$/u.test(character)) return false
      escaped = false
      previousWasQuantifier = false
      continue
    }
    if (character === "\\") {
      escaped = true
      continue
    }
    if (inCharacterClass) {
      if (character === "]") inCharacterClass = false
      continue
    }
    if (character === "[") {
      inCharacterClass = true
      previousWasQuantifier = false
      continue
    }
    if (character === "(") {
      if (pattern[index + 1] === "?" && pattern[index + 2] !== ":") return false
      groups.push({ hasQuantifier: false, hasAlternation: false })
      if (pattern[index + 1] === "?" && pattern[index + 2] === ":") index += 2
      previousWasQuantifier = false
      continue
    }
    if (character === "|") {
      hasAlternation = true
      groups.at(-1).hasAlternation = true
      previousWasQuantifier = false
      continue
    }
    if (character === ")") {
      if (groups.length === 1) return false
      const group = groups.pop()
      const next = pattern[index + 1]
      const quantifiesGroup = next === "*" || next === "+" || next === "?" || next === "{"
      if (quantifiesGroup && (group.hasQuantifier || group.hasAlternation)) return false
      if (quantifiesGroup) groups.at(-1).hasQuantifier = true
      previousWasQuantifier = false
      continue
    }
    if (
      character === "*" ||
      character === "+" ||
      character === "?" ||
      character === "{"
    ) {
      if (previousWasQuantifier) return false
      quantifierCount += 1
      if (quantifierCount > 1) return false
      groups.at(-1).hasQuantifier = true
      previousWasQuantifier = true
      continue
    }
    previousWasQuantifier = false
  }

  return !hasAlternation || quantifierCount === 0
}

/**
 * @param {string} pageName
 * @param {string} format
 */
const matchesNewPageFormat = (pageName, format) => {
  if (format.length === 0) return true

  if (pageName.length > MAX_NEWPAGE_PAGE_NAME_LENGTH) return false
  if (!newPageFormatIsSafe(format)) return false

  const regex = parseDelimitedRegex(format)
  if (!regex) return true
  return regex.test(pageName)
}

/** @param {AjaxModuleConnectorOptions["canCreateNewPage"]} canCreateNewPage */
export const resolveCanCreateNewPage = async (canCreateNewPage) => {
  if (typeof canCreateNewPage === "function") return Boolean(await canCreateNewPage())
  return Boolean(canCreateNewPage)
}

/**
 * @param {Map<string, string>} fields
 * @param {Pick<
 *   AjaxModuleConnectorOptions,
 *   "createNewPage" | "canCreateNewPage" | "pageExists"
 * >} options
 */
export const handleNewPageHelperRequest = async (
  fields,
  { createNewPage, canCreateNewPage, pageExists }
) => {
  const pageName = fieldValue(fields, "pageName")
  if (pageName.length === 0) {
    return jsonResponse({
      status: "no_name",
      message: NEWPAGE_NO_NAME_MESSAGE
    })
  }

  const unixName = toWikidotUnixName({
    pageName,
    categoryName: fieldValue(fields, "categoryName")
  })
  if (pageExists && (await pageExists(unixName))) {
    const escapedUnixName = escapeHtml(unixName)
    return jsonResponse({
      status: "page_exists",
      message: `The page <em>${escapedUnixName}</em> already exists. <a href="/${escapedUnixName}">Jump to it</a> if you wish.`
    })
  }

  if (!matchesNewPageFormat(pageName, fieldValue(fields, "format"))) {
    return jsonResponse({
      status: "incorrect_name",
      message: NEWPAGE_INCORRECT_NAME_MESSAGE
    })
  }

  const pageTitle = pageName
  const tags = fieldValue(fields, "tags")
  const parentPage = fieldValue(fields, "parent")
  const templateId = fieldValue(fields, "template")
  const mode = fieldValue(fields, "mode")

  if (NEWPAGE_AUTOSAVE_MODES.has(mode)) {
    if (!(await resolveCanCreateNewPage(canCreateNewPage))) {
      return jsonResponse({
        status: "no_permission",
        message: NEWPAGE_NO_PERMISSION_MESSAGE
      })
    }
    if (templateId.length > 0 && tags.length > 0) {
      return jsonResponse({
        status: "not_ok",
        message: NEWPAGE_GENERIC_ERROR_MESSAGE
      })
    }
    if (!createNewPage) {
      return jsonResponse({
        status: "not_ok",
        message: "NewPage autosave is unavailable"
      })
    }

    await createNewPage({
      slug: unixName,
      title: pageTitle,
      wikitext: "",
      tags: templateId.length > 0 ? [] : splitNewPageTags(tags),
      parentPage: templateId.length > 0 ? "" : parentPage
    })

    return jsonResponse({
      status: "ok",
      goToUrl: mode === "save-and-refresh" ? "." : fieldValue(fields, "goTo") || unixName
    })
  }

  /**
   * @type {{
   *   status: string
   *   unixName: string
   *   pageTitle: string
   *   tags: string
   *   parentPage: string
   *   templateId?: string
   * }}
   */
  const response = {
    status: "ok",
    unixName,
    pageTitle,
    tags,
    parentPage
  }
  if (templateId.length > 0) response.templateId = templateId
  return jsonResponse(response)
}
