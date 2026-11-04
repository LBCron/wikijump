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

export interface SearchOpts {
  min?: number
  max?: number
  precise?: boolean
}

export function search<T, TR>(
  haystack: T[],
  target: TR,
  comparator: (element: T, target: TR) => number | boolean,
  { min = 0, max = haystack.length - 1, precise = true }: SearchOpts = {}
) {
  if (haystack.length === 0) return null

  let index = -1
  while (min <= max) {
    index = min + ((max - min) >>> 1)
    const cmp = comparator(haystack[index], target)
    if (cmp === true || cmp === 0) return { element: haystack[index], index }
    if (cmp === false) return null
    if (cmp < 0) min = index + 1
    else if (cmp > 0) max = index - 1
  }

  if (index === -1) return null

  if (!precise) return { element: null, index }

  return null
}

export function isEmpty(obj: unknown) {
  if (!obj) return true
  if (Array.isArray(obj)) return obj.length === 0
  if (typeof obj === "object" && Object.getPrototypeOf(obj) === Object.prototype) {
    return Object.keys(obj).length === 0
  }
  return true
}

export function has<K extends string, T>(key: K, obj: T): obj is T & Record<K, unknown> {
  if (typeof obj !== "object" || obj === null) return false
  return key in obj && (obj as Record<string, unknown>)[key] !== undefined
}

export function removeUndefined<T>(obj: T) {
  const keys = Object.keys(obj as object) as (keyof T)[]
  for (let i = 0; i < keys.length; i++) {
    if (obj[keys[i]] === undefined) delete obj[keys[i]]
  }
  return obj as { [K in keyof T]: Exclude<T[K], undefined> }
}

export function escapeRegExp(str: string) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

export function hasSigil<T extends string = string>(
  str: unknown,
  sigils: string | string[]
): str is T {
  if (typeof str !== "string") return false
  if (typeof sigils === "string") return str.startsWith(sigils)
  for (const sigil of sigils) if (str.startsWith(sigil)) return true
  return false
}

export function unSigil<T extends string>(str: T, sigils: string | string[]): T {
  if (typeof sigils === "string") {
    return (str.startsWith(sigils) ? str.slice(sigils.length) : str) as T
  } else {
    for (const sigil of sigils) {
      if (str.startsWith(sigil)) {
        return unSigil(str.slice(sigil.length), sigils) as T
      }
    }
  }
  return str as T
}

export function createID(prefix = "") {
  const suffix = hash(Math.random() * 100 + prefix)
  return `${prefix}-${suffix}`
}

export function toPoints(str: string) {
  const codes: number[] = []
  for (let i = 0; i < str.length; i++) {
    codes.push(str.codePointAt(i)!)
  }
  return codes
}

export function pointsMatch(points: number[], str: string | number[], pos: number) {
  if (typeof str === "string") {
    for (let i = 0; i < points.length; i++) {
      if (points[i] !== str.codePointAt(pos + i)) return false
    }
  } else {
    for (let i = 0; i < points.length; i++) {
      if (points[i] !== str[pos + i]) return false
    }
  }
  return true
}

