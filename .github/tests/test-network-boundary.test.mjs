import assert from "node:assert/strict"
import { readFileSync, readdirSync } from "node:fs"
import path from "node:path"
import { spawnSync } from "node:child_process"
import test from "node:test"
import { fileURLToPath } from "node:url"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..")
const read = (file) => readFileSync(path.join(root, file), "utf8")
const guard = path.join(root, "scripts/run-test-no-external-network.sh")
const shellSourcesUnder = (directory) =>
  readdirSync(path.join(root, directory), { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && (entry.name.endsWith(".sh") || entry.name.endsWith(".bash")))
    .map((entry) => path.relative(root, path.join(entry.parentPath, entry.name)))
    .sort()
const independentGuardEnvironment = () => {
  const environment = { ...process.env }
  delete environment.WIKIJUMP_TEST_NETWORK_GUARD_ACTIVE
  delete environment.WIKIJUMP_TEST_NETWORK_BLOCK_LOG
  delete environment.LD_PRELOAD
  return environment
}

test("test network guard permits loopback traffic", () => {
  const program = `
    const http = require("node:http");
    const server = http.createServer((_req, res) => res.end("ok"));
    server.listen(0, "127.0.0.1", async () => {
      try {
        const { port } = server.address();
        const response = await fetch("http://127.0.0.1:" + port + "/");
        if (await response.text() !== "ok") process.exitCode = 2;
      } finally {
        server.close();
      }
    });
  `
  const result = spawnSync(guard, [process.execPath, "-e", program], {
    cwd: root,
    env: independentGuardEnvironment(),
    encoding: "utf8"
  })
  assert.equal(result.status, 0, result.stderr)
})

test("test network guard blocks and reports external socket attempts before transmission", () => {
  const program = `
    const net = require("node:net");
    const socket = net.connect({ host: "203.0.113.7", port: 9 });
    socket.on("error", () => process.exit(0));
    setTimeout(() => process.exit(3), 500);
  `
  const expected = spawnSync(guard, ["--expect-blocked", process.execPath, "-e", program], {
    cwd: root,
    env: independentGuardEnvironment(),
    encoding: "utf8"
  })
  assert.equal(expected.status, 0, expected.stderr)
  assert.match(expected.stdout, /blocked 1 external attempt/u)

  const strict = spawnSync(guard, [process.execPath, "-e", program], {
    cwd: root,
    env: independentGuardEnvironment(),
    encoding: "utf8"
  })
  assert.equal(strict.status, 86)
  assert.match(strict.stderr, /suite is non-hermetic/u)
  assert.match(strict.stderr, /connect\t203\.0\.113\.7:9/u)
})

test("maintained local test entrypoints are network-hermetic", () => {
  const verification = JSON.parse(read("install/local/wikidot-verification/package.json"))
  const framerail = JSON.parse(read("framerail/package.json"))
  const preflight = read("scripts/preflight.sh")
  const playwright = read("framerail/playwright.config.ts")
  const browserSupport = read("framerail/playwright.browser-support.config.ts")
  const browserGuard = read("scripts/run-browser-test-no-external-network.sh")
  const unitRunner = read("scripts/run-framerail-unit-tests.sh")

  for (const name of ["test", "test:ci"]) {
    assert.match(verification.scripts[name], /run-test-no-external-network\.sh/u, name)
  }
  assert.equal(framerail.scripts["test:unit"], "../scripts/run-framerail-unit-tests.sh")
  assert.match(unitRunner, /run-test-no-external-network\.sh/u)
  assert.match(unitRunner, /svelte-kit sync/u)
  assert.match(unitRunner, /node --test/u)
  for (const name of ["test", "test:browser-support"]) {
    assert.match(framerail.scripts[name], /run-browser-test-no-external-network\.sh/u, name)
  }
  assert.match(preflight, /TEST_NETWORK_GUARD=/u)
  assert.match(preflight, /run_test/u)
  assert.doesNotMatch(playwright, /WIKIJUMP_CI_OFFLINE_EGRESS/u)
  assert.match(playwright, /use: \{\}/u)
  assert.match(browserSupport, /baseConfig\.use/u)
  assert.doesNotMatch(playwright, /\bpnpm\s+dev\b/u)
  assert.match(playwright, /\.\/node_modules\/\.bin\/vite dev/u)
  assert.match(browserGuard, /unshare -Urn/u)
  assert.match(browserGuard, /exec sudo -n -E unshare -n/u)
  assert.match(browserGuard, /ip link set lo up/u)
  assert.match(browserGuard, /exec setpriv --reuid/u)
})

test("test shell sources contain no literal external curl or wget targets", () => {
  const files = [
    ...shellSourcesUnder("deepwell/tests"),
    ...shellSourcesUnder("install/dev/tests")
  ]
  assert.ok(files.length > 0, "expected maintained shell test sources")
  for (const file of files) {
    const source = read(file)
    for (const match of source.matchAll(/\b(?:curl|wget)\b[^\n]*(https?:\/\/[^\s'"]+)/gu)) {
      const url = new URL(match[1])
      assert.ok(
        url.hostname === "127.0.0.1" || url.hostname === "localhost" || !url.hostname.includes("."),
        `${file}: external shell target ${url.hostname}`
      )
    }
  }
})

test("Docker-backed tests cannot implicitly pull images", () => {
  const caddyShell = read("deepwell/tests/caddy/single-upstream-policy.test.sh")
  const caddyCanary = read("deepwell/tests/caddy/deploy-header-canary.test.mjs")
  const valkey = read("install/dev/tests/valkey-auth.test.sh")

  assert.equal((caddyShell.match(/\bdocker run\b/gu) ?? []).length, 4)
  assert.equal((caddyShell.match(/\bdocker run --pull=never\b/gu) ?? []).length, 4)
  assert.match(caddyCanary, /"run",\s*"--pull",\s*"never"/u)

  assert.doesNotMatch(valkey, /\bdocker\s+(?:pull|build)\b/u)
  assert.doesNotMatch(valkey, /\bdocker compose\b[^\n]*\bup\b[^\n]*--build/u)
  assert.equal((valkey.match(/\bdocker run --pull=never\b/gu) ?? []).length, 2)
  assert.equal((valkey.match(/--network none/gu) ?? []).length, 2)
  assert.match(valkey, /docker image inspect "\$base_image"/u)
})
