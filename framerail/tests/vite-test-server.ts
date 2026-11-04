import { createServer } from "vite"
import type { RunnableDevEnvironment } from "vite"

export const createTestViteServer = async () => {
  const server = await createServer({
    appType: "custom",
    logLevel: "silent",
    server: {
      middlewareMode: true,
      watch: null
    }
  })

  server.ssrLoadModule = (url) =>
    (server.environments.ssr as RunnableDevEnvironment).runner.import(url)
  return server
}
