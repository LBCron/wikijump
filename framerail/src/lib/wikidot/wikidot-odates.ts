const MONTHS_SHORT = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec"
]
const MONTHS_FULL = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December"
]
const DAYS_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]
const DAYS_FULL = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday"
]

const TIME_TOKEN = /^time_(-?\d+)$/
const FORMAT_PREFIX = "format_"
const AGO_HOVER_SUFFIX = "|agohover"

export function parseOdateSpan(element: { className: string }) {
  const tokens = String(element?.className ?? "").split(/\s+/)
  let timestamp: number | null = null
  let format: string | null = null
  for (const token of tokens) {
    const timeMatch = TIME_TOKEN.exec(token)
    if (timeMatch) {
      timestamp = Number.parseInt(timeMatch[1], 10)
      continue
    }
    if (token.startsWith(FORMAT_PREFIX)) {
      try {
        format = decodeURIComponent(token.slice(FORMAT_PREFIX.length))
      } catch {
        return null
      }
    }
  }
  if (timestamp === null || !Number.isFinite(timestamp) || format === null) return null
  let agoHover = false
  if (format.endsWith(AGO_HOVER_SUFFIX)) {
    agoHover = true
    format = format.slice(0, -AGO_HOVER_SUFFIX.length)
  }
  return { timestamp, format, agoHover }
}

export function agoText(deltaSeconds: number) {
  const delta = Math.max(0, Math.floor(deltaSeconds))
  const unit = (value: number, singular: string, plural: string) =>
    `${value} ${value === 1 ? singular : plural} ago`
  if (delta < 60) return unit(delta, "second", "seconds")
  const minutes = Math.floor(delta / 60)
  if (minutes < 60) return unit(minutes, "minute", "minutes")
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return unit(hours, "hour", "hours")
  return unit(Math.floor(hours / 24), "day", "days")
}

const pad2 = (value: number) => String(value).padStart(2, "0")

export function formatOdateTimestamp(
  timestampSeconds: number,
  format: string,
  nowSeconds: number,
  utcOffsetMinutes: number
): string | null {
  const shifted = new Date((timestampSeconds + utcOffsetMinutes * 60) * 1000)
  const parts: Record<string, string> = {
    d: pad2(shifted.getUTCDate()),
    e: String(shifted.getUTCDate()),
    m: pad2(shifted.getUTCMonth() + 1),
    Y: String(shifted.getUTCFullYear()),
    H: pad2(shifted.getUTCHours()),
    M: pad2(shifted.getUTCMinutes()),
    S: pad2(shifted.getUTCSeconds()),
    b: MONTHS_SHORT[shifted.getUTCMonth()],
    B: MONTHS_FULL[shifted.getUTCMonth()],
    a: DAYS_SHORT[shifted.getUTCDay()],
    A: DAYS_FULL[shifted.getUTCDay()]
  }
  const applyPad = (modifier: string, value: string, width = 2) => {
    const digits = value.replace(/^0+(?=\d)/u, "")
    if (modifier === "-") return digits
    if (modifier === "_") return digits.padStart(width, " ")
    if (modifier === "0") return digits.padStart(width, "0")
    return value
  }
  let output = ""
  let index = 0
  while (index < format.length) {
    const percent = format.indexOf("%", index)
    if (percent === -1) {
      output += format.slice(index)
      break
    }
    output += format.slice(index, percent)
    let cursor = percent + 1
    let modifier = ""
    if (format[cursor] === "_" || format[cursor] === "-" || format[cursor] === "0") {
      modifier = format[cursor]
      cursor += 1
    }
    const directive = format[cursor]
    if (directive === undefined) return null
    if (directive === "%") {
      output += "%"
    } else if (directive === "R") {
      output += `${parts.H}:${parts.M}`
    } else if (directive === "O") {
      output += agoText(nowSeconds - timestampSeconds)
    } else if (directive in parts) {
      output += applyPad(modifier, parts[directive])
    } else {
      return null
    }
    index = cursor + 1
  }
  return output
}

export function rewriteOdateSpan(
  element: HTMLElement,
  nowSeconds: number = Math.floor(Date.now() / 1000)
) {
  const parsed = parseOdateSpan(element)
  if (!parsed) return false
  const offsetMinutes = -new Date(parsed.timestamp * 1000).getTimezoneOffset()
  const text = formatOdateTimestamp(
    parsed.timestamp,
    parsed.format,
    nowSeconds,
    offsetMinutes
  )
  if (text === null) return false
  element.textContent = text
  if (parsed.agoHover) {
    element.title = agoText(nowSeconds - parsed.timestamp)
  }
  return true
}

const ODATES_SELECTOR = 'span.odate[class*="time_"]'

function sweepOdates(root: Document | HTMLElement, nowSeconds: number) {
  for (const element of root.querySelectorAll<HTMLElement>(ODATES_SELECTOR)) {
    rewriteOdateSpan(element, nowSeconds)
  }
}

export function installWikidotOdates(root: Document | HTMLElement): () => void {
  sweepOdates(root, Math.floor(Date.now() / 1000))
  const observer = new MutationObserver((changes) => {
    const nowSeconds = Math.floor(Date.now() / 1000)
    for (const change of changes) {
      for (const node of change.addedNodes) {
        if (node.nodeType !== Node.ELEMENT_NODE) continue
        const element = node as HTMLElement
        if (element.matches?.(ODATES_SELECTOR)) {
          rewriteOdateSpan(element, nowSeconds)
        }
        for (const descendant of element.querySelectorAll<HTMLElement>(ODATES_SELECTOR)) {
          rewriteOdateSpan(descendant, nowSeconds)
        }
      }
    }
  })
  observer.observe(root === document ? document.documentElement : root, {
    childList: true,
    subtree: true
  })
  const refreshHover = (event: Event) => {
    const target = (event.target as HTMLElement | null)?.closest<HTMLElement>(
      ODATES_SELECTOR
    )
    if (!target) return
    const parsed = parseOdateSpan(target)
    if (parsed?.agoHover) {
      target.title = agoText(Math.floor(Date.now() / 1000) - parsed.timestamp)
    }
  }
  const listenerRoot = root === document ? document : (root as HTMLElement)
  listenerRoot.addEventListener("mouseenter", refreshHover, true)
  return () => {
    observer.disconnect()
    listenerRoot.removeEventListener("mouseenter", refreshHover, true)
  }
}
