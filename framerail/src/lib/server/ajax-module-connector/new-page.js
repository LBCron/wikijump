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

const QUANTIFIER_STARTS = new Set(["*", "+", "?", "{"])

/** @param {string} character */
const isQuantifierStart = (character) => QUANTIFIER_STARTS.has(character)

/**
 * @typedef {{
 *   index: number
 *   quantifierCount: number
 *   hasAlternation: boolean
 * }} NewPagePatternState
 *
 * @typedef {{
 *   source: string
 *   hasQuantifier: boolean
 *   hasAlternation: boolean
 * }} NewPagePatternBody
 */

/**
 * @param {NewPagePatternState} state
 * @param {string} pattern
 * @returns {string | null}
 */
const parseNewPagePatternEscape = (state, pattern) => {
  state.index += 1
  if (state.index >= pattern.length) return "\\"
  const character = pattern[state.index]
  if (/^[1-9]$/u.test(character)) return null
  state.index += 1
  return `\\${character}`
}

/**
 * @param {NewPagePatternState} state
 * @param {string} pattern
 */
const parseNewPagePatternClass = (state, pattern) => {
  let source = ""
  while (state.index < pattern.length) {
    const character = pattern[state.index]
    source += character
    state.index += 1
    if (character === "]") break
  }
  return source
}

/**
 * @param {NewPagePatternState} state
 * @param {string} pattern
 * @returns {{ source: string; hasQuantifier: boolean } | null}
 */
const parseNewPagePatternGroup = (state, pattern) => {
  let source = "("
  state.index += 1
  if (pattern[state.index] === "?") {
    if (pattern[state.index + 1] !== ":") return null
    source += "?:"
    state.index += 2
  }
  const body = parseNewPagePatternBody(state, pattern)
  if (body === null) return null
  source += body.source
  if (pattern[state.index] === ")") {
    source += ")"
    state.index += 1
  }
  let hasQuantifier = body.hasQuantifier
  if (state.index < pattern.length && isQuantifierStart(pattern[state.index])) {
    if (body.hasQuantifier || body.hasAlternation) return null
    state.quantifierCount += 1
    if (state.quantifierCount > 1) return null
    source += pattern[state.index]
    state.index += 1
    hasQuantifier = true
  }
  return { source, hasQuantifier }
}

/**
 * @param {NewPagePatternState} state
 * @param {string} pattern
 * @returns {{ source: string; hasQuantifier: boolean } | null}
 */
const parseNewPagePatternTerm = (state, pattern) => {
  const character = pattern[state.index]
  if (character === "(") return parseNewPagePatternGroup(state, pattern)

  let source
  if (character === "[") {
    source = parseNewPagePatternClass(state, pattern)
  } else if (character === "\\") {
    source = parseNewPagePatternEscape(state, pattern)
    if (source === null) return null
  } else if (isQuantifierStart(character)) {
    return null
  } else {
    source = character
    state.index += 1
  }

  let hasQuantifier = false
  if (state.index < pattern.length && isQuantifierStart(pattern[state.index])) {
    state.quantifierCount += 1
    if (state.quantifierCount > 1) return null
    source += pattern[state.index]
    state.index += 1
    hasQuantifier = true
  }
  return { source, hasQuantifier }
}

/**
 * @param {NewPagePatternState} state
 * @param {string} pattern
 * @returns {NewPagePatternBody | null}
 */
const parseNewPagePatternBody = (state, pattern) => {
  let source = ""
  let hasQuantifier = false
  let hasAlternation = false
  while (state.index < pattern.length) {
    const character = pattern[state.index]
    if (character === ")") break
    if (character === "|") {
      state.hasAlternation = true
      hasAlternation = true
      source += character
      state.index += 1
      continue
    }
    const term = parseNewPagePatternTerm(state, pattern)
    if (term === null) return null
    if (term.hasQuantifier) hasQuantifier = true
    source += term.source
  }
  return { source, hasQuantifier, hasAlternation }
}

/**
 * @param {string} format
 * @returns {RegExp | "unsafe" | null}
 */
const compileNewPageFormat = (format) => {
  if (format.length > MAX_NEWPAGE_FORMAT_LENGTH) return "unsafe"
  if (!format.startsWith("/")) return null

  const delimiter = format.lastIndexOf("/")
  if (delimiter <= 0) return null

  const pattern = format.slice(1, delimiter)
  const rawFlags = format.slice(delimiter + 1)
  let flags = ""
  if (rawFlags.includes("i")) flags += "i"
  if (rawFlags.includes("m")) flags += "m"

  const state = { index: 0, quantifierCount: 0, hasAlternation: false }
  const body = parseNewPagePatternBody(state, pattern)
  if (body === null || state.index !== pattern.length) return "unsafe"
  if (state.hasAlternation && state.quantifierCount > 0) return "unsafe"

  try {
    return new RegExp(body.source, flags)
  } catch {
    return null
  }
}

/**
 * @param {string} pageName
 * @param {string} format
 */
const matchesNewPageFormat = (pageName, format) => {
  if (format.length === 0) return true

  if (pageName.length > MAX_NEWPAGE_PAGE_NAME_LENGTH) return false

  const regex = compileNewPageFormat(format)
  if (regex === "unsafe") return false
  if (regex === null) return true
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
