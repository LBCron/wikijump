import { isIP } from "node:net"

/**
 * Resolve the real client IP for rate-limit buckets.
 *
 * Our reverse proxies (Caddy) append the client address to
 * `X-Forwarded-For`, but that header is only trustworthy when the socket
 * peer is our own proxy infrastructure (loopback or private ranges, as in
 * the docker/caddy topologies). A directly connected client can forge the
 * header to evade throttling, so for any other peer the socket address is
 * used unchanged. Without a parseable forwarded address we also fall back
 * to the socket peer, preserving current behavior.
 */
export function resolveClientIp(request: Request, socketPeer: string): string {
  const forwardedFor = request.headers.get("x-forwarded-for")
  if (forwardedFor && isTrustedProxyPeer(socketPeer)) {
    for (const part of forwardedFor.split(",")) {
      const candidate = part.trim().replace(/^\[|\]$/gu, "")
      if (candidate && isIP(candidate) !== 0) return candidate
    }
  }
  return socketPeer
}

export function isTrustedProxyPeer(peer: string): boolean {
  const kind = isIP(peer)
  if (kind === 4) {
    const [a, b] = peer.split(".").map(Number)
    if (a === 127) return true
    if (a === 10) return true
    if (a === 172 && b >= 16 && b <= 31) return true
    if (a === 192 && b === 168) return true
    return false
  }
  if (kind === 6) {
    const lower = peer.toLowerCase()
    if (lower === "::1") return true
    // Unique-local (fc00::/7) and link-local (fe80::/10) transports.
    return lower.startsWith("fc") || lower.startsWith("fd") || lower.startsWith("fe80:")
  }
  return false
}
