import { expect, test } from "./hermetic-playwright"
import type { Page } from "@playwright/test"
import observation from "./fixtures/wikidot-footnote-navigation-observation.json" with { type: "json" }

const headers = {
  "X-Wikijump-Site-Id": "6000005",
  "X-Wikijump-Site-Slug": "scp-wiki"
}

async function expectCentered(page: Page, selector: string) {
  await expect
    .poll(() =>
      page.locator(selector).evaluate((element) => {
        const rect = element.getBoundingClientRect()
        return Math.abs(rect.top + rect.height / 2 - window.innerHeight / 2)
      })
    )
    .toBeLessThan(16)
}

test("Wikidot footnote references and returns scroll under strict CSP", async ({
  page
}) => {
  const consoleErrors: string[] = []
  const pageErrors: string[] = []
  await page.setExtraHTTPHeaders(headers)
  await page.emulateMedia({ reducedMotion: "reduce" })
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text())
  })
  page.on("pageerror", (error) => pageErrors.push(error.message))

  await page.goto("/wikidot-footnotes", { waitUntil: "domcontentloaded" })
  await page.locator("#page-content").evaluate((content) => {
    const spacer = document.createElement("div")
    spacer.style.height = "600px"
    content.prepend(spacer)
  })

  const firstReference = page.locator("#footnoteref-1")
  const secondReference = page.locator("#footnoteref-2")
  const firstNote = page.locator("#footnote-1")
  const secondNote = page.locator("#footnote-2")
  const historyBefore = await page.evaluate(() => ({
    length: history.length,
    url: location.href
  }))

  await expect(firstReference).toHaveCount(1)
  await expect(page.locator("#page-content a[onclick*='scrollToReference']")).toHaveCount(
    0
  )
  await expect(firstReference).toHaveAttribute("href", /^javascript:;$/u)
  await firstReference.click()
  await expectCentered(page, "#footnote-1")
  expect(await firstNote.evaluate((target) => target.getAnimations().length)).toBe(0)
  expect(
    await page.evaluate(() => ({ length: history.length, url: location.href }))
  ).toEqual(historyBefore)

  await firstNote.locator(":scope > a").click()
  await expectCentered(page, "#footnoteref-1")

  await secondReference.focus()
  await secondReference.press("Enter")
  await expectCentered(page, "#footnote-2")
  await secondNote.locator(":scope > a").click()
  await expectCentered(page, "#footnoteref-2")

  await page.setViewportSize({ width: 320, height: 720 })
  await firstReference.click()
  await expectCentered(page, "#footnote-1")
  await firstNote.locator(":scope > a").click()
  await expectCentered(page, "#footnoteref-1")
  await page.setViewportSize({ width: 1280, height: 720 })

  await page.locator("#page-content").evaluate((content) => {
    content.innerHTML = `
      <div style="height: 1000px"></div>
      <sup class="footnoteref"><a id="footnoteref-replaced" class="footnoteref" href="javascript:;" onclick="WIKIDOT.page.utils.scrollToReference('footnote-replaced')">3</a></sup>
      <div style="height: 1000px"></div>
      <div class="footnote-footer" id="footnote-replaced"><a href="javascript:;" onclick="WIKIDOT.page.utils.scrollToReference('footnoteref-replaced')">3</a>. Replaced note.</div>
      <div style="height: 1000px"></div>
      <sup class="footnoteref"><a id="footnoteref-nested" class="footnoteref" href="javascript:;" onclick="WIKIDOT.page.utils.scrollToReference('footnote-nested')">4</a></sup>
      <div class="collapsible-block">
        <div class="collapsible-block-folded"><a class="collapsible-block-link" href="javascript:;">Show nested note</a></div>
        <div class="collapsible-block-unfolded" style="display: none">
          <div class="yui-navset">
            <ul class="yui-nav"><li class="selected"><a href="javascript:;"><em>Other</em></a></li><li><a href="javascript:;"><em>Footnote</em></a></li></ul>
            <div class="yui-content"><div style="display: block">Other content</div><div style="display: none"><div class="footnote-footer" id="footnote-nested"><a href="javascript:;" onclick="WIKIDOT.page.utils.scrollToReference('footnoteref-nested')">4</a>. Nested note.</div></div></div>
          </div>
        </div>
      </div>
      <div style="height: 1000px"></div>
      <a id="unrelated-handler" href="javascript:;" onclick="alert(1)">Unrelated</a>
    `
  })
  const replacedReference = page.locator("#footnoteref-replaced")
  await expect(replacedReference).not.toHaveAttribute("onclick", /./u)
  await expect(page.locator("#unrelated-handler")).toHaveAttribute("onclick", "alert(1)")
  await replacedReference.click()
  await expectCentered(page, "#footnote-replaced")
  await page.locator("#footnoteref-nested").click()
  await expect(page.locator(".collapsible-block-unfolded")).toBeVisible()
  await expect(page.locator(".yui-nav > li").nth(1)).toHaveClass(/selected/u)
  await expectCentered(page, "#footnote-nested")
  await page.locator("#footnote-nested > a").click()
  await expectCentered(page, "#footnoteref-nested")

  expect(
    consoleErrors.filter(
      (message) =>
        message.includes("Content Security Policy") ||
        message.includes("Running the JavaScript URL") ||
        message.includes("WIKIDOT.page.utils.scrollToReference")
    )
  ).toEqual([])
  expect(pageErrors).toEqual([])
  expect(observation.actions).toHaveLength(4)
})
