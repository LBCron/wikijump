import type { IncomingMessage, ServerResponse } from "node:http"

import { handleFileRpc } from "./file-handler.ts"
import { handleInfoRpc } from "./info-handler.ts"
import { handleReadRpc } from "./read-handler.ts"
import { handleProfileRpc } from "./profile-handler.ts"
import { sendRpcError, sendRpcResult } from "./response.ts"
import { handleWriteRpc } from "./write-handler.ts"
import { fixtureState } from "./context.ts"

export const dispatchFixtureRpc = ({
  rpcRequest,
  request,
  response,
  port
}: {
  rpcRequest: any
  request: IncomingMessage
  response: ServerResponse
  port: number
}) => {
  const input = { rpcRequest, request, response, fixtureState }
  const outcome =
    handleInfoRpc(input) ??
    handleProfileRpc(input) ??
    handleReadRpc(input) ??
    handleWriteRpc(input) ??
    handleFileRpc({ ...input, port })

  if (outcome && "responded" in outcome && outcome.responded) return
  if (outcome) {
    sendRpcResult(response, rpcRequest.id, outcome.result)
    return
  }

  const requestShape =
    rpcRequest.method === "article_view"
      ? ` ${JSON.stringify({
          paramKeys: Object.keys(rpcRequest.params ?? {}).sort(),
          route: rpcRequest.params?.route,
          sessionTokenType:
            rpcRequest.params?.session_token === null
              ? "null"
              : typeof rpcRequest.params?.session_token,
          siteId: rpcRequest.params?.site_id,
          headerSiteId: request.headers["x-deepwell-site-id"],
          hasHeaderSessionToken: Boolean(request.headers["x-deepwell-session-token"])
        })}`
      : ""
  sendRpcError(
    response,
    rpcRequest.id,
    -32601,
    `Unexpected Deepwell fixture request: ${rpcRequest.method}${requestShape}`
  )
}
