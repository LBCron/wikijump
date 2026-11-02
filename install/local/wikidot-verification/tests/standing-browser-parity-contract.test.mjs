import assert from "node:assert/strict";
import test from "node:test";

import { canaryForUrl } from "../src/standing-browser-canaries.mjs";
import {
  DEFAULT_THRESHOLDS,
  compareAttributeSignatures,
  compareCaptures,
  evaluateFirstPaintCustomProperties,
  validateLiveCompletionPolicy,
} from "../src/standing-browser-parity-contract.mjs";

function capture(overrides = {}) {
  return {
    input_url: "https://scp-wiki.wikijump.localhost:18443/scp-9506",
    final_url: "https://scp-wiki.wikijump.localhost:18443/scp-9506",
    navigation_status: 200,
    failures: [],
    request_gate_aborts: [],
    geometry: {
      "#main-content": {
        count: 1,
        rect: { x: 100, y: 80, width: 900, height: 1200 },
      },
    },
    rendered_images: 2,
    broken_images: [],
    dom_signatures: ["div.block", "img.hero"],
    first_paint: {
      document: { geometry: {}, presence_probes: [], custom_properties: {} },
    },
    document: { presence_probes: [] },
    ...overrides,
  };
}

test("a candidate-only request-gate abort remains a parity failure", () => {
  const gateAbort = {
    kind: "request_gate_abort",
    url: "https://cdn.example.test/local-only.js",
    resource_type: "script",
    error: "net::ERR_BLOCKED_BY_CLIENT.Inspector",
    decision: "unsupported_public_origin_resource_type",
    abort_reason: "blockedbyclient",
  };
  const local = capture({ request_gate_aborts: [gateAbort] });
  const live = capture({
    input_url: "https://scp-wiki.wikidot.com/scp-9506",
    final_url: "https://scp-wiki.wikidot.com/scp-9506",
  });

  const result = compareCaptures(local, live, DEFAULT_THRESHOLDS, [], null);

  assert.equal(result.status, "fail");
  assert.deepEqual(result.classified_request_gate_aborts, [
    { ...gateAbort, classification: "local_only" },
  ]);
  assert.ok(
    result.anomalies.some(
      (anomaly) => anomaly.code === "local_only_request_gate_abort",
    ),
  );
});

test("request-gate parity does not depend on Chromium error suffix text", () => {
  const common = {
    kind: "request_gate_abort",
    url: "https://cdn.example.test/shared.js",
    resource_type: "script",
    decision: "unsupported_public_origin_resource_type",
    abort_reason: "blockedbyclient",
  };
  const local = capture({
    request_gate_aborts: [
      { ...common, error: "net::ERR_BLOCKED_BY_CLIENT.Inspector" },
    ],
  });
  const live = capture({
    input_url: "https://scp-wiki.wikidot.com/scp-9506",
    final_url: "https://scp-wiki.wikidot.com/scp-9506",
    request_gate_aborts: [
      { ...common, error: "net::ERR_BLOCKED_BY_CLIENT" },
    ],
  });

  const result = compareCaptures(local, live, DEFAULT_THRESHOLDS, [], null);

  assert.equal(result.status, "pass");
  assert.equal(
    result.classified_request_gate_aborts[0].classification,
    "parity_matched",
  );
});

test("external request-failure parity ignores browser-specific error text", () => {
  const local = capture({
    failures: [{ kind: "request_failed", url: "https://cdn.example.test/font.css", resource_type: "stylesheet", error: "net::ERR_ABORTED" }],
  });
  const live = capture({
    input_url: "https://scp-wiki.wikidot.com/scp-9506",
    final_url: "https://scp-wiki.wikidot.com/scp-9506",
    failures: [{ kind: "request_failed", url: "https://cdn.example.test/font.css", resource_type: "stylesheet", error: "net::ERR_BLOCKED_BY_ORB" }],
  });
  const result = compareCaptures(local, live, DEFAULT_THRESHOLDS, [], null);
  assert.equal(result.status, "pass");
  assert.equal(result.classified_failures[0].classification, "parity_matched");
});

