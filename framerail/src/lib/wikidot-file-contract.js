/**
 * Wikidot attachment-list contract helpers, frozen from the live
 * `files/PageFilesModule` output. Refs #2067.
 */

const FILE_TYPE_DESCRIPTIONS = new Map([
  ["image/png", "PNG image data"],
  ["image/jpeg", "JPEG image data"],
  ["image/gif", "GIF image data"]
])

export const wikidotBareMimeType = (mime) => (mime ?? "").split(";")[0].trim()

export const wikidotFileTypeDescription = (mime) =>
  FILE_TYPE_DESCRIPTIONS.get(wikidotBareMimeType(mime).toLowerCase()) ??
  wikidotBareMimeType(mime)

const FILE_SIZE_UNITS = ["Bytes", "kB", "MB", "GB"]

export const wikidotFileSize = (bytes) => {
  const size = Math.max(Number(bytes) || 0, 0)
  if (size < 1024) return `${size} Bytes`
  let value = size
  let unit = 0
  while (value >= 1024 && unit < FILE_SIZE_UNITS.length - 1) {
    value /= 1024
    unit += 1
  }
  return `${value.toFixed(2)} ${FILE_SIZE_UNITS[unit]}`
}

export const sortFilesWikidot = (files) =>
  [...(files ?? [])].sort((a, b) => {
    const left = (a?.name ?? "").toLowerCase()
    const right = (b?.name ?? "").toLowerCase()
    if (left === right) return 0
    return left < right ? -1 : 1
  })

export const isMirrorFileInventoryReadOnly = (page, site) =>
  Boolean(page?.from_wikidot && site?.from_wikidot)

export const wikidotFileTotals = (files) => ({
  count: (files ?? []).length,
  bytes: (files ?? []).reduce((sum, file) => sum + (Number(file?.size) || 0), 0)
})

const FILE_UPLOAD_MONTHS = [
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

export const wikidotFileUploadDate = (createdAt) => {
  const date = new Date(createdAt)
  const timestamp = Math.floor(date.getTime() / 1000)
  const day = String(date.getUTCDate()).padStart(2, "0")
  const hour = String(date.getUTCHours()).padStart(2, "0")
  const minute = String(date.getUTCMinutes()).padStart(2, "0")
  return {
    timestamp,
    text: `${day} ${FILE_UPLOAD_MONTHS[date.getUTCMonth()]} ${date.getUTCFullYear()}, ${hour}:${minute}`,
    className: `odate time_${timestamp} format_%25e%20%25b%20%25Y%2C%20%25H%3A%25M%7Cagohover`
  }
}

const WIKIDOT_ATTACH_ROLE_NOTE =
  "Only owner (creator) of this page, site administrators and perhaps selected moderators are allowed to do it."

const wikidotSignInAction = () => ({
  href: "#action:login",
  label: "Sign in as Wikidot user"
})

export const wikidotUploadDeniedPopup = () => ({
  state: true,
  title: "PERMISSION ERROR",
  leadIn: "Please note:",
  message: "Sorry, you can not attach a new file to this page.",
  extraMessage: WIKIDOT_ATTACH_ROLE_NOTE,
  actionLink: wikidotSignInAction(),
  data: null
})

export const wikidotRenameDeniedPopup = () => ({
  state: true,
  title: "PERMISSION ERROR",
  leadIn: "Please note:",
  message: "Sorry, you can not rename file attachment in this page.",
  extraMessage: WIKIDOT_ATTACH_ROLE_NOTE,
  actionLink: wikidotSignInAction(),
  data: null
})
