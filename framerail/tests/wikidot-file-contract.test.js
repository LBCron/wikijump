import assert from "node:assert/strict"
import { test } from "node:test"

import {
  isMirrorFileInventoryReadOnly,
  sortFilesWikidot,
  wikidotBareMimeType,
  wikidotFileSize,
  wikidotFileTotals,
  wikidotFileTypeDescription,
  wikidotFileUploadDate,
  wikidotRenameDeniedPopup,
  wikidotUploadDeniedPopup
} from "../src/lib/wikidot-file-contract.js"

test("file sizes match the frozen Wikidot strings", () => {
  assert.equal(wikidotFileSize(204126), "199.34 kB")
  assert.equal(wikidotFileSize(108082), "105.55 kB")
  assert.equal(wikidotFileSize(7067459), "6.74 MB")
  assert.equal(wikidotFileSize(0), "0 Bytes")
  assert.equal(wikidotFileSize(1023), "1023 Bytes")
  assert.equal(wikidotFileSize(1024), "1.00 kB")
  assert.equal(wikidotFileSize(1048576), "1.00 MB")
})

test("only fixture-observed types map to Wikidot labels", () => {
  assert.equal(wikidotFileTypeDescription("image/png"), "PNG image data")
  assert.equal(wikidotFileTypeDescription("image/jpeg"), "JPEG image data")
  assert.equal(wikidotFileTypeDescription("image/gif"), "GIF image data")
  assert.equal(wikidotFileTypeDescription("application/pdf"), "application/pdf")
  assert.equal(wikidotFileTypeDescription(undefined), "")
})

test("stored charset-suffixed MIME resolves to Wikidot labels", () => {
  assert.equal(wikidotFileTypeDescription("image/png; charset=binary"), "PNG image data")
  assert.equal(
    wikidotFileTypeDescription("image/jpeg; charset=binary"),
    "JPEG image data"
  )
  assert.equal(wikidotFileTypeDescription("image/gif; charset=binary"), "GIF image data")
  assert.equal(
    wikidotFileTypeDescription("application/octet-stream"),
    "application/octet-stream"
  )
  assert.equal(
    wikidotFileTypeDescription("application/octet-stream; charset=binary"),
    "application/octet-stream"
  )
  assert.equal(wikidotFileTypeDescription("image/webp; charset=binary"), "image/webp")
  assert.equal(
    wikidotFileTypeDescription("application/pdf; charset=binary"),
    "application/pdf"
  )
})

test("bare MIME strips the analysis cache suffix for display", () => {
  assert.equal(wikidotBareMimeType("image/png; charset=binary"), "image/png")
  assert.equal(wikidotBareMimeType("image/png"), "image/png")
  assert.equal(wikidotBareMimeType(undefined), "")
  assert.equal(wikidotBareMimeType(""), "")
})

test("files sort case-insensitively by name like the frozen list", () => {
  const names = [
    "WHEN_ALERT.png",
    "alert.jpg",
    "AFTER_FOG.png",
    "weathermap.gif",
    "Sam.jpg",
    "cold.jpg"
  ].map((name) => ({ name }))
  assert.deepEqual(
    sortFilesWikidot(names).map((file) => file.name),
    [
      "AFTER_FOG.png",
      "alert.jpg",
      "cold.jpg",
      "Sam.jpg",
      "weathermap.gif",
      "WHEN_ALERT.png"
    ]
  )
})

test("totals count files and sum bytes", () => {
  assert.deepEqual(wikidotFileTotals([{ size: 100 }, { size: 200 }, {}]), {
    count: 3,
    bytes: 300
  })
  assert.deepEqual(wikidotFileTotals([]), { count: 0, bytes: 0 })
})

test("mirror inventory is read-only only when page and site are both imported", () => {
  const imported = { from_wikidot: true }
  const native = { from_wikidot: false }
  assert.equal(isMirrorFileInventoryReadOnly(imported, imported), true)
  assert.equal(isMirrorFileInventoryReadOnly(imported, native), false)
  assert.equal(isMirrorFileInventoryReadOnly(native, imported), false)
  assert.equal(isMirrorFileInventoryReadOnly(native, native), false)
  assert.equal(isMirrorFileInventoryReadOnly(null, imported), false)
  assert.equal(isMirrorFileInventoryReadOnly(imported, undefined), false)
})

test("info modal upload date keeps the frozen comma and odate shape", () => {
  const uploaded = wikidotFileUploadDate("2026-04-21T06:01:00Z")
  assert.equal(uploaded.timestamp, Math.floor(Date.parse("2026-04-21T06:01:00Z") / 1000))
  assert.equal(uploaded.text, "21 Apr 2026, 06:01")
  assert.equal(
    uploaded.className,
    `odate time_${uploaded.timestamp} format_%25e%20%25b%20%25Y%2C%20%25H%3A%25M%7Cagohover`
  )

  assert.equal(wikidotFileUploadDate("2026-10-11T03:04:05Z").text, "11 Oct 2026, 03:04")
})

test("permission denials keep the recorded PERMISSION ERROR shape", () => {
  const roleNote =
    "Only owner (creator) of this page, site administrators and perhaps selected moderators are allowed to do it."
  const signIn = { href: "#action:login", label: "Sign in as Wikidot user" }

  assert.deepEqual(wikidotUploadDeniedPopup(), {
    state: true,
    title: "PERMISSION ERROR",
    leadIn: "Please note:",
    message: "Sorry, you can not attach a new file to this page.",
    extraMessage: roleNote,
    actionLink: signIn,
    data: null
  })
  assert.deepEqual(wikidotRenameDeniedPopup(), {
    state: true,
    title: "PERMISSION ERROR",
    leadIn: "Please note:",
    message: "Sorry, you can not rename file attachment in this page.",
    extraMessage: roleNote,
    actionLink: signIn,
    data: null
  })
  const first = wikidotUploadDeniedPopup()
  first.message = "mutated"
  assert.equal(
    wikidotUploadDeniedPopup().message,
    "Sorry, you can not attach a new file to this page."
  )
})