test("standing chrome scope delegates page-body geometry and DOM distance", () => {
  const geometry = {
    "#header": { count: 1, rect: { x: 0, y: 0, width: 1, height: 1 } },
    "#header h1 a": { count: 1, rect: { x: 0, y: 0, width: 1, height: 1 } },
  };
  const result = compareCaptures(
    capture({ geometry, dom_signatures: ["div"] }),
    capture({
      input_url: "https://scp-wiki.wikidot.com/scp-9506",
      final_url: "https://scp-wiki.wikidot.com/scp-9506",
      geometry,
      dom_signatures: ["span", "span", "span", "span"],
    }),
    DEFAULT_THRESHOLDS,
    [],
    { comparison_scope: "standing-chrome", first_paint_geometry_selectors: [] },
  );
  assert.equal(result.status, "pass");
  assert.deepEqual(result.geometry, [
    { selector: "#header", status: "pass", local: geometry["#header"].rect, live: geometry["#header"].rect, delta: { x: 0, y: 0, width: 0, height: 0 } },
    { selector: "#header h1 a", status: "pass", local: geometry["#header h1 a"].rect, live: geometry["#header h1 a"].rect, delta: { x: 0, y: 0, width: 0, height: 0 } },
  ]);
  assert.equal(result.dom_multiset_distance.ratio, 1);
});

test("standing chrome scope ignores page-body attributes", () => {
  const geometry = {
    "#header": { count: 1, rect: { x: 0, y: 0, width: 1, height: 1 } },
    "#header h1 a": { count: 1, rect: { x: 0, y: 0, width: 1, height: 1 } },
  };
  const result = compareCaptures(
    capture({ geometry, attribute_signatures: [{ tag: "img", name: "src", value: "/local.png" }] }),
    capture({ geometry, input_url: "https://scp-wiki.wikidot.com/scp-9506", final_url: "https://scp-wiki.wikidot.com/scp-9506", attribute_signatures: [{ tag: "img", name: "src", value: "/live.png" }] }),
    DEFAULT_THRESHOLDS,
    [],
    { comparison_scope: "standing-chrome", first_paint_geometry_selectors: [] },
  );
  assert.equal(result.status, "pass");
  assert.equal(result.attributes.status, "pass");
});

test("immediate theme properties fail before a settled state can conceal a flash", () => {
  const expectations = canaryForUrl(
    "https://scp-wiki.wikidot.com/scp-9506",
  ).first_paint_custom_properties;
  const passing = evaluateFirstPaintCustomProperties(
    {
      "--logo":
        "url(https://scp-wiki.wjfiles.localhost/local--files/scp-9506/NFSI.png)",
      "--header-logo":
        "url(https://scp-wiki.wjfiles.localhost/local--files/scp-9506/NFSI.png)",
      "--header-title": '"NFSI"',
      "--header-subtitle": '"National Fog Safety Initiative"',
    },
    expectations,
  );
  assert.equal(passing.status, "pass");
  const failing = evaluateFirstPaintCustomProperties(
    {
      "--logo": "",
      "--header-logo": "",
      "--header-title": '"NFSI"',
      "--header-subtitle": '"National Fog Safety Initiative"',
    },
    expectations,
  );
  assert.equal(failing.status, "fail");
});

test("DOMContentLoaded selector geometry is independently blocking", () => {
  const contract = {
    geometry_selectors: ["#main-content"],
    first_paint_geometry_selectors: ["#main-content"],
    presence_probes: [],
    first_paint_custom_properties: {},
  };
  const local = capture({
    first_paint: {
      document: {
        geometry: {
          "#main-content": {
            count: 1,
            rect: { x: 120, y: 80, width: 900, height: 1200 },
          },
        },
        presence_probes: [],
        custom_properties: {},
      },
    },
  });
  const live = capture({
    input_url: "https://scp-wiki.wikidot.com/scp-9506",
    final_url: "https://scp-wiki.wikidot.com/scp-9506",
    first_paint: {
      document: {
        geometry: {
          "#main-content": {
            count: 1,
            rect: { x: 100, y: 80, width: 900, height: 1200 },
          },
        },
        presence_probes: [],
        custom_properties: {},
      },
    },
  });
  const result = compareCaptures(local, live, DEFAULT_THRESHOLDS, [], contract);
  assert.equal(result.status, "fail");
  assert.ok(
    result.anomalies.some(
      (anomaly) =>
        anomaly.code ===
        "domcontentloaded_immediate_selector_geometry_divergence",
    ),
  );
  assert.equal(result.geometry[0].status, "pass");
});

