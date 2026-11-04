import type { IncomingMessage, ServerResponse } from "node:http"

import { handlePageWriteRpc } from "./page-write-handler.ts"
import { handleParentWriteRpc } from "./parent-write-handler.ts"
import { fixtureState, hasExactKeys } from "./context.ts"
import { sendRpcError } from "./response.ts"

const handleUserCreate = ({
  rpcRequest,
  response
}: {
  rpcRequest: any
  response: ServerResponse
}) => {
  const params = rpcRequest.params
  if (
    rpcRequest.method !== "user_create" ||
    !hasExactKeys(params, [
      "user_type",
      "name",
      "email",
      "locales",
      "password",
      "ip_address",
      "bypass_filter",
      "bypass_email_verification"
    ]) ||
    params.user_type !== "regular" ||
    typeof params.name !== "string" ||
    typeof params.email !== "string" ||
    !Array.isArray(params.locales) ||
    typeof params.password !== "string" ||
    typeof params.ip_address !== "string" ||
    typeof params.bypass_filter !== "boolean" ||
    typeof params.bypass_email_verification !== "boolean"
  ) {
    return undefined
  }

  fixtureState.userCreateRequests.push({
    user_type: params.user_type,
    name: params.name,
    email: params.email,
    locales: params.locales,
    hasPassword: params.password.length > 0,
    ip_address: params.ip_address,
    bypass_filter: params.bypass_filter,
    bypass_email_verification: params.bypass_email_verification
  })
  if (params.name === "fixture-registration-failure") {
    sendRpcError(response, rpcRequest.id, -32000, "Fixture registration rejected")
    return { responded: true }
  }
  return { result: { user_id: 6000008, slug: "fixture-new-user" } }
}

export const handleWriteRpc = (input: {
  rpcRequest: any
  request: IncomingMessage
  response: ServerResponse
}) => {
  return (
    handleUserCreate(input) ?? handlePageWriteRpc(input) ?? handleParentWriteRpc(input)
  )
}
