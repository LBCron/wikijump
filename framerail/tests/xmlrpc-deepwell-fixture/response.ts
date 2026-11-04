import type { ServerResponse } from "node:http"

export const sendRpcError = (
  response: ServerResponse,
  id: unknown,
  code: number,
  message: string
) => {
  response.writeHead(200, { "content-type": "application/json" }).end(
    JSON.stringify({
      error: { code, message },
      id,
      jsonrpc: "2.0"
    })
  )
}

export const sendRpcResult = (response: ServerResponse, id: unknown, result: unknown) => {
  response
    .writeHead(200, { "content-type": "application/json" })
    .end(JSON.stringify({ id, jsonrpc: "2.0", result }))
}
