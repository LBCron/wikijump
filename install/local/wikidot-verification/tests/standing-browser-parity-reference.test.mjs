import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { canaryForUrl } from "../src/standing-browser-canaries.mjs";
import {
  buildLiveReferenceLedger,
  loadLiveReference,
} from "../src/standing-browser-parity-reference.mjs";

const viewport = { width: 1366, height: 900 };
const thresholds = {
  geometry_position_px: 8,
  geometry_size_px: 12,
  image_count_delta: 0,
  dom_multiset_distance_ratio: 0.15,
};

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function screenshotArtifacts(directory) {
  const entries = [
    ["first.png", "first", false],
    ["viewport.png", "viewport", false],
    ["full.png", "full", true],
  ];
  await Promise.all(
    entries.map(([file, contents]) =>
      fs.writeFile(path.join(directory, file), contents),
    ),
  );
  return Object.fromEntries(
    entries.map(([file, contents, fullPage]) => [
      file,
      { path: file, sha256: sha256(contents), full_page: fullPage },
    ]),
  );
}

function policy() {
  return {
    schema: "wikijump.standing_browser_live_completion_policy.v1",
    policy_version: "2026-07-20.1",
    allowed_external_failures: [],
  };
}

function requestGate() {
  return {
    schema: "wikijump_full_parity.browser_request_gate.v1",
    interval_ms: 4_000,
    enforcement_failed: false,
    public_requests: 1,
    unsupported_requests_blocked: 0,
  };
}

function probesFor(pair) {
  return canaryForUrl(pair.live_url).presence_probes.map((requirement) => {
    const pseudoLayout = requirement.pseudo_layout
      ? {
          status: "captured",
          node_present: true,
          layout_present: true,
          painted_bounds: { x: 0, y: 0, width: 100, height: 20 },
          visible_bounds: { x: 0, y: 0, width: 100, height: 20 },
          visible_area_ratio: 1,
          descendant_text: requirement.pseudo_layout.require_descendant_text
            ? "generated text"
            : "",
          computed_style: {
            content: requirement.pseudo_layout.require_generated_content
              ? '"generated text"'
              : "none",
            "background-image": requirement.pseudo_layout
              .require_background_image
              ? "url(https://cdn.example/logo.png)"
              : "none",
          },
        }
      : undefined;
    return {
      id: requirement.id,
      selector: requirement.selector,
      pseudo: requirement.pseudo ?? null,
      count: requirement.minimum_count ?? 1,
      rendered_count: requirement.require_rendered
        ? (requirement.minimum_count ?? 1)
        : 0,
      style: {
        content: pseudoLayout?.computed_style.content,
        "background-image": pseudoLayout?.computed_style["background-image"],
      },
      ...(pseudoLayout ? { pseudo_layout: pseudoLayout } : {}),
    };
  });
}

function capture(pair, artifacts, overrides = {}) {
  const probes = probesFor(pair);
  return {
    schema: "wikijump_local_lab.standing_browser_parity_capture.v2",
    captured_at: "2026-07-20T00:00:00.000Z",
    input_url: pair.live_url,
    final_url: pair.live_url,
    navigation_status: 200,
    failures: [],
    request_gate_aborts: [],
    broken_images: [],
    first_paint: {
      document: {
        phase: "domcontentloaded_immediate_observation",
        custom_properties: {},
        presence_probes: probes,
        geometry: {},
      },
      screenshot: artifacts["first.png"],
    },
    document: {
      phase: "settled",
      presence_probes: probes,
      geometry: {},
      resource_completion: {
        status: "complete",
        load_ready_state: "complete",
        font_status: "loaded",
        image_count: 0,
        incomplete_image_count: 0,
      },
    },
    settled_viewport_screenshot: artifacts["viewport.png"],
    screenshot: artifacts["full.png"],
    ...overrides,
  };
}

test("live-reference sealing rejects an unrecognized request-gate attribution", async (context) => {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "standing-browser-live-reference-"),
  );
  context.after(() => fs.rm(directory, { recursive: true, force: true }));
  const pair = {
    local_url: "https://scp-wiki.wikijump.localhost:18443/scp-9506",
    live_url: "https://scp-wiki.wikidot.com/scp-9506",
  };
  const artifacts = await screenshotArtifacts(directory);
  const live = capture(pair, artifacts, {
    request_gate_aborts: [
      {
        kind: "request_gate_abort",
        url: "https://cdn.example.test/blocked.js",
        resource_type: "script",
        error: "net::ERR_BLOCKED_BY_CLIENT.Inspector",
        decision: "guessed_from_error_text",
        abort_reason: "blockedbyclient",
      },
    ],
  });

  assert.throws(
    () =>
      buildLiveReferenceLedger({
        records: [{ input: pair, live }],
        viewport,
        thresholds,
        policy: policy(),
        browserEnvironment: {
          engine: "chromium",
          version: "fixture",
        },
        requestGate: { ...requestGate(), unsupported_requests_blocked: 1 },
      }),
    /request-gate abort decision/u,
  );
});

async function writeReference(directory, pair, live, rawPolicy = policy(), requestGateValue = requestGate()) {
  const policyFile = path.join(directory, "completion-policy.json");
  await fs.writeFile(policyFile, `${JSON.stringify(rawPolicy)}\n`, {
    mode: 0o600,
  });
  const reference = buildLiveReferenceLedger({
    records: [{ input: pair, live }],
    viewport,
    thresholds,
    policy: rawPolicy,
    browserEnvironment: {
      engine: "chromium",
      version: "fixture",
    },
    requestGate: requestGateValue,
    generatedAt: "2026-07-20T00:00:00.000Z",
  });
  const file = path.join(directory, "standing-browser-live-reference.json");
  await fs.writeFile(file, `${JSON.stringify(reference)}\n`, { mode: 0o600 });
  return {
    file,
    policyFile,
    policy: rawPolicy,
  };
}

