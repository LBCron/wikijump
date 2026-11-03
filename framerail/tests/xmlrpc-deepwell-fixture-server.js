import { createServer } from "node:http"

import {
  createAuthenticatedUser,
  fixtureState,
  resetRequestGroups
} from "./xmlrpc-deepwell-fixture/context.js"
import { pages } from "./xmlrpc-deepwell-fixture/data.js"
import { dispatchFixtureRpc } from "./xmlrpc-deepwell-fixture/dispatch.js"
import { sendRpcError } from "./xmlrpc-deepwell-fixture/response.js"

const PORT = Number(process.env.PLAYWRIGHT_FIXTURE_PORT ?? "42747")
const initialPageWorkflowProbe = structuredClone(pages["page-workflow-probe"])
const initialPageWorkflowFiles = Object.fromEntries(
  Object.entries(fixtureState.filesByPageId[3000340] ?? {}).map(([name, file]) => [
    name,
    { ...file, content: Buffer.from(file.content) }
  ])
)

/**
 * @param {import("node:http").ServerResponse} response
 * @param {unknown} value
 */
const sendJson = (response, value) => {
  response
    .writeHead(200, { "content-type": "application/json" })
    .end(JSON.stringify(value))
}

/**
 * @param {import("node:http").IncomingMessage} request
 * @param {import("node:http").ServerResponse} response
 */
const handleUpload = (request, response) => {
  if (request.method !== "PUT" || !request.url?.startsWith("/upload/")) return false

  const pendingBlobId = decodeURIComponent(request.url.slice("/upload/".length))
  const chunks = []
  request.on("data", (chunk) => chunks.push(Buffer.from(chunk)))
  request.on("end", () => {
    if (request.headers.host !== `127.0.0.1:${PORT}`) {
      response.writeHead(400).end("Unexpected signed upload Host")
      return
    }
    fixtureState.pendingUploads[pendingBlobId] = Buffer.concat(chunks)
    response.writeHead(200).end()
  })
  return true
}

/**
 * @param {import("node:http").IncomingMessage} request
 * @param {import("node:http").ServerResponse} response
 */
const handleDiagnosticRequest = (request, response) => {
  const url = new URL(request.url ?? "/", `http://127.0.0.1:${PORT}`)

  if (request.method === "POST" && url.pathname === "/reset-authenticated-profile") {
    fixtureState.authenticatedUser = createAuthenticatedUser()
    sendJson(response, { reset: true })
    return true
  }
  if (request.method === "POST" && url.pathname === "/reset-page-workflow-probe") {
    Object.assign(pages["page-workflow-probe"], structuredClone(initialPageWorkflowProbe))
    fixtureState.filesByPageId[3000340] = Object.fromEntries(
      Object.entries(initialPageWorkflowFiles).map(([name, file]) => [
        name,
        { ...file, content: Buffer.from(file.content) }
      ])
    )
    sendJson(response, { reset: true })
    return true
  }
  if (request.method === "POST" && url.pathname === "/hold-page-edit-lock") {
    const slug = url.searchParams.get("slug")
    if (!slug || !pages[slug]) {
      response.writeHead(400).end("Unknown page slug")
      return true
    }
    const lockId = fixtureState.counters.nextEditLockId++
    fixtureState.editLocks[slug] = {
      lock_id: lockId,
      secret: `fixture-edit-lock-secret-${lockId}`,
      user_id: Number(url.searchParams.get("user_id") ?? "456"),
      mode: "page",
      section_index: null
    }
    sendJson(response, { held: true, lock_id: lockId })
    return true
  }
  if (request.method === "POST" && url.pathname === "/clear-page-edit-locks") {
    fixtureState.editLocks = {}
    sendJson(response, { cleared: true })
    return true
  }
  if (request.method !== "GET") return false
  if (request.url === "/last-page-tags-request") {
    sendJson(response, fixtureState.lastPageTagsSelectRequest)
    return true
  }
  if (request.url === "/last-page-select-request") {
    sendJson(response, fixtureState.lastPageSelectParams)
    return true
  }
  if (request.url === "/last-page-read-requests") {
    const snapshot = structuredClone(fixtureState.pageReadRequests)
    resetRequestGroups(fixtureState.pageReadRequests)
    sendJson(response, snapshot)
    return true
  }
  if (request.url === "/page-revision-diff-requests") {
    sendJson(response, fixtureState.pageReadRequests.pageRevisionDiff)
    return true
  }
  if (url.pathname === "/release-page-revision-diff") {
    const release = fixtureState.pendingPageRevisionDiffResponse
    fixtureState.pendingPageRevisionDiffResponse = null
    release?.(url.searchParams.get("outcome") === "success" ? "success" : "failure")
    sendJson(response, { released: release !== null })
    return true
  }
  if (request.url === "/last-article-read-requests") {
    const snapshot = structuredClone(fixtureState.articleReadRequests)
    resetRequestGroups(fixtureState.articleReadRequests)
    sendJson(response, snapshot)
    return true
  }
  if (request.url === "/last-forum-module-requests") {
    const snapshot = structuredClone(fixtureState.forumModuleRequests)
    fixtureState.forumModuleRequests.length = 0
    sendJson(response, snapshot)
    return true
  }
  if (request.url === "/last-page-write-requests") {
    const snapshot = structuredClone(fixtureState.pageWriteRequests)
    resetRequestGroups(fixtureState.pageWriteRequests)
    sendJson(response, snapshot)
    return true
  }
  if (request.url === "/last-user-create-requests") {
    const snapshot = fixtureState.userCreateRequests.slice()
    fixtureState.userCreateRequests.length = 0
    sendJson(response, snapshot)
    return true
  }
  if (request.url === "/last-site-create-requests") {
    const snapshot = fixtureState.siteCreateRequests.slice()
    fixtureState.siteCreateRequests.length = 0
    fixtureState.lastCreatedSiteSlug = null
    sendJson(response, snapshot)
    return true
  }
  if (request.url === "/last-file-requests") {
    const snapshot = structuredClone(fixtureState.fileRequests)
    resetRequestGroups(fixtureState.fileRequests)
    sendJson(response, snapshot)
    return true
  }
  return false
}

/**
 * @param {import("node:http").IncomingMessage} request
 * @param {import("node:http").ServerResponse} response
 */
const handleJsonRpc = (request, response) => {
  if (request.method !== "POST" || request.url !== "/jsonrpc") return false

  let body = ""
  request.setEncoding("utf8")
  request.on("data", (chunk) => {
    body += chunk
  })
  request.on("end", () => {
    let rpcRequest
    try {
      rpcRequest = JSON.parse(body)
    } catch {
      sendRpcError(response, null, -32700, "Parse error")
      return
    }

    if (
      typeof rpcRequest !== "object" ||
      rpcRequest === null ||
      Array.isArray(rpcRequest) ||
      typeof rpcRequest.method !== "string"
    ) {
      sendRpcError(response, null, -32600, "Invalid Request")
      return
    }

    dispatchFixtureRpc({ rpcRequest, request, response, port: PORT })
  })
  return true
}

const server = createServer((request, response) => {
  if (handleUpload(request, response)) return
  if (handleDiagnosticRequest(request, response)) return
  if (handleJsonRpc(request, response)) return
  response.writeHead(404).end()
})

server.on("connect", (_request, socket) => {
  socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n")
})

server.listen(PORT, "127.0.0.1", () => {
  console.log(`XML-RPC Deepwell fixture listening on 127.0.0.1:${PORT}`)
})

process.on("SIGTERM", () => {
  server.close(() => process.exit(0))
})

process.on("SIGINT", () => {
  server.close(() => process.exit(0))
})
