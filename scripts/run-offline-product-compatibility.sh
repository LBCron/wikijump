#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
GUARD="${ROOT}/scripts/run-test-no-external-network.sh"

cd "${ROOT}"

export WIKIJUMP_OFFLINE_CARGO="$(rustup which --toolchain 1.99.1 cargo)"
export RUSTC="$(rustup which --toolchain 1.99.1 rustc)"
export RUSTDOC="$(rustup which --toolchain 1.99.1 rustdoc)"

"${GUARD}" "${WIKIJUMP_OFFLINE_CARGO}" test \
  --offline \
  --locked \
  --manifest-path "${ROOT}/wws/Cargo.toml" \
  --all-features \
  -- \
  --nocapture \
  --test-threads 1

pnpm --dir "${ROOT}/framerail" test:unit
pnpm --dir "${ROOT}/framerail" test

WIKIJUMP_DEEPWELL_TEST_SHARDS="${WIKIJUMP_DEEPWELL_TEST_SHARDS:-8}" \
  "${GUARD}" node \
  "${ROOT}/install/local/wikidot-verification/scripts/run-deepwell-integration-validation-sharded.mjs"
