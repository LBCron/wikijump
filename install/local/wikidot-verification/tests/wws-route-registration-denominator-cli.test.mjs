import assert from "node:assert/strict"
import { spawn, spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"

const toolRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const repositoryRoot = path.resolve(toolRoot, "../../..")
const cliPath = path.join(toolRoot, "scripts/build-wws-route-registration-denominator.mjs")

const expectedRegistrations = [
  ["ANY", "/-/avatar/{user_id}", "handle_invalid_method", "wws/src/handler/misc.rs"],
  ["ANY", "/-/basic-error/{error_code}", "handle_invalid_method", "wws/src/handler/misc.rs"],
  ["ANY", "/-/code/{page_slug}/{index}", "handle_invalid_method", "wws/src/handler/misc.rs"],
  ["ANY", "/-/download/{page_slug}/{filename}", "handle_invalid_method", "wws/src/handler/misc.rs"],
  ["ANY", "/-/file/{page_slug}/{filename}", "handle_invalid_method", "wws/src/handler/misc.rs"],
  ["ANY", "/-/files/{page_slug}/{filename}", "handle_file_redirect", "wws/src/handler/redirect.rs"],
  ["ANY", "/-/health-check", "handle_health_check", "wws/src/handler/misc.rs"],
  ["ANY", "/-/html/{page_slug}/{id}", "handle_invalid_method", "wws/src/handler/misc.rs"],
  ["ANY", "/.well-known", "handle_well_known", "wws/src/handler/well_known.rs"],
  ["ANY", "/.well-known/{*path}", "handle_well_known", "wws/src/handler/well_known.rs"],
  ["ANY", "/local--code/{page_slug}/{index}", "handle_code_redirect", "wws/src/handler/redirect.rs"],
  ["ANY", "/local--files/{page_slug}/{filename}", "handle_local_file", "wws/src/handler/file.rs"],
  ["ANY", "/local--html/{page_slug}/{id}", "handle_html_redirect", "wws/src/handler/redirect.rs"],
  ["ANY", "/local--html/{page_slug}/{id}/{domain}", "handle_invalid_method", "wws/src/handler/misc.rs"],
  ["ANY", "/local--resized-images/{page_slug}/{filename}/{variant}", "handle_invalid_method", "wws/src/handler/misc.rs"],
  ["ANY", "/{page_slug}/code/{filename}", "handle_code_redirect", "wws/src/handler/redirect.rs"],
  ["ANY", "/{page_slug}/download/{filename}", "handle_download_redirect", "wws/src/handler/redirect.rs"],
  ["ANY", "/{page_slug}/file/{filename}", "handle_file_redirect", "wws/src/handler/redirect.rs"],
  ["ANY", "/{page_slug}/html/{filename}", "handle_html_redirect", "wws/src/handler/redirect.rs"],
  ["GET", "/-/avatar/{user_id}", "handle_user_avatar", "wws/src/handler/avatar.rs"],
  ["GET", "/-/basic-error/{error_code}", "handle_basic_error", "wws/src/handler/basic_error.rs"],
  ["GET", "/-/code/{page_slug}/{index}", "handle_code_block", "wws/src/handler/text_block.rs"],
  ["GET", "/-/download/{page_slug}/{filename}", "handle_file_download", "wws/src/handler/file.rs"],
  ["GET", "/-/file/{page_slug}/{filename}", "handle_file_fetch", "wws/src/handler/file.rs"],
  ["GET", "/-/html/{page_slug}/{id}", "handle_html_block", "wws/src/handler/text_block.rs"],
  ["GET", "/common--javascript/html-block-iframe.js", "handle_html_block_iframe_js", "wws/src/handler/misc.rs"],
  ["GET", "/common--javascript/resize-iframe.html", "handle_resize_iframe_html", "wws/src/handler/misc.rs"],
  ["GET", "/common--javascript/{*path}", "handle_common_javascript", "wws/src/handler/misc.rs"],
  ["GET", "/common--theme/base/css/html-block.css", "handle_html_block_css", "wws/src/handler/misc.rs"],
  ["GET", "/common--theme/{*path}", "handle_common_theme", "wws/src/handler/misc.rs"],
  ["GET", "/local--html/{page_slug}/{id}/{domain}", "handle_html_terminal", "wws/src/handler/text_block.rs"],
  ["GET", "/local--resized-images/{page_slug}/{filename}/{variant}", "handle_resized_image", "wws/src/handler/resized_image.rs"],
  ["GET", "/robots.txt", "handle_robots_txt", "wws/src/handler/robots.rs"],
  ["GET", "/{page_slug}/code", "handle_default_code_redirect", "wws/src/handler/redirect.rs"]
]

function runCli(root, output, extraArguments = [], environment = process.env) {
  return runCliWithScript(cliPath, root, output, extraArguments, environment)
}

function runCliWithScript(scriptPath, root, output, extraArguments = [], environment = process.env) {
  const arguments_ = [scriptPath, "--root", root]
  if (output !== null) arguments_.push("--output", output)
  arguments_.push(...extraArguments)
  return spawnSync(process.execPath, arguments_, {
    encoding: "utf8",
    env: environment
  })
}

async function writeGeneratorFixture(root, mutate = (source) => source) {
  const generatorPath = path.join(root, "install/local/wikidot-verification/scripts/build-wws-route-registration-denominator.mjs")
  await fs.mkdir(path.dirname(generatorPath), { recursive: true })
  const source = await fs.readFile(cliPath, "utf8")
  const mutated = mutate(source)
  assert.notEqual(mutated, source)
  await fs.writeFile(generatorPath, mutated)
  return generatorPath
}

async function sha256(filePath) {
  return createHash("sha256").update(await fs.readFile(filePath)).digest("hex")
}

async function writeRouteSource(root, source) {
  const target = path.join(root, "wws/src/route.rs")
  await fs.mkdir(path.dirname(target), { recursive: true })
  await fs.writeFile(target, source)
}

function runGit(root, ...arguments_) {
  const result = spawnSync("git", ["-C", root, ...arguments_], { encoding: "utf8" })
  assert.equal(result.status, 0, result.stderr)
}

async function copyHistoricalEvidence(root) {
  for (const relativePath of [
    "install/local/wikidot-verification/artifacts/pr1334-wws-route-attribution-no-thumbnails-20260810.json",
    "install/local/wikidot-verification/fixtures/pr1334-wws-route-attribution-no-thumbnails.json",
    "docs/development/wws-cache-head-live-observations-20260815.md"
  ]) {
    const target = path.join(root, relativePath)
    await fs.mkdir(path.dirname(target), { recursive: true })
    await fs.copyFile(path.join(repositoryRoot, relativePath), target)
  }
}

async function copyBehaviorSourceInputs(root) {
  for (const relativePath of [
    "deepwell/Cargo.lock",
    "deepwell/Cargo.toml",
    "deepwell/migrations/20260815010000_text_block_wikidot_sha1.sql",
    "deepwell/src/api.rs",
    "deepwell/src/endpoints/text_block.rs",
    "deepwell/src/models/text_block.rs",
    "deepwell/src/services/context.rs",
    "deepwell/src/services/text_block/service.rs",
    "deepwell/src/services/text_block/structs.rs",
    "deepwell/tests/page.rs",
    "wws/Cargo.lock",
    "wws/Cargo.toml",
    "wws/src/deepwell.rs",
    "wws/src/handler/file.rs",
    "wws/src/handler/text_block.rs"
  ]) {
    const target = path.join(root, relativePath)
    await fs.mkdir(path.dirname(target), { recursive: true })
    await fs.copyFile(path.join(repositoryRoot, relativePath), target)
  }
}

async function writeCommittedProductionFixture(root) {
  await fs.cp(path.join(repositoryRoot, "wws/src"), path.join(root, "wws/src"), { recursive: true })
  await copyBehaviorSourceInputs(root)
  await copyHistoricalEvidence(root)
  runGit(root, "init", "--quiet")
  runGit(root, "config", "user.email", "denominator-test@example.invalid")
  runGit(root, "config", "user.name", "Denominator Test")
  runGit(root, "add", ".")
  runGit(root, "commit", "--quiet", "-m", "fixture")
}

async function writeNonProductionHandlerFixture(root, symbol, handlerSource) {
  const routes = Array.from(
    { length: 34 },
    (_, index) => `.route("/fixture-${index}", any(${symbol}))`
  ).join("\n")
  await writeRouteSource(root, `pub fn build_router() { Router::new()${routes} }\n`)
  const handlerPath = path.join(root, "wws/src/handler/fake.rs")
  await fs.mkdir(path.dirname(handlerPath), { recursive: true })
  await fs.writeFile(handlerPath, handlerSource)
  await copyBehaviorSourceInputs(root)
  await copyHistoricalEvidence(root)
  runGit(root, "init", "--quiet")
  runGit(root, "config", "user.email", "denominator-test@example.invalid")
  runGit(root, "config", "user.name", "Denominator Test")
  runGit(root, "add", ".")
  runGit(root, "commit", "--quiet", "-m", "fixture")
}

test("CLI writes the exact current 34-registration WWS denominator with source ownership", async (t) => {
  const temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "wws-route-denominator-"))
  t.after(() => fs.rm(temporaryDirectory, { recursive: true, force: true }))
  const output = path.join(temporaryDirectory, "denominator.json")

  const result = runCli(repositoryRoot, output)

  assert.equal(result.status, 0, result.stderr)
  assert.equal(result.stdout, `wrote 34 WWS route registrations to ${output}\n`)
  const manifest = JSON.parse(await fs.readFile(output, "utf8"))
  assert.equal(manifest.schema, "wikijump.wws_route_registration_denominator.v2")
  assert.deepEqual(manifest.historical_artifact, {
    path: "install/local/wikidot-verification/artifacts/pr1334-wws-route-attribution-no-thumbnails-20260810.json",
    sha256: "356c8b5b3ee063a92e8dac266bd8e0aa32b221ff4e0e2a7d660001da04c0478d",
    fixture_path: "install/local/wikidot-verification/fixtures/pr1334-wws-route-attribution-no-thumbnails.json",
    fixture_sha256: "c5a21d7c1b5bc3af42d325b8bb68e67c78f0dd1cfdc8624e8df884a7110642c2",
    registration_count: 27,
    status: "historical_27_route_source_attribution_preserved"
  })
  assert.equal(manifest.source.identity, "git_blob_and_sha256_per_captured_input")
  assert.deepEqual(Object.keys(manifest.source).sort(), ["identity", "inputs"])
  assert.deepEqual(manifest.counts, {
    registrations: 34,
    by_declared_method_class: { ANY: 19, GET: 15 },
    primary_handler_owners: 34,
    fallback_handler_owners: 1,
    handler_owner_bindings: 35,
    duplicate_registration_ids: 0
  })
  assert.deepEqual(
    manifest.registrations.map((registration) => [
      registration.declared_method_class,
      registration.path,
      registration.registered_handler_symbol,
      registration.handler_definition_path
    ]),
    expectedRegistrations
  )
  assert.equal(new Set(manifest.registrations.map(({ registration_id }) => registration_id)).size, 34)
  assert.deepEqual(
    manifest.registrations
      .filter(({ fallback_handler_symbol: symbol }) => symbol !== null)
      .map(({ registration_id, fallback_handler_symbol: symbol }) => [registration_id, symbol]),
    [["wws-route-registration:GET:/{page_slug}/code", "redirect_to_main"]]
  )
  for (const input of manifest.source.inputs) {
    assert.equal(input.sha256, await sha256(path.join(repositoryRoot, input.path)))
  }
  for (const registration of manifest.registrations) {
    assert.ok(registration.route_registration_reference.startsWith("wws/src/route.rs#L"))
    assert.ok(registration.handler_definition_reference.startsWith(`${registration.handler_definition_path}#L`))
  }
  const behaviorRecords = manifest.behavior_records
  assert.equal(
    manifest.behavior_evidence.sha256,
    await sha256(path.join(repositoryRoot, "docs/development/wws-cache-head-live-observations-20260815.md"))
  )
  assert.equal(manifest.behavior_evidence.capture_source_commit, "776ea0bf5d4be01d24226765e9c144313f00de46")
  assert.equal(manifest.behavior_evidence.capture_source_status, "historical")
  const liveBehavior = behaviorRecords.find(({ id }) => id === "wws-behavior:live-html-hash-domain-identity")
  assert.equal(liveBehavior.status, "not_faithfully_mapped")
  assert.equal(liveBehavior.public_test, "wws/src/handler/text_block.rs#html_terminal_hash_verifies_fetched_bytes")
  assert.equal(liveBehavior.route_pattern, "^/local--html/[^/]+/[0-9a-f]{40}-[0-9][0-9]*/[^/]+/$")
  assert.equal(liveBehavior.preserves_behavior_id, "wws-behavior:numeric-html-cache-head-range")
  assert.deepEqual(
    behaviorRecords.find(({ id }) => id === "wws-behavior:basic-error-guard"),
    {
      id: "wws-behavior:basic-error-guard",
      status: "implemented",
      source_paths: ["wws/src/route.rs", "wws/src/handler/basic_error.rs", "wws/src/handler/misc.rs"],
      registration_ids: [
        "wws-route-registration:ANY:/-/basic-error/{error_code}",
        "wws-route-registration:GET:/-/basic-error/{error_code}"
      ],
      public_test: "wws/src/route.rs#public_basic_error_route_rejects_external_get_head_and_post"
    }
  )
})

