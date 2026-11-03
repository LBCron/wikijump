import { deserialize } from "$app/forms"
import {
  createEditLeaseTransport,
  WikidotEditLeaseSession
} from "$lib/wikidot/wikidot-edit-lease.js"

type EditLeaseActionFailure = {
  message: string
  code?: number
  data?: Record<string, unknown>
}

const postEditLeaseAction = async (action: string, payload: Record<string, unknown>) => {
  const text = await fetch(`?/${action}`, {
    method: "POST",
    body: JSON.stringify(payload)
  }).then((res) => res.text())
  const result = deserialize<{ res: unknown }, EditLeaseActionFailure>(text)
  if (result.type === "success" && result.data) {
    return result.data.res
  }
  if (result.type === "failure" && result.data) {
    throw Object.assign(new Error(result.data.message), {
      code: result.data.code
    })
  }
  throw new Error("The edit lock request failed.")
}

export const createPageEditLeaseSession = (): WikidotEditLeaseSession =>
  new WikidotEditLeaseSession(createEditLeaseTransport(postEditLeaseAction))

export const startEditLeaseTimers = (
  session: WikidotEditLeaseSession,
  sync: () => void
): (() => void) => {
  let seconds = 0
  const timer = setInterval(() => {
    seconds += 1
    if (seconds % 60 === 0 && session.status === "held") {
      void session.renew().then(sync)
    }
    sync()
  }, 1000)
  return () => clearInterval(timer)
}
