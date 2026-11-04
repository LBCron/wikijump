export const clearLoginPassword = <T extends { data: { password?: string } }>(
  form: T
): T => {
  form.data.password = ""
  return form
}

export const clearRegisterPasswords = <
  T extends { data: { password?: string; confirmPassword?: string } }
>(
  form: T
): T => {
  form.data.password = ""
  form.data.confirmPassword = ""
  return form
}

const isSuperForm = (value: object): boolean =>
  "id" in value && "valid" in value && "posted" in value && "data" in value

export const redactAuthActionPayload = <T>(payload: T, secrets: string[]): T => {
  const submitted = secrets.filter((secret) => secret.length > 0)
  const visited = new WeakSet<object>()

  const redact = (value: unknown): unknown => {
    if (typeof value === "string") {
      return submitted.reduce(
        (redacted, secret) => redacted.replaceAll(secret, ""),
        value
      )
    }
    if (value === null || typeof value !== "object" || visited.has(value)) {
      return value
    }

    visited.add(value)
    const form = isSuperForm(value)
    for (const [key, nested] of Object.entries(value)) {
      ;(value as Record<string, unknown>)[key] =
        key === "errors"
          ? redactValidationErrors(nested)
          : key === "password" || key === "confirmPassword"
            ? ""
            : key === "session_token" || (form && key === "id")
              ? nested
              : redact(nested)
    }
    return value
  }

  const redactValidationErrors = (value: unknown): unknown => {
    if (typeof value === "string") {
      return submitted.reduce(
        (redacted, secret) => redacted.replaceAll(secret, "[redacted]"),
        value
      )
    }
    if (value === null || typeof value !== "object" || visited.has(value)) {
      return value
    }

    visited.add(value)
    for (const [key, nested] of Object.entries(value)) {
      ;(value as Record<string, unknown>)[key] = redactValidationErrors(nested)
    }
    return value
  }

  return redact(payload) as T
}
