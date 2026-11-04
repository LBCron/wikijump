import { fixtureState, hasExactKeys, pageById, requestContextHeaders } from "./context.js"

export const handlePageRevisionRpc = ({
  rpcRequest,
  request
}: {
  rpcRequest: any
  request: import("node:http").IncomingMessage
}) => {
  const { counters, pageWriteRequests } = fixtureState
  let result: any

  if (
    rpcRequest.method === "page_rollback" &&
    rpcRequest.params.site_id === 6000005 &&
    typeof rpcRequest.params.page === "number" &&
    pageById(rpcRequest.params.page) &&
    typeof rpcRequest.params.last_revision_id === "number" &&
    typeof rpcRequest.params.revision_number === "number" &&
    typeof rpcRequest.params.revision_comments === "string" &&
    rpcRequest.params.user_id === 123 &&
    typeof rpcRequest.params.ip_address === "string" &&
    request.headers["x-deepwell-session-token"] === "fixture-session-token" &&
    request.headers["x-deepwell-site-id"] === "6000005" &&
    request.headers["x-deepwell-page"] === pageById(rpcRequest.params.page)?.slug
  ) {
    pageWriteRequests.pageRollback.push({
      headers: requestContextHeaders(request),
      params: rpcRequest.params
    })
    const page = pageById(rpcRequest.params.page)
    if (!page) return undefined
    page.revision_id = counters.nextRevisionId++
    page.page_revision_count += 1
    result = {
      revision_id: page.revision_id,
      revision_number: page.page_revision_count - 1
    }
  } else if (
    rpcRequest.method === "vote_set" &&
    hasExactKeys(rpcRequest.params, ["page_id", "value"]) &&
    pageById(rpcRequest.params.page_id) &&
    [-1, 1, 2, 3, 4, 5].includes(rpcRequest.params.value) &&
    request.headers["x-deepwell-session-token"] === "fixture-session-token" &&
    request.headers["x-deepwell-site-id"] === "6000005" &&
    request.headers["x-deepwell-page"] === pageById(rpcRequest.params.page_id)?.slug
  ) {
    pageWriteRequests.voteSet.push({
      headers: requestContextHeaders(request),
      params: rpcRequest.params
    })
    const pageId = rpcRequest.params.page_id
    const previousValue = fixtureState.voteValues[pageId] ?? 0
    fixtureState.voteValues[pageId] = rpcRequest.params.value
    if (pageById(pageId)?.slug === "page-workflow-star-probe") {
      ;(fixtureState.ratingScores as Record<number, number>)[pageId] =
        rpcRequest.params.value
    } else if (pageId === 3000342) {
      ;(fixtureState.ratingScores as Record<number, number>)[pageId] +=
        rpcRequest.params.value - previousValue
    }
    result = {
      page_vote_id: 7000001,
      page_id: rpcRequest.params.page_id,
      user_id: 123,
      value: rpcRequest.params.value
    }
  } else if (
    rpcRequest.method === "vote_remove" &&
    hasExactKeys(rpcRequest.params, ["page_id"]) &&
    pageById(rpcRequest.params.page_id) &&
    request.headers["x-deepwell-session-token"] === "fixture-session-token" &&
    request.headers["x-deepwell-site-id"] === "6000005" &&
    request.headers["x-deepwell-page"] === pageById(rpcRequest.params.page_id)?.slug
  ) {
    pageWriteRequests.voteRemove.push({
      headers: requestContextHeaders(request),
      params: rpcRequest.params
    })
    const pageId = rpcRequest.params.page_id
    const previousValue = fixtureState.voteValues[pageId] ?? 0
    delete fixtureState.voteValues[pageId]
    if (pageById(pageId)?.slug === "page-workflow-star-probe") {
      ;(fixtureState.ratingScores as Record<number, number>)[pageId] = 3
    } else if (pageId === 3000342) {
      ;(fixtureState.ratingScores as Record<number, number>)[pageId] -= previousValue
    }
    result = {
      page_vote_id: 7000001,
      page_id: rpcRequest.params.page_id,
      user_id: 123,
      value: null
    }
  } else {
    return undefined
  }

  return { result }
}
