import { handlePageCreateEditRpc } from "./page-create-edit-handler.ts"
import { handlePageRevisionRpc } from "./page-revision-handler.ts"

export const handlePageWriteRpc = (input: {
  rpcRequest: any
  request: import("node:http").IncomingMessage
  response: import("node:http").ServerResponse
}) => {
  return handlePageCreateEditRpc(input) ?? handlePageRevisionRpc(input)
}
