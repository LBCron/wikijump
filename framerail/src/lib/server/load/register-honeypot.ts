/**
 * Refs #2074. Live Wikidot signup carries an off-screen honeypot field
 * labelled "Please leave this checkbox blank" (spec `module-createaccount`
 * P6 records "an anti-bot blank checkbox"). A normal browser never touches
 * it; an automated filler checks or fills every field. This module owns
 * the field identity and the trip decision so the register template and
 * the server-side action gate cannot disagree.
 *
 * Pure module: no framework imports, directly runnable under `node
 * --test`.
 */

export const REGISTER_HONEYPOT_FIELD = "leaveBlank"

export const REGISTER_HONEYPOT_LABEL = "Please leave this checkbox blank"

const UNTRIPPED_VALUES = new Set(["", "false", "off", "0"])

export const isRegistrationHoneypotTripped = (value: unknown): boolean => {
  if (value === undefined || value === null) return false
  if (Array.isArray(value)) return value.some(isRegistrationHoneypotTripped)
  return !UNTRIPPED_VALUES.has(String(value).trim().toLowerCase())
}
