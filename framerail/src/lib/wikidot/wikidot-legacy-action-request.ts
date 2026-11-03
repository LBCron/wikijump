export type LegacyRequestRuntime = {
  fetch(input: string, init?: RequestInit): Promise<{ text(): Promise<string> }>
  deserialize(value: string): {
    type: string
    data?: { res?: unknown; message?: string }
  }
}

const submit = async (runtime: LegacyRequestRuntime, action: string, body?: unknown) => {
  const response = await runtime.fetch(`?/${action}`, {
    method: "POST",
    credentials: "same-origin",
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  })
  const result = runtime.deserialize(await response.text())
  if (result.type === "failure") {
    throw new Error(result.data?.message ?? "Legacy page action failed.")
  }
  return result.data?.res
}

/**
 * Submit a set-tags descriptor by server-issued ordinal, never by client
 * tags.
 */
export const requestLegacySetTags = (
  runtime: LegacyRequestRuntime,
  input: {
    pageId: number
    lastRevisionId: number
    actionIndex: number
    actionFingerprint: string
  }
) => {
  return submit(runtime, "legacySetTags", {
    actionIndex: input.actionIndex,
    actionFingerprint: input.actionFingerprint,
    lastRevisionId: input.lastRevisionId,
    pageId: input.pageId
  })
}

/**
 * Submit one server-issued Rate action without a client-selected vote
 * value.
 */
export const requestLegacyRate = (
  runtime: LegacyRequestRuntime,
  input: {
    pageId: number
    lastRevisionId: number
    actionIndex: number
    actionFingerprint: string
  }
) => {
  return submit(runtime, "legacyRate", {
    actionFingerprint: input.actionFingerprint,
    actionIndex: input.actionIndex,
    lastRevisionId: input.lastRevisionId,
    pageId: input.pageId
  }) as Promise<{ score: number } | undefined>
}

/** Submit one server-issued Rate cancellation descriptor. */
export const requestLegacyRateCancel = (
  runtime: LegacyRequestRuntime,
  input: {
    pageId: number
    lastRevisionId: number
    actionIndex: number
    actionFingerprint: string
  }
) => {
  return requestLegacyRate(runtime, input)
}

/**
 * Read the authoritative score for the route page after a vote mutation.
 *
 * The score request carries an explicit (empty) JSON body. SvelteKit
 * rejects a bodyless named-action POST with HTTP 415 before the action
 * executes (issue #2060), so this must never regress to a bodyless fetch.
 */
export const requestLegacyScore = (
  runtime: LegacyRequestRuntime
): Promise<{ score: number } | undefined> => {
  return submit(runtime, "score", {}) as Promise<{ score: number } | undefined>
}
