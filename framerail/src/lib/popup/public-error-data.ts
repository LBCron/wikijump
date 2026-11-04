/**
 * Return only deliberately public, plain-string error detail for the
 * popup. Structured diagnostics are never rendered.
 */
export const publicErrorExtraMessage = (data: unknown): string | null =>
  typeof data === "string" && data.length > 0 ? data : null
