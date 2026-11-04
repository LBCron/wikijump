import { fixtureState, hasExactKeys, requestContextHeaders } from "./context.js"
import { sendRpcError } from "./response.js"

export const handlePageQueryRpc = ({
  rpcRequest,
  request,
  response
}: {
  rpcRequest: any
  request: import("node:http").IncomingMessage
  response: import("node:http").ServerResponse
}) => {
  const { pageReadRequests } = fixtureState
  let result: string[]

  if (
    rpcRequest.method === "page_select" &&
    rpcRequest.params !== null &&
    typeof rpcRequest.params === "object" &&
    rpcRequest.params.site === "missing-site" &&
    Object.keys(rpcRequest.params).every((key) =>
      ["site", "categories", "tags_any", "tags_all", "tags_none"].includes(key)
    ) &&
    Object.entries(rpcRequest.params).every(
      ([key, value]) => key === "site" || (Array.isArray(value) && value.length === 0)
    ) &&
    request.headers["x-deepwell-session-token"] === "fixture-session-token"
  ) {
    pageReadRequests.pageSelect.push({
      headers: requestContextHeaders(request),
      params: rpcRequest.params
    })
    sendRpcError(response, rpcRequest.id, 2004, "Site does not exist")
    return { responded: true }
  } else if (
    rpcRequest.method === "page_select" &&
    rpcRequest.params !== null &&
    typeof rpcRequest.params === "object" &&
    rpcRequest.params.site === "scp-wiki" &&
    Object.keys(rpcRequest.params).some((key) =>
      ["categories", "tags_any"].includes(key)
    ) &&
    Object.keys(rpcRequest.params).every((key) =>
      ["site", "categories", "tags_any"].includes(key)
    ) &&
    Object.entries(rpcRequest.params).every(
      ([key, value]) => key === "site" || (Array.isArray(value) && value.length === 0)
    ) &&
    request.headers["x-deepwell-session-token"] === "fixture-session-token"
  ) {
    pageReadRequests.pageSelect.push({
      headers: requestContextHeaders(request),
      params: rpcRequest.params
    })
    result = []
  } else if (
    rpcRequest.method === "page_select" &&
    hasExactKeys(rpcRequest.params, ["parent", "site"]) &&
    rpcRequest.params.site === "scp-wiki" &&
    rpcRequest.params.parent === "scp-173" &&
    request.headers["x-deepwell-session-token"] === "fixture-session-token"
  ) {
    pageReadRequests.pageSelect.push({
      headers: requestContextHeaders(request),
      params: rpcRequest.params
    })
    result = ["scp-173-child-a", "scp-173-child-b"]
  } else if (
    rpcRequest.method === "page_select" &&
    hasExactKeys(rpcRequest.params, ["parent", "site"]) &&
    rpcRequest.params.site === "scp-wiki" &&
    typeof rpcRequest.params.parent === "string" &&
    request.headers["x-deepwell-session-token"] === "fixture-session-token"
  ) {
    pageReadRequests.pageSelect.push({
      headers: requestContextHeaders(request),
      params: rpcRequest.params
    })
    result = []
  } else if (
    rpcRequest.method === "page_tags_select" &&
    rpcRequest.params?.site === "scp-wiki" &&
    request.headers["x-deepwell-session-token"] === "fixture-session-token" &&
    (rpcRequest.params.categories === undefined ||
      rpcRequest.params.categories === null ||
      (Array.isArray(rpcRequest.params.categories) &&
        rpcRequest.params.categories.length <= 100 &&
        rpcRequest.params.categories.every(
          (category: unknown) => typeof category === "string"
        ))) &&
    (rpcRequest.params.pages === undefined ||
      rpcRequest.params.pages === null ||
      (Array.isArray(rpcRequest.params.pages) &&
        rpcRequest.params.pages.length <= 100 &&
        rpcRequest.params.pages.every((page: unknown) => typeof page === "string")))
  ) {
    fixtureState.lastPageTagsSelectRequest = {
      headers: requestContextHeaders(request),
      params: rpcRequest.params
    }
    result = ["_cc", "tale"]
  } else if (
    rpcRequest.method === "page_select" &&
    rpcRequest.params?.site === "scp-wiki" &&
    rpcRequest.params?.pagetype === "normal" &&
    Array.isArray(rpcRequest.params.categories) &&
    rpcRequest.params.categories.length === 1 &&
    rpcRequest.params.categories[0] === "_default" &&
    rpcRequest.params?.created_by === "-1" &&
    rpcRequest.params?.rating === ">=0" &&
    rpcRequest.params?.order === "created_at desc" &&
    request.headers["x-deepwell-session-token"] === "fixture-session-token"
  ) {
    fixtureState.lastPageSelectParams = rpcRequest.params
    result = ["scp-173", "scp-anthology-2024", "scp-8566"]
  } else {
    return undefined
  }

  return { result }
}
