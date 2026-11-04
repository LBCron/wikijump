import { handlePageCreateRpc } from "./page-create-handler.ts"
import { handlePageEditRpc } from "./page-edit-handler.ts"
import { handlePageEditLockRpc } from "./page-edit-lock-handler.ts"

export const handlePageCreateEditRpc = (input: {
  rpcRequest: any
  request: import("node:http").IncomingMessage
  response: import("node:http").ServerResponse
}) => {
  return (
    handlePageCreateRpc(input) ?? handlePageEditLockRpc(input) ?? handlePageEditRpc(input)
  )
}
