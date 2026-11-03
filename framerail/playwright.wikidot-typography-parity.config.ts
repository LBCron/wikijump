import { devices, type PlaywrightTestConfig } from "@playwright/test"

import browserSupport from "./playwright.browser-support.config"

const config: PlaywrightTestConfig = {
  ...browserSupport,
  testMatch: "**/wikidot-typography-parity.spec.ts",
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"], ignoreHTTPSErrors: true }
    },
    {
      name: "firefox",
      use: { ...devices["Desktop Firefox"], ignoreHTTPSErrors: true }
    },
    {
      name: "webkit",
      use: { ...devices["Desktop Safari"], ignoreHTTPSErrors: true }
    }
  ]
}

export default config
