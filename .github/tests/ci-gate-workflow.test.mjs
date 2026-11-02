import assert from "node:assert/strict"
import { readFileSync, readdirSync } from "node:fs"
import path from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"

import { classifyChanges, GROUPS } from "../scripts/classify-changes.mjs"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..")
const read = (file) => readFileSync(path.join(root, file), "utf8")
const workflow = (name) => read(`.github/workflows/${name}`)
const triggerBlock = (source) =>
  source.slice(source.indexOf("on:\n"), source.indexOf("\npermissions:"))

const validationWorkflows = [
  "full-ci.yaml",
  "wikidot-verification.yaml"
]

const forbiddenCiCommands = [
  /node\s+--test/u,
  /(?:pnpm|npm|yarn)\s+[^\n]*\btest(?::[\w-]+)?\b/u,
  /\bcargo\s+test\b/u,
  /\bcargo\s+clippy\b/u,
  /\bcargo\s+fmt\b/u,
  /\bpytest\b/u,
  /\bplaywright\b[^\n]*(?:test|install)/u,
  /\bactionlint\b/u,
  /(?:pnpm|npm|yarn)\s+[^\n]*\binstall\b/u,
  /\bdocker\s+build\b/u,
  /\bpnpm\s+[^\n]*\blint\b/u
]

test("targeted PR checks are the merge signal; the full suite is informational", () => {
  // The PR workflow runs fast path-scoped targeted checks only.
  const prChecks = workflow("pr-checks.yml")
  const prTrigger = triggerBlock(prChecks)
  assert.match(prTrigger, /pull_request:/u)
  assert.doesNotMatch(prTrigger, /schedule:|merge_group:|push:/u)
  assert.match(prChecks, /cargo test/u)
  assert.match(prChecks, /test:unit/u)
  assert.doesNotMatch(prChecks, /run-consolidated-validation/u)

  // The full consolidated suite runs nightly and on dispatch only,
  // never on pull requests, and keeps its sealed receipt as an artifact.
  const full = workflow("consolidated-validation.yml")
  const fullTrigger = triggerBlock(full)
  assert.match(fullTrigger, /workflow_dispatch:/u)
  assert.match(fullTrigger, /schedule:/u)
  assert.doesNotMatch(fullTrigger, /pull_request:|merge_group:|push:/u)
  assert.match(full, /run-consolidated-validation\.mjs/u)
  assert.match(full, /upload-artifact/u)
  assert.doesNotMatch(full, /(?:wikidot\.com|wdfiles)/iu)

  // The retired gate name stays retired.
  const names = readdirSync(path.join(root, ".github/workflows"))
  assert.equal(names.includes("ci-gate.yaml"), false)
  // The manual-only policy stubs keep their triggers.
  for (const name of validationWorkflows) {
    const stubTrigger = triggerBlock(workflow(name))
    assert.doesNotMatch(stubTrigger, /pull_request:|merge_group:|push:/u, name)
  }
})
test("Browser CI is manual-only and runs no browser validation", () => {
  const source = workflow("full-ci.yaml")
  const trigger = triggerBlock(source)

  assert.match(trigger, /^\s*workflow_dispatch:\s*$/mu)
  assert.doesNotMatch(trigger, /pull_request:|push:|merge_group:/u)
  assert.match(source, /Browser tests are intentionally disabled in GitHub Actions/u)
  assert.doesNotMatch(source, /^\s*uses:/mu)
})

test("Wikidot verification is manual-only and runs no verification", () => {
  const source = workflow("wikidot-verification.yaml")
  const trigger = triggerBlock(source)

  assert.match(trigger, /^\s*workflow_dispatch:\s*$/mu)
  assert.doesNotMatch(trigger, /pull_request:|push:|merge_group:/u)
  assert.match(source, /persistent identity-bound response cache/u)
  assert.match(source, /cache hit must perform zero external requests/u)
  assert.doesNotMatch(source, /^\s*uses:/mu)
})

test("GitHub validation workflows execute no tests, installs, lint, builds, or compatibility acquisition", () => {
  for (const name of validationWorkflows) {
    const source = workflow(name)
    for (const pattern of forbiddenCiCommands) {
      assert.doesNotMatch(source, pattern, `${name}: ${pattern}`)
    }
    assert.doesNotMatch(
      source,
      /(?:candidate-cases|live-reference|sandbox-oracle|WIKIDOT_USERNAME|WIKIDOT_PASSWORD|wikidot\.com|wdfiles)/iu,
      `${name}: external compatibility acquisition`
    )
  }
})

