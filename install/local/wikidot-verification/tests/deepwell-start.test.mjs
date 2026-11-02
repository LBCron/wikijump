import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import path from "node:path";
import {spawnSync} from "node:child_process";
import test from "node:test";
import {fileURLToPath} from "node:url";

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const START_SCRIPT = path.resolve(PACKAGE_ROOT, "..", "deepwell", "deepwell-start");

test("deepwell cargo-watch selects the compact, debugging, and release profiles", () => {
  const syntax = spawnSync("/bin/sh", ["-n", START_SCRIPT], {encoding: "utf8"});
  assert.equal(syntax.status, 0, syntax.stderr);

  const source = readFileSync(START_SCRIPT, "utf8");
  assert.match(source, /debugging\)\n\s+RUN_COMMAND="run --locked --profile debugging -- \/etc\/deepwell\.toml"/u);
  assert.match(source, /release\)\n\s+RUN_COMMAND="run --locked --release -- \/etc\/deepwell\.toml"/u);
  assert.match(source, /\*\)\n\s+echo "Unsupported DEEPWELL_BUILD_PROFILE/u);
  assert.match(source, /-w \/src\/\.cargo\/config\.toml/u);
  assert.match(source, /^ {8}-x "\$RUN_COMMAND"$/mu);
});

test("wws cargo-watch selects the compact, debugging, and release profiles", () => {
  const wwsStart = path.resolve(PACKAGE_ROOT, "..", "wws", "wws-start");
  const syntax = spawnSync("/bin/sh", ["-n", wwsStart], {encoding: "utf8"});
  assert.equal(syntax.status, 0, syntax.stderr);

  const source = readFileSync(wwsStart, "utf8");
  assert.match(source, /debugging\)\n\s+RUN_COMMAND="run --locked --profile debugging -- --disable-deepwell-check"/u);
  assert.match(source, /release\)\n\s+RUN_COMMAND="run --locked --release -- --disable-deepwell-check"/u);
  assert.match(source, /\*\)\n\s+echo "Unsupported WWS_BUILD_PROFILE/u);
  assert.match(source, /-w \/src\/\.cargo\/config\.toml/u);
});

test("local Docker development pins tools and keeps Rust caches scoped", () => {
  const compose = readFileSync(
    path.resolve(PACKAGE_ROOT, "..", "docker-compose.yaml"),
    "utf8",
  );
  const devCompose = readFileSync(
    path.resolve(PACKAGE_ROOT, "..", "docker-compose.dev.yaml"),
    "utf8",
  );
  const deepwellDockerfile = readFileSync(
    path.resolve(PACKAGE_ROOT, "..", "deepwell", "Dockerfile"),
    "utf8",
  );
  const wwsDockerfile = readFileSync(
    path.resolve(PACKAGE_ROOT, "..", "wws", "Dockerfile"),
    "utf8",
  );
  const framerailDockerfile = readFileSync(
    path.resolve(PACKAGE_ROOT, "..", "framerail", "Dockerfile"),
    "utf8",
  );

  assert.match(deepwellDockerfile, /FROM rust:1\.99\.1@sha256:[0-9a-f]{64}/u);
  assert.match(wwsDockerfile, /FROM rust:1\.99\.1@sha256:[0-9a-f]{64}/u);
  assert.match(framerailDockerfile, /FROM node:24\.22\.1-alpine@sha256:[0-9a-f]{64}/u);
  assert.match(framerailDockerfile, /npm install --global pnpm@11\.10\.0/u);
  assert.doesNotMatch(`${deepwellDockerfile}\n${wwsDockerfile}\n${framerailDockerfile}`, /:latest\b/u);
  assert.match(compose, /CARGO_BUILD_JOBS=\$\{CARGO_BUILD_JOBS:-2\}/gu);
  assert.equal((compose.match(/CARGO_BUILD_JOBS=\$\{CARGO_BUILD_JOBS:-2\}/gu) ?? []).length, 2);
  assert.match(compose, /CARGO_INCREMENTAL=1/u);
  assert.match(compose, /local-rust-1-99-1-target:\/src\/target/u);
  assert.match(compose, /local-rust-1-99-1-cargo-registry:\/usr\/local\/cargo\/registry/u);
  assert.match(compose, /local-rust-1-99-1-cargo-git:\/usr\/local\/cargo\/git/u);
  assert.doesNotMatch(devCompose, /source: .*\/target\s*$/mu);
  assert.match(devCompose, /source: \.\.\/\.\.\/\.cargo\/config\.toml/u);
});
