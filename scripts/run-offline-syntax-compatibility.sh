#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if [[ "${WIKIJUMP_TEST_NETWORK_GUARD_ACTIVE:-}" != "1" ]]; then
  export WIKIJUMP_OFFLINE_CARGO="$(rustup which --toolchain 1.99.1 cargo)"
  export WIKIJUMP_OFFLINE_RUSTC="$(rustup which --toolchain 1.99.1 rustc)"
  export WIKIJUMP_OFFLINE_RUSTDOC="$(rustup which --toolchain 1.99.1 rustdoc)"
  exec "${ROOT}/scripts/run-test-no-external-network.sh" "$0" "$@"
fi

CARGO="${WIKIJUMP_OFFLINE_CARGO:-$(command -v cargo)}"
RUSTC="${WIKIJUMP_OFFLINE_RUSTC:-$(command -v rustc)}"
RUSTDOC="${WIKIJUMP_OFFLINE_RUSTDOC:-$(command -v rustdoc)}"
if [[ ! -x "${CARGO}" || ! -x "${RUSTC}" || ! -x "${RUSTDOC}" ]]; then
  echo "offline syntax compatibility requires executable Cargo, rustc, and rustdoc paths" >&2
  exit 2
fi
export RUSTC
export RUSTDOC

OUTPUT="${1:-}"
TMP=""
if [[ -z "${OUTPUT}" ]]; then
  TMP="$(mktemp -d "${TMPDIR:-/tmp}/wikijump-offline-syntax.XXXXXX")"
  trap 'rm -rf -- "${TMP}"' EXIT
  OUTPUT="${TMP}/verdict.json"
fi

"${CARGO}" build \
  --offline \
  --locked \
  --manifest-path "${ROOT}/deepwell/Cargo.toml" \
  --bin wikidot_syntax_renderer

TARGET_DIR="$("${CARGO}" metadata \
  --offline \
  --locked \
  --no-deps \
  --format-version 1 \
  --manifest-path "${ROOT}/deepwell/Cargo.toml" \
  | jq -r .target_directory)"

node "${ROOT}/install/local/wikidot-verification/scripts/run-syntax-differential.mjs" \
  --references "${ROOT}/install/local/wikidot-verification/fixtures/syntax-differential/preview-references.jsonl" \
  --renderer "${TARGET_DIR}/debug/wikidot_syntax_renderer" \
  --output "${OUTPUT}"

if [[ -z "${TMP}" ]]; then
  printf '%s\n' "offline syntax verdict: ${OUTPUT}"
fi