test("local classifier still selects complete component validation", () => {
  assert.equal(classifyChanges(["deepwell/Cargo.lock"]).deepwell, true)
  assert.equal(classifyChanges(["wws/Cargo.lock"]).wws, true)
  assert.equal(classifyChanges(["locales/validator/Cargo.lock"]).locales, true)
  assert.equal(classifyChanges(["framerail/pnpm-lock.yaml"]).framerail, true)
  assert.equal(classifyChanges(["install/prod/deepwell/config.toml"]).deepwell, true)

  const toolchain = classifyChanges(["rust-toolchain.toml"])
  assert.equal(toolchain.deepwell, true)
  assert.equal(toolchain.wws, true)
  assert.equal(toolchain.locales, true)
})

test("known local Compose runtime definitions trigger runtime, workflow and verification checks", () => {
  // These compose files instantiate local runtime services, not Theme Lab or
  // locales. Check their service inventories so adding a new kind of service
  // cannot silently inherit this reduced classification.
  const known = new Map([
    ["install/local/docker-compose.yaml", ["database", "files", "cache", "deepwell", "framerail", "wws", "caddy"]],
    ["install/local/docker-compose.dev.yaml", ["deepwell", "framerail", "wws"]],
    ["install/local/docker-compose.postgres-perf.yaml", ["database"]],
  ])
  for (const [file, services] of known) {
    const source = read(file)
    const serviceSection = source.split(/^volumes:\s*$/mu, 1)[0]
    assert.deepEqual(
      [...serviceSection.matchAll(/^  ([\w-]+):\s*$/gmu)].map((match) => match[1]),
      services,
      `${file}: compose service inventory changed; revisit validation ownership`
    )
    const selected = classifyChanges([file])
    for (const group of ["deepwell", "wws", "framerail", "workflow", "verification"]) {
      assert.equal(selected[group], true, `${file}: ${group}`)
    }
    for (const group of ["locales", "theme_lab"]) {
      assert.equal(selected[group], false, `${file}: no ${group} input`)
    }
  }
  for (const file of [
    "install/local/caddy/request.json",
    "install/local/caddy/health-check.sh",
    "install/local/caddy/Caddyfile",
  ]) {
    const selected = classifyChanges([file])
    for (const group of ["deepwell", "wws", "framerail", "workflow", "verification"]) {
      assert.equal(selected[group], true, `${file}: ${group}`)
    }
    for (const group of ["locales", "theme_lab"]) {
      assert.equal(selected[group], false, `${file}: no ${group} input`)
    }
  }
  const unknown = classifyChanges(["install/local/docker-compose.new-service.yaml"])
  for (const group of [...GROUPS, "verification"]) {
    assert.equal(unknown[group], true, `unknown compose: ${group}`)
  }

  // A promotion that changes local publish security, Framerail CSP, and
  // locale messages still checks every affected group. Unrelated historical
  // Theme Lab evidence is outside those change inputs.
  const promotion = classifyChanges([
    "install/local/docker-compose.yaml",
    ".github/tests/local-publish-loopback.test.mjs",
    "framerail/sveltekit-options.js",
    "framerail/tests/wikidot-csp-config.test.js",
    "locales/fluent/wiki-page/zh_Hans.ftl",
  ])
  for (const group of ["deepwell", "wws", "framerail", "locales", "workflow", "verification"]) {
    assert.equal(promotion[group], true, `promotion: ${group}`)
  }
  assert.equal(promotion.theme_lab, false, "unrelated Theme Lab inputs are not part of this promotion")
})

test("local classifier keeps workflow and verification ownership", () => {
  for (const file of [
    ".github/workflows/README.md",
    ".github/scripts/classify-changes.mjs",
    ".github/tests/ci-gate-workflow.test.mjs"
  ]) {
    const selected = classifyChanges([file])
    assert.equal(selected.workflow, true, `${file}: workflow`)
  }

  const browser = classifyChanges([".github/workflows/full-ci.yaml"])
  assert.equal(browser.workflow, true)
  assert.equal(browser.framerail, true)

  const verification = classifyChanges([".github/workflows/wikidot-verification.yaml"])
  assert.equal(verification.workflow, true)
  assert.equal(verification.verification, true)

  const manual = classifyChanges([], true)
  for (const group of GROUPS) assert.equal(manual[group], true, group)
  assert.equal(manual.verification, true, "verification")
})

test("machine-readable development authorities select local verification", () => {
  for (const file of [
    "docs/development/compatibility-surface-semantics.json",
    "docs/development/deepwell-jsonrpc-contract-manifest.json",
    "docs/development/open43-a-authoring-closure-audit.json",
    "docs/development/wws-route-registration-denominator.json"
  ]) {
    const selected = classifyChanges([file])
    for (const group of GROUPS) assert.equal(selected[group], false, `${file}: ${group}`)
    assert.equal(selected.verification, true, `${file}: verification`)
  }
})

