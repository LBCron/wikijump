import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import test from "node:test";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (relative) => readFileSync(path.join(root, relative), "utf8");
const atLeast = (actual, minimum) => {
  const a = actual.split(".").map(Number);
  const b = minimum.split(".").map(Number);
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    const delta = (a[i] ?? 0) - (b[i] ?? 0);
    if (delta !== 0) return delta > 0;
  }
  return true;
};
const lockedVersion = (lock, name) => {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = lock.match(new RegExp(`^${escaped}==([^\\s\\\\]+)`, "m"));
  assert.ok(match, `${name} is missing from its hash-locked requirements`);
  return match[1];
};

test("Python TLS bootstrap is hash-pinned and precedes all pip network installs", () => {
  const bootstrap = read("requirements-bootstrap.lock");
  const runtime = read("requirements.lock");
  const requirements = read("requirements.txt");
  const pypiRequirements = read("requirements-pypi.txt");
  const setup = read("scripts/setup-python-env.sh");

  assert.equal(lockedVersion(bootstrap, "pip"), "26.2.2");
  assert.equal(lockedVersion(bootstrap, "certifi"), "2026.10.19");
  assert.equal(lockedVersion(runtime, "certifi"), "2026.10.19");
  assert.match(requirements, /^certifi==2026\.10\.19$/m);
  assert.match(pypiRequirements, /^certifi==2026\.10\.19$/m);
  for (const name of ["pip", "certifi"]) {
    const section = bootstrap.split(/(?=^[A-Za-z0-9_.-]+==)/m).find((part) => part.startsWith(`${name}==`));
    assert.ok(section, `${name} lock entry is present`);
    assert.ok((section.match(/--hash=sha256:/g) ?? []).length >= 2, `${name} has distribution hashes`);
  }

  assert.match(setup, /uv >= 0\.13\.4 is required/u);
  assert.match(setup, /PYPI_INDEX_URL=https:\/\/pypi\.org\/simple\//u);
  const bootstrapInstall = setup.indexOf('"$UV_BIN" pip install');
  const applicationPipInstall = setup.indexOf('"$VENV/bin/python" -m pip install');
  const sourceFetch = setup.indexOf('git -C "$SOURCE_ROOT" fetch');
  assert.ok(bootstrapInstall >= 0, "uv installs the fixed trust bundle");
  assert.ok(applicationPipInstall > bootstrapInstall, "pip is invoked only after the bootstrap");
  assert.ok(sourceFetch > applicationPipInstall, "the pinned Git dependency is fetched after TLS bootstrap");
  const uvVersionGate = setup.indexOf("uv >= 0.13.4 is required; found");
  const venvCreation = setup.indexOf('python3 -m venv --clear "$VENV"');
  assert.ok(uvVersionGate >= 0 && venvCreation > uvVersionGate, "uv version is verified before any venv is created");
});

test("Rust TLS root bundles and verifiers are pinned to emSign-safe versions", () => {
  for (const relative of ["../../../deepwell/Cargo.lock", "../../../wws/Cargo.lock"]) {
    const lock = read(relative);
    const packages = lock.split(/^\[\[package\]\]$/m).slice(1).map((block) => {
      const name = block.match(/^name = "([^"]+)"$/m)?.[1];
      const version = block.match(/^version = "([^"]+)"$/m)?.[1];
      const deps = [...block.matchAll(/^ "([^"]+)",?$/gm)].map((match) => match[1]);
      return { name, version, deps };
    });
    for (const pkg of packages.filter((entry) => entry.name === "webpki-roots")) {
      assert.ok(atLeast(pkg.version, "1.0.10"), `${relative}: webpki-roots ${pkg.version} still contains the removed root`);
    }
    for (const pkg of packages.filter((entry) => entry.name === "webpki-root-certs")) {
      if (pkg.version.startsWith("0.")) {
        assert.ok(pkg.deps.includes("webpki-root-certs 1.0.10"), `${relative}: webpki-root-certs ${pkg.version} shim must use 1.0.10`);
        continue;
      }
      assert.ok(atLeast(pkg.version, "1.0.10"), `${relative}: webpki-root-certs ${pkg.version} still contains the removed root`);
    }
    const verifiers = packages.filter((entry) => entry.name === "rustls-webpki");
    assert.ok(verifiers.length > 0, `${relative}: rustls-webpki is present`);
    for (const verifier of verifiers) {
      assert.ok(atLeast(verifier.version, "0.103.16"), `${relative}: rustls-webpki ${verifier.version} lacks the emSign intermediate rejection`);
    }
  }
});