test("CLI reproduces and verifies the exact committed denominator", async (t) => {
  const temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "wws-route-verify-"))
  t.after(() => fs.rm(temporaryDirectory, { recursive: true, force: true }))
  const output = path.join(temporaryDirectory, "denominator.json")

  const generateResult = runCli(repositoryRoot, output)
  const verifyResult = runCli(repositoryRoot, null, ["--verify"])

  assert.equal(generateResult.status, 0, generateResult.stderr)
  assert.equal(verifyResult.status, 0, verifyResult.stderr)
  assert.equal(
    verifyResult.stdout,
    "verified 34 WWS route registrations in docs/development/wws-route-registration-denominator.json\n"
  )
  assert.deepEqual(
    await fs.readFile(output),
    await fs.readFile(path.join(repositoryRoot, "docs/development/wws-route-registration-denominator.json"))
  )
})

test("CLI content-addresses dirty captured inputs before the source commit exists", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wws-route-dirty-source-"))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  await writeCommittedProductionFixture(root)
  const sourcePath = "deepwell/tests/page.rs"
  const absoluteSource = path.join(root, sourcePath)
  await fs.appendFile(absoluteSource, "\n// pre-commit denominator identity fixture\n")
  const output = path.join(root, "denominator.json")

  const result = runCli(root, output)

  assert.equal(result.status, 0, result.stderr)
  const manifest = JSON.parse(await fs.readFile(output, "utf8"))
  const input = manifest.source.inputs.find(({ path: candidate }) => candidate === sourcePath)
  assert.ok(input)
  const workingBlob = spawnSync("git", ["-C", root, "hash-object", sourcePath], { encoding: "utf8" })
  const committedBlob = spawnSync("git", ["-C", root, "rev-parse", `HEAD:${sourcePath}`], { encoding: "utf8" })
  assert.equal(workingBlob.status, 0, workingBlob.stderr)
  assert.equal(committedBlob.status, 0, committedBlob.stderr)
  assert.equal(input.git_blob, workingBlob.stdout.trim())
  assert.notEqual(input.git_blob, committedBlob.stdout.trim())
  assert.equal(input.sha256, await sha256(absoluteSource))
})

