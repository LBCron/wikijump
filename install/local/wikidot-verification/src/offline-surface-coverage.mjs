import fs from "node:fs/promises";
import path from "node:path";

import {
  extractDeclaredPublicTests,
  extractDeclaredRustModuleReferences,
} from "../../../../scripts/lib/wikidot-implementation-ledger.mjs";

export const OFFLINE_SURFACE_COVERAGE_SCHEMA =
  "wikijump.offline_compatibility_surface_coverage.v1";
export const FINAL_ZERO_SURFACE_COUNT = 900;
export const CAMPAIGN_ONLY_MIGRATED_COUNT = 100;

const SHA256_RE = /^[0-9a-f]{64}$/u;
const SURFACE_ID_RE = /^surface:\d{8}$/u;
const LANES = new Set(["products", "verification"]);
const DIRECT_ANCHOR_RE =
  /^(deepwell\/(?:src|tests)\/[^:#\s]+|wws\/(?:src|tests)\/[^:#\s]+|framerail\/tests\/[^:#\s]+|install\/local\/wikidot-verification\/tests\/[^:#\s]+)/u;
const DEEPWELL_RUNNER_RE =
  /^node (install\/local\/wikidot-verification\/scripts\/run-deepwell-integration-validation\.mjs)\b/u;
const CARGO_TEST_RE = /^(?:DATABASE_URL=\S+ )?cargo test\b/u;
const NODE_TEST_RE = /^node --test\b/u;
const FRAMERAIL_RUNNER = "scripts/run-framerail-unit-tests.sh";
const DEEPWELL_RUST_ROOTS = ["deepwell/src/", "deepwell/tests/"];
const WWS_RUST_ROOTS = ["wws/src/", "wws/tests/"];
const PUBLIC_TEST_FILE_ROOTS = [
  ...DEEPWELL_RUST_ROOTS,
  "framerail/tests/",
  "install/local/wikidot-verification/tests/",
  "install/standing/tests/",
  ...WWS_RUST_ROOTS,
];

function isSupportedPublicTestFile(relativePath) {
  if (/\.(?:test|spec)\.(?:[cm]?[jt]sx?)$/u.test(relativePath)) return true;
  return (
    relativePath.endsWith(".rs") &&
    PUBLIC_TEST_FILE_ROOTS.some((root) => relativePath.startsWith(root))
  );
}

function object(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value;
}

function strings(value, label) {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error(`${label} must be an array of strings`);
  }
  return value;
}

function sha256(value, label) {
  if (typeof value !== "string" || !SHA256_RE.test(value)) {
    throw new Error(`${label} must be a lowercase SHA-256`);
  }
  return value;
}

function shellTokens(command) {
  return command.trim().split(/\s+/u).filter(Boolean);
}

function rustCommandTarget(tokens, manifestDirectory = "deepwell") {
  const testIndex = tokens.indexOf("--test");
  const libIndex = tokens.indexOf("--lib");
  let rustRoot = null;
  let selectorStart = -1;
  if (testIndex !== -1 && tokens[testIndex + 1]) {
    rustRoot = `${manifestDirectory}/tests/${tokens[testIndex + 1]}.rs`;
    selectorStart = testIndex + 2;
  } else if (libIndex !== -1) {
    rustRoot = `${manifestDirectory}/src/lib.rs`;
    selectorStart = libIndex + 1;
  }
  if (rustRoot === null) return null;
  const separator = tokens.indexOf("--", selectorStart);
  const selectorTokens = tokens
    .slice(selectorStart, separator === -1 ? tokens.length : separator)
    .filter((token) => !token.startsWith("-"));
  if (selectorTokens.length > 1) return null;
  const testArguments = separator === -1 ? [] : tokens.slice(separator + 1);
  return {
    rustRoot,
    selector: selectorTokens[0] ?? null,
    exact: testArguments.includes("--exact"),
  };
}

function parseCoverageAnchor(anchor) {
  if (typeof anchor !== "string" || anchor.length === 0) return null;
  const runner = anchor.match(DEEPWELL_RUNNER_RE);
  if (runner) {
    const tokens = shellTokens(anchor);
    const rust = rustCommandTarget(tokens.slice(2));
    return {
      kind: "command",
      command: "deepwell-runner",
      files: [runner[1], ...(rust ? [rust.rustRoot] : [])],
      rust,
      fragment: null,
    };
  }
  if (CARGO_TEST_RE.test(anchor)) {
    const tokens = shellTokens(anchor).filter((token) => !/^DATABASE_URL=/u.test(token));
    const manifestIndex = tokens.indexOf("--manifest-path");
    const manifest = manifestIndex === -1 ? null : tokens[manifestIndex + 1];
    const manifestDirectory = manifest ? path.posix.dirname(manifest) : null;
    const rust = manifestDirectory ? rustCommandTarget(tokens, manifestDirectory) : null;
    return {
      kind: "command",
      command: "cargo-test",
      files: [...(manifest ? [manifest] : []), ...(rust ? [rust.rustRoot] : [])],
      rust,
      fragment: null,
    };
  }
  if (NODE_TEST_RE.test(anchor)) {
    const tokens = shellTokens(anchor).slice(2);
    const files = tokens.filter((token) => !token.startsWith("-"));
    const unsupported = tokens.some((token) => token.startsWith("-"));
    return {
      kind: "command",
      command: "node-test",
      files,
      unsupported,
      fragment: null,
    };
  }
  if (anchor === FRAMERAIL_RUNNER || anchor.startsWith(`${FRAMERAIL_RUNNER} `)) {
    const files = shellTokens(anchor)
      .slice(1)
      .map((file) => (file.startsWith("framerail/") ? file : `framerail/${file}`));
    return {
      kind: "command",
      command: "framerail-runner",
      files: [FRAMERAIL_RUNNER, ...files],
      testFiles: files,
      fragment: null,
    };
  }
  const direct = anchor.match(DIRECT_ANCHOR_RE);
  if (!direct) return null;
  const file = direct[1];
  const rest = anchor.slice(file.length);
  if (rest.length === 0) return {kind: "file", files: [file], fragment: null};
  if (rest.startsWith("#")) {
    return {kind: "named", files: [file], fragment: rest.slice(1)};
  }
  if (rest.startsWith("::")) {
    return {kind: "named", files: [file], fragment: rest.slice(2)};
  }
  return null;
}

export function anchorFilePath(anchor) {
  return parseCoverageAnchor(anchor)?.files[0] ?? null;
}

function declaredTestNames(fragment) {
  if (typeof fragment !== "string") return [];
  const text = fragment
    .trim()
    .replace(/^(?:pub\s+)?(?:async\s+)?fn\s+/u, "")
    .replace(/\(\)$/u, "");
  const names = [];
  for (const part of text.split(";")) {
    const trimmed = part.trim();
    if (trimmed.length === 0) continue;
    const segments = trimmed.split("::").map((segment) => segment.trim());
    if (segments.some((segment) => segment.length === 0)) return [];
    names.push(segments.at(-1));
  }
  return [...new Set(names)];
}

async function readSource(repositoryRoot, relativePath, cache) {
  if (cache.has(relativePath)) return cache.get(relativePath);
  const pending = fs
    .readFile(path.resolve(repositoryRoot, relativePath), "utf8")
    .catch(() => null);
  cache.set(relativePath, pending);
  return pending;
}

function isRustCrateRoot(relativePath) {
  return (
    relativePath === "deepwell/src/lib.rs" ||
    relativePath === "wws/src/lib.rs" ||
    /^deepwell\/tests\/[^/]+\.rs$/u.test(relativePath) ||
    /^wws\/tests\/[^/]+\.rs$/u.test(relativePath)
  );
}

function rustModuleCandidates(relativePath, reference) {
  const directory = path.posix.dirname(relativePath);
  if (reference.path) {
    return [path.posix.normalize(path.posix.join(directory, reference.path))];
  }
  const basename = path.posix.basename(relativePath);
  const moduleDirectory =
    basename === "mod.rs" || isRustCrateRoot(relativePath)
      ? directory
      : path.posix.join(directory, basename.slice(0, -3));
  return [
    path.posix.join(moduleDirectory, `${reference.name}.rs`),
    path.posix.join(moduleDirectory, reference.name, "mod.rs"),
  ];
}

async function collectDeclaredRustTests(
  repositoryRoot,
  relativePath,
  target,
  sourceCache,
  visited,
  modulePrefix = "",
) {
  if (visited.has(relativePath)) return;
  visited.add(relativePath);
  const source = await readSource(repositoryRoot, relativePath, sourceCache);
  if (source === null) return;
  const declared = extractDeclaredPublicTests(relativePath, source);
  if (declared !== null) {
    for (const name of declared) {
      target.add(name);
      if (modulePrefix) target.add(`${modulePrefix}::${name}`);
    }
  }
  for (const reference of extractDeclaredRustModuleReferences(source)) {
    for (const candidate of rustModuleCandidates(relativePath, reference)) {
      const candidateSource = await readSource(repositoryRoot, candidate, sourceCache);
      if (candidateSource === null) continue;
      const prefix = modulePrefix
        ? `${modulePrefix}::${reference.name}`
        : reference.name;
      await collectDeclaredRustTests(
        repositoryRoot,
        candidate,
        target,
        sourceCache,
        visited,
        prefix,
      );
      break;
    }
  }
}

async function declaredTestsFor(repositoryRoot, relativePath, cache) {
  if (cache.has(relativePath)) return cache.get(relativePath);
  const pending = (async () => {
    const source = await readSource(repositoryRoot, relativePath, cache.sourceCache);
    if (source === null) return null;
    const declared = extractDeclaredPublicTests(relativePath, source);
    if (declared === null) return null;
    if (!relativePath.endsWith(".rs")) return declared;
    const all = new Set();
    await collectDeclaredRustTests(
      repositoryRoot,
      relativePath,
      all,
      cache.sourceCache,
      new Set(),
    );
    return all;
  })();
  cache.set(relativePath, pending);
  return pending;
}

function normalizeRustTestPath(value) {
  return value
    .split("::")
    .filter((segment) => segment !== "tests")
    .join("::");
}

async function commandHasExecutableOwner(target, repositoryRoot, cache) {
  if (target.command === "cargo-test" || target.command === "deepwell-runner") {
    if (!target.rust) return false;
    const declared = await declaredTestsFor(repositoryRoot, target.rust.rustRoot, cache);
    if (declared === null || declared.size === 0) return false;
    if (target.rust.selector === null) return true;
    const selector = normalizeRustTestPath(target.rust.selector);
    return [...declared].some((name) => {
      const candidate = normalizeRustTestPath(name);
      return target.rust.exact
        ? candidate === selector || candidate.endsWith(`::${selector}`)
        : candidate.includes(selector);
    });
  }
  const testFiles =
    target.command === "framerail-runner" ? target.testFiles : target.files;
  if (target.command === "node-test" && target.unsupported) return false;
  if (!Array.isArray(testFiles) || testFiles.length === 0) return false;
  let hasDeclaredTest = false;
  for (const relativePath of testFiles) {
    if (!isSupportedPublicTestFile(relativePath)) return false;
    const declared = await declaredTestsFor(repositoryRoot, relativePath, cache);
    if (declared === null || declared.size === 0) return false;
    hasDeclaredTest = true;
  }
  return hasDeclaredTest;
}

function createDeclaredTestCache() {
  const cache = new Map();
  cache.sourceCache = new Map();
  return cache;
}

export function validateOfflineSurfaceCoverage(value) {
  const fixture = object(value, "offline surface coverage");
  if (fixture.schema !== OFFLINE_SURFACE_COVERAGE_SCHEMA) {
    throw new Error(
      `offline surface coverage must use ${OFFLINE_SURFACE_COVERAGE_SCHEMA}`,
    );
  }
  if (fixture.status !== "portable") {
    throw new Error("offline surface coverage must be portable");
  }
  const finalZero = object(fixture.final_zero, "final_zero");
  sha256(finalZero.receipt_sha256, "final_zero.receipt_sha256");
  sha256(finalZero.denominator_sha256, "final_zero.denominator_sha256");
  sha256(
    finalZero.reconciled_ledger_sha256,
    "final_zero.reconciled_ledger_sha256",
  );
  if (finalZero.surface_count !== FINAL_ZERO_SURFACE_COUNT) {
    throw new Error(`final-zero surface count must remain ${FINAL_ZERO_SURFACE_COUNT}`);
  }
  const counts = object(fixture.counts, "counts");
  if (counts.total !== FINAL_ZERO_SURFACE_COUNT) {
    throw new Error(`coverage total must remain ${FINAL_ZERO_SURFACE_COUNT}`);
  }
  if (counts.campaign_only_migrated !== CAMPAIGN_ONLY_MIGRATED_COUNT) {
    throw new Error(
      `campaign-only migrated count must remain ${CAMPAIGN_ONLY_MIGRATED_COUNT}`,
    );
  }
  if (!Array.isArray(fixture.rows) || fixture.rows.length !== FINAL_ZERO_SURFACE_COUNT) {
    throw new Error(`coverage must contain exactly ${FINAL_ZERO_SURFACE_COUNT} rows`);
  }
  const seen = new Set();
  let campaignOnly = 0;
  for (const [index, rowValue] of fixture.rows.entries()) {
    const row = object(rowValue, `rows[${index}]`);
    if (typeof row.surface_id !== "string" || !SURFACE_ID_RE.test(row.surface_id)) {
      throw new Error(`rows[${index}].surface_id is invalid`);
    }
    if (seen.has(row.surface_id)) {
      throw new Error(`duplicate offline surface coverage: ${row.surface_id}`);
    }
    seen.add(row.surface_id);
    const lanes = strings(row.offline_lanes, `rows[${index}].offline_lanes`);
    if (lanes.length === 0 || lanes.some((lane) => !LANES.has(lane))) {
      throw new Error(`rows[${index}] has an unsupported offline lane`);
    }
    const anchors = strings(row.anchors, `rows[${index}].anchors`);
    if (anchors.length === 0) {
      throw new Error(`rows[${index}] has no offline executable anchor`);
    }
    if (
      anchors.some(
        (anchor) =>
          anchor.includes("/home/roku/") ||
          anchor.includes("wikidot.com") ||
          anchor.includes("wdfiles.com"),
      )
    ) {
      throw new Error(`rows[${index}] retains a host or live-Wikidot dependency`);
    }
    if (row.migrated_from_campaign_only === true) campaignOnly += 1;
  }
  if (campaignOnly !== CAMPAIGN_ONLY_MIGRATED_COUNT) {
    throw new Error("campaign-only migrated row count disagrees with the fixture summary");
  }
  return fixture;
}

export async function loadOfflineSurfaceCoverage(filePath) {
  const raw = await fs.readFile(filePath, "utf8");
  if (raw.includes("/home/roku/") || raw.includes("/home/roku/wjlab")) {
    throw new Error("portable coverage fixture contains a host-specific absolute path");
  }
  return validateOfflineSurfaceCoverage(JSON.parse(raw));
}

export async function verifyCoverageAnchorFiles(fixture, repositoryRoot) {
  const missing = [];
  const unresolvedNamedTests = [];
  const unresolvedCommands = [];
  const unresolvedAnchors = [];
  const rowsWithoutExecutableOwner = [];
  const rowsWithoutNamedTestOwner = [];
  const checked = new Set();
  const cache = createDeclaredTestCache();

  for (const [index, row] of fixture.rows.entries()) {
    let owned = false;
    let namedOwner = false;
    for (const anchor of row.anchors ?? []) {
      const target = parseCoverageAnchor(anchor);
      if (!target) {
        unresolvedAnchors.push({anchor, reason: "unsupported-anchor"});
        continue;
      }
      let filesOk = target.files.length > 0;
      for (const relative of target.files) {
        const absolute = path.resolve(repositoryRoot, relative);
        const relativeBack = path.relative(repositoryRoot, absolute);
        if (relativeBack.startsWith("..") || path.isAbsolute(relativeBack)) {
          missing.push({anchor, reason: "outside-repository"});
          filesOk = false;
          continue;
        }
        checked.add(relative);
        const stat = await fs.lstat(absolute).catch(() => null);
        if (!stat?.isFile() || stat.isSymbolicLink()) {
          missing.push({anchor, path: relative, reason: "missing"});
          filesOk = false;
        }
      }
      if (!filesOk) continue;

      if (target.kind === "command") {
        if (await commandHasExecutableOwner(target, repositoryRoot, cache)) {
          owned = true;
          if (target.rust?.selector != null) namedOwner = true;
        } else {
          unresolvedCommands.push({anchor, reason: "no-runnable-test-selected"});
        }
        continue;
      }

      const relativeFile = target.files[0];
      if (target.kind === "file") {
        if (!isSupportedPublicTestFile(relativeFile)) {
          unresolvedAnchors.push({anchor, path: relativeFile, reason: "not-a-runnable-test-target"});
          continue;
        }
        const declared = await declaredTestsFor(repositoryRoot, relativeFile, cache);
        if (declared !== null && declared.size > 0) owned = true;
        else unresolvedAnchors.push({anchor, path: relativeFile, reason: "no-declared-runnable-tests"});
        continue;
      }

      if (!isSupportedPublicTestFile(relativeFile)) {
        unresolvedNamedTests.push({
          anchor,
          path: relativeFile,
          name: target.fragment,
          reason: "not-a-public-test-file",
        });
        continue;
      }
      const declared = await declaredTestsFor(repositoryRoot, relativeFile, cache);
      const names = declaredTestNames(target.fragment);
      if (
        declared !== null &&
        names.length > 0 &&
        names.every((name) => declared.has(name))
      ) {
        owned = true;
        namedOwner = true;
        continue;
      }
      unresolvedNamedTests.push({
        anchor,
        path: relativeFile,
        name: target.fragment,
        reason: "not-a-declared-runnable-test",
      });
    }
    if (!owned) {
      rowsWithoutExecutableOwner.push({
        surface_id: row.surface_id ?? null,
        index,
        anchors: [...(row.anchors ?? [])],
      });
    }
    if (!namedOwner) {
      rowsWithoutNamedTestOwner.push({
        surface_id: row.surface_id ?? null,
        index,
        anchors: [...(row.anchors ?? [])],
      });
    }
  }

  const status =
    missing.length === 0 &&
    unresolvedNamedTests.length === 0 &&
    unresolvedCommands.length === 0 &&
    unresolvedAnchors.length === 0 &&
    rowsWithoutExecutableOwner.length === 0 &&
    rowsWithoutNamedTestOwner.length === 0
      ? "pass"
      : "fail";
  return {
    status,
    checked: checked.size,
    missing,
    unresolvedNamedTests,
    unresolvedCommands,
    unresolvedAnchors,
    rowsWithoutExecutableOwner,
    rowsWithoutNamedTestOwner,
  };
}
