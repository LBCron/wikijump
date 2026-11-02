import { expect, test, waitForSvelteDelegatedHandler } from "./hermetic-playwright"

const SITE_HEADERS = {
  "X-Wikijump-Site-Id": "6000005",
  "X-Wikijump-Site-Slug": "scp-wiki"
}

const REVISION_MARKER = "history-banner-revision-body-marker"

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

test("viewing a revision shows its banner and closing restores the page", async ({
  page
}) => {
  await page.setExtraHTTPHeaders(SITE_HEADERS)
  await page.route(
    (url) => url.search === "?/history",
    async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: successBody({
          res: {
            entries: [
              {
                revision_id: 42420,
                history_row_id: "banner-row-2",
                timeline_number: 2,
                revision_number: 42,
                page_revision_number: 42,
                history_kind: "page",
                revision_type: "regular",
                created_at: "2026-10-02T00:00:00Z",
                user_id: 123,
                author: {
                  "user-id": 123,
                  "user-slug": "banner-author",
                  "user-name": "Banner Author",
                  "user-karma": 5,
                  "user-avatar-data": null,
                  "user-profile-url": "https://example.invalid/user/banner-author"
                },
                comments: "banner file-operation context"
              }
            ],
            total: 1,
            page: 1,
            perPage: 20,
            totalPages: 1
          }
        })
      })
    }
  )
  await page.route(
    (url) => url.search === "?/revision",
    async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: successBody({
          res: {
            revision_id: 42420,
            revision_type: "regular",
            created_at: "2026-10-02T00:00:00Z",
            revision_number: 42,
            page_id: 3000340,
            site_id: 6000005,
            user_id: 123,
            author: {
              "user-id": 123,
              "user-slug": "banner-author",
              "user-name": "Banner Author",
              "user-karma": 5,
              "user-avatar-data": null,
              "user-profile-url": "https://example.invalid/user/banner-author"
            },
            wikitext: "banner revision source",
            compiled_body_html: `<p>${REVISION_MARKER}</p>`,
            compiled_at: "2026-10-02T00:00:00Z",
            compiled_generator: "fixture",
            comments: "banner revision comments",
            title: "Page Workflow Probe"
          }
        })
      })
    }
  )

  await page.goto("/page-workflow-probe", { waitUntil: "domcontentloaded" })
  await waitForSvelteDelegatedHandler(page, "#history-button")
  await page.locator("#history-button").click()
  await expect(page.locator("#revision-row-banner-row-2")).toBeVisible()
  await page
    .locator("#revision-row-banner-row-2")
    .getByRole("link", { name: "V", exact: true })
    .click()

  const banner = page.locator("#page-version-info")
  await expect(banner).toBeVisible()
  await expect(banner).toContainText("42")
  await expect(banner).toContainText("Banner Author")
  await expect(banner).toContainText("banner file-operation context")
  await expect(page.locator("#page-content")).toContainText(REVISION_MARKER)

  await banner.getByRole("button", { name: /close/i }).click()
  await expect(banner).toHaveCount(0)
  await expect(page.locator("#page-content")).not.toContainText(REVISION_MARKER)
})