test("public geometry comparison rejects over-threshold raw height but accepts the boundary", () => {
  const trace = (height) => ({
    root_selector: "#page-content",
    element_count: 1,
    captured_count: 1,
    truncated: false,
    incomplete_image_count: 0,
    elements: [{
      path: "p[1]",
      tag: "p",
      id: null,
      classes: [],
      direct_text_sha256: "same",
      child_element_count: 0,
      rect: { x: 0, y: 0, width: 100, height },
      style: { display: "block" },
    }],
  });
  const contract = {
    geometry_selectors: ["#page-content"],
    first_paint_geometry_selectors: [],
    presence_probes: [],
    first_paint_custom_properties: {},
    first_divergence_trace: { root_selector: "#page-content", max_elements: 10 },
  };
  const live = capture({
    geometry: {
      "#page-content": {
        count: 1,
        rect: { x: 0, y: 0, width: 100, height: 1000 },
      },
    },
    document: { presence_probes: [], first_divergence_trace: trace(1000) },
  });
  const over = compareCaptures(
    capture({
      geometry: {
        "#page-content": {
          count: 1,
          rect: { x: 0, y: 0, width: 100, height: 1012.004 },
        },
      },
      document: { presence_probes: [], first_divergence_trace: trace(1012.004) },
    }),
    live,
    DEFAULT_THRESHOLDS,
    [],
    contract,
  );
  assert.equal(over.status, "fail");
  assert.equal(over.geometry[0].delta.height, 12);
  assert.equal(over.geometry[0].status, "fail");
  assert.equal(over.settled_first_divergent_element.kind, "geometry_divergence");
  assert.equal(over.settled_first_divergent_element.geometry_delta.height, 12);
  const boundary = compareCaptures(
    capture({
      geometry: {
        "#page-content": {
          count: 1,
          rect: { x: 0, y: 0, width: 100, height: 1012 },
        },
      },
      document: { presence_probes: [], first_divergence_trace: trace(1012) },
    }),
    live,
    DEFAULT_THRESHOLDS,
    [],
    contract,
  );
  assert.equal(boundary.status, "pass");
  assert.equal(boundary.geometry[0].status, "pass");
  assert.equal(boundary.settled_first_divergent_element.kind, "none");
});

test("settled page geometry is not reused as DOMContentLoaded geometry", () => {
  const contract = {
    geometry_selectors: ["#main-content"],
    first_paint_geometry_selectors: ["#header"],
    presence_probes: [],
    first_paint_custom_properties: {},
  };
  const local = capture({
    first_paint: {
      document: {
        geometry: {
          "#main-content": {
            count: 1,
            rect: { x: 100, y: 80, width: 900, height: 2400 },
          },
          "#header": {
            count: 1,
            rect: { x: 0, y: 0, width: 1366, height: 60 },
          },
        },
        presence_probes: [],
        custom_properties: {},
      },
    },
  });
  const live = capture({
    input_url: "https://scp-wiki.wikidot.com/scp-9506",
    final_url: "https://scp-wiki.wikidot.com/scp-9506",
    first_paint: {
      document: {
        geometry: {
          "#main-content": {
            count: 1,
            rect: { x: 100, y: 80, width: 900, height: 1200 },
          },
          "#header": {
            count: 1,
            rect: { x: 0, y: 0, width: 1366, height: 60 },
          },
        },
        presence_probes: [],
        custom_properties: {},
      },
    },
  });
  const result = compareCaptures(local, live, DEFAULT_THRESHOLDS, [], contract);
  assert.equal(result.status, "pass");
  assert.deepEqual(
    result.domcontentloaded_immediate_geometry.map(({ selector }) => selector),
    ["#header"],
  );
});