test("all Deepwell and WWS image variants refresh OS roots in builder and runtime stages", () => {
  const dockerfiles = [
    "../../../install/local/deepwell/Dockerfile",
    "../../../install/local/wws/Dockerfile",
    "../../../install/dev/deepwell/Dockerfile",
    "../../../install/dev/wws/Dockerfile",
    "../../../install/prod/deepwell/Dockerfile",
    "../../../install/prod/wws/Dockerfile",
  ];
  for (const relative of dockerfiles) {
    const source = read(relative);
    const stages = source.split(/^FROM\s+/m).slice(1);
    assert.ok(stages.length > 0, `${relative}: image stages are present`);
    const builder = stages[0];
    assert.match(builder, /apt-get install -y --no-install-recommends ca-certificates/u, `${relative}: builder refreshes roots`);
    assert.match(builder, /update-ca-certificates/u, `${relative}: builder activates the updated roots`);
    assert.ok(builder.indexOf("RUN apt-get update &&") < builder.indexOf("rustup-init"), `${relative}: CA refresh precedes the rustup download`);
    for (const stage of stages.slice(1)) {
      assert.match(stage, /apt-get install -y --no-install-recommends ca-certificates/u, `${relative}: final stage refreshes roots`);
      assert.match(stage, /update-ca-certificates/u, `${relative}: final stage activates the updated roots`);
    }
  }
});


test("Alpine-based infrastructure images refresh the OS CA bundle before use", () => {
  const dockerfiles = [
    "../../../install/prod/caddy/Dockerfile",
    "../../../install/local/caddy/Dockerfile",
    "../../../install/dev/caddy/Dockerfile",
    "../../../install/prod/framerail/Dockerfile",
    "../../../install/local/framerail/Dockerfile",
    "../../../install/dev/framerail/Dockerfile",
    "../../../install/local/postgres/Dockerfile",
    "../../../install/dev/postgres/Dockerfile",
    "../../../install/local/valkey/Dockerfile",
    "../../../install/dev/valkey/Dockerfile",
  ];
  for (const relative of dockerfiles) {
    const source = read(relative);
    assert.match(source, /apk add --no-cache --upgrade ca-certificates ca-certificates-bundle/u, `${relative}: refreshes the pinned base image CA bundle`);
  }
  for (const relative of ["../../../install/prod/caddy/Dockerfile", "../../../install/local/caddy/Dockerfile", "../../../install/dev/caddy/Dockerfile"]) {
    const source = read(relative);
    assert.equal((source.match(/apk add --no-cache --upgrade ca-certificates ca-certificates-bundle/g) ?? []).length, 2, `${relative}: refreshes roots in both the build and runtime stages`);
  }
});

test("Silo runtime copies the refreshed trust bundle into its package-manager-free image", () => {
  const source = read("../../../install/local/silo/Dockerfile");
  assert.match(source, /FROM debian:trixie-slim@sha256:[0-9a-f]{64} AS ca-bundle/u);
  assert.match(source, /apt-get install -y --no-install-recommends ca-certificates/u);
  assert.match(source, /update-ca-certificates/u);
  assert.match(source, /COPY --from=ca-bundle \/etc\/ssl\/certs\/ca-certificates\.crt \/etc\/ssl\/certs\/ca-certificates\.crt/u);
});
