import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import { STANDING_BROWSER_CAPTURE_SCHEMA } from "./standing-browser-parity-contract.mjs";
import { domSignature } from "./oracle-fixtures.mjs";
import { normalizeText } from "./render-compare.mjs";
import {
  applyCssBoxFallback,
  capturePseudoLayouts,
} from "./standing-browser-pseudo-layout.mjs";
import { capturePng } from "./standing-browser-screenshot.mjs";
import { sha256File } from "./standing-browser-parity-util.mjs";

const FIRST_DIVERGENCE_STYLE_PROPERTIES = Object.freeze([
  "display",
  "position",
  "margin-top",
  "margin-right",
  "margin-bottom",
  "margin-left",
  "padding-top",
  "padding-right",
  "padding-bottom",
  "padding-left",
  "font-family",
  "font-size",
  "font-weight",
  "line-height",
  "letter-spacing",
  "white-space",
]);

function failureKey(failure) {
  return JSON.stringify([
    failure?.kind ?? null,
    failure?.url ?? null,
    failure?.status ?? null,
    failure?.resource_type ?? null,
    failure?.error ?? null,
  ]);
}

function artifactBase({ label, index, url }) {
  const digest = createHash("sha256").update(url).digest("hex").slice(0, 16);
  return `standing-browser-${label}-${String(index).padStart(2, "0")}-${digest}`;
}

export function observationArtifactName({ label, index, url, phase }) {
  if (
    !new Set([
      "domcontentloaded-immediate",
      "settled-viewport",
      "settled-full-page",
    ]).has(phase)
  ) {
    throw new Error(`unsupported browser observation artifact phase: ${phase}`);
  }
  return `${artifactBase({ label, index, url })}-${phase}.png`;
}