test("ordered first-divergence diagnostics do not change parity thresholds", () => {
  const contract = {
    geometry_selectors: ["#main-content"],
    first_paint_geometry_selectors: [],
    presence_probes: [],
    first_paint_custom_properties: {},
    first_divergence_trace: {
      root_selector: "#page-content",
      max_elements: 10_000,
    },
  };
  const trace = (fontSize) => ({
    root_selector: "#page-content",
    element_count: 1,
    captured_count: 1,
    truncated: false,
    incomplete_image_count: 0,
    elements: [
      {
        path: "p[1]",
        tag: "p",
        id: null,
        classes: [],
        direct_text_sha256: "same",
        rect: { x: 0, y: 0, width: 100, height: 20 },
        style: { "font-size": fontSize },
      },
    ],
  });
  const local = capture({
    first_paint: {
      document: {
        geometry: {},
        presence_probes: [],
        custom_properties: {},
        first_divergence_trace: trace("18px"),
      },
    },
    document: {
      presence_probes: [],
      first_divergence_trace: trace("18px"),
    },
  });
  const live = capture({
    input_url: "https://scp-wiki.wikidot.com/scp-9506",
    final_url: "https://scp-wiki.wikidot.com/scp-9506",
    first_paint: {
      document: {
        geometry: {},
        presence_probes: [],
        custom_properties: {},
        first_divergence_trace: trace("16px"),
      },
    },
    document: {
      presence_probes: [],
      first_divergence_trace: trace("16px"),
    },
  });
  const result = compareCaptures(local, live, DEFAULT_THRESHOLDS, [], contract);
  assert.equal(result.status, "pass");
  assert.equal(
    result.domcontentloaded_immediate_first_divergent_element.kind,
    "style_divergence",
  );
  assert.equal(result.settled_first_divergent_element.kind, "style_divergence");
  assert.equal(
    result.anomalies.some((anomaly) =>
      anomaly.code.includes("first_divergent_element"),
    ),
    false,
  );
});

test("page-chrome skeleton deletion is a blocking parity regression", () => {
  const contract = {
    geometry_selectors: ["#main-content"],
    first_paint_geometry_selectors: [],
    presence_probes: [],
    first_paint_custom_properties: {},
    page_chrome_skeleton: {
      links: [
        { parent: "body", child: "#skrollr-body" },
        { parent: "#skrollr-body", child: "#container-wrap-wrap" },
        { parent: "#container-wrap-wrap", child: "#container-wrap" },
        { parent: "#container-wrap", child: "#container" },
        { parent: "#container", child: "#header" },
        { parent: "#header", child: "#top-bar" },
      ],
    },
  };
  const live = capture({
    page_chrome_skeleton: {
      links: contract.page_chrome_skeleton.links.map((link) => ({
        ...link,
        parent_count: 1,
        child_count: 1,
        direct_child_count: 1,
      })),
    },
  });
  const local = capture({
    page_chrome_skeleton: {
      links: contract.page_chrome_skeleton.links.map((link, index) => ({
        ...link,
        parent_count: 1,
        child_count: index === 2 ? 0 : 1,
        direct_child_count: index === 2 ? 0 : 1,
      })),
    },
  });
  const result = compareCaptures(local, live, DEFAULT_THRESHOLDS, [], contract);
  assert.equal(result.status, "fail");
  assert.equal(local.page_chrome_skeleton.links[3].child_count, 1);
  assert.ok(
    result.anomalies.some(
      (anomaly) => anomaly.code === "page_chrome_skeleton_divergence",
    ),
  );
});

test("volatile attribute normalization is a finding rather than a silent pass", () => {
  const result = compareAttributeSignatures(
    [{ tag: "form", name: "data-page-id", value: "123" }],
    [{ tag: "form", name: "data-page-id", value: "456" }],
  );
  assert.equal(result.status, "fail");
  assert.ok(
    result.anomalies.some(
      (anomaly) => anomaly.code === "normalization_hides_difference",
    ),
  );
});

