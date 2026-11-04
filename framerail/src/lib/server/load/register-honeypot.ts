export const REGISTER_HONEYPOT_FIELD = "leaveBlank"

export const REGISTER_HONEYPOT_LABEL = "Please leave this checkbox blank"

const UNTRIPPED_VALUES = new Set(["", "false", "off", "0"])

export const isRegistrationHoneypotTripped = (value: unknown): boolean => {
  if (value === undefined || value === null) return false
  if (Array.isArray(value)) return value.some(isRegistrationHoneypotTripped)
  return !UNTRIPPED_VALUES.has(String(value).trim().toLowerCase())
}
