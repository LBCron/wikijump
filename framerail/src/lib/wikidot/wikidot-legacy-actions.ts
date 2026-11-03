/* eslint-disable no-script-url -- Wikidot footer and fixture markup use javascript:; no-op links that parity requires */
export type LegacyBrowserAction =
  | { type: "edit" | "history" | "source" | "print" }
  | { type: "set-tags"; index: number; fingerprint: string }

export type RateBrowserAction =
  | {
      type: "rate"
      index: number
      fingerprint: string
      value: -1 | 1 | 2 | 3 | 4 | 5
    }
  | { type: "rate-cancel"; index: number; fingerprint: string }

export type BoundAction = LegacyBrowserAction | RateBrowserAction

export type LegacyActionRuntime = {
  edit?: () => unknown
  history?: () => unknown
  source?: () => unknown
  print?: () => unknown
  setTags?: (index: number, fingerprint: string) => unknown
  rate?: (
    index: number,
    fingerprint: string,
    value: number,
    element: HTMLElement
  ) => unknown
  cancelRate?: (index: number, fingerprint: string, element: HTMLElement) => unknown
  error?: (error: unknown) => unknown
}

export type LegacyActionParameters = {
  actions: LegacyBrowserAction[]
  rateActions?: RateBrowserAction[]
  runtime: LegacyActionRuntime
}

export type ActionControl = {
  parentElement: ActionControl | null
  getAttribute(name: string): string | null
  removeAttribute(name: string): void
  setAttribute(name: string, value: string): void
}

declare global {
  var WIKIDOT:
    | {
        page?: {
          listeners?: {
            userInfo?: (userId: number) => unknown
          }
        }
      }
    | undefined
}

const boundActions: WeakMap<ActionControl, BoundAction> = new WeakMap()
const busyActions: WeakSet<object> = new WeakSet()
const busyCounts: WeakMap<ActionControl, number> = new WeakMap()
const trustedRateHandlers: WeakMap<ActionControl, string> = new WeakMap()

const USER_INFO_ONCLICK =
  /^WIKIDOT\.page\.listeners\.userInfo\((-?[0-9]+)\); return false;$/u
const WIKIDOT_USER_INFO_HREF = /^https?:\/\/www\.wikidot\.com\/user:info\/([a-z0-9-]+)$/u
// Wikidot links users over https since 2026-09-21; content it compiled
// before then keeps http links.
const WIKIDOT_PRINTUSER_LINKS = [
  '.printuser > a[href^="https://www.wikidot.com/user:info/"][onclick]',
  '.printuser > a[href^="http://www.wikidot.com/user:info/"][onclick]'
].join(", ")

const installDefaultWikidotUserInfoListener = (): void => {
  const wikidot = globalThis.WIKIDOT ?? (globalThis.WIKIDOT = {})
  const page = wikidot.page ?? (wikidot.page = {})
  const listeners = page.listeners ?? (page.listeners = {})
  if (typeof listeners.userInfo === "function") return
  listeners.userInfo = (userId) => {
    if (!Number.isSafeInteger(userId)) return false
    const documentObject = globalThis.document
    if (!documentObject?.querySelectorAll) return false
    const expected = `WIKIDOT.page.listeners.userInfo(${userId}); return false;`
    const anchor = [...documentObject.querySelectorAll(WIKIDOT_PRINTUSER_LINKS)].find(
      (element) => element.getAttribute("onclick") === expected
    )
    const match = WIKIDOT_USER_INFO_HREF.exec(anchor?.getAttribute("href") ?? "")
    if (match) globalThis.location?.assign?.(`/user:info/${match[1]}`)
    return false
  }
}

/**
 * Rebind only the exact renderer-owned Wikidot printuser handler shape.
 * The legacy onclick attribute stays in served DOM for parity, while
 * CSP-safe trusted client code supplies the executable property without
 * eval. The attribute's own handler is never read: reading `onclick`
 * compiles the inline attribute, which the CSP reports as a violation.
 */
const bindWikidotUserInfoHandlers = (root: HTMLElement): (() => void) => {
  installDefaultWikidotUserInfoListener()
  const elements: HTMLElement[] = []
  for (const element of root.querySelectorAll<HTMLElement>(WIKIDOT_PRINTUSER_LINKS)) {
    const match = USER_INFO_ONCLICK.exec(element.getAttribute("onclick") ?? "")
    if (!match) continue
    const userId = Number(match[1])
    if (!Number.isSafeInteger(userId)) continue
    element.onclick = () => {
      const listener = globalThis.WIKIDOT?.page?.listeners?.userInfo
      if (typeof listener === "function") listener(userId)
      return false
    }
    elements.push(element)
  }
  return () => {
    for (const element of elements) element.onclick = null
  }
}

