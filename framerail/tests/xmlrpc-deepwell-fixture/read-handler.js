import { handleArticleRpc } from "./article-handler.ts"
import { handleAuthRpc } from "./auth-handler.js"
import { handleForumRpc } from "./forum-handler.js"
import { handlePageReadRpc } from "./page-read-handler.ts"
import { handleVoteReadRpc } from "./vote-read-handler.js"

/**
 * @param {{
 *   rpcRequest: any
 *   request: import("node:http").IncomingMessage
 *   response: import("node:http").ServerResponse
 * }} input
 */
export const handleReadRpc = (input) => {
  return (
    handleAuthRpc(input) ??
    handleArticleRpc(input) ??
    handlePageReadRpc(input) ??
    handleVoteReadRpc(input) ??
    handleForumRpc(input)
  )
}
