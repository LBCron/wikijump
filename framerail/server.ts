import http from "node:http"
import { pathToFileURL } from "node:url"
import { createStartupReadiness, probeStartupDeepwell } from "./startup-readiness.ts"
import type { StartupReadiness } from "./startup-readiness.ts"

import { createArticleResponseFastPathHandler } from "./article-response-fast-path.ts"
import type {
  ArticleResponseFastPathHandler,
  FastPathFallbackHandler
} from "./article-response-fast-path.ts"
import type { ArticleResponseCacheStores } from "./src/lib/server/cache/article-response/stores.ts"
import { createMemoryArticleResponseFenceCache } from "./src/lib/server/cache/article-response/index.ts"
import { configureArticleResponseCacheStores } from "./src/lib/server/cache/article-response/runtime.ts"
import { createArticleResponseCacheStores } from "./src/lib/server/cache/article-response/stores.ts"

export const createFramerailHttpServer = ({
  fastPathHandler,
  fenceCache,
  closeResources = () => {},
  readiness
}: {
  fastPathHandler: ArticleResponseFastPathHandler
  fenceCache: { close: () => void }
  closeResources?: () => void
  readiness?: StartupReadiness
}) => {
  const server = http.createServer((request, response) => {
    if (readiness && (!readiness.isReady() || request.url === "/-/startup-ready")) {
      response.statusCode = readiness.isReady() ? 200 : 503
      response.setHeader("Cache-Control", "no-store")
      response.setHeader("Content-Type", "text/plain; charset=utf-8")
      response.end(readiness.isReady() ? "Ready\n" : "Wikijump is starting\n")
      return
    }
    void fastPathHandler(request, response).catch((error) => {
      response.statusCode = 500
      response.end(error instanceof Error ? error.message : "Internal Server Error")
    })
  })

  const closeServer = () => {
    readiness?.close()
    fenceCache.close()
    closeResources()
    server.close()
  }

  return { server, closeServer }
}

export const createFramerailServerRuntime = ({
  handler,
  cacheStores = createArticleResponseCacheStores(),
  readiness
}: {
  handler: FastPathFallbackHandler
  cacheStores?: ArticleResponseCacheStores
  readiness?: StartupReadiness
}) => {
  const { responseStore, tokenStore } = cacheStores
  const resetRuntimeStores = configureArticleResponseCacheStores(cacheStores)
  const fenceCache = createMemoryArticleResponseFenceCache({
    store: tokenStore,
    subscriber: tokenStore
  })
  const fastPathHandler = createArticleResponseFastPathHandler({
    responseStore,
    tokenStore,
    handler,
    fenceCache
  })
  const lifecycle = createFramerailHttpServer({
    readiness,
    fastPathHandler,
    fenceCache,
    closeResources: () => {
      resetRuntimeStores()
      tokenStore?.reset?.()
    }
  })

  return { ...lifecycle, cacheStores, fenceCache }
}

export const startFramerailServer = async () => {
  const handlerSpecifier: string = "./build/handler.js"
  const { handler } = (await import(handlerSpecifier)) as {
    handler: FastPathFallbackHandler
  }
  const path = process.env.SOCKET_PATH
  const host = process.env.HOST ?? "0.0.0.0"
  const port = process.env.PORT ?? "3000"
  const readiness =
    process.env.WIKIJUMP_STARTUP_READINESS === "true"
      ? createStartupReadiness({ probe: probeStartupDeepwell })
      : undefined
  const lifecycle = createFramerailServerRuntime({ handler, readiness })

  lifecycle.server.listen(path ? { path } : { host, port: Number(port) }, () => {
    console.log(`Listening on ${path || `http://${host}:${port}`}`)
    void readiness?.start()
  })
  process.on("SIGTERM", lifecycle.closeServer)
  process.on("SIGINT", lifecycle.closeServer)

  return lifecycle
}

const entryPoint = process.argv[1]
if (entryPoint && import.meta.url === pathToFileURL(entryPoint).href) {
  void startFramerailServer().catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
}
