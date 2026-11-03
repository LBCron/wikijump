import { expect, test } from "./hermetic-playwright"

const SITE_HEADERS = {
  "X-Wikijump-Site-Id": "6000005",
  "X-Wikijump-Site-Slug": "scp-wiki"
}

const LIVE_YOSSISTYLE_TYPOGRAPHY = {
  body: {
    fontFamily: "verdana, arial, helvetica, sans-serif",
    fontSize: "12.8px",
    fontWeight: "400",
    lineHeight: "normal",
    textRendering: "auto"
  },
  content: {
    fontFamily: "verdana, arial, helvetica, sans-serif",
    fontSize: "12.8px",
    fontWeight: "400",
    lineHeight: "19.2px",
    textRendering: "auto"
  },
  title: {
    fontFamily: "verdana, arial, helvetica, sans-serif",
    fontSize: "25.6px",
    fontWeight: "400",
    lineHeight: "normal",
    textRendering: "auto"
  }
} as const

const QUANTIZATION_TOLERANCE_PX = 0.02

const PX_VALUE = /^(-?\d+(?:\.\d+)?)px$/

type TypographySnapshot = Readonly<Record<string, Readonly<Record<string, string>>>>

const typographyMismatches = (
  actual: TypographySnapshot,
  expected: TypographySnapshot
): string[] => {
  const mismatches: string[] = []
  for (const [element, properties] of Object.entries(expected)) {
    for (const [property, expectedValue] of Object.entries(properties)) {
      const actualValue = actual[element]?.[property]
      const expectedPx = PX_VALUE.exec(expectedValue)
      const actualPx = actualValue === undefined ? null : PX_VALUE.exec(actualValue)
      if (expectedPx && actualPx) {
        const difference = Math.abs(Number(actualPx[1]) - Number(expectedPx[1]))
        if (difference > QUANTIZATION_TOLERANCE_PX) {
          mismatches.push(
            `${element}.${property}: expected ${expectedValue}, got ${actualValue}`
          )
        }
      } else if (actualValue !== expectedValue) {
        mismatches.push(
          `${element}.${property}: expected ${expectedValue}, got ${actualValue}`
        )
      }
    }
  }
  return mismatches
}

test("imported-page typography follows the recorded Wikidot live reference", async ({
  page
}) => {
  test.skip(
    !process.env.PLAYWRIGHT_HTTPS_APP_PORT,
    "requires the hermetic HTTPS Vite fixture"
  )
  const host = `https://localhost:${process.env.PLAYWRIGHT_HTTPS_APP_PORT}`
  await page.setExtraHTTPHeaders(SITE_HEADERS)
  const response = await page.goto(`${host}/theme:yossistyle`, {
    waitUntil: "networkidle"
  })
  expect(response?.status()).toBe(200)

  await expect(page.locator("#page-content p")).toHaveText("XML-RPC theme body marker.")
  await expect(page.locator("head style[data-wikidot-generated-css]")).toHaveCount(2)

  const actual = await page.evaluate(() => {
    const typography = (element: Element | null) => {
      if (!element) throw new Error("typography probe target is missing")
      const style = getComputedStyle(element)
      const properties = [
        ["fontFamily", "font-family"],
        ["fontSize", "font-size"],
        ["fontWeight", "font-weight"],
        ["lineHeight", "line-height"],
        ["textRendering", "text-rendering"]
      ] as const
      return Object.fromEntries(
        properties.map(([key, property]) => [key, style.getPropertyValue(property)])
      )
    }

    return {
      body: typography(document.body),
      content: typography(document.querySelector("#page-content p")),
      title: typography(document.querySelector("#page-title"))
    }
  })

  expect(typographyMismatches(actual, LIVE_YOSSISTYLE_TYPOGRAPHY)).toEqual([])
})
