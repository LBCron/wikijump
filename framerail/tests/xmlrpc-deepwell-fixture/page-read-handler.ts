import { handlePageDetailRpc } from "./page-detail-handler.ts"
import { handlePageLookupRpc } from "./page-lookup-handler.ts"
import { handlePageQueryRpc } from "./page-query-handler.ts"

export const handlePageReadRpc = (input: {
  rpcRequest: any
  request: import("node:http").IncomingMessage
  response: import("node:http").ServerResponse
}) => {
  return (
    handlePageDetailRpc(input) ?? handlePageLookupRpc(input) ?? handlePageQueryRpc(input)
  )
}
