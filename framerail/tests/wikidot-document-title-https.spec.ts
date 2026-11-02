import { expect, test } from "./hermetic-playwright"

const SITE_HEADERS = {
  "X-Wikijump-Site-Id": "6000005",
  "X-Wikijump-Site-Slug": "scp-wiki"
}

test("imported pages have the Wikidot browser tab title in SSR and after hydration", async ({
  page
}) => {
  test.skip(!process.env.PLAYWRIGHT_HTTPS_APP_PORT, "requires hermetic HTTPS fixture")
  const host = `https://localhost:${process.env.PLAYWRIGHT_HTTPS_APP_PORT}`
  await page.setExtraHTTPHeaders(SITE_HEADERS)
  const response = await page.goto(`${host}/wikidot-login-probe`, {
    waitUntil: "domcontentloaded"
  })
  expect(response?.status()).toBe(200)
  expect(await response?.text()).toContain("<title>Login probe - SCP Foundation</title>")
  await expect(page).toHaveTitle("Login probe - SCP Foundation")
  await expect(page.locator("#page-title")).toHaveText("Login probe")
})

test("local-native pages retain their non-imported title convention", async ({
  page
}) => {
  test.skip(!process.env.PLAYWRIGHT_HTTPS_APP_PORT, "requires hermetic HTTPS fixture")
  const host = `https://localhost:${process.env.PLAYWRIGHT_HTTPS_APP_PORT}`
  await page.setExtraHTTPHeaders(SITE_HEADERS)
  const response = await page.goto(`${host}/theme:yossistyle`, {
    waitUntil: "domcontentloaded"
  })
  expect(response?.status()).toBe(200)
  expect(await response?.text()).toContain("<title>YOSSISTYLE | SCP Foundation</title>")
  await expect(page).toHaveTitle("YOSSISTYLE | SCP Foundation")
})

test("client-side route changes keep the imported/local title boundary", async ({
  page
}) => {
  test.skip(!process.env.PLAYWRIGHT_HTTPS_APP_PORT, "requires hermetic HTTPS fixture")
  const host = `https://localhost:${process.env.PLAYWRIGHT_HTTPS_APP_PORT}`
  await page.setExtraHTTPHeaders(SITE_HEADERS)
  await page.goto(`${host}/theme:yossistyle`, { waitUntil: "domcontentloaded" })
  await expect(page).toHaveTitle("YOSSISTYLE | SCP Foundation")

  await page.evaluate(() => {
    const link = document.createElement("a")
    link.id = "imported-title-navigation-probe"
    link.href = "/wikidot-login-probe"
    link.textContent = "Go to imported page"
    document.body.appendChild(link)
  })
  await page.locator("#imported-title-navigation-probe").click()
  await expect(page).toHaveURL(`${host}/wikidot-login-probe`)
  await expect(page).toHaveTitle("Login probe - SCP Foundation")
})
