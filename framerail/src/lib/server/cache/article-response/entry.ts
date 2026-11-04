export type HeaderPair = [string, string]

export interface CachedArticleResponseEntry {
  status: number
  headers: HeaderPair[]
  body: string
  bodyBuffer?: Buffer
}

export const isHeaderPair = (value: unknown): value is HeaderPair => {
  return (
    Array.isArray(value) &&
    value.length === 2 &&
    typeof value[0] === "string" &&
    typeof value[1] === "string"
  )
}

const isCachedArticleResponse = (value: unknown): value is CachedArticleResponseEntry => {
  if (value === null || typeof value !== "object") return false
  const candidate = value as Partial<CachedArticleResponseEntry>
  return (
    Number.isInteger(candidate.status) &&
    Number(candidate.status) >= 200 &&
    Number(candidate.status) <= 599 &&
    Array.isArray(candidate.headers) &&
    candidate.headers.every(isHeaderPair) &&
    typeof candidate.body === "string"
  )
}

export const normalizeCachedArticleResponseEntry = (
  value: unknown
): CachedArticleResponseEntry | null => {
  if (!isCachedArticleResponse(value)) return null

  return {
    status: value.status,
    headers: value.headers.map(([name, headerValue]): HeaderPair => [name, headerValue]),
    body: value.body
  }
}

export const copyCachedArticleResponseEntry = (
  entry: CachedArticleResponseEntry
): CachedArticleResponseEntry => {
  const copy: CachedArticleResponseEntry = {
    status: entry.status,
    headers: entry.headers.map(([name, value]): HeaderPair => [name, value]),
    body: entry.body
  }
  if (Buffer.isBuffer(entry.bodyBuffer)) {
    copy.bodyBuffer = Buffer.from(entry.bodyBuffer)
  }
  return copy
}

// SvelteKit writes a fresh base64 nonce into the CSP header and into each inline
// `nonce="..."` attribute of a dynamic response. A cached response must not replay
// its first nonce, so the nonce is renewed in both places on every serve.
const CSP_NONCE_DETECT = /'nonce-[A-Za-z0-9+/_=-]+'/u
const HTML_NONCE_DETECT = /\bnonce="[A-Za-z0-9+/_=-]+"/u
const CSP_NONCE_REPLACE = /'nonce-[A-Za-z0-9+/_=-]+'/gu
const HTML_NONCE_REPLACE = /\bnonce="[A-Za-z0-9+/_=-]+"/gu

export const containsCspNonce = (entry: {
  headers: HeaderPair[]
  body: string
}): boolean => {
  return (
    entry.headers.some(([, value]) => CSP_NONCE_DETECT.test(value)) ||
    HTML_NONCE_DETECT.test(entry.body)
  )
}

export const renewCspNonce = <T extends { headers: HeaderPair[]; body: string }>(
  entry: T,
  nonce: string
): T => {
  if (!containsCspNonce(entry)) return entry
  return {
    ...entry,
    headers: entry.headers.map(([name, value]): HeaderPair => [
      name,
      value.replace(CSP_NONCE_REPLACE, `'nonce-${nonce}'`)
    ]),
    body: entry.body.replace(HTML_NONCE_REPLACE, `nonce="${nonce}"`),
    bodyBuffer: undefined
  } as T
}
