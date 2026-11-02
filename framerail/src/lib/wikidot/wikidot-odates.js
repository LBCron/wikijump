/**
 * Viewer-local rendering for Wikidot `span.odate` timestamps (issue
 * #2638).
 *
 * Wikidot's model is two-phase: the server sends UTC text plus the unix
 * timestamp and the requested display format in the span class (`odate
 * time_<unix> format_<encoded>[|agohover]`), and the browser phase
 * rewrites the text into viewer-local time, showing a relative "nn
 * seconds/minutes/hours/days ago" hovering text when `|agohover` is set
 * (see
 * docs/wikidot-specifications/specifications/wiki-syntax/syntax-date.md).
 * Saved pages must therefore never pin a server-side timezone: the browser
 * phase below is what makes JST viewers see JST and UTC viewers see UTC.
 *
 * Grammar coverage is deliberately bounded: the numeric EN subset the
 * render path emits (`%d %e %m %Y %H %M %S %R %%`, padding modifiers
 * `_`/`-`/`0`), EN month/weekday names (`%b %B %a %A`), and the relative
 * modifier (`%O`). A span whose format uses anything else — including
 * `%Z`/`%z` (the spec documents usage but no retained capture shows the
 * rendered shape; a JST server would more likely read `JST` than `GMT+9`)
 * and `%c` — keeps its server text untouched: an unspecified format needs
 * oracle evidence, not a guess. Spans without an explicit `format_` class
 * are left alone for the same reason.
 *
 * Two more documented choices: future timestamps clamp to "0 seconds ago"
 * (the spec allows `%O` with future dates but defines no output shape),
 * and the hovering text uses proper English singular/plural (Wikidot's
 * exact pluralization needs a live oracle to confirm).
 *
 * Hover exactness gap: the spec ladder names only
 * seconds/minutes/hours/days, so the hovering text uses proper English
 * singular/plural here. Wikidot's exact pluralization needs a live oracle
 * to confirm; the mismatch surface is one tooltip string.
 */

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

/**
 * Parse an odate span's class list. Returns null when the span carries no
 * usable timestamp or its format cannot be decoded.
 *
 * @param {{ className: string }} element - Span or span-like with
 *   className.
 */
export function parseOdateSpan(element) {
  const tokens = String(element?.className ?? "").split(/\s+/)
  let timestamp = null
  let format = null
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
  if (!Number.isFinite(timestamp) || format === null) return null
  let agoHover = false
  if (format.endsWith(AGO_HOVER_SUFFIX)) {
    agoHover = true
    format = format.slice(0, -AGO_HOVER_SUFFIX.length)
  }
  return { timestamp, format, agoHover }
}

export function agoText(deltaSeconds) {
  const delta = Math.max(0, Math.floor(deltaSeconds))
  const unit = (value, singular, plural) =>
    `${value} ${value === 1 ? singular : plural} ago`
  if (delta < 60) return unit(delta, "second", "seconds")
  const minutes = Math.floor(delta / 60)
  if (minutes < 60) return unit(minutes, "minute", "minutes")
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return unit(hours, "hour", "hours")
  return unit(Math.floor(hours / 24), "day", "days")
}

const pad2 = (value) => String(value).padStart(2, "0")

/**
 * Render viewer-local text for a timestamp under a format string.
 *
 * @param {number} timestampSeconds - Unix timestamp from `time_`.
 * @param {string} format - Decoded `format_` class value (no `|agohover`).
 * @param {number} nowSeconds - Current unix time (for `%O`).
 * @param {number} utcOffsetMinutes - Viewer offset east of UTC in minutes
 *   (callers pass the per-date local offset, exactly as a browser would).
 * @returns {string | null} Rendered text, or null when the format uses an
 *   unsupported directive (caller keeps the server text).
 */
export function formatOdateTimestamp(
  timestampSeconds,
  format,
  nowSeconds,
  utcOffsetMinutes
) {
  const shifted = new Date((timestampSeconds + utcOffsetMinutes * 60) * 1000)
  const parts = {
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
  const applyPad = (modifier, value, width = 2) => {
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

/**
 * Rewrite one span's text into viewer-local time. Returns false when the
 * span is left untouched (unparseable, or unsupported format).
 *
 * @param {HTMLElement} element - `span.odate` element.
 * @param {number} [nowSeconds] - Current unix time (defaults to now).
 */
export function rewriteOdateSpan(element, nowSeconds = Math.floor(Date.now() / 1000)) {
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

function sweepOdates(root, nowSeconds) {
  for (const element of root.querySelectorAll(ODATES_SELECTOR)) {
    rewriteOdateSpan(element, nowSeconds)
  }
}

/**
 * Install the browser ODate phase on Wikidot-layout pages. Sweeps once,
 * then re-sweeps added nodes; hovering text refreshes on mouseenter so a
 * long-open page does not show a stale relative time.
 *
 * @param {Document | HTMLElement} root - Root to sweep and observe.
 * @returns {() => void} Uninstall function (rewritten text is kept).
 */
export function installWikidotOdates(root) {
  sweepOdates(root, Math.floor(Date.now() / 1000))
  const observer = new MutationObserver((changes) => {
    const nowSeconds = Math.floor(Date.now() / 1000)
    for (const change of changes) {
      for (const node of change.addedNodes) {
        if (node.nodeType !== Node.ELEMENT_NODE) continue
        const element = /** @type {HTMLElement} */ (node)
        if (element.matches?.(ODATES_SELECTOR)) {
          rewriteOdateSpan(element, nowSeconds)
        }
        for (const descendant of element.querySelectorAll?.(ODATES_SELECTOR) ?? []) {
          rewriteOdateSpan(descendant, nowSeconds)
        }
      }
    }
  })
  observer.observe(root === document ? document.documentElement : root, {
    childList: true,
    subtree: true
  })
  const refreshHover = (event) => {
    const target = /** @type {HTMLElement | null} */ (event.target)?.closest?.(
      ODATES_SELECTOR
    )
    if (!target) return
    const parsed = parseOdateSpan(target)
    if (parsed?.agoHover) {
      target.title = agoText(Math.floor(Date.now() / 1000) - parsed.timestamp)
    }
  }
  const listenerRoot = root === document ? document : /** @type {HTMLElement} */ (root)
  listenerRoot.addEventListener("mouseenter", refreshHover, true)
  return () => {
    observer.disconnect()
    listenerRoot.removeEventListener("mouseenter", refreshHover, true)
  }
}