test("CLI verify rejects a byte-drifted denominator", async (t) => {
  const temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "wws-route-stale-"))
  t.after(() => fs.rm(temporaryDirectory, { recursive: true, force: true }))
  const output = path.join(temporaryDirectory, "denominator.json")
  const committedOutput = await fs.readFile(
    path.join(repositoryRoot, "docs/development/wws-route-registration-denominator.json"),
    "utf8"
  )
  await fs.writeFile(output, `${committedOutput}\n`)

  const result = runCli(repositoryRoot, output, ["--verify"])

  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /denominator\.json is stale/u)
  assert.equal(result.stdout, "")
})

for (const [label, mutate, expectedError] of [
  [
    "an omitted behavior row",
    (source) => source.replace(/\n  \{\n    id: "wws-behavior:code-cache-head-range",[\s\S]*?\n  \},/u, ""),
    /WWS behavior ids do not match expected set; missing: wws-behavior:code-cache-head-range/u
  ],
  [
    "duplicate behavior IDs",
    (source) => source.replace('id: "wws-behavior:code-cache-head-range"', 'id: "wws-behavior:file-cache-head-range"'),
    /duplicate WWS behavior ids/u
  ],
  [
    "an unknown behavior route",
    (source) => source.replace('wws-route-registration:GET:/-/code/{page_slug}/{index}', 'wws-route-registration:GET:/-/unknown/{page_slug}/{index}'),
    /unknown WWS route registration ids/u
  ],
  [
    "a non-declaration public test anchor",
    (source) => source.replace("wws/src/handler/file.rs#file_exact_if_none_match_returns_not_modified_without_reading_blob", "wws/src/handler/file.rs#missing_public_test"),
    /public test anchor is not exactly one function declaration/u
  ],
  [
    "a missing declared source input",
    (source) => source.replace('"deepwell/Cargo.toml",', '"deepwell/missing/Cargo.toml",\n      "deepwell/Cargo.toml",'),
    /declared WWS source input is missing: deepwell\/missing\/Cargo\.toml/u
  ]
]) {
  test(`CLI rejects ${label} in the generator`, async (t) => {
    const temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "wws-route-behavior-validation-"))
    t.after(() => fs.rm(temporaryDirectory, { recursive: true, force: true }))
    await writeCommittedProductionFixture(temporaryDirectory)
    const generatorPath = await writeGeneratorFixture(temporaryDirectory, mutate)
    const output = path.join(temporaryDirectory, "denominator.json")

    const result = runCliWithScript(generatorPath, temporaryDirectory, output)

    assert.notEqual(result.status, 0)
    assert.match(result.stderr, expectedError)
    assert.equal(result.stdout, "")
  })
}

