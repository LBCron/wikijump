export const DEEPWELL_INVALID_AUTHENTICATION = 3000
export const DEEPWELL_SESSION_INVALID = 3001
export const DEEPWELL_PERMISSION_DENIED = 3106
// Deepwell ErrorType::NotLatestRevisionId.
export const DEEPWELL_NOT_LATEST_REVISION_ID = 4303
// Deepwell ErrorType::PageEditLockConflict.
export const DEEPWELL_PAGE_EDIT_LOCK_CONFLICT = 4304
// Deepwell ErrorType::LocaleMessageMissing.
export const DEEPWELL_LOCALE_MESSAGE_MISSING = 5002

export const isNotLatestRevisionIdError = (error: unknown): boolean =>
  error !== null &&
  typeof error === "object" &&
  "code" in error &&
  error.code === DEEPWELL_NOT_LATEST_REVISION_ID

export const isPageEditLockConflictError = (error: unknown): boolean =>
  error !== null &&
  typeof error === "object" &&
  "code" in error &&
  error.code === DEEPWELL_PAGE_EDIT_LOCK_CONFLICT

export const isMissingLocaleMessageError = (error: unknown): boolean =>
  error !== null &&
  typeof error === "object" &&
  "code" in error &&
  error.code === DEEPWELL_LOCALE_MESSAGE_MISSING

export const isInvalidAuthenticationError = (error: unknown): boolean =>
  error !== null &&
  typeof error === "object" &&
  "code" in error &&
  error.code === DEEPWELL_INVALID_AUTHENTICATION

export const isInvalidSessionTokenError = (error: unknown): boolean =>
  error !== null &&
  typeof error === "object" &&
  "code" in error &&
  error.code === DEEPWELL_SESSION_INVALID

/**
 * Remove structured Deepwell diagnostics before a JSON-RPC error crosses
 * the Framerail public boundary. Plain string data is retained for
 * deliberately user-facing JSON-RPC errors.
 */
export const stripPrivateDeepwellErrorData = <T>(response: T): T => {
  if (Array.isArray(response)) {
    return response.map(stripPrivateDeepwellErrorData) as T
  }

  if (response === null || typeof response !== "object") return response

  const error = (response as { error?: unknown }).error
  if (error === null || typeof error !== "object" || Array.isArray(error)) {
    return response
  }

  const errorObject = error as Record<string, unknown>
  if (!("data" in errorObject) || typeof errorObject.data === "string") {
    return response
  }

  const publicError = { ...errorObject }
  delete publicError.data
  return { ...response, error: publicError } as T
}