export function perfy(meta?: string, threshold?: number): (msg?: string) => number {
  const start = performance.now()
  return (msg?: string) => {
    const time = parseFloat((performance.now() - start).toFixed(4))
    if (meta && threshold && time > threshold) {
      if (msg) {
        console.log(`${msg} | ${meta}: ${time}ms`)
      } else {
        console.log(`${meta}: ${time}ms`)
      }
    }
    return time
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export function animationFrame(): Promise<void>
export function animationFrame<T>(fn: () => T): Promise<T>
export function animationFrame(fn?: () => unknown): Promise<unknown> {
  if (!fn) return new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
  return new Promise((resolve) =>
    requestAnimationFrame(() => {
      const result = fn()
      if (result instanceof Promise) {
        result.then((res) => resolve(res))
      } else {
        resolve(result)
      }
    })
  )
}

export function throttle<T extends AnyFunction>(
  fn: T,
  limitMS: number,
  immediate = false
) {
  let timeout: number | null = null
  let initialCall = true

  return function (this: ThisParameterType<T>, ...args: Parameters<T>) {
    const callNow = immediate && initialCall
    const next = () => {
      fn.apply(this, [...args])
      timeout = null
    }
    if (callNow) {
      initialCall = false
      next()
    }
    if (!timeout) timeout = setTimeout(next, limitMS) as unknown as number
  }
}

// Credit: https://gist.github.com/vincentorback/9649034
export function debounce<T extends AnyFunction>(fn: T, wait = 1) {
  let timeout: ReturnType<typeof setTimeout> | undefined
  return function (this: ThisParameterType<T>, ...args: Parameters<T>) {
    clearTimeout(timeout)
    timeout = setTimeout(() => void fn.call(this, ...args), wait)
  }
}

export async function waitFor(
  conditionFn: () => Promisable<boolean>,
  asyncTimerFn: () => Promise<void> = () => sleep(100)
) {
  while ((await conditionFn()) === false) {
    await asyncTimerFn()
    continue
  }
  return true
}

export function createLock<T extends AnyFunction>(fn: T) {
  type Return = PromiseValue<ReturnType<T>>
  const call = async (args: Parameters<T>) => {
    return (await fn(...args)) as Return
  }

  let running: Promise<Return> | null = null

  return async (...args: Parameters<T>) => {
    if (running) await running
    running = call(args)
    const result = await running
    running = null
    return result
  }
}

export function createMutatingLock<T extends AnyFunction>(fn: T) {
  type Return = PromiseValue<ReturnType<T>>
  const call = async (args: Parameters<T>) => {
    return (await fn(...args)) as Return
  }

  let running: boolean
  let useArgs: Parameters<T> | null = null
  return async (...args: Parameters<T>): Promise<Return | null> => {
    useArgs = args
    if (running) return null
    running = true
    let result = await call(args)
    while (useArgs !== null && useArgs !== args) {
      args = useArgs
      result = await call(args)
    }
    useArgs = null
    running = false
    return result
  }
}

export function createAnimQueued<T extends AnyFunction>(fn: T) {
  let queued: boolean
  let useArgs: Parameters<T> | null = null
  return (...args: Parameters<T>): void => {
    useArgs = args
    if (queued !== true) {
      queued = true
      requestAnimationFrame(async () => {
        if (useArgs !== null) await fn(...useArgs)
        queued = false
      })
    }
  }
}

export function mod(a: number, n: number) {
  return ((a % n) + n) % n
}

export function replaceRange(str: string, from: number, to: number, sub: string) {
  return str.substring(0, from) + sub + str.substring(to)
}

export function uppercase(str: string, locale?: string | string[]) {
  return locale ? str.toLocaleUpperCase(locale) : str.toUpperCase()
}

export function lowercase(str: string, locale?: string | string[]) {
  return locale ? str.toLocaleLowerCase(locale) : str.toLowerCase()
}

export function titlecase(str: string, locale?: string | string[]) {
  return replaceRange(lowercase(str, locale), 0, 1, uppercase(str[0], locale))
}

export function isTitlecased(str: string, locale?: string | string[]) {
  return titlecase(str, locale) === str
}

export function isUppercased(str: string, locale?: string | string[]) {
  return uppercase(str, locale) === str
}

export function isLowercased(str: string, locale?: string | string[]) {
  return lowercase(str, locale) === str
}

export async function url(imp: Promise<{ default: string }>) {
  return new URL((await imp).default, import.meta.url).toString()
}

export function dedupe<T>(arr: T[], ...insert: T[]) {
  return [...new Set([...arr, ...insert])]
}

export class LazySingleton<T> {
  private instance?: T

  constructor(private factory: () => T) {}

  get() {
    return !this.instance ? (this.instance = this.factory()) : this.instance
  }

  get loaded() {
    return Boolean(this.instance)
  }
}

export function byteLength(str: string) {
  let len = 0

  for (let i = 0; i < str.length; i++) {
    const high = str.charCodeAt(i)

    if (high < 0x0080) len += 1
    else if (high < 0x0800) len += 2
    else if (high < 0xd800) len += 3
    else if (high < 0xdc00) {
      const low = str.charCodeAt(++i)
      if (i < str.length && low >= 0xdc00 && low <= 0xdfff) {
        len += 4
      } else {
        throw new Error("malformed UTF-16 string")
      }
    } else if (high < 0xe000) {
      throw new Error("malformed UTF-16 string")
    } else len += 3
  }

  return len
}

const decoder = new TextDecoder()
const encoder = new TextEncoder()

export function encode(buffer: string | ArrayBufferLike | ArrayBufferView) {
  if (typeof buffer === "string") return encoder.encode(buffer).buffer
  if ("buffer" in buffer) return buffer.buffer
  if (buffer instanceof ArrayBuffer) return buffer
  throw new TypeError("Expected a string, ArrayBuffer, or typed array!")
}

export function decode(buffer: ArrayBufferLike | ArrayBufferView) {
  return decoder.decode(buffer)
}
