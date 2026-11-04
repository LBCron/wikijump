export const EMAIL_TOKEN_LENGTH = 48

const EMAIL_TOKEN_PATTERN = /^[A-Za-z0-9]{48}$/

export const isEmailTokenWellFormed = (token: unknown): boolean =>
  typeof token === "string" && EMAIL_TOKEN_PATTERN.test(token)

export const normalizeLookupEmail = (email: unknown): string =>
  typeof email === "string" ? email.trim() : ""
