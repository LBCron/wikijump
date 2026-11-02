import { expect, test } from "./hermetic-playwright"
import interaction from "./fixtures/wikidot-toc-fold-unfold-live.json" with { type: "json" }

const headers = {
  "X-Wikijump-Site-Id": "6000005",
  "X-Wikijump-Site-Slug": "scp-wiki"
}

test("Wikidot TOC controls fold independently without inline script execution", async ({
  page
}) => {
  const consoleErrors: string[] = []
  const pageErrors: string[] = []
  await page.setExtraHTTPHeaders(headers)
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text())
  })
  page.on("pageerror", (error) => pageErrors.push(error.message))

  await page.goto("/wikidot-toc", { waitUntil: "domcontentloaded" })

  const tocs = page.locator('#page-content div[id="toc"]')
  await expect(tocs).toHaveCount(2)
  const first = tocs.nth(0)
  const second = tocs.nth(1)
  const firstControls = first.locator("#toc-action-bar > a")
  const firstList = first.locator("#toc-list")
  const fold = firstControls.nth(0)
  const unfold = firstControls.nth(1)
  const initialNavigation = await page.evaluate(() => ({
    historyLength: history.length,
    url: location.href
  }))

  await expect(firstList).toHaveCSS("display", "block")
  await expect(fold).toBeVisible()
  await expect(unfold).toBeHidden()
  await expect(
    page.locator('#page-content [id="toc-action-bar"] a[onclick]')
  ).toHaveCount(0)
  await expect(fold).toHaveAttribute("href", /^javascript:;$/u)

  await fold.click()
  await expect(firstList).toHaveCSS("display", interaction.actions[0].toc_list_display)
  await expect(fold).toHaveCSS("display", interaction.actions[0].fold_display)
  await expect(unfold).toHaveCSS("display", interaction.actions[0].unfold_display)
  expect(
    await page.evaluate(() => ({ historyLength: history.length, url: location.href }))
  ).toEqual(initialNavigation)

  await unfold.focus()
  await unfold.press("Enter")
  await expect(firstList).toHaveCSS("display", interaction.actions[1].toc_list_display)
  await expect(fold).toHaveCSS("display", interaction.actions[1].fold_display)
  await expect(unfold).toHaveCSS("display", interaction.actions[1].unfold_display)
  expect(
    await page.evaluate(() => ({ historyLength: history.length, url: location.href }))
  ).toEqual(initialNavigation)

  await fold.click()
  await expect(firstList).toBeHidden()
  await unfold.click()
  await expect(firstList).toBeVisible()
  await fold.click()
  await expect(firstList).toBeHidden()

  const secondControls = second.locator("#toc-action-bar > a")
  const secondList = second.locator("#toc-list")
  await expect(secondList).toBeVisible()
  await secondControls.nth(0).click()
  await expect(secondList).toBeHidden()
  await expect(firstList).toBeHidden()
  await secondControls.nth(1).click()
  await expect(secondList).toBeVisible()
  await second.locator('#toc-list a[href="#toc1"]').click()
  await expect(page).toHaveURL(/#toc1$/u)

  await page.locator("#page-content").evaluate((content) => {
    content.innerHTML =
      '<div id="toc"><div id="toc-action-bar"><a href="javascript:;" onclick="WIKIDOT.page.listeners.foldToc(event)">Fold</a><a style="display: none" href="javascript:;" onclick="WIKIDOT.page.listeners.unfoldToc(event)">Unfold</a></div><div class="title">Table of Contents</div><div id="toc-list"><div><a href="#next-heading">Next heading</a></div></div></div><h1 id="next-heading">Next heading</h1>'
  })
  const replacement = page.locator('#page-content div[id="toc"]')
  const replacementControls = replacement.locator("#toc-action-bar > a")
  await expect(replacement.locator("#toc-action-bar a[onclick]")).toHaveCount(0)
  await replacementControls.nth(0).click()
  await expect(replacement.locator("#toc-list")).toBeHidden()
  await replacementControls.nth(1).press("Enter")
  await expect(replacement.locator("#toc-list")).toBeVisible()

  expect(
    consoleErrors.filter(
      (message) =>
        message.includes("Running the JavaScript URL") ||
        (message.includes("Content Security Policy") && message.includes("inline")) ||
        message.includes("WIKIDOT.page.listeners.foldToc") ||
        message.includes("WIKIDOT.page.listeners.unfoldToc")
    )
  ).toEqual([])
  expect(pageErrors).toEqual([])
})
