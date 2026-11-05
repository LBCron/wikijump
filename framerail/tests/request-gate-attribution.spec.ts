import type { Page } from "@playwright/test"

import { expect, test } from "./hermetic-playwright"

import {
  createBrowserRequestGate,
  installBrowserRequestGate,
  isWikidotCapturePublicOrigin
} from "../../install/local/wikidot-verification/src/browser-request-gate.mjs"
import {
  captureBrowserParityObservation,
  captureDocumentObservation
} from "../../install/local/wikidot-verification/src/standing-browser-parity-observation.mjs"

test("an intentional request-gate abort is sealed separately from organic page failures", async ({
  context,
  page
}, testInfo) => {
  const gate = createBrowserRequestGate({ intervalMs: 4_000 })
  const attribution = await installBrowserRequestGate(context, {
    gate,
    // @ts-expect-error
    publicOriginPredicate: isWikidotCapturePublicOrigin
  })
  const observation = await captureBrowserParityObservation({
    context,
    // @ts-expect-error
    page,
    url: "https://scp-wiki.wikidot.com/gate-attribution-fixture",
    label: "live",
    index: 0,
    outputDir: testInfo.outputDir,
    contract: null,
    viewport: { width: 800, height: 600 },
    timeoutMs: 10_000,
    settleMs: 0,
    // @ts-expect-error
    requestGateAttribution: attribution,
    // @ts-expect-error
    navigate: async ({ page: target }: { page: Page }) => {
      await target.setContent(
        '<main id="page-content">fixture</main><script src="https://cdn.onesignal.com/sdks/OneSignalSDK.js"></script>',
        { waitUntil: "load" }
      )
      return { status: 200 }
    }
  })

  expect(observation.failures).toEqual([])
  expect(observation.request_gate_aborts).toEqual([
    {
      kind: "request_gate_abort",
      url: "https://cdn.onesignal.com/sdks/OneSignalSDK.js",
      resource_type: "script",
      error: "net::ERR_BLOCKED_BY_CLIENT.Inspector",
      decision: "unsupported_public_origin_resource_type",
      abort_reason: "blockedbyclient"
    }
  ])
  expect(gate.snapshot()).toMatchObject({
    public_requests: 0,
    unsupported_requests_blocked: 1,
    grants: []
  })
})

test("rating-score normalization is limited to the real rating widget node", async ({
  page
}) => {
  await page.setContent(`
    <main id="page-content">
      <div class="page-rate-widget-box">
        <span class="rate-points">rating: <span class="number prw54353">+312</span></span>
      </div>
      <span class="number prw54353">stable 312</span>
    </main>
  `)

  const observation = await captureDocumentObservation(page, {
    contract: {
      geometry_selectors: [],
      presence_probes: [],
      first_paint_custom_properties: {},
      first_divergence_trace: {
        root_selector: "#page-content",
        max_elements: 10
      }
    },
    phase: "settled",
    viewport: { width: 800, height: 600 }
  })
  const scores = observation.first_divergence_trace.elements.filter(
    (element: { classes: string[] }) => element.classes.includes("prw54353")
  )

  expect(scores).toHaveLength(2)
  expect(scores[0]).toMatchObject({
    direct_text_normalization: "page_rating_score",
    direct_text_observed: "+312",
    direct_text_normalized: true
  })
  expect(scores[1]).toMatchObject({ direct_text_normalized: false })
  expect(scores[1]).not.toHaveProperty("direct_text_normalization")
  expect(scores[1]).not.toHaveProperty("direct_text_observed")
})