const operationFor = (
  element: ActionControl,
  action: BoundAction,
  runtime: LegacyActionRuntime
): (() => unknown) | undefined => {
  switch (action.type) {
    case "edit":
      return runtime.edit
    case "history":
      return runtime.history
    case "source":
      return runtime.source
    case "print":
      return runtime.print
    case "set-tags":
      return Number.isSafeInteger(action.index) &&
        action.index >= 0 &&
        /^[0-9a-f]{32}$/u.test(action.fingerprint) &&
        runtime.setTags
        ? () => runtime.setTags?.(action.index, action.fingerprint)
        : undefined
    case "rate":
      return validRegistryAction(action) && runtime.rate
        ? () =>
            runtime.rate?.(
              action.index,
              action.fingerprint,
              action.value,
              element as HTMLElement
            )
        : undefined
    case "rate-cancel":
      return validRegistryAction(action) && runtime.cancelRate
        ? () =>
            runtime.cancelRate?.(action.index, action.fingerprint, element as HTMLElement)
        : undefined
    default:
      return undefined
  }
}

const validRegistryAction = (action: {
  index?: unknown
  fingerprint?: unknown
}): boolean =>
  Number.isSafeInteger(action.index) &&
  Number(action.index) >= 0 &&
  typeof action.fingerprint === "string" &&
  /^[0-9a-f]{32}$/u.test(action.fingerprint)

const validRateAction = (action: unknown): boolean => {
  if (!action || typeof action !== "object") return false
  if (!validRegistryAction(action as { index?: unknown; fingerprint?: unknown })) {
    return false
  }
  const typed = action as { type?: unknown; value?: unknown }
  if (typed.type === "rate-cancel") return true
  return typed.type === "rate" && [-1, 1, 2, 3, 4, 5].includes(typed.value as number)
}

const rateActionOnclick = (action: RateBrowserAction): string =>
  action.type === "rate"
    ? `WIKIDOT.modules.PageRateWidgetModule.listeners.rate(event, ${action.value})`
    : "WIKIDOT.modules.PageRateWidgetModule.listeners.cancelVote(event)"

