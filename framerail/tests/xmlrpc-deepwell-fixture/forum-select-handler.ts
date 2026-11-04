import type { ServerResponse } from "node:http"

import { fixtureState, isSignedI64String } from "./context.ts"
import { forumPostsByPage } from "./data.ts"
import type { FixtureForumPost } from "./data.ts"
import { sendRpcError } from "./response.ts"

export const handleForumSelectRpc = ({
  rpcRequest,
  response
}: {
  rpcRequest: any
  response: ServerResponse
}): { result?: number[]; responded?: boolean } | undefined => {
  if (
    rpcRequest.method !== "forum_post_select" ||
    rpcRequest.params?.site_id !== 6000005 ||
    (rpcRequest.params.page !== undefined &&
      typeof rpcRequest.params.page !== "string") ||
    (rpcRequest.params.reply_to !== undefined &&
      typeof rpcRequest.params.reply_to !== "string") ||
    (rpcRequest.params.created_by !== undefined &&
      typeof rpcRequest.params.created_by !== "string")
  ) {
    return undefined
  }

  fixtureState.pageReadRequests.forumPostSelect.push(rpcRequest.params)

  if (
    rpcRequest.params.reply_to !== undefined &&
    rpcRequest.params.reply_to !== "-" &&
    !isSignedI64String(rpcRequest.params.reply_to)
  ) {
    sendRpcError(
      response,
      rpcRequest.id,
      -32602,
      "Unexpected fixture forum_post_select params"
    )
    return { responded: true }
  }

  const posts =
    rpcRequest.params.page === undefined
      ? Object.values(forumPostsByPage).flat()
      : (forumPostsByPage[rpcRequest.params.page] ?? [])
  const result = posts
    .filter((post: FixtureForumPost) => {
      if (rpcRequest.params.reply_to === undefined) return true
      if (rpcRequest.params.reply_to === "-") return post.reply_to === null
      return String(post.reply_to) === rpcRequest.params.reply_to
    })
    .filter(
      (post: FixtureForumPost) =>
        rpcRequest.params.created_by === undefined ||
        post.created_by === rpcRequest.params.created_by
    )
    .map((post: FixtureForumPost) => post.id)

  return { result }
}
