import type { ServerResponse } from "node:http"

import { fixtureState, isSignedI64String } from "./context.ts"
import { forumPostsByPage } from "./data.ts"
import type { FixtureForumPost } from "./data.ts"
import { sendRpcError } from "./response.ts"

export const handleForumGetRpc = ({
  rpcRequest,
  response
}: {
  rpcRequest: any
  response: ServerResponse
}):
  | { result?: (FixtureForumPost & { fullname: string })[]; responded?: boolean }
  | undefined => {
  if (
    rpcRequest.method !== "forum_post_get" ||
    rpcRequest.params?.site_id !== 6000005 ||
    !Array.isArray(rpcRequest.params.posts) ||
    !rpcRequest.params.posts.every((post: unknown) => typeof post === "string")
  ) {
    return undefined
  }

  if (
    rpcRequest.params.posts.length > 10 ||
    rpcRequest.params.posts.some((post: string) => !isSignedI64String(post))
  ) {
    sendRpcError(
      response,
      rpcRequest.id,
      -32602,
      "Unexpected fixture forum_post_get params"
    )
    return { responded: true }
  }

  const postsById = new Map<string, FixtureForumPost & { fullname: string }>(
    Object.entries(forumPostsByPage).flatMap(([page, posts]) =>
      posts.map((post: FixtureForumPost) => [
        String(post.id),
        { ...post, fullname: page }
      ])
    )
  )
  const result = rpcRequest.params.posts.flatMap((post: string) => {
    const fixturePost = postsById.get(post)
    return fixturePost === undefined ? [] : [fixturePost]
  })

  fixtureState.pageReadRequests.forumPostGet.push({
    params: structuredClone(rpcRequest.params),
    resultIds: result.map((post: FixtureForumPost & { fullname: string }) => post.id)
  })

  return { result }
}
