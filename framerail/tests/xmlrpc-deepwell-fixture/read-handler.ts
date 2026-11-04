import type { IncomingMessage, ServerResponse } from "node:http"

import { handleArticleRpc } from "./article-handler.ts"
import { handleAuthRpc } from "./auth-handler.ts"
import { handleForumRpc } from "./forum-handler.ts"
import { handlePageReadRpc } from "./page-read-handler.ts"
import { handleVoteReadRpc } from "./vote-read-handler.ts"

export const handleReadRpc = (input: {
  rpcRequest: any
  request: IncomingMessage
  response: ServerResponse
  fixtureState: any
}) => {
  return (
    handleAuthRpc(input) ??
    handleArticleRpc(input) ??
    handlePageReadRpc(input) ??
    handleVoteReadRpc(input) ??
    handleForumRpc(input)
  )
}