test("CLI ignores hostile Git process controls while hashing captured source bytes", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wws-route-captured-bytes-"))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  await writeCommittedProductionFixture(root)
  const originalRouteSource = await fs.readFile(path.join(root, "wws/src/route.rs"))
  const shimDirectory = path.join(root, "git-shim")
  await fs.mkdir(shimDirectory)
  const realGit = spawnSync("which", ["git"], { encoding: "utf8" }).stdout.trim()
  await fs.writeFile(
    path.join(shimDirectory, "git"),
    `#!/bin/sh
printf 'hostile PATH git executed: %s\\n' "${realGit}" >&2
exit 97
`
  )
  await fs.chmod(path.join(shimDirectory, "git"), 0o755)
  const output = path.join(root, "denominator.json")

  const result = runCli(root, output, [], {
    ...process.env,
    PATH: `${shimDirectory}:${process.env.PATH}`,
    GIT_DIR: path.join(root, "hostile-git-dir"),
    GIT_WORK_TREE: path.join(root, "hostile-work-tree"),
    GIT_INDEX_FILE: path.join(root, "hostile-index"),
    GIT_OBJECT_DIRECTORY: path.join(root, "hostile-objects")
  })

  assert.equal(result.status, 0, result.stderr)
  assert.deepEqual(await fs.readFile(path.join(root, "wws/src/route.rs")), originalRouteSource)
  const manifest = JSON.parse(await fs.readFile(output, "utf8"))
  const routeInput = manifest.source.inputs.find(({ path: inputPath }) => inputPath === "wws/src/route.rs")
  assert.equal(routeInput.sha256, createHash("sha256").update(originalRouteSource).digest("hex"))
})

