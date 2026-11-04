// Shared shape contract for the email-token lane (#2128 recovery, #2130
// verification). Pure module: no imports, node-testable.
//
// The backend owns token validity absolutely (unknown, wrong-purpose,
// expired, and consumed tokens all fail identically server-side, and the
// address lookup trims surrounding whitespace only). This module mirrors
// those two client-observable rules so framerail submits exactly what the
// backend expects; it never decides validity on its own.

// Plaintext token length. Mirrors TOKEN_LENGTH in
// deepwell/src/services/email/email_token.rs: 48 URL-safe alphanumerics.
// LOCAL DEFAULT pending Wikidot evidence.
export const EMAIL_TOKEN_LENGTH = 48

const EMAIL_TOKEN_PATTERN = /^[A-Za-z0-9]{48}$/

export const isEmailTokenWellFormed = (token: unknown): boolean =>
  typeof token === "string" && EMAIL_TOKEN_PATTERN.test(token)

// Trim surrounding whitespace, otherwise exact. Mirrors
// normalize_lookup_email in deepwell/src/endpoints/email.rs: the user
// store performs no case folding anywhere, so recovery must not invent
// any either.
export const normalizeLookupEmail = (email: unknown): string =>
  typeof email === "string" ? email.trim() : ""
