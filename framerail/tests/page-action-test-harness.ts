import { fileURLToPath } from "node:url"

import { createTestViteServer } from "./vite-test-server.ts"

export const PAGE_ACTION_ROOT = fileURLToPath(new URL("..", import.meta.url))

export const startPageActionHarness = async () => {
  const previousWorkingDirectory = process.cwd()
  process.chdir(PAGE_ACTION_ROOT)
  const vite = await createTestViteServer()

  const { client } = await vite.ssrLoadModule("/src/lib/server/deepwell/index.ts")
  const originalClientRequest = client.request
  const { actions } = await vite.ssrLoadModule(
    "/src/routes/[slug]/[...extra]/+page.server.ts"
  )

  return {
    client,
    actions,
    async close() {
      client.request = originalClientRequest
      await vite.close()
      process.chdir(previousWorkingDirectory)
    }
  }
}

export interface PageActionEventOptions {
  action: string
  body?: unknown
  siteId: number
  siteSlug?: string
  sessionToken?: string | null
  requestContext?: unknown
  clientAddress?: string
  params?: Record<string, string>
}

export const pageActionEvent = ({
  action,
  body,
  siteId,
  siteSlug = "test",
  sessionToken = null,
  requestContext,
  clientAddress = "192.0.2.91",
  params = { slug: "main" }
}: PageActionEventOptions) => ({
  request: new Request(`https://wikijump.test/main?/${action}`, {
    method: "POST",
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    headers: {
      "content-type": "application/json",
      "X-Wikijump-Site-Id": String(siteId),
      "X-Wikijump-Site-Slug": siteSlug
    }
  }),
  getClientAddress: () => clientAddress,
  params,
  cookies: { get: () => sessionToken },
  locals: { requestContext }
})