test("CLI does not reread a source pathname after capturing its bytes", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wws-route-no-reread-"))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  await writeCommittedProductionFixture(root)
  const routePath = path.join(root, "wws/src/route.rs")
  const originalRouteSource = await fs.readFile(routePath)
  await fs.unlink(routePath)
  const fifoResult = spawnSync("mkfifo", [routePath], { encoding: "utf8" })
  assert.equal(fifoResult.status, 0, fifoResult.stderr)
  const output = path.join(root, "denominator.json")
  const child = spawn(
    process.execPath,
    [cliPath, "--root", root, "--output", output],
    { stdio: ["ignore", "pipe", "pipe"] }
  )
  let stdout = ""
  let stderr = ""
  child.stdout.setEncoding("utf8")
  child.stderr.setEncoding("utf8")
  child.stdout.on("data", (chunk) => { stdout += chunk })
  child.stderr.on("data", (chunk) => { stderr += chunk })
  const exit = new Promise((resolve) => child.on("close", (status) => resolve(status)))
  const writer = await fs.open(routePath, "w")
  await writer.writeFile(originalRouteSource)
  await writer.close()
  await fs.unlink(routePath)
  await fs.writeFile(routePath, Buffer.from("changed after capture\n"))

  const status = await exit

  assert.equal(status, 0, stderr)
  assert.equal(stdout, `wrote 34 WWS route registrations to denominator.json\n`)
  const manifest = JSON.parse(await fs.readFile(output, "utf8"))
  const routeInput = manifest.source.inputs.find(({ path: inputPath }) => inputPath === "wws/src/route.rs")
  assert.equal(routeInput.sha256, createHash("sha256").update(originalRouteSource).digest("hex"))
  assert.notEqual(routeInput.sha256, await sha256(routePath))
})

