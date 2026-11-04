import type { IncomingMessage, ServerResponse } from "node:http"

import { handleFileCreateRpc } from "./file-create-handler.ts"
import { handleFileEditRpc } from "./file-edit-handler.ts"
import { handleFileReadRpc } from "./file-read-handler.ts"

export const handleFileRpc = (input: {
  rpcRequest: any
  request: IncomingMessage
  response: ServerResponse
  port: number
}) => {
  return (
    handleFileReadRpc(input) ?? handleFileCreateRpc(input) ?? handleFileEditRpc(input)
  )
}
