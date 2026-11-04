import { isIP } from "node:net"

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
    return lower.startsWith("fc") || lower.startsWith("fd") || lower.startsWith("fe80:")
  }
  return false
}