test("tabview instance identities normalize only the live 32-hex shape", () => {
  const live = capture({
    dom_signatures: [
      "div#wiki-tabview-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.yui-navset",
    ],
    attribute_signatures: [
      {
        tag: "div",
        name: "id",
        value: "wiki-tabview-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      },
    ],
  });
  const local = capture({
    dom_signatures: [
      "div#wiki-tabview-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb.yui-navset",
    ],
    attribute_signatures: [
      {
        tag: "div",
        name: "id",
        value: "wiki-tabview-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      },
    ],
  });
  const result = compareCaptures(local, live, DEFAULT_THRESHOLDS, [], {
    comparison_scope: "construct",
    geometry_selectors: [],
    first_paint_geometry_selectors: [],
    presence_probes: [],
    first_paint_custom_properties: {},
  });
  assert.equal(result.status, "pass");
  assert.equal(result.dom_multiset_distance.different_elements, 0);
  assert.equal(result.dom_signature_normalization.events.length, 2);
  assert.equal(result.attributes.status, "pass");
});

test("tabview identity normalization requires a tabview root", () => {
  const id = (value) => `wiki-tabview-${value.repeat(32)}`;
  const result = compareCaptures(
    capture({
      dom_signatures: [`span#${id("a")}`],
      attribute_signatures: [{ tag: "span", name: "id", value: id("a") }],
    }),
    capture({
      dom_signatures: [`span#${id("b")}`],
      attribute_signatures: [{ tag: "span", name: "id", value: id("b") }],
    }),
    DEFAULT_THRESHOLDS,
    [],
    {
      comparison_scope: "construct",
      geometry_selectors: [],
      first_paint_geometry_selectors: [],
      presence_probes: [],
      first_paint_custom_properties: {},
    },
  );
  assert.equal(result.status, "fail");
  assert.ok(result.anomalies.some((anomaly) => anomaly.code === "normalization_hides_difference"));
});

test("tabview normalization remains fail-closed for malformed identities", () => {
  const result = compareCaptures(
    capture({
      dom_signatures: ["div#wiki-tabview-not-a-tabview-id.yui-navset"],
    }),
    capture({
      dom_signatures: [
        "div#wiki-tabview-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.yui-navset",
      ],
    }),
    DEFAULT_THRESHOLDS,
    [],
    {
      comparison_scope: "construct",
      geometry_selectors: [],
      first_paint_geometry_selectors: [],
      presence_probes: [],
      first_paint_custom_properties: {},
    },
  );
  assert.equal(result.status, "fail");
  assert.ok(
    result.anomalies.some(
      (anomaly) => anomaly.code === "dom_structure_divergence",
    ),
  );
});

test("SCP file asset host localization is equivalent across live and local captures", () => {
  const result = compareAttributeSignatures(
    [{
      tag: "img",
      name: "src",
      value: "https://scp-wiki.wjfiles.localhost/local--files/scp-9506/NFSI.png",
    }],
    [{
      tag: "img",
      name: "src",
      value: "https://scp-wiki.wdfiles.com/local--files/scp-9506/NFSI.png",
    }],
  );
  assert.equal(result.status, "pass");
  assert.deepEqual(result.anomalies, []);
  assert.equal(result.normalization_events.length, 1);
  assert.equal(
    result.normalization_events[0].code,
    "environment_identity_translation",
  );
  assert.deepEqual(result.normalization_events[0].detail.pairs, [
    {
      tag: "img",
      name: "src",
      local: {
        hostname: "scp-wiki.wjfiles.localhost",
        identity: "{{site-files-host}}",
      },
      live: {
        hostname: "scp-wiki.wdfiles.com",
        identity: "{{site-files-host}}",
      },
    },
  ]);
});

test("unrelated hosts do not enter the environment identity translation", () => {
  const result = compareAttributeSignatures(
    [{tag: "img", name: "src", value: "https://scp-wiki.wjfiles.localhost/a.png"}],
    [{tag: "img", name: "src", value: "https://cdn.example.test/a.png"}],
  );
  assert.equal(result.status, "fail");
  assert.equal(result.normalization_events.length, 0);
  assert.equal(result.anomalies[0].code, "attribute_divergence");
});

test("volatile normalization remains a finding beside a host translation", () => {
  const result = compareAttributeSignatures(
    [
      {tag: "img", name: "src", value: "https://scp-wiki.wjfiles.localhost/a.png"},
      {tag: "div", name: "data-page-id", value: "local-page"},
    ],
    [
      {tag: "img", name: "src", value: "https://scp-wiki.wdfiles.com/a.png"},
      {tag: "div", name: "data-page-id", value: "live-page"},
    ],
  );
  assert.equal(result.status, "fail");
  assert.equal(result.normalization_events.length, 0);
  assert.equal(result.anomalies[0].code, "normalization_hides_difference");
});

test("host translation does not mask a second attribute normalization channel", () => {
  const result = compareAttributeSignatures(
    [{tag: "img", name: "src", value: "https://scp-wiki.wjfiles.localhost/a.png?v=local"}],
    [{tag: "img", name: "src", value: "https://scp-wiki.wdfiles.com/a.png?v=live"}],
  );
  assert.equal(result.status, "fail");
  assert.deepEqual(result.normalization_events, []);
  assert.equal(result.anomalies[0].code, "normalization_hides_difference");
});

test("completion policy is sealed and names exact external failures", () => {
  const policy = validateLiveCompletionPolicy({
    schema: "wikijump.standing_browser_live_completion_policy.v1",
    status: "sealed",
    policy_version: "2026-07-20.1",
    allowed_external_failures: [
      {
        kind: "http_error",
        url: "https://cdn.example/advert.css",
        resource_type: "stylesheet",
        status: 404,
      },
    ],
  });
  assert.equal(policy.status, "sealed");
  assert.throws(
    () =>
      validateLiveCompletionPolicy({
        schema: "wikijump.standing_browser_live_completion_policy.v1",
        status: "sealed",
        policy_version: "2026-07-20.1",
        allowed_external_failures: [{ url: "https://cdn.example/advert.css" }],
      }),
    /kind/u,
  );
});

test("an unretained avatar abort is an evidence gap, not a parity failure", () => {
  const gateAbort = {
    kind: "request_gate_abort",
    url: "https://www.wikidot.com/avatar.php?userid=5525011&amp;amp;size=small&amp;amp;timestamp=1793525364",
    resource_type: "image",
    error: "net::ERR_BLOCKED_BY_CLIENT.Inspector",
    decision: "unretained_avatar_image",
    abort_reason: "blockedbyclient",
  };
  const local = capture({ request_gate_aborts: [gateAbort] });
  const live = capture({
    input_url: "https://scp-wiki.wikidot.com/scp-9506",
    final_url: "https://scp-wiki.wikidot.com/scp-9506",
  });

  const result = compareCaptures(local, live, DEFAULT_THRESHOLDS, [], null);

  assert.equal(result.status, "pass");
  assert.deepEqual(result.classified_request_gate_aborts, [
    { ...gateAbort, classification: "parity_matched" },
  ]);
});

test("the unretained avatar classification requires an avatar URL", () => {
  const gateAbort = {
    kind: "request_gate_abort",
    url: "https://cdn.example.test/local-only.png",
    resource_type: "image",
    error: "net::ERR_BLOCKED_BY_CLIENT.Inspector",
    decision: "unretained_avatar_image",
    abort_reason: "blockedbyclient",
  };
  const local = capture({ request_gate_aborts: [gateAbort] });
  const live = capture({
    input_url: "https://scp-wiki.wikidot.com/scp-9506",
    final_url: "https://scp-wiki.wikidot.com/scp-9506",
  });

  const result = compareCaptures(local, live, DEFAULT_THRESHOLDS, [], null);

  assert.equal(result.status, "fail");
  assert.deepEqual(result.classified_request_gate_aborts, [
    { ...gateAbort, classification: "local_only" },
  ]);
  assert.ok(
    result.anomalies.some(
      (anomaly) => anomaly.code === "local_only_request_gate_abort",
    ),
  );
});
