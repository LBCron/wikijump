import { expect, test, waitForSvelteDelegatedHandler } from "./hermetic-playwright"

const SITE_HEADERS = {
  "X-Wikijump-Site-Id": "6000005",
  "X-Wikijump-Site-Slug": "scp-wiki"
}

const devalue = (value: unknown): string => {
  const flat: unknown[] = []
  const add = (item: unknown): number => {
    const index = flat.length
    flat.push(null)
    if (Array.isArray(item)) {
      flat[index] = item.map(add)
    } else if (item !== null && typeof item === "object") {
      const encoded: Record<string, number> = {}
      for (const [key, child] of Object.entries(item)) encoded[key] = add(child)
      flat[index] = encoded
    } else {
      flat[index] = item
    }
    return index
  }
  add(value)
  return JSON.stringify(flat)
}

const successBody = (value: unknown) =>
  JSON.stringify({ type: "success", status: 200, data: devalue(value) })

const fileEntry = (fileId: number, name: string, mime: string, size: number) => ({
  file_id: fileId,
  file_created_at: "2026-04-21T00:00:00Z",
  file_updated_at: null,
  file_deleted_at: null,
  page_id: 7000005,
  revision_id: 9000000 + fileId,
  revision_type: "regular",
  revision_created_at: "2026-04-21T00:00:00Z",
  revision_number: 0,
  revision_user_id: 123,
  name,
  data: null,
  mime,
  size,
  s3_hash: "abc",
  revision_comments: `Uploaded file "${name}"`,
  hidden_fields: []
})

const FILES = [
  fileEntry(3, "weathermap.gif", "image/gif", 1748073),
  fileEntry(1, "AFTER_FOG.png", "image/png", 204126),
  fileEntry(2, "alert.jpg", "image/jpeg", 108082)
]

const AUTHOR = {
  "user-id": 123,
  "user-slug": "fixture-uploader",
  "user-name": "Fixture Uploader",
  "user-karma": 5,
  "user-avatar-data": null,
  "user-profile-url": "https://example.invalid/user/fixture-uploader"
}

const openFiles = async (page: import("@playwright/test").Page) => {
  await page.setExtraHTTPHeaders(SITE_HEADERS)
  await page.route(
    (url) => url.search === "?/fileList",
    async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: successBody({ res: FILES })
      })
    }
  )
  await page.route(
    (url) => url.search === "?/fileHistory",
    async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: successBody({
          res: [
            {
              revision_id: 9000001,
              revision_type: "regular",
              created_at: "2026-04-21T00:00:00Z",
              revision_number: 0,
              file_id: 1,
              page_id: 7000005,
              site_id: 6000005,
              user_id: 123,
              author: AUTHOR,
              name: "AFTER_FOG.png",
              s3_hash: null,
              mime: "image/png",
              size: 204126,
              changes: [],
              comments: 'Uploaded file "AFTER_FOG.png"'
            }
          ]
        })
      })
    }
  )
  await page.goto("/page-workflow-probe", { waitUntil: "domcontentloaded" })
  await waitForSvelteDelegatedHandler(page, "#files-button")
  await page.locator("#files-button").click()
  await expect(page.locator("tr[id^='file-row-']").first()).toBeVisible()
}

test("wikidot files list matches the attachment contract", async ({ page }) => {
  await openFiles(page)

  await expect(page.locator("table.page-files")).toBeVisible()
  await expect(page.locator("table.page-files thead")).toContainText("File name")
  await expect(page.locator("table.page-files thead")).toContainText("File type")
  await expect(page.locator("table.page-files thead")).toContainText("Size")
  await expect(page.locator("text=Total files: 3")).toBeVisible()
  await expect(page.locator("text=Total size: 1.96 MB")).toBeVisible()

  const ids = await page
    .locator("table.page-files tr[id^='file-row-']")
    .evaluateAll((rows) => rows.map((row) => row.id))
  expect(ids).toEqual(["file-row-1", "file-row-2", "file-row-3"])

  const first = page.locator("#file-row-1")
  await expect(first).toContainText("AFTER_FOG.png")
  await expect(first).toContainText("PNG image data")
  await expect(first).toContainText("199.34 kB")
  await expect(first.locator("a:has-text('Info')")).toBeVisible()
  await expect(first.locator("a:has-text('Options')")).toBeVisible()
  await expect(page.locator("#show-upload-button")).toContainText(
    "Upload a file from your computer"
  )
})

test("options row exposes guarded rename, move, delete, and history", async ({
  page
}) => {
  await openFiles(page)

  await page.locator("#file-row-1 a:has-text('Options')").click()
  const options = page.locator("#file-options-row-1")
  await expect(options).toBeVisible()
  for (const label of ["Rename", "Move", "Delete", "History"]) {
    await expect(options.locator(`button:has-text('${label}')`)).toBeVisible()
  }

  await options.locator("button:has-text('Move')").click()
  await expect(page.locator("#owindow-1")).toContainText("PERMISSION ERROR")

  await page.keyboard.press("Escape")
  await expect(page.locator("#owindow-1")).toHaveCount(0)
  await page.locator("#file-row-1 a:has-text('Options')").click()
  await expect(options).toHaveCount(0)
})

test("info modal reports the frozen file fields", async ({ page }) => {
  await openFiles(page)

  await page.locator("#file-row-1 a:has-text('Info')").click()
  const modal = page.locator("#owindow-1")
  await expect(modal).toContainText("File Information")
  await expect(modal).toContainText("AFTER_FOG.png")
  await expect(modal).toContainText("199.34 kB (204126 Bytes)")
  await expect(modal).toContainText("image/png")
  await expect(modal).toContainText("Fixture Uploader")
})

test("anonymous upload stays denied from the wikidot affordance", async ({ page }) => {
  await openFiles(page)

  await page.locator("#show-upload-button").click()
  await expect(page.locator("#owindow-1")).toContainText("PERMISSION ERROR")
})
