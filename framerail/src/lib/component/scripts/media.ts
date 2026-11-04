import { writable, type Readable } from "svelte/store"

const HAS_MATCH_MEDIA = typeof globalThis.matchMedia === "function"

const OPERATORS = [">", "<", ">=", "<=", "=="] as const

const BREAKPOINTS = [
  ["tiny", 350],
  ["narrow", 500],
  ["small", 850],
  ["normal", 1000],
  ["wide", 1400]
] as const

export type Operator = (typeof OPERATORS)[number]
export type BreakpointName = (typeof BREAKPOINTS)[number][0]
export type BreakpointString = `${Operator | ""}${BreakpointName}`

export interface MediaQueryStore {
  reducedMotion: boolean
  colorScheme: "light" | "dark"
  canHover: boolean
  breakpoint: BreakpointName
  orientation: "landscape" | "portrait"
}

class BreakpointMapping {
  private queries: Map<BreakpointName, MediaQueryList> = new Map()
  private map: Map<BreakpointName | number, BreakpointName | number> = new Map()

  constructor(callback: () => void) {
    let idx = 0
    for (const [name, pixels] of BREAKPOINTS) {
      if (HAS_MATCH_MEDIA) {
        const query = matchMedia(`(min-width: ${pixels}px)`)
        query.addEventListener("change", callback)
        this.queries.set(name, query)
      }
      this.map.set(idx, name)
      this.map.set(name, idx)
      idx++
    }
  }

  get(id: number): BreakpointName
  get(name: BreakpointName): number
  get(key: BreakpointName | number): BreakpointName | number {
    return this.map.get(key)!
  }

  has(name: string): name is BreakpointName {
    return BREAKPOINTS.some(([breakpoint]) => breakpoint === name)
  }

  active() {
    if (!HAS_MATCH_MEDIA) return "normal"
    let current: BreakpointName = "tiny"
    for (const [name, query] of this.queries) {
      if (query.matches) current = name
    }
    return current
  }
}

class MediaQueryHandler {
  store = writable<MediaQueryStore>({
    reducedMotion: false,
    colorScheme: "light",
    canHover: true,
    breakpoint: "normal",
    orientation: "landscape"
  })
  subscribe = this.store.subscribe

  private _reducedMotion = this.addQuery("(prefers-reduced-motion: reduce)")
  private _colorSchemeLight = this.addQuery("(prefers-color-scheme: light)")
  private _colorSchemeDark = this.addQuery("(prefers-color-scheme: dark)")
  private _canHover = this.addQuery("(any-hover: hover), (hover: hover)")
  private _orientationLandscape = this.addQuery("(orientation: landscape)")
  private _orientationPortrait = this.addQuery("(orientation: portrait)")

  private breakpoints = new BreakpointMapping(() => this.refresh())

  constructor() {
    this.refresh()
  }

  get reducedMotion() {
    if (!HAS_MATCH_MEDIA) return false
    return this._reducedMotion.matches
  }

  get colorScheme(): "light" | "dark" {
    if (!HAS_MATCH_MEDIA) return "light"
    return this._colorSchemeLight.matches
      ? "light"
      : this._colorSchemeDark.matches
        ? "dark"
        : "light"
  }

  get canHover() {
    if (!HAS_MATCH_MEDIA) return true
    return this._canHover.matches
  }

  get breakpoint() {
    if (!HAS_MATCH_MEDIA) return "normal"
    return this.breakpoints.active()
  }

  get orientation(): "landscape" | "portrait" {
    if (!HAS_MATCH_MEDIA) return "landscape"
    return this._orientationLandscape.matches
      ? "landscape"
      : this._orientationPortrait.matches
        ? "portrait"
        : "landscape"
  }

  private addQuery(query: string) {
    if (!HAS_MATCH_MEDIA) return { matches: false } as MediaQueryList
    const mediaQuery = matchMedia(query)
    mediaQuery.addEventListener("change", () => this.refresh())
    return mediaQuery
  }

  private refresh() {
    this.store.set({
      reducedMotion: this.reducedMotion,
      colorScheme: this.colorScheme,
      canHover: this.canHover,
      breakpoint: this.breakpoint,
      orientation: this.orientation
    })
  }

  test(query: string) {
    if (!HAS_MATCH_MEDIA) return false
    const mediaQuery = matchMedia(query)
    return mediaQuery.matches
  }

  matchBreakpoint(query: BreakpointString) {
    let operator: Operator = "=="

    const match = /^[=<>]+/.exec(query)

    if (match && OPERATORS.includes(match[0] as Operator)) {
      operator = match[0] as Operator
    } else if (match) {
      throw new Error(`Bad operator (${match[0]}) given in breakpoint string!`)
    }

    const breakpoint = query.replace(/^[=<>]+/, "")

    if (!this.breakpoints.has(breakpoint)) {
      throw new Error(`Bad breakpoint (${breakpoint}) given in breakpoint string!`)
    }

    const current = this.breakpoints.active()
    const curIdx = this.breakpoints.get(current)
    const brkIdx = this.breakpoints.get(breakpoint)

    switch (operator) {
      case "==":
        return curIdx === brkIdx
      case ">":
        return curIdx > brkIdx
      case "<":
        return curIdx < brkIdx
      case ">=":
        return curIdx >= brkIdx
      case "<=":
        return curIdx <= brkIdx
      default:
        throw new Error(`Query (${query}) was somehow impossible to evaluate!`)
    }
  }
}

export const Media = new MediaQueryHandler()

const matchBreakpointStore = writable<MediaQueryHandler["matchBreakpoint"]>((query) =>
  Media.matchBreakpoint(query)
)

let lastBreakpoint: BreakpointName
Media.subscribe((store) => {
  const current = store.breakpoint
  if (lastBreakpoint !== current) {
    matchBreakpointStore.set((query) => Media.matchBreakpoint(query))
  }
  lastBreakpoint = current
})

export const matchBreakpoint: Readable<MediaQueryHandler["matchBreakpoint"]> = {
  subscribe: matchBreakpointStore.subscribe
}