test("a live reference loads for a candidate port", async (context) => {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "standing-browser-live-reference-"),
  );
  context.after(() => fs.rm(directory, { recursive: true, force: true }));
  const pair = {
    local_url: "https://scp-wiki.wikijump.localhost:18443/theme:basalt",
    live_url: "https://scp-wiki.wikidot.com/theme:basalt",
  };
  const artifacts = await screenshotArtifacts(directory);
  const stored = await writeReference(
    directory,
    pair,
    capture(pair, artifacts),
  );
  const candidatePair = {
    ...pair,
    local_url: "https://scp-wiki.wikijump.localhost:24443/theme:basalt",
  };
  const loaded = await loadLiveReference({
    filePath: stored.file,
    pairs: [candidatePair],
    viewport,
    thresholds,
    policy: stored.policy,
  });
  assert.equal(loaded.records.length, 1);
});

test("live reference refuses an immediate theme mismatch instead of treating a later state as evidence", async (context) => {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "standing-browser-live-reference-"),
  );
  context.after(() => fs.rm(directory, { recursive: true, force: true }));
  const pair = {
    local_url: "https://scp-wiki.wikijump.localhost:18443/scp-9506",
    live_url: "https://scp-wiki.wikidot.com/scp-9506",
  };
  const artifacts = await screenshotArtifacts(directory);
  const live = capture(pair, artifacts, {
    first_paint: {
      document: {
        phase: "domcontentloaded_immediate_observation",
        custom_properties: { "--logo": "" },
        presence_probes: [],
        geometry: {},
      },
      screenshot: artifacts["first.png"],
    },
  });
  const stored = await writeReference(directory, pair, live);
  await assert.rejects(
    loadLiveReference({
      filePath: stored.file,
      pairs: [pair],
      viewport,
      thresholds,
      policy: stored.policy,
    }),
    /DOMContentLoaded theme properties/u,
  );
});

test("live reference refuses a post-settle capture relabeled as immediate evidence", async (context) => {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "standing-browser-live-reference-"),
  );
  context.after(() => fs.rm(directory, { recursive: true, force: true }));
  const pair = {
    local_url: "https://scp-wiki.wikijump.localhost:18443/theme:basalt",
    live_url: "https://scp-wiki.wikidot.com/theme:basalt",
  };
  const artifacts = await screenshotArtifacts(directory);
  const live = capture(pair, artifacts);
  live.first_paint.document.phase = "settled";
  const stored = await writeReference(directory, pair, live);
  await assert.rejects(
    loadLiveReference({
      filePath: stored.file,
      pairs: [pair],
      viewport,
      thresholds,
      policy: stored.policy,
    }),
    /required DOMContentLoaded observation/u,
  );
});

test("live reference refuses a capture whose load, font, or image completion was not observed", async (context) => {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "standing-browser-live-reference-"),
  );
  context.after(() => fs.rm(directory, { recursive: true, force: true }));
  const pair = {
    local_url: "https://scp-wiki.wikijump.localhost:18443/theme:basalt",
    live_url: "https://scp-wiki.wikidot.com/theme:basalt",
  };
  const artifacts = await screenshotArtifacts(directory);
  const live = capture(pair, artifacts);
  live.document.resource_completion = { status: "timed_out" };
  const stored = await writeReference(directory, pair, live);
  await assert.rejects(
    loadLiveReference({
      filePath: stored.file,
      pairs: [pair],
      viewport,
      thresholds,
      policy: stored.policy,
    }),
    /did not complete load, font, and image observation/u,
  );
});

test("live reference requires a clean request gate to admit each live navigation", async (context) => {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "standing-browser-live-reference-"),
  );
  context.after(() => fs.rm(directory, { recursive: true, force: true }));
  const pair = {
    local_url: "https://scp-wiki.wikijump.localhost:18443/theme:basalt",
    live_url: "https://scp-wiki.wikidot.com/theme:basalt",
  };
  const artifacts = await screenshotArtifacts(directory);
  const rawPolicy = policy();
  const policyFile = path.join(directory, "completion-policy.json");
  await fs.writeFile(policyFile, `${JSON.stringify(rawPolicy)}\n`, {
    mode: 0o600,
  });
  const policySha256 = sha256(await fs.readFile(policyFile));
  assert.throws(
    () =>
      buildLiveReferenceLedger({
        records: [{ input: pair, live: capture(pair, artifacts) }],
        viewport,
        thresholds,
        policy: rawPolicy,
        browserEnvironment: {
          engine: "chromium",
          version: "fixture",
        },
        requestGate: { ...requestGate(), public_requests: 0 },
      }),
    /did not admit every required live navigation/u,
  );
});

test("live reference refuses a broken external image unless its exact failure is allowlisted", async (context) => {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "standing-browser-live-reference-"),
  );
  context.after(() => fs.rm(directory, { recursive: true, force: true }));
  const pair = {
    local_url: "https://scp-wiki.wikijump.localhost:18443/theme:basalt",
    live_url: "https://scp-wiki.wikidot.com/theme:basalt",
  };
  const artifacts = await screenshotArtifacts(directory);
  const stored = await writeReference(
    directory,
    pair,
    capture(pair, artifacts, {
      broken_images: [{ src: "https://cdn.example/broken.png" }],
    }),
  );
  await assert.rejects(
    loadLiveReference({
      filePath: stored.file,
      pairs: [pair],
      viewport,
      thresholds,
      policy: stored.policy,
    }),
    /unapproved broken external image/u,
  );
});