const RATE_ANCHOR_TAG = /<a\b(?:[^>"']|"[^"]*"|'[^']*')*>/giu

/**
 * Read a quoted or unquoted attribute from one renderer-produced start
 * tag.
 */
const readHtmlAttribute = (tag: string, name: string): string | null => {
  const match = new RegExp(
    `\\s${name}(?=\\s|=|>)(?:\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+)))?`,
    "iu"
  ).exec(tag)
  return match ? (match[1] ?? match[2] ?? match[3] ?? "") : null
}

/**
 * Replace or append one attribute while leaving the rest of the start tag
 * byte-for-byte intact.
 */
const setHtmlAttribute = (tag: string, name: string, value: string): string => {
  const attribute = new RegExp(
    `(\\s${name}(?=\\s|=|>)(?:\\s*=\\s*)(?:"[^"]*"|'[^']*'|[^\\s>]+))`,
    "iu"
  )
  if (attribute.test(tag)) {
    return tag.replace(attribute, ` ${name}="${value}"`)
  }
  return tag.replace(/\s*\/?>$/u, (end) => ` ${name}="${value}"${end}`)
}

const removeHtmlAttribute = (tag: string, name: string): string =>
  tag.replace(
    new RegExp(`\\s${name}(?=\\s|=|>)(?:\\s*=\\s*(?:"[^"]*"|'[^']*'|[^\\s>]+))?`, "iu"),
    ""
  )

/**
 * Materialize the trusted Rate descriptor pairing before HTML reaches the
 * browser parser. This keeps Firefox from reporting parse-time CSP
 * violations for the renderer's inline handlers. A shape or descriptor
 * mismatch leaves the original HTML untouched and therefore cannot create
 * new bindings.
 */
export const materializeWikidotRateActionHtml = (
  html: string | null | undefined,
  actions: RateBrowserAction[]
): string | null | undefined => {
  if (typeof html !== "string" || !Array.isArray(actions) || actions.length === 0) {
    return html
  }
  if (actions.some((action) => !validRateAction(action))) return html

  const matches = [...html.matchAll(RATE_ANCHOR_TAG)]
  const rateAnchors = matches.filter((match) => {
    const tag = match[0]
    const handler = readHtmlAttribute(tag, "onclick")
    return (
      readHtmlAttribute(tag, "href") === "javascript:;" &&
      handler !== null &&
      /^WIKIDOT\.modules\.PageRateWidgetModule\.listeners\.(?:rate\(event, -?[0-9]+\)|cancelVote\(event\))$/u.test(
        handler
      )
    )
  })
  if (
    rateAnchors.length !== actions.length ||
    rateAnchors.some(
      (match, index) =>
        readHtmlAttribute(match[0], "onclick") !== rateActionOnclick(actions[index])
    )
  ) {
    return html
  }

  let actionIndex = 0
  return html.replace(RATE_ANCHOR_TAG, (tag) => {
    const handler = readHtmlAttribute(tag, "onclick")
    if (
      actionIndex >= actions.length ||
      readHtmlAttribute(tag, "href") !== "javascript:;" ||
      handler !== rateActionOnclick(actions[actionIndex])
    ) {
      return tag
    }
    const index = actionIndex++
    return setHtmlAttribute(
      setHtmlAttribute(removeHtmlAttribute(tag, "onclick"), "href", "#"),
      "data-wikijump-rate-action-index",
      `${index}`
    )
  })
}

/**
 * Execute one server-issued Wikidot action descriptor. The closed switch
 * is the browser authority boundary: authored attributes never select a
 * function, URL, vote value, or tag mutation payload.
 */
export const performWikidotLegacyAction = async (
  element: ActionControl,
  action: BoundAction,
  runtime: LegacyActionRuntime
): Promise<boolean> => {
  const busyKey =
    action.type === "rate" || action.type === "rate-cancel" ? runtime : element
  // Print is a fixed synchronous navigation action on live Wikidot: the
  // control never observes a busy state and every activation opens its own
  // child window. Only long-running server actions serialize per element.
  const serialized = action.type !== "edit" && action.type !== "print"
  if (serialized && busyActions.has(busyKey)) return false

  const operation = operationFor(element, action, runtime)
  if (!operation) return false

  if (serialized) busyActions.add(busyKey)
  busyCounts.set(element, (busyCounts.get(element) ?? 0) + 1)
  element.setAttribute("aria-busy", "true")
  try {
    await operation()
    return true
  } catch (error) {
    runtime.error?.(error)
    return false
  } finally {
    if (serialized) busyActions.delete(busyKey)
    const remaining = (busyCounts.get(element) ?? 1) - 1
    if (remaining === 0) {
      busyCounts.delete(element)
      element.removeAttribute("aria-busy")
    } else {
      busyCounts.set(element, remaining)
    }
  }
}

const STAR_TITLES = ["Poor", "Fair", "Good", "Very Good", "Excellent"]

const starAsset = (rating: number, index: number): string => {
  const threshold = index + 1
  const file =
    rating >= threshold
      ? "star-on.png"
      : rating >= threshold - 0.5
        ? "star-half.png"
        : "star-off.png"
  return `/common--images/jquery-raty/${file}`
}

const bind = (
  elements: Set<ActionControl>,
  element: ActionControl | null | undefined,
  action: BoundAction
): void => {
  if (!element) return
  boundActions.set(element, action)
  elements.add(element)
}

const bindStandaloneActions = (
  root: HTMLElement,
  actions: LegacyBrowserAction[],
  elements: Set<ActionControl>
): void => {
  const candidates = [...root.querySelectorAll('a[href="javascript:;"]')]
  for (const [element, action] of planWikidotStandaloneActionBindings(
    candidates as ActionControl[],
    actions
  )) {
    bind(elements, element, action)
  }
}

/**
 * Match exact legacy anchors to the out-of-band typed sidecar. Any extra,
 * missing, or unknown entry disables the whole standalone-action surface.
 */
export const planWikidotStandaloneActionBindings = (
  candidates: ActionControl[],
  actions: LegacyBrowserAction[]
): [ActionControl, LegacyBrowserAction][] => {
  if (candidates.length !== actions.length) return []
  if (
    actions.some(
      (action) =>
        !action ||
        !["edit", "history", "source", "print", "set-tags"].includes(action.type) ||
        (action.type === "set-tags" &&
          (!Number.isSafeInteger(action.index) ||
            action.index < 0 ||
            !/^[0-9a-f]{32}$/u.test(action.fingerprint)))
    )
  ) {
    return []
  }
  return actions.map((action, index): [ActionControl, LegacyBrowserAction] => [
    candidates[index],
    action
  ])
}

const wikidotPointRateControls = (root: HTMLElement): Element[] => [
  ...root.querySelectorAll(
    '.page-rate-widget-box > .rateup > a[href="javascript:;"], ' +
      '.page-rate-widget-box > .ratedown > a[href="javascript:;"], ' +
      '.page-rate-widget-box > .cancel > a[href="javascript:;"], ' +
      ".page-rate-widget-box > .rateup > a[data-wikijump-rate-action-index], " +
      ".page-rate-widget-box > .ratedown > a[data-wikijump-rate-action-index], " +
      ".page-rate-widget-box > .cancel > a[data-wikijump-rate-action-index], " +
      '.page-rate-widget-box > .rateup > a[data-wikijump-rate-bound="1"], ' +
      '.page-rate-widget-box > .ratedown > a[data-wikijump-rate-bound="1"], ' +
      '.page-rate-widget-box > .cancel > a[data-wikijump-rate-bound="1"]'
  )
]

/** Initialize the browser-only children present in live five-star widgets. */
const initializeWikidotRateWidgets = (
  root: HTMLElement,
  elements: Set<ActionControl>
): HTMLImageElement[][] => {
  const groups: HTMLImageElement[][] = []
  for (const widget of root.querySelectorAll<HTMLElement>(".page-rate-widget-start")) {
    if (widget.querySelector("img")) {
      const existing = [...widget.querySelectorAll("img")]
      for (const image of existing) elements.add(image)
      groups.push(existing)
      continue
    }
    const rating = Number.parseFloat(widget.dataset.rating ?? "0") || 0
    widget.style.cursor = "pointer"
    widget.style.width = "100px"
    const images: HTMLImageElement[] = []
    for (let index = 0; index < STAR_TITLES.length; index += 1) {
      const image = widget.ownerDocument.createElement("img")
      image.alt = `${index + 1}`
      image.title = STAR_TITLES[index]
      image.src = starAsset(rating, index)
      elements.add(image)
      images.push(image)
      widget.append(image)
      if (index < STAR_TITLES.length - 1) widget.append("\u00a0")
    }
    const score = widget.ownerDocument.createElement("input")
    score.name = "score"
    score.type = "hidden"
    score.value = `${rating}`
    widget.append(score)
    groups.push(images)
  }
  return groups
}

/**
 * Pair renderer-owned Rate controls with server-issued descriptors. Point
 * controls and star controls are mutually exclusive for one page category.
 * Any cardinality, shape, or value mismatch disables the whole Rate
 * surface.
 */
export const planWikidotRateActionBindings = (
  pointControls: ActionControl[],
  starControlGroups: ActionControl[][],
  actions: RateBrowserAction[]
): [ActionControl, RateBrowserAction][] => {
  if (actions.some((action) => !validRateAction(action))) return []
  if (pointControls.length > 0 && starControlGroups.length > 0) return []
  if (pointControls.length > 0) {
    if (pointControls.length !== actions.length) return []
    if (
      pointControls.some((control, index) => {
        const action = actions[index]
        const expectedOnclick = rateActionOnclick(action)
        const rendererActionIndex = control.getAttribute(
          "data-wikijump-rate-action-index"
        )
        return rendererActionIndex !== null
          ? rendererActionIndex !== `${index}`
          : control.getAttribute("onclick") !== expectedOnclick &&
              trustedRateHandlers.get(control) !== expectedOnclick
      })
    ) {
      return []
    }
    return actions.map((action, index): [ActionControl, RateBrowserAction] => [
      pointControls[index],
      action
    ])
  }
  const starControls = starControlGroups.flat()
  if (
    starControls.length !== actions.length ||
    starControlGroups.some((group) => group.length !== 5)
  ) {
    return []
  }
  for (let offset = 0; offset < actions.length; offset += 5) {
    const group = actions.slice(offset, offset + 5)
    if (
      group.some((action, index) => action.type !== "rate" || action.value !== index + 1)
    ) {
      return []
    }
  }
  return actions.map((action, index): [ActionControl, RateBrowserAction] => [
    starControls[index],
    action
  ])
}

/** Apply only the score returned by Deepwell after a vote mutation. */
export const updateWikidotRateWidget = (element: HTMLElement, score: unknown): void => {
  const widget = element.closest(".page-rate-widget-box, .page-rate-widget")
  const numericScore = Number(score)
  if (!widget || !Number.isFinite(numericScore)) return
  const points = widget.querySelector(".rate-points .number")
  if (points) {
    points.textContent = numericScore > 0 ? `+${numericScore}` : `${numericScore}`
  }
  const stars = widget.querySelector(".page-rate-widget-start") as HTMLElement | null
  if (!stars) return
  stars.dataset.rating = `${numericScore}`
  const hiddenScore = stars.querySelector<HTMLInputElement>('input[name="score"]')
  if (hiddenScore) hiddenScore.value = `${numericScore}`
  for (const [index, image] of [...stars.querySelectorAll("img")].entries()) {
    image.src = starAsset(numericScore, index)
  }
}

/**
 * Install delegated browser behavior for the fixed legacy action registry.
 * Dynamic rendered HTML remains inert unless the out-of-band Deepwell
 * sidecar matches its exact legacy control count.
 */
export const wikidotLegacyActions = (
  root: HTMLElement,
  parameters: LegacyActionParameters
) => {
  const elements: Set<ActionControl> = new Set()
  let runtime = parameters.runtime
  let releaseUserInfoHandlers = () => {}

  const refresh = (actions: LegacyBrowserAction[]): void => {
    releaseUserInfoHandlers()
    for (const element of elements) boundActions.delete(element)
    elements.clear()
    bindStandaloneActions(root, actions, elements)
    const pointControls = wikidotPointRateControls(root) as ActionControl[]
    for (const control of pointControls) elements.add(control)
    const starControlGroups = initializeWikidotRateWidgets(
      root,
      elements
    ) as ActionControl[][]
    for (const [element, action] of planWikidotRateActionBindings(
      pointControls,
      starControlGroups,
      parameters.rateActions ?? []
    )) {
      // The exact legacy handlers above are only provenance markers. Once a
      // trusted sidecar is paired with a renderer-owned control, remove the
      // CSP-blocked inline JavaScript and leave a normal, inert anchor for the
      // delegated click/keyboard handler below.
      if (pointControls.includes(element)) {
        element.removeAttribute("onclick")
        element.setAttribute("href", "#")
        element.setAttribute("data-wikijump-rate-bound", "1")
        trustedRateHandlers.set(element, rateActionOnclick(action))
      }
      bind(elements, element, action)
    }
    releaseUserInfoHandlers = bindWikidotUserInfoHandlers(root)
  }
  refresh(parameters.actions)

  const actionElement = (event: Event): ActionControl | undefined => {
    let element = event.target as ActionControl | null
    while (element && element !== root) {
      if (elements.has(element)) return element
      element = element.parentElement
    }
    return undefined
  }
  const activate = (event: Event): Promise<boolean> | undefined => {
    const element = actionElement(event)
    if (!element) return undefined
    const action = boundActions.get(element)
    event.preventDefault()
    event.stopPropagation()
    if (!action) return undefined
    return performWikidotLegacyAction(element, action, runtime)
  }
  const keydown = (event: KeyboardEvent): Promise<boolean> | undefined => {
    const element = actionElement(event)
    if (!element) return undefined
    const action = boundActions.get(element)
    const spaceActivatesRate = action?.type === "rate" || action?.type === "rate-cancel"
    // Live Wikidot standalone actions are anchors: Enter activates them and
    // Space scrolls without firing the handler. Rate controls retain their
    // separately evidenced Space-key activation contract.
    if (
      event.key !== "Enter" &&
      !(spaceActivatesRate && [" ", "Spacebar", "Space"].includes(event.key))
    ) {
      return undefined
    }
    return activate(event)
  }

  root.addEventListener("click", activate, true)
  root.addEventListener("keydown", keydown, true)
  return {
    destroy(): void {
      releaseUserInfoHandlers()
      for (const element of elements) boundActions.delete(element)
      root.removeEventListener("click", activate, true)
      root.removeEventListener("keydown", keydown, true)
    },
    update(nextParameters: LegacyActionParameters): void {
      runtime = nextParameters.runtime
      parameters = nextParameters
      refresh(nextParameters.actions)
    }
  }
}
