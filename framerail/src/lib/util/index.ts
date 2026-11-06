export * from "./html"
export * from "./pref"
export * from "./timeout"

// https://gist.github.com/hyamamoto/fd435505d29ebfa3d9716fd2be8d42f0#gistcomment-2694461
export function hash(s: string) {
  let h = 0
  for (let i = 0; i < s.length; i++) {
    h = (Math.imul(31, h) + s.charCodeAt(i)) | 0
  }
  return h
}

export function createID(prefix = "") {
  const suffix = hash(Math.random() * 100 + prefix)
  return `${prefix}-${suffix}`
}

export function escapeRegExp(str: string) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export function mod(a: number, n: number) {
  return ((a % n) + n) % n
}