test("documentation stays cheap and unknown local-preflight paths fail closed", () => {
  const docs = classifyChanges([
    "README.md",
    "AGENTS.md",
    "docs/development.md",
    "install/local/README.md",
  ])
  for (const group of GROUPS) assert.equal(docs[group], false, group)

  for (const file of [
    "new-service/config.toml",
    "unexpected-root.json",
    "install/new-tier/config.toml",
    "scripts/data/wikidot-unknown-output.json"
  ]) {
    const selected = classifyChanges([file])
    for (const group of GROUPS) assert.equal(selected[group], true, `${file}: ${group}`)
    assert.equal(selected.verification, true, `${file}: verification`)
  }
})

test("verification inputs remain selected by the local preflight classifier", () => {
  for (const file of [
    "install/local/wikidot-verification/artifacts/example.json",
    "install/local/wikidot-verification/src/generic-runtime-differential.mjs",
    "install/local/wikidot-verification/tests/generic-runtime-differential.test.mjs",
    "install/standing/tests/verify-promotion-precondition.test.mjs",
    "scripts/data/wikidot-implementation-ledger.json",
    "scripts/data/wikidot-live-observations.json",
    "scripts/data/wikidot-detailed-spec-evidence-20260816.json",
    "scripts/data/wikidot-detailed-feature-contracts.json",
    "scripts/generate-wikidot-specifications.mjs",
    "docs/wikidot-specifications/catalog.json"
  ]) {
    const selected = classifyChanges([file])
    for (const group of GROUPS) assert.equal(selected[group], false, `${file}: ${group}`)
    assert.equal(selected.verification, true, `${file}: verification`)
  }
})

test("Framerail unit and browser scripts remain available for local validation", () => {
  const pkg = JSON.parse(read("framerail/package.json"))
  const playwright = read("framerail/playwright.config.ts")
  const unitRunner = read("scripts/run-framerail-unit-tests.sh")

  assert.equal(pkg.scripts["test:unit"], "../scripts/run-framerail-unit-tests.sh")
  assert.match(unitRunner, /run-test-no-external-network\.sh/u)
  assert.match(unitRunner, /svelte-kit sync/u)
  assert.match(unitRunner, /node --test/u)
  assert.doesNotMatch(pkg.scripts["test:unit"], /\.spec\.(?:js|ts)/u)
  assert.equal(
    pkg.scripts.test,
    "../scripts/run-browser-test-no-external-network.sh node tests/playwright-runner.js"
  )
  assert.doesNotMatch(pkg.scripts.test, /test:unit/u)
  assert.doesNotMatch(playwright, /\.test\.(?:js|ts)/u)
})

test("external actions in every remaining workflow are immutable pins", () => {
  const workflowRoot = path.join(root, ".github/workflows")
  for (const name of readdirSync(workflowRoot).filter((entry) => entry.endsWith(".yml") || entry.endsWith(".yaml"))) {
    const source = read(`.github/workflows/${name}`)
    for (const [, action] of source.matchAll(/^\s*uses:\s*([^\s#]+)(?:\s+#\s*\S+)?$/gmu)) {
      if (action.startsWith("./")) continue
      assert.match(action, /^[^@]+@[0-9a-f]{40}$/u, `${name}: ${action}`)
    }
  }
})

test("validation workflows contain no Wikidot or WDFiles origin literals", () => {
  for (const name of validationWorkflows) {
    assert.doesNotMatch(workflow(name), /(?:wikidot\.com|wdfiles)/iu, name)
  }
})

test("Theme Lab inputs select their own acceptance gates without selecting runtime components", () => {
  for (const file of ["install/local/theme-lab/src/verdict.mjs", "install/local/theme-lab/ports/adaptation-authority.json", "install/local/theme-lab/.gitattributes"]) {
    const selected = classifyChanges([file])
    assert.equal(selected.theme_lab, true, file)
    for (const group of ["deepwell", "wws", "framerail", "locales"]) assert.equal(selected[group], false, `${file}: ${group}`)
    assert.equal(selected.verification, false, file)
  }
  const mixed = classifyChanges(["install/local/theme-lab/src/verdict.mjs", "deepwell/src/api.rs"])
  assert.equal(mixed.theme_lab, true)
  assert.equal(mixed.deepwell, true)
  const preflight = read("scripts/preflight.sh")
  for (const gate of ["check-adaptation-authority.mjs", "prepare-maintainable-sources.mjs --check", "real-port-regression.mjs --verify-only", "sigma10-migration/check-final.mjs"]) assert.ok(preflight.includes(gate), gate)
})

test("specification supplements select only verification", () => {
  for (const file of [
    "scripts/data/wikidot-spec-supplements.json",
  ]) {
    const selected = classifyChanges([file])
    assert.equal(selected.verification, true, file)
    for (const group of GROUPS) assert.equal(selected[group], false, `${file} selected ${group}`)
  }
})
