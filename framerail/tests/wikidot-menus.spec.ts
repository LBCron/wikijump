import { expect, test } from "./hermetic-playwright"

const SITE_HEADERS = {
  "X-Wikijump-Site-Id": "6000005",
  "X-Wikijump-Site-Slug": "scp-wiki"
}

test("the menu action wraps bare top-bar item text like Wikidot's fixMenuList", async ({
  page
}) => {
  await page.setExtraHTTPHeaders(SITE_HEADERS)
  await page.goto("/wikidot-tabview", { waitUntil: "load" })

  const html = await page.evaluate(async () => {
    const bar = document.createElement("div")
    bar.innerHTML = [
      '<div class="top-bar"><ul>',
      '<li>About\n<ul>\n<li><a href="/faq">FAQ</a></li>\n</ul>\n</li>',
      '<li><a href="/contact-staff">Contact Us</a></li>',
      "</ul></div>"
    ].join("")
    document.body.append(bar)
    const module = (await import(
      /* @vite-ignore */
      new URL("/src/lib/wikidot/wikidot-menus.js", location.href).href
    )) as typeof import("../src/lib/wikidot/wikidot-menus.js")
    module.wikidotMenu(bar, { list: true })

    const about = bar.querySelector(".top-bar > ul > li") as HTMLElement
    about.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }))
    const hovered = about.classList.contains("sfhover")
    about.dispatchEvent(new MouseEvent("mouseout", { bubbles: true }))
    return { html: bar.innerHTML, hovered, after: about.classList.contains("sfhover") }
  })

  expect(html.html).toMatch(/<li(?: class="")?><a href="javascript:;">About\n<\/a><ul>/)
  expect(html.html).toContain('<li><a href="/faq">FAQ</a></li>')
  expect(html.html).toContain('<li><a href="/contact-staff">Contact Us</a></li>')
  expect(html.html.match(/javascript:;/g)?.length).toBe(1)
  expect(html.hovered).toBe(true)
  expect(html.after).toBe(false)
})

test("the side-bar menu action only toggles hover state", async ({ page }) => {
  await page.setExtraHTTPHeaders(SITE_HEADERS)
  await page.goto("/wikidot-tabview", { waitUntil: "load" })

  const result = await page.evaluate(async () => {
    const bar = document.createElement("div")
    bar.innerHTML = "<ul><li>Plain item</li></ul>"
    document.body.append(bar)
    const module = (await import(
      /* @vite-ignore */
      new URL("/src/lib/wikidot/wikidot-menus.js", location.href).href
    )) as typeof import("../src/lib/wikidot/wikidot-menus.js")
    module.wikidotMenu(bar, undefined)
    const item = bar.querySelector("li") as HTMLElement
    item.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }))
    return { html: bar.innerHTML, hovered: item.classList.contains("sfhover") }
  })

  expect(result.html).toBe('<ul><li class="sfhover">Plain item</li></ul>')
  expect(result.hovered).toBe(true)
})
