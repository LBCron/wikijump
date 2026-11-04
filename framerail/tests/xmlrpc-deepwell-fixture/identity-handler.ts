import type { IncomingMessage } from "node:http"

import { fixtureState, hasExactKeys, requestContextHeaders } from "./context.ts"

export const handleIdentityRpc = ({
  rpcRequest,
  request
}: {
  rpcRequest: any
  request: IncomingMessage
}) => {
  const { pageWriteRequests } = fixtureState
  let result

  if (
    rpcRequest.method === "login" &&
    hasExactKeys(rpcRequest.params, [
      "ip_address",
      "name_or_email",
      "password",
      "user_agent"
    ]) &&
    rpcRequest.params.name_or_email === "fixture-mfa-member" &&
    rpcRequest.params.password === "fixture-mfa-password" &&
    typeof rpcRequest.params.ip_address === "string" &&
    typeof rpcRequest.params.user_agent === "string"
  ) {
    result = { needs_mfa: true, session_token: "fixture-pending-mfa-session-token" }
  } else if (
    rpcRequest.method === "login" &&
    hasExactKeys(rpcRequest.params, [
      "ip_address",
      "name_or_email",
      "password",
      "user_agent"
    ]) &&
    rpcRequest.params.name_or_email === "fixture-member" &&
    rpcRequest.params.password === "fixture-member-password" &&
    typeof rpcRequest.params.ip_address === "string" &&
    typeof rpcRequest.params.user_agent === "string"
  ) {
    result = { needs_mfa: false, session_token: "fixture-authenticated-session-token" }
  } else if (
    rpcRequest.method === "login" &&
    hasExactKeys(rpcRequest.params, [
      "ip_address",
      "name_or_email",
      "password",
      "user_agent"
    ]) &&
    rpcRequest.params.name_or_email === process.env.XML_RPC_WRITE_USERNAME &&
    rpcRequest.params.password === process.env.XML_RPC_WRITE_PASSWORD &&
    typeof rpcRequest.params.ip_address === "string" &&
    rpcRequest.params.user_agent === "wikijump-xmlrpc-api/0.1"
  ) {
    pageWriteRequests.login.push({
      headers: requestContextHeaders(request),
      params: rpcRequest.params
    })
    result = { needs_mfa: false, session_token: "fixture-session-token" }
  } else if (
    rpcRequest.method === "session_get" &&
    Array.isArray(rpcRequest.params) &&
    rpcRequest.params.length === 1 &&
    ["fixture-session-token", "fixture-authenticated-session-token"].includes(
      rpcRequest.params[0]
    )
  ) {
    pageWriteRequests.sessionGet.push({
      headers: requestContextHeaders(request),
      params: rpcRequest.params
    })
    result =
      rpcRequest.params[0] === "fixture-authenticated-session-token"
        ? {
            session_token: "fixture-authenticated-session-token",
            user_id: 6000008,
            created_at: "2026-01-01T00:00:00Z",
            expires_at: "2099-01-01T00:00:00Z",
            ip_address: "127.0.0.1",
            user_agent: "fixture-browser",
            restricted: false
          }
        : { user_id: 123 }
  } else if (
    rpcRequest.method === "user_get" &&
    hasExactKeys(rpcRequest.params, ["user"]) &&
    ((rpcRequest.params.user === 123 &&
      request.headers["x-deepwell-session-token"] === "fixture-session-token") ||
      rpcRequest.params.user === "rokurokubi")
  ) {
    pageWriteRequests.userGet.push({
      headers: requestContextHeaders(request),
      params: rpcRequest.params
    })
    result = {
      aliases: [],
      user_id: 123,
      name: "Rokurokubi",
      slug: "rokurokubi"
    }
  } else {
    return undefined
  }

  return { result }
}