export async function captureDocumentObservation(
  page,
  { contract, phase, viewport },
) {
  const geometrySelectors =
    phase === "domcontentloaded_immediate_observation"
      ? (contract?.first_paint_geometry_selectors ?? [])
      : (contract?.geometry_selectors ?? []);
  const presenceProbes = contract?.presence_probes ?? [];
  const customPropertyNames = Object.keys(
    contract?.first_paint_custom_properties ?? {},
  ).sort();
  const firstDivergenceTrace = contract?.first_divergence_trace ?? null;
  const skeleton =
    contract?.capture_page_chrome_skeleton ??
    contract?.page_chrome_skeleton ??
    null;
  const documentPhase = await page.evaluate(
    ({
      geometrySelectors: selectors,
      presenceProbes: probes,
      customPropertyNames: properties,
      skeletonContract,
      traceContract,
      traceStyleProperties,
      phase: capturedPhase,
    }) => {
      const rounded = (value) => Math.round(Number(value) * 100) / 100;
      const rect = (element) => {
        const box = element.getBoundingClientRect();
        return Object.fromEntries(
          ["x", "y", "width", "height"].map((key) => [key, rounded(box[key])]),
        );
      };
      const rendered = (element) => {
        // Chromium may report non-zero descendant boxes for closed details.
        // Only the direct summary subtree participates in rendered parity.
        for (
          let details = element.parentElement?.closest?.(
            "details:not([open])",
          );
          details;
          details = details.parentElement?.closest?.("details:not([open])")
        ) {
          const summary = [...details.children].find(
            (child) => child.localName === "summary",
          );
          if (!summary || (element !== summary && !summary.contains(element))) {
            return false;
          }
        }
        const style = getComputedStyle(element);
        const box = element.getBoundingClientRect();
        return (
          style.display !== "none" &&
          style.visibility !== "hidden" &&
          Number.parseFloat(style.opacity || "1") > 0 &&
          box.width > 0 &&
          box.height > 0
        );
      };
      const normalized = (value) =>
        String(value ?? "")
          .trim()
          .replace(/\s+/gu, " ");
      const pseudoRendered = (element, pseudo) => {
        const style = getComputedStyle(element, pseudo);
        const content = normalized(style.content).replace(
          /^(?:["'])|(?:["'])$/gu,
          "",
        );
        const paintsContent =
          content !== "" && content !== "none" && content !== "normal";
        const paintsBackground = normalized(style.backgroundImage) !== "none";
        return (
          rendered(element) &&
          style.display !== "none" &&
          style.visibility !== "hidden" &&
          Number.parseFloat(style.opacity || "1") > 0 &&
          (paintsContent || paintsBackground)
        );
      };
      const geometry = Object.fromEntries(
        selectors.map((selector) => {
          const nodes = [...document.querySelectorAll(selector)];
          return [
            selector,
            {
              count: nodes.length,
              rect: nodes.length === 1 ? rect(nodes[0]) : null,
            },
          ];
        }),
      );
      const observedProbes = probes.map((probe) => {
        const nodes = [...document.querySelectorAll(probe.selector)];
        const element = nodes.length === 1 ? nodes[0] : null;
        const style = element
          ? getComputedStyle(element, probe.pseudo ?? null)
          : null;
        return {
          id: probe.id,
          selector: probe.selector,
          pseudo: probe.pseudo ?? null,
          count: nodes.length,
          rendered_count: nodes.filter((candidate) =>
            probe.pseudo
              ? pseudoRendered(candidate, probe.pseudo)
              : rendered(candidate),
          ).length,
          rect: element ? rect(element) : null,
          style: style
            ? Object.fromEntries(
                (probe.comparison_properties ?? []).map((property) => [
                  property,
                  normalized(style.getPropertyValue(property)),
                ]),
              )
            : null,
        };
      });
      const root = document.querySelector("#page-content");
      const images = [...document.images].filter(rendered);
      const pageChromeSkeleton = {
        schema: skeletonContract?.schema ?? null,
        links: (skeletonContract?.links ?? []).map((link) => {
          const parentNodes =
            link.parent === "body"
              ? document.body
                ? [document.body]
                : []
              : [...document.querySelectorAll(link.parent)];
          const childNodes = [...document.querySelectorAll(link.child)];
          const directChildCount = parentNodes.reduce(
            (count, parent) =>
              count +
              [...(parent.children ?? [])].filter((child) =>
                child.matches(link.child),
              ).length,
            0,
          );
          return {
            parent: link.parent,
            child: link.child,
            parent_count: parentNodes.length,
            child_count: childNodes.length,
            direct_child_count: directChildCount,
          };
        }),
      };
      const pageContentElements = root
        ? [...root.querySelectorAll("*")]
        : [];
      const traceRoot = traceContract
        ? document.querySelector(traceContract.root_selector)
        : null;
      const allTraceElements = traceRoot
        ? [...traceRoot.querySelectorAll("*")]
        : [];
      const tracePaths = new WeakMap();
      const siblingOrdinals = new WeakMap();
      for (const element of allTraceElements) {
        const parent = element.parentElement;
        const ordinals = siblingOrdinals.get(parent) ?? new Map();
        const ordinal = (ordinals.get(element.localName) ?? 0) + 1;
        ordinals.set(element.localName, ordinal);
        siblingOrdinals.set(parent, ordinals);
        const parentPath = parent === traceRoot ? "" : tracePaths.get(parent);
        tracePaths.set(
          element,
          parentPath
            ? `${parentPath}/${element.localName}[${ordinal}]`
            : `${element.localName}[${ordinal}]`,
        );
      }
      const traceElements = allTraceElements.filter(rendered);
      const traceLimit = Math.max(
        0,
        Math.floor(Number(traceContract?.max_elements ?? 0)),
      );
      const firstDivergenceTrace = traceContract
        ? {
            root_selector: traceContract.root_selector,
            root_count: document.querySelectorAll(traceContract.root_selector)
              .length,
            element_count: traceElements.length,
            captured_count: Math.min(traceElements.length, traceLimit),
            truncated: traceElements.length > traceLimit,
            incomplete_image_count: traceRoot
              ? [...traceRoot.querySelectorAll("img")].filter(
                  (image) =>
                    rendered(image) &&
                    (!image.complete || image.naturalWidth <= 0),
                ).length
              : 0,
            elements: traceElements.slice(0, traceLimit).map((element) => {
              const style = getComputedStyle(element);
              const box = element.getBoundingClientRect();
              return {
                path: tracePaths.get(element),
                tag: element.localName,
                id: element.id || null,
                classes: [...element.classList].sort(),
                child_element_count: element.children.length,
                direct_text: normalized(
                  [...element.childNodes]
                    .filter((node) => node.nodeType === Node.TEXT_NODE)
                    .map((node) => node.textContent ?? "")
                    .join(" "),
                ),
                direct_text_kind: element.matches(
                  ".page-rate-widget-box .rate-points > .number.prw54353",
                )
                  ? "page_rating_score"
                  : null,
                rect: {
                  x: rounded(box.x + window.scrollX),
                  y: rounded(box.y + window.scrollY),
                  width: rounded(box.width),
                  height: rounded(box.height),
                },
                style: Object.fromEntries(
                  traceStyleProperties.map((property) => [
                    property,
                    normalized(style.getPropertyValue(property)),
                  ]),
                ),
              };
            }),
          }
        : null;
      return {
        phase: capturedPhase,
        captured_at_epoch_ms: Date.now(),
        captured_at_performance_ms: rounded(performance.now()),
        ready_state: document.readyState,
        geometry,
        presence_probes: observedProbes,
        custom_properties: Object.fromEntries(
          properties.map((property) => [
            property,
            normalized(
              getComputedStyle(document.documentElement).getPropertyValue(
                property,
              ),
            ),
          ]),
        ),
        dom_signatures: root
          ? pageContentElements
              .filter(rendered)
              .map(
                (element) =>
                  `${element.localName}${element.id ? `#${element.id}` : ""}${[
                    ...element.classList,
                  ]
                    .sort()
                    .map((name) => `.${name}`)
                    .join("")}`,
              )
            .sort()
          : [],
        page_content_html: root?.innerHTML ?? null,
        attribute_signatures: pageContentElements
          .filter(rendered)
          .flatMap((element) =>
            [...(element.attributes ?? [])].map((attribute) => ({
              tag: element.localName,
              name: attribute.name,
              value: attribute.value,
            })),
          )
          .sort((left, right) =>
            JSON.stringify(left).localeCompare(JSON.stringify(right)),
          ),
        rendered_images: images.length,
        broken_images: images
          .filter((image) => !image.complete || image.naturalWidth <= 0)
          .map((image) => ({
            src: image.currentSrc || image.src,
            natural_width: image.naturalWidth,
            natural_height: image.naturalHeight,
          })),
        page_content_rendered_images: root
          ? [...root.querySelectorAll("img")].filter(rendered).length
          : 0,
        page_content_broken_images: root
          ? [...root.querySelectorAll("img")]
              .filter(
                (image) =>
                  rendered(image) &&
                  (!image.complete || image.naturalWidth <= 0),
              )
              .map((image) => ({
                src: image.currentSrc || image.src,
                natural_width: image.naturalWidth,
                natural_height: image.naturalHeight,
              }))
          : [],
        page_chrome_skeleton: pageChromeSkeleton,
        first_divergence_trace: firstDivergenceTrace,
      };
    },
    {
      geometrySelectors,
      presenceProbes,
      customPropertyNames,
      skeletonContract: skeleton,
      traceContract: firstDivergenceTrace,
      traceStyleProperties: FIRST_DIVERGENCE_STYLE_PROPERTIES,
      phase,
    },
  );
  for (const element of documentPhase.first_divergence_trace?.elements ?? []) {
    const normalizedText =
      element.direct_text_kind === "page_rating_score"
        ? "{{page-rating-score}}"
        : normalizeText(element.direct_text).text;
    element.direct_text_sha256 = createHash("sha256")
      .update(element.direct_text)
      .digest("hex");
    element.normalized_direct_text_sha256 = createHash("sha256")
      .update(normalizedText)
      .digest("hex");
    element.direct_text_normalized = normalizedText !== element.direct_text;
    if (element.direct_text_kind !== null) {
      element.direct_text_normalization = element.direct_text_kind;
      element.direct_text_observed = element.direct_text;
    }
    delete element.direct_text_kind;
    delete element.direct_text;
  }
  if (typeof documentPhase.page_content_html === "string") {
    documentPhase.dom_signature = domSignature(documentPhase.page_content_html);
  } else {
    documentPhase.dom_signature = null;
  }
  delete documentPhase.page_content_html;
  const pseudoLayouts = await capturePseudoLayouts(
    page,
    presenceProbes,
    viewport,
  );
  const requirements = new Map(
    presenceProbes.map((probe) => [probe.id, probe]),
  );
  for (const probe of documentPhase.presence_probes) {
    if (!probe.pseudo) continue;
    const requirement = requirements.get(probe.id);
    const layout = pseudoLayouts[probe.id] ?? {
      status: "capture_error",
      error: "pseudo layout was not returned",
    };
    probe.pseudo_layout = requirement?.pseudo_layout?.allow_css_box_fallback
      ? applyCssBoxFallback(layout, probe.rect, probe.style)
      : layout;
  }
  return documentPhase;
}

async function capturedScreenshot(filePath, fullPage) {
  if (!filePath) return null;
  const stat = await fs.lstat(filePath).catch(() => null);
  if (!stat?.isFile() || stat.isSymbolicLink()) return null;
  return {
    path: path.basename(filePath),
    sha256: await sha256File(filePath),
    full_page: fullPage,
  };
}

export async function prewarmBrowserParityLazyImages(page) {
  await page.evaluate(async () => {
    const initialScrollY = window.scrollY;
    for (const image of [...document.images]) {
      image.scrollIntoView({ block: "center", inline: "nearest" });
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    window.scrollTo({ left: 0, top: initialScrollY, behavior: "instant" });
  });
}

export async function prewarmBrowserParityFullPageRaster(page, viewport) {
  const step = Math.max(1, Math.floor(Number(viewport?.height ?? 0) * 0.75));
  if (!Number.isSafeInteger(step) || step < 1) {
    throw new Error("browser full-page raster prewarm requires a positive viewport height");
  }
  await page.evaluate(async (scrollStep) => {
    const initialX = window.scrollX;
    const initialY = window.scrollY;
    const frame = () =>
      new Promise((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(resolve)),
      );
    const maximumY = Math.max(
      0,
      Math.ceil(
        Math.max(
          document.documentElement.scrollHeight,
          document.body?.scrollHeight ?? 0,
        ) - window.innerHeight,
      ),
    );
    const positions = [];
    for (let y = 0; y < maximumY; y += scrollStep) positions.push(y);
    if (positions.at(-1) !== maximumY) positions.push(maximumY);
    for (const y of positions) {
      window.scrollTo({left: 0, top: y, behavior: "instant"});
      await frame();
    }
    window.scrollTo({left: initialX, top: initialY, behavior: "instant"});
    await frame();
  }, step);
}

export async function waitForBrowserParitySettledResources(page, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  const remaining = (label) => {
    const value = deadline - Date.now();
    if (value <= 0) throw new Error(`${label} exceeded the capture timeout`);
    return value;
  };
  let loadStatus = "complete";
  try {
    await page.waitForLoadState("load", {
      timeout: remaining("load completion"),
    });
  } catch (error) {
    if (error?.name !== "TimeoutError") throw error;
    loadStatus = "bounded_domcontentloaded";
  }
  if (loadStatus === "bounded_domcontentloaded") {
    return await page.evaluate((limit) => ({
      status: "bounded_domcontentloaded",
      load_ready_state: document.readyState,
      font_status: document.fonts?.status ?? "not_supported",
      image_count: document.images.length,
      incomplete_image_count: [...document.images].filter(
        (image) => !image.complete,
      ).length,
      load_timeout_ms: limit,
      pending_image_urls: [...document.images]
        .filter((image) => !image.complete)
        .map((image) => image.currentSrc || image.src)
        .sort(),
    }), timeoutMs);
  }
  return await page.evaluate(async (limit) => {
    const waitForImage = (image) => {
      if (image.complete) return Promise.resolve();
      return new Promise((resolve) => {
        let finished = false;
        const finish = () => {
          if (finished) return;
          finished = true;
          image.removeEventListener("load", finish);
          image.removeEventListener("error", finish);
          resolve();
        };
        image.addEventListener("load", finish, { once: true });
        image.addEventListener("error", finish, { once: true });
        if (image.complete) finish();
      });
    };
    let timeout = null;
    try {
      await Promise.race([
        Promise.all([
          Promise.resolve(document.fonts?.ready),
          ...[...document.images].map(waitForImage),
        ]),
        new Promise((_, reject) => {
          timeout = setTimeout(
            () => reject(new Error("font or image completion timed out")),
            limit,
          );
        }),
      ]);
    } finally {
      if (timeout !== null) clearTimeout(timeout);
    }
    const incompleteImages = [...document.images].filter(
      (image) => !image.complete,
    );
    if (incompleteImages.length > 0) {
      throw new Error("image completion remained incomplete after load");
    }
    return {
      status: "complete",
      load_ready_state: document.readyState,
      font_status: document.fonts?.status ?? "not_supported",
      image_count: document.images.length,
      incomplete_image_count: incompleteImages.length,
    };
  }, remaining("font and image completion"));
}

export async function waitForBrowserParityLayoutStable(
  page,
  {
    rootSelector = "#page-content",
    fallbackRootSelectors = [],
    stableFrames = 3,
    timeoutMs = 5_000,
    tolerancePx = 0.25,
  } = {},
) {
  if (typeof rootSelector !== "string" || rootSelector === "") {
    throw new Error("browser layout stability root selector is invalid");
  }
  if (
    !Array.isArray(fallbackRootSelectors) ||
    fallbackRootSelectors.some((selector) => typeof selector !== "string" || selector === "")
  ) {
    throw new Error("browser layout stability fallback root selectors are invalid");
  }
  const rootSelectors = [...new Set([rootSelector, ...fallbackRootSelectors, "body"])];
  if (!Number.isSafeInteger(stableFrames) || stableFrames < 1) {
    throw new Error("browser layout stability frame count is invalid");
  }
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error("browser layout stability timeout is invalid");
  }
  if (!Number.isFinite(tolerancePx) || tolerancePx < 0) {
    throw new Error("browser layout stability tolerance is invalid");
  }
  return await page.evaluate(
    async ({ rootSelectors: selectors, stableFrames: requiredStableFrames, timeoutMs: limit, tolerancePx: tolerance }) => {
      const selector = selectors.find((candidate) => document.querySelector(candidate));
      if (!selector) throw new Error(`browser layout stability root is missing: ${selectors.join(", ")}`);
      const root = document.querySelector(selector);
      const coordinates = (element) => {
        const box = element.getBoundingClientRect();
        return [
          box.x + window.scrollX,
          box.y + window.scrollY,
          box.width,
          box.height,
        ];
      };
      const sample = () => [root, ...root.querySelectorAll("*")].map(coordinates);
      const maxDelta = (left, right) => {
        if (left.length !== right.length) return Number.POSITIVE_INFINITY;
        let maximum = 0;
        for (let index = 0; index < left.length; index += 1) {
          for (let coordinate = 0; coordinate < 4; coordinate += 1) {
            maximum = Math.max(
              maximum,
              Math.abs(left[index][coordinate] - right[index][coordinate]),
            );
          }
        }
        return maximum;
      };
      const nextFrame = () => new Promise((resolve) => requestAnimationFrame(resolve));
      const startedAt = performance.now();
      let previous = sample();
      let stable = 0;
      let samples = 1;
      let observedMaximumDelta = 0;
      while (performance.now() - startedAt <= limit) {
        await nextFrame();
        const current = sample();
        samples += 1;
        const delta = maxDelta(previous, current);
        observedMaximumDelta = Math.max(observedMaximumDelta, delta);
        if (delta <= tolerance) stable += 1;
        else stable = 0;
        if (stable >= requiredStableFrames) {
          return {
            status: "stable",
            root_selector: selector,
            stable_frames: stable,
            samples,
            tolerance_px: tolerance,
            observed_maximum_delta_px: Number.isFinite(observedMaximumDelta)
              ? Math.round(observedMaximumDelta * 100) / 100
              : null,
          };
        }
        previous = current;
      }
      throw new Error(
        `browser layout did not stabilize within ${limit} ms for ${selector}`,
      );
    },
    { rootSelectors, stableFrames, timeoutMs, tolerancePx },
  );
}

export function isExpectedExternalAssetFailure(event) {
  if (event?.error !== "net::ERR_BLOCKED_BY_ORB" && event?.error !== "net::ERR_TIMED_OUT" && event?.error !== "net::ERR_TUNNEL_CONNECTION_FAILED") return false;
  try {
    const url = new URL(event.url);
    return (event.resource_type === "stylesheet" && url.hostname.endsWith(".wdfiles.com")) ||
      (event.resource_type === "other" && (url.hostname.endsWith(".wikidot.com") || url.hostname.endsWith(".wdfiles.com")) && url.pathname.startsWith("/local--favicon/") ||
        event.resource_type === "other" && url.hostname.endsWith(".wdfiles.com") && url.pathname.startsWith("/local--files/") && url.pathname.endsWith("/site/favicon.gif"));
  } catch { return false; }
}

export async function captureBrowserParityObservation({
  context,
  page: suppliedPage = null,
  url,
  label,
  index,
  outputDir,
  contract,
  viewport,
  timeoutMs,
  settleMs,
  requestGateAttribution = null,
  onPhase = null,
  navigate = null,
  resetSuppliedPage = true,
}) {
  if (onPhase !== null && typeof onPhase !== "function") {
    throw new Error("browser observation phase callback must be a function");
  }
  if (navigate !== null && typeof navigate !== "function") {
    throw new Error("browser observation navigation callback must be a function");
  }
  if (
    requestGateAttribution !== null &&
    typeof requestGateAttribution?.classifyRequestFailure !== "function"
  ) {
    throw new Error("browser request-gate attribution is malformed");
  }
  const page = suppliedPage ?? (await context.newPage());
  const ownsPage = suppliedPage === null;
  if (!ownsPage && resetSuppliedPage) {
    await page.evaluate(() => {
      window.stop();
      window.name = "";
      try {
        window.sessionStorage.clear();
      } catch (error) {
        if (error?.name !== "SecurityError") throw error;
      }
    });
    await page.goto("about:blank", {waitUntil: "commit", timeout: timeoutMs});
  }
  const failures = [];
  const expectedFailures = [];
  const requestGateAborts = [];
  const onRequestFailed = (request) => {
    const attribution =
      requestGateAttribution?.classifyRequestFailure(request) ?? null;
    const event = {
      kind: attribution === null ? "request_failed" : "request_gate_abort",
      url: request.url(),
      resource_type: request.resourceType(),
      error: request.failure()?.errorText ?? "request failed",
      ...(attribution ?? {}),
    };
    if (attribution === null && isExpectedExternalAssetFailure(event)) expectedFailures.push(event);
    else (attribution === null ? failures : requestGateAborts).push(event);
  };
  const onResponse = (response) => {
    if (response.status() >= 400) {
      failures.push({
        kind: "http_error",
        url: response.url(),
        resource_type: response.request().resourceType(),
        status: response.status(),
      });
    }
  };
  page.on("requestfailed", onRequestFailed);
  page.on("response", onResponse);
  const capturedAt = new Date().toISOString();
  let navigationStatus = 0;
  let firstDocument = null;
  let document = null;
  const firstPath = path.join(
    outputDir,
    observationArtifactName({
      label,
      index,
      url,
      phase: "domcontentloaded-immediate",
    }),
  );
  const viewportPath = path.join(
    outputDir,
    observationArtifactName({ label, index, url, phase: "settled-viewport" }),
  );
  const fullPagePath = path.join(
    outputDir,
    observationArtifactName({ label, index, url, phase: "settled-full-page" }),
  );
  try {
    await onPhase?.("domcontentloaded_immediate_observation");
    const navigation = navigate === null
      ? await page.goto(url, { waitUntil: "domcontentloaded", timeout: timeoutMs })
      : await navigate({ page, url, timeoutMs });
    navigationStatus = typeof navigation?.status === "function" ? navigation.status() : navigation?.status ?? 0;
    firstDocument = await captureDocumentObservation(page, {
      contract,
      phase: "domcontentloaded_immediate_observation",
      viewport,
    });
    await capturePng(page, firstPath);
    await onPhase?.("settled");
    if (settleMs > 0) await page.waitForTimeout(settleMs);
    await prewarmBrowserParityLazyImages(page);
    const resourceCompletion = await waitForBrowserParitySettledResources(page, timeoutMs);
    const layoutStability = await waitForBrowserParityLayoutStable(page, {
      fallbackRootSelectors: contract?.geometry_selectors ?? [],
    });
    document = await captureDocumentObservation(page, {
      contract,
      phase: "settled",
      viewport,
    });
    document.resource_completion = resourceCompletion;
    document.layout_stability = layoutStability;
    await capturePng(page, viewportPath);
    // Chromium's captureBeyondViewport path can otherwise race compositor
    // rasterization for off-screen tiles even after DOM/layout stability. The
    // visible viewport remains identical while a full-page screenshot may
    // sporadically contain stale lower-page tiles. Paint every viewport-sized
    // region first so the visual oracle measures page state, not compositor
    // cache timing.
    await prewarmBrowserParityFullPageRaster(page, viewport);
    await capturePng(page, fullPagePath, { fullPage: true });
    failures.sort((left, right) =>
      failureKey(left).localeCompare(failureKey(right)),
    );
    requestGateAborts.sort((left, right) =>
      failureKey(left).localeCompare(failureKey(right)),
    );
    return {
      schema: STANDING_BROWSER_CAPTURE_SCHEMA,
      captured_at: capturedAt,
      input_url: url,
      final_url: page.url(),
      navigation_status: navigationStatus,
      canary: contract
        ? { slug: contract.slug, theme_family: contract.theme_family }
        : null,
      failures,
      expected_failures: expectedFailures,
      request_gate_aborts: requestGateAborts,
      first_paint: {
        document: firstDocument,
        screenshot: await capturedScreenshot(firstPath, false),
      },
      document,
      geometry: document.geometry,
      page_chrome_skeleton: document.page_chrome_skeleton,
      dom_signature: document.dom_signature,
      attribute_signatures: document.attribute_signatures,
      dom_signatures: document.dom_signatures,
      rendered_images: document.rendered_images,
      broken_images: document.broken_images,
      settled_viewport_screenshot: await capturedScreenshot(
        viewportPath,
        false,
      ),
      screenshot: await capturedScreenshot(fullPagePath, true),
    };
  } catch (error) {
    const partial = document ?? {
      geometry: {},
      presence_probes: [],
      custom_properties: {},
      dom_signatures: [],
      page_chrome_skeleton: null,
      dom_signature: null,
      attribute_signatures: [],
      rendered_images: 0,
      broken_images: [],
    };
    failures.sort((left, right) =>
      failureKey(left).localeCompare(failureKey(right)),
    );
    requestGateAborts.sort((left, right) =>
      failureKey(left).localeCompare(failureKey(right)),
    );
    return {
      schema: STANDING_BROWSER_CAPTURE_SCHEMA,
      captured_at: capturedAt,
      input_url: url,
      final_url: page.url() || null,
      navigation_status: navigationStatus,
      canary: contract
        ? { slug: contract.slug, theme_family: contract.theme_family }
        : null,
      failures,
      expected_failures: expectedFailures,
      request_gate_aborts: requestGateAborts,
      first_paint:
        firstDocument || (await capturedScreenshot(firstPath, false))
          ? {
              document: firstDocument,
              screenshot: await capturedScreenshot(firstPath, false),
            }
          : null,
      document: partial,
      geometry: partial.geometry,
      dom_signatures: partial.dom_signatures,
      page_chrome_skeleton: partial.page_chrome_skeleton,
      dom_signature: partial.dom_signature,
      attribute_signatures: partial.attribute_signatures,
      rendered_images: partial.rendered_images,
      broken_images: partial.broken_images,
      settled_viewport_screenshot: await capturedScreenshot(
        viewportPath,
        false,
      ),
      screenshot: await capturedScreenshot(fullPagePath, true),
      capture_error: { name: error.name, message: error.message },
    };
  } finally {
    page.off("requestfailed", onRequestFailed);
    page.off("response", onResponse);
    if (ownsPage) {
      await page.close({runBeforeUnload: false, timeout: 10_000}).catch(() => undefined);
    }
  }
}
