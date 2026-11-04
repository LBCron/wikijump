import { handlePageLookupRpc } from "./page-lookup-handler.ts"
import { handlePageRelationshipRpc } from "./page-relationship-handler.ts"
import { hasExactKeys } from "./context.ts"

export const handlePageDetailRpc = (input: {
  rpcRequest: any
  request: import("node:http").IncomingMessage
  response: import("node:http").ServerResponse
}) => {
  const { rpcRequest } = input
  if (
    rpcRequest.method === "page_meta_tags" &&
    hasExactKeys(rpcRequest.params, ["site_id", "page_id"]) &&
    rpcRequest.params.site_id === 6000005 &&
    Number.isSafeInteger(rpcRequest.params.page_id)
  ) {
    return { result: [] }
  }

  return handlePageLookupRpc(input) ?? handlePageRelationshipRpc(input)
}
