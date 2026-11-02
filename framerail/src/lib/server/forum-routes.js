import { error } from "@sveltejs/kit"

const INVALID_FORUM_ROUTE = '<div class="error-block">Invalid forum route.</div>'
const MISSING_CATEGORY =
  '<div class="error-block">Requested forum category does not exist.</div>'
const MISSING_THREAD =
  '<div class="error-block">The thread you\'re trying to show seems to have been deleted</div>'
const FORUM_SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u
const CATEGORY_PAGE = /^p\/([1-9]\d*)$/u
const MAX_CATEGORY_PAGE = 50
const FORUM_THREAD_ID_SCRIPT =
  /<script type="text\/javascript">WIKIDOT\.forumThreadId = ([1-9]\d*);<\/script>/gu

/**
 * @typedef {{
 *   params: Record<string, string | undefined>
 *   request: Request
 *   cookies: { get(name: string): string | undefined }
 * }} ForumRouteEvent
 *
 *
 * @typedef {{ status: string; body: string; js_include?: string[] }} ForumOutput
 *
 *
 * @typedef {{
 *   loadSiteInfo(headers: Headers): { siteId: number }
 *   wikidotForumModule(
 *     siteId: number,
 *     moduleName: string,
 *     parameters: Record<string, string>,
 *     requestContext: { siteId: number; sessionToken: string | undefined }
 *   ): PromiseLike<ForumOutput>
 * }} ForumRouteDependencies
 */

/**
 * @param {ForumRouteEvent} event @param
 *   {ForumRouteDependencies["loadSiteInfo"]} loadSiteInfo
 */
const requestContext = (event, loadSiteInfo) => {
  const { siteId } = loadSiteInfo(event.request.headers)
  return {
    siteId,
    deepwell: {
      siteId,
      sessionToken: event.cookies.get("wikijump_token")
    }
  }
}

/** @param {ForumOutput} result @param {string} fallback */
const bodyOr = (result, fallback) => ({
  body: result.status === "ok" ? result.body : fallback
})

/**
 * Preserve Wikidot's forumThreadId semantic without executing raw inline
 * HTML. SvelteKit owns the CSP nonce, so the trusted route ID is passed to
 * compiled client code and the exact legacy assignment is removed here.
 *
 * @param {ForumOutput} result @param {string} fallback @param {string}
 *   thread
 */
const threadBody = (result, fallback, thread) => {
  if (result.status !== "ok") return { body: fallback, forumThreadId: null }
  const threadId = Number(thread)
  if (!Number.isSafeInteger(threadId) || threadId <= 0) {
    throw new Error("forum thread route produced an invalid trusted thread ID")
  }
  const matches = [...result.body.matchAll(FORUM_THREAD_ID_SCRIPT)]
  if (matches.length !== 1 || Number(matches[0][1]) !== threadId) {
    throw new Error(
      "forum thread response did not bind its exact trusted thread ID script"
    )
  }
  return {
    body: result.body.replace(matches[0][0], ""),
    forumThreadId: threadId
  }
}

/**
 * @param {ForumRouteEvent} event @param {ForumRouteDependencies}
 *   dependencies
 */
export const loadForumStartRoute = async (event, dependencies) => {
  const hidden = event.params.extra?.split("/", 1)[0] === "hidden"

  const context = requestContext(event, (headers) => dependencies.loadSiteInfo(headers))
  const result = await dependencies.wikidotForumModule(
    context.siteId,
    "forum/ForumStartModule",
    hidden ? { hidden: "true" } : {},
    context.deepwell
  )
  return bodyOr(result, INVALID_FORUM_ROUTE)
}

/**
 * @param {ForumRouteEvent} event @param {ForumRouteDependencies}
 *   dependencies
 */
export const loadForumCategoryRoute = async (event, dependencies) => {
  const category = event.params.category
  if (!category) {
    error(404)
  }

  let page = "1"
  if (!FORUM_SLUG.test(event.params.name ?? "")) {
    const match = CATEGORY_PAGE.exec(event.params.name ?? "")
    if (!match || Number(match[1]) > MAX_CATEGORY_PAGE) {
      error(404)
    }
    page = match[1]
  }

  const context = requestContext(event, (headers) => dependencies.loadSiteInfo(headers))
  const result = await dependencies.wikidotForumModule(
    context.siteId,
    "forum/ForumViewCategoryModule",
    { c: category, p: page },
    context.deepwell
  )
  return bodyOr(result, MISSING_CATEGORY)
}

/**
 * @param {ForumRouteEvent} event @param {ForumRouteDependencies}
 *   dependencies
 */
export const loadForumThreadRoute = async (event, dependencies) => {
  const thread = event.params.thread
  if (!thread) {
    error(404)
  }
  if (!FORUM_SLUG.test(event.params.name ?? "")) {
    error(404)
  }

  const context = requestContext(event, (headers) => dependencies.loadSiteInfo(headers))
  const result = await dependencies.wikidotForumModule(
    context.siteId,
    "forum/ForumViewThreadModule",
    { t: thread },
    context.deepwell
  )
  return threadBody(result, MISSING_THREAD, thread)
}