for (const [form, symbol, handlerSource] of [
  ["comment", "handle_comment_only", "// pub async fn handle_comment_only() {}\n"],
  ["string", "handle_string_only", "const EXAMPLE: &str = \"pub async fn handle_string_only() {}\";\n"],
  ["cfg(test)", "handle_test_only", "#[cfg(test)]\nmod tests { pub async fn handle_test_only() {} }\n"]
]) {
  test(`CLI rejects a handler found only in a Rust ${form}`, async (t) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "wws-route-handler-owner-"))
    t.after(() => fs.rm(root, { recursive: true, force: true }))
    await writeNonProductionHandlerFixture(root, symbol, handlerSource)

    const result = runCli(root, path.join(root, "denominator.json"))

    assert.notEqual(result.status, 0)
    assert.match(result.stderr, new RegExp(`missing WWS handler definition: ${symbol}`, "u"))
    assert.equal(result.stdout, "")
  })
}

test("CLI rejects duplicate registrations with equivalent reordered method filters", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wws-route-duplicate-"))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const filler = Array.from(
    { length: 32 },
    (_, index) => `.route("/filler-${index}", any(handle_filler_${index}))`
  ).join("\n")
  await writeRouteSource(
    root,
    `pub fn build_router() {
  Router::new()
    .route("/duplicate", on(MethodFilter::GET.or(MethodFilter::HEAD), handle_first).fallback(handle_fallback))
    .route("/duplicate", on(MethodFilter::HEAD.or(MethodFilter::GET), handle_second).fallback(handle_fallback))
    ${filler}
}
`
  )

  const result = runCli(root, path.join(root, "denominator.json"))

  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /duplicate WWS route registration ids/u)
  assert.equal(result.stdout, "")
})

test("CLI fails closed when another Axum router composition form is introduced", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wws-route-unsupported-"))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  await fs.cp(path.join(repositoryRoot, "wws/src"), path.join(root, "wws/src"), { recursive: true })
  const routePath = path.join(root, "wws/src/route.rs")
  const routeSource = await fs.readFile(routePath, "utf8")
  await fs.writeFile(
    routePath,
    routeSource.replace(
      "        .fallback(redirect_to_main)\n",
      "        .fallback(redirect_to_main)\n        .route_service(\"/unsupported\", unsupported_service)"
    )
  )
  runGit(root, "init", "--quiet")
  runGit(root, "config", "user.email", "denominator-test@example.invalid")
  runGit(root, "config", "user.name", "Denominator Test")
  runGit(root, "add", "wws/src")
  runGit(root, "commit", "--quiet", "-m", "fixture")

  const result = runCli(root, path.join(root, "denominator.json"))

  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /unsupported WWS router composition: route_service/u)
  assert.equal(result.stdout, "")
})
