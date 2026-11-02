import { expect, test } from "./hermetic-playwright"

const SITE_HEADERS = {
  "X-Wikijump-Site-Id": "6000005",
  "X-Wikijump-Site-Slug": "scp-wiki"
}

test("imported Wikidot typography CSS survives HTTPS across browser engines", async ({
  page
}, testInfo) => {
  test.skip(
    !process.env.PLAYWRIGHT_HTTPS_APP_PORT,
    "requires the hermetic HTTPS Vite fixture"
  )
  const port = process.env.PLAYWRIGHT_HTTPS_APP_PORT
  const host = `https://localhost:${port}`
  await page.setExtraHTTPHeaders(SITE_HEADERS)

  const failedLocalStylesheets: string[] = []
  page.on("requestfailed", (request) => {
    if (request.resourceType() === "stylesheet" && request.url().startsWith(host)) {
      failedLocalStylesheets.push(`${request.url()}: ${request.failure()?.errorText}`)
    }
  })
  const response = await page.goto(`${host}/theme:yossistyle`, {
    waitUntil: "networkidle"
  })
  expect(response?.status()).toBe(200)
  await expect(page.locator("#page-content p")).toHaveText("XML-RPC theme body marker.")
  await expect(page.locator("head style[data-wikidot-generated-css]")).toHaveCount(2)

  const styles = await page.evaluate(() => {
    const fontSize = (selector: string, property = "font-size") => {
      const element = document.querySelector(selector)
      if (!element) throw new Error(`typography target missing: ${selector}`)
      return parseFloat(getComputedStyle(element).getPropertyValue(property))
    }
    return {
      body: fontSize("body"),
      content: fontSize("#page-content p"),
      title: fontSize("#page-title"),
      paragraphLeading: fontSize("#page-content p", "line-height"),
      fontFamilies: ["body", "#page-content p", "#page-title"].map((selector) => {
        const element = document.querySelector(selector)
        if (!element) throw new Error(`typography target missing: ${selector}`)
        return getComputedStyle(element).fontFamily
      }),
      cssLinks: [
        ...document.querySelectorAll<HTMLLinkElement>(
          'head link[href^="/wikidot/styles/"]'
        )
      ].map((link) => link.href)
    }
  })
  expect(failedLocalStylesheets).toEqual([])
  expect(styles.cssLinks).toHaveLength(3)
  expect(styles.fontFamilies).toEqual(
    Array(3).fill("verdana, arial, helvetica, sans-serif")
  )
  for (const url of styles.cssLinks) {
    expect(new URL(url).protocol).toBe("https:")
    const resource = await page.request.get(url)
    expect(resource.status(), url).toBe(200)
  }
  const mobile = testInfo.project.name.startsWith("mobile-")
  expect(styles.body).toBeGreaterThan(12.78)
  expect(styles.body).toBeLessThan(12.82)
  expect(styles.title / styles.body).toBeCloseTo(2, 2)
  expect(styles.content / styles.body).toBeCloseTo(mobile ? 0.9 : 1, 2)
  expect(styles.paragraphLeading / styles.content).toBeCloseTo(1.5, 2)
})
