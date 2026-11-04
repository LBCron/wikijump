export const publicErrorExtraMessage = (data: unknown): string | null =>
  typeof data === "string" && data.length > 0 ? data : null
