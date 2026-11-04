import assert from "node:assert/strict"
import test from "node:test"

import {
  agoText,
  formatOdateTimestamp,
  parseOdateSpan,
  rewriteOdateSpan
} from "../src/lib/wikidot/wikidot-odates.ts"

const TIMESTAMP = 1455223901
const FORMAT = "%e %b %Y, %H:%M"
const ENCODED_CLASS = `odate time_${TIMESTAMP} format_%25e%20%25b%20%25Y%2C%20%25H%3A%25M%7Cagohover`

test("odate span parsing extracts timestamp, format and hover flag", () => {
  assert.deepEqual(parseOdateSpan({ className: ENCODED_CLASS }), {
    timestamp: TIMESTAMP,
    format: FORMAT,
    agoHover: true
  })
  assert.deepEqual(parseOdateSpan({ className: "odate time_42 format_%25Y" }), {
    timestamp: 42,
    format: "%Y",
    agoHover: false
  })
  assert.equal(parseOdateSpan({ className: "odate time_42" }), null)
  assert.equal(parseOdateSpan({ className: "odate format_%25Y" }), null)
  assert.equal(parseOdateSpan({ className: "odate time_nan format_%25Y" }), null)
  assert.equal(parseOdateSpan({ className: "odate time_42 format_%E0%A4%A" }), null)
  assert.equal(parseOdateSpan({} as { className: string }), null)
})

test("UTC viewer sees the live server wall clock", () => {
  assert.equal(
    formatOdateTimestamp(TIMESTAMP, FORMAT, TIMESTAMP, 0),
    "11 Feb 2016, 20:51"
  )
  assert.equal(
    formatOdateTimestamp(TIMESTAMP, "%d %b %Y %H:%M", TIMESTAMP, 0),
    "11 Feb 2016 20:51"
  )
})

test("JST viewer sees the next-day wall clock with the comma format", () => {
  assert.equal(
    formatOdateTimestamp(TIMESTAMP, FORMAT, TIMESTAMP, 540),
    "12 Feb 2016, 05:51"
  )
})

test("other viewer timezones shift the wall clock", () => {
  assert.equal(
    formatOdateTimestamp(TIMESTAMP, FORMAT, TIMESTAMP, -300),
    "11 Feb 2016, 15:51"
  )
  assert.equal(
    formatOdateTimestamp(TIMESTAMP, FORMAT, TIMESTAMP, 330),
    "12 Feb 2016, 02:21"
  )
})

test("format grammar covers names, padding, escapes and relative time", () => {
  assert.equal(
    formatOdateTimestamp(TIMESTAMP, "%A, %B %e, %Y", TIMESTAMP, 0),
    "Thursday, February 11, 2016"
  )
  assert.equal(formatOdateTimestamp(TIMESTAMP, "%a %b", TIMESTAMP, 0), "Thu Feb")
  assert.equal(formatOdateTimestamp(TIMESTAMP, "%R", TIMESTAMP, 0), "20:51")
  assert.equal(formatOdateTimestamp(TIMESTAMP, "100%%", TIMESTAMP, 0), "100%")
  assert.equal(formatOdateTimestamp(1454705501, "%d", 1454705501, 0), "05")
  assert.equal(formatOdateTimestamp(1454705501, "%e", 1454705501, 0), "5")
  assert.equal(formatOdateTimestamp(1454705501, "%_d", 1454705501, 0), " 5")
  assert.equal(formatOdateTimestamp(1454705501, "%-m", 1454705501, 0), "2")
  assert.equal(formatOdateTimestamp(TIMESTAMP, "%O", TIMESTAMP + 90, 0), "1 minute ago")
  assert.equal(formatOdateTimestamp(TIMESTAMP, "%Z", TIMESTAMP, 540), null)
  assert.equal(formatOdateTimestamp(TIMESTAMP, "%z", TIMESTAMP, 330), null)
})

test("unsupported formats keep the server text", () => {
  assert.equal(formatOdateTimestamp(TIMESTAMP, "%c", TIMESTAMP, 0), null)
  assert.equal(formatOdateTimestamp(TIMESTAMP, "%Q", TIMESTAMP, 0), null)
  assert.equal(formatOdateTimestamp(TIMESTAMP, "ends with percent%", TIMESTAMP, 0), null)
})

test("hover text follows the seconds/minutes/hours/days ladder", () => {
  assert.equal(agoText(0), "0 seconds ago")
  assert.equal(agoText(1), "1 second ago")
  assert.equal(agoText(59), "59 seconds ago")
  assert.equal(agoText(60), "1 minute ago")
  assert.equal(agoText(3599), "59 minutes ago")
  assert.equal(agoText(3600), "1 hour ago")
  assert.equal(agoText(86399), "23 hours ago")
  assert.equal(agoText(86400), "1 day ago")
  assert.equal(agoText(3 * 86400 + 5), "3 days ago")
  assert.equal(agoText(-5), "0 seconds ago")
})

test("span rewrite wires parsed values into text and hover title", () => {
  const element = { className: ENCODED_CLASS, textContent: "server", title: "" }
  const now = TIMESTAMP + 3725
  assert.equal(rewriteOdateSpan(element as unknown as HTMLElement, now), true)
  const offset = -new Date(TIMESTAMP * 1000).getTimezoneOffset()
  assert.equal(element.textContent, formatOdateTimestamp(TIMESTAMP, FORMAT, now, offset))
  assert.equal(element.title, "1 hour ago")
})

test("span rewrite leaves unsupported spans untouched", () => {
  const unsupported = {
    className: "odate time_42 format_%25c",
    textContent: "server",
    title: ""
  }
  assert.equal(rewriteOdateSpan(unsupported as unknown as HTMLElement, 42), false)
  assert.equal(unsupported.textContent, "server")
  assert.equal(unsupported.title, "")
  const classless = { className: "odate time_42", textContent: "server", title: "" }
  assert.equal(rewriteOdateSpan(classless as unknown as HTMLElement, 42), false)
  assert.equal(classless.textContent, "server")
})
