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

test("imported-page typography follows the recorded Wikidot live reference", async ({
  page
}) => {
  await page.setExtraHTTPHeaders(SITE_HEADERS)
  await page.goto("/theme:yossistyle")

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

  expect(actual).toEqual(LIVE_YOSSISTYLE_TYPOGRAPHY)
})
