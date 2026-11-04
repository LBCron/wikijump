import { setTimeout as delay } from "node:timers/promises"

// Deployment opt-in: keep the ordinary handler (including its response cache)
// inaccessible until the dependency has answered a real authenticated RPC.
export interface StartupReadiness {
  isReady: () => boolean
  start: () => Promise<void>
  close: () => void
}

export const createStartupReadiness = ({
  probe,
  sleep = delay,
  random = Math.random
}: {
  probe: (signal: AbortSignal) => Promise<boolean>
  sleep?: typeof delay
  random?: () => number
}): StartupReadiness => {
  const controller = new AbortController()
  let ready = false
  const start = async () => {
    let backoff = 50
    while (!controller.signal.aborted) {
      try {
        if (await probe(controller.signal)) {
          if (!controller.signal.aborted) ready = true
          return
        }
      } catch {
        // Do not log RPC credentials, response bodies, or transient errors.
      }
      try {
        await sleep(backoff + Math.floor((random() * backoff) / 4), undefined, {
          signal: controller.signal
        })
      } catch {
        return
      }
      backoff = Math.min(backoff * 2, 500)
    }
  }
  return {
    isReady: () => ready,
    start,
    close: () => controller.abort()
  }
}

export const probeStartupDeepwell = async (signal: AbortSignal): Promise<boolean> => {
  const token = process.env.DEEPWELL_RPC_TOKEN ?? ""
  if (!/^[0-9a-f]{64}$/.test(token)) return false
  const response = await fetch(
    `http://${process.env.DEEPWELL_HOST ?? "deepwell"}:2747/jsonrpc`,
    {
      method: "POST",
      redirect: "error",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${token}`
      },
      body: JSON.stringify({ jsonrpc: "2.0", method: "ping", id: 1 }),
      signal: AbortSignal.any([signal, AbortSignal.timeout(1000)])
    }
  )
  if (!response.ok) return false
  const body = (await response.json()) as {
    jsonrpc?: unknown
    id?: unknown
    result?: unknown
    error?: unknown
  }
  return (
    body.jsonrpc === "2.0" &&
    body.id === 1 &&
    typeof body.result === "string" &&
    body.result.length > 0 &&
    !body.error
  )
}
