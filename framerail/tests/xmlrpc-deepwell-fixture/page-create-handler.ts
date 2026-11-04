import { fixtureState, hasExactKeys, requestContextHeaders } from "./context.js"
import { pages } from "./data.js"

export const handlePageCreateRpc = ({
  rpcRequest,
  request
}: {
  rpcRequest: any
  request: import("node:http").IncomingMessage
}) => {
  const pageEditKeys = [
    "alt_title",
    "ip_address",
    "layout",
    "revision_comments",
    "site_id",
    "slug",
    "tags",
    "title",
    "user_id",
    "wikitext"
  ]
  const xmlRpcKeys = pageEditKeys.filter((key) => key !== "tags")
  if (
    rpcRequest.method !== "page_create" ||
    (!hasExactKeys(rpcRequest.params, pageEditKeys) &&
      !hasExactKeys(rpcRequest.params, xmlRpcKeys)) ||
    rpcRequest.params.site_id !== 6000005 ||
    request.headers["x-deepwell-session-token"] !== "fixture-session-token" ||
    request.headers["x-deepwell-site-id"] !== "6000005" ||
    typeof rpcRequest.params.slug !== "string" ||
    (rpcRequest.params.tags !== undefined && !Array.isArray(rpcRequest.params.tags))
  ) {
    return undefined
  }

  const { counters, pageWriteRequests } = fixtureState
  pageWriteRequests.pageCreate.push({
    headers: requestContextHeaders(request),
    params: rpcRequest.params
  })
  const requestedSlug = rpcRequest.params.slug
  const slug =
    requestedSlug === "autonumber-requested"
      ? "104"
      : requestedSlug === "data-form-create-flow:example"
        ? "data-form-create-flow:104"
        : requestedSlug
  const revisionId = counters.nextRevisionId++
  pages[slug] = {
    page_id: counters.nextPageId++,
    revision_id: revisionId,
    page_created_at: "2026-06-29T00:00:00Z",
    page_updated_at: null,
    page_revision_count: 1,
    revision_created_at: "2026-06-29T00:00:00Z",
    revision_user_id: rpcRequest.params.user_id,
    creator_user_id: rpcRequest.params.user_id,
    title: rpcRequest.params.title,
    slug,
    tags: rpcRequest.params.tags ?? [],
    rating: 0,
    wikitext: rpcRequest.params.wikitext,
    compiled_body_html: `<p>${rpcRequest.params.wikitext}</p>`
  }
  return {
    result: { page_id: pages[slug].page_id, revision_id: revisionId, slug }
  }
}
