#!/usr/bin/env bash
#
# Run path-focused local validation for the files you actually changed. The
# default checkpoint does not compile Cargo targets; --final adds the complete
# candidate barrier.
#
# The point is to fail here rather than eight minutes into a CI run. Which
# checks apply is decided by .github/scripts/classify-changes.mjs, the same
# script the consolidated-validation workflow uses, so this cannot drift from CI's own idea of what a
# change touches.
#
# Usage:
#   scripts/preflight.sh [--base <ref>] [--final] [--groups <a,b>] [--jobs <n>] [--list]
#
#   --base <ref>    Compare against this ref instead of origin/develop.
#   --final         Run the complete candidate barrier, including Clippy, full
#                   tests, validators, and the Framerail production build.
#   --groups <a,b>  Run exactly these groups, whatever the change-set selects
#                   Unknown group names are refused. Without it, the
#                   groups come from the changes against the base.
#   --jobs <n>      Run up to n check groups at once (0: all; the default for
#                   --final, 1 otherwise), in two waves: the suites with
#                   wall-clock deadlines plus the compile-only lint groups,
#                   then the Deepwell tests beside the small Rust groups.
#                   Checks within a group stay in order, except the groups
#                   that opt into run_checks_concurrent; each Rust group
#                   builds in its own target directory.
#   --list          Print the selected groups and the checks, then exit.
#
# Exit code is non-zero if any check fails.

set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${REPO_ROOT}" || exit 1

BASE="origin/develop"
MODE="checkpoint"
LIST=false
ONLY_GROUPS=""
JOBS="${PREFLIGHT_JOBS:-}"
TEST_NETWORK_GUARD="${REPO_ROOT}/scripts/run-test-no-external-network.sh"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --base) BASE="$2"; shift 2 ;;
    --final) MODE="final"; shift ;;
    --groups) ONLY_GROUPS="$2"; shift 2 ;;
    --jobs) JOBS="$2"; shift 2 ;;
    --list) LIST=true; shift ;;
    -h|--help) sed -n '2,/^# Exit code/p' "${BASH_SOURCE[0]}" | sed 's/^# \?//'; exit 0 ;;
    *) echo "preflight: unknown argument: $1" >&2; exit 2 ;;
  esac
done

if ! git rev-parse --verify --quiet "${BASE}" >/dev/null; then
  echo "preflight: base ref '${BASE}' not found; fetch it or pass --base" >&2
  exit 2
fi

MERGE_BASE="$(git merge-base HEAD "${BASE}")"

CHANGED_PATHS_FILE="$(mktemp)" || {
  echo "preflight: failed to create changed path file" >&2
  exit 2
}
trap 'rm -f -- "${CHANGED_PATHS_FILE}"' EXIT
if ! {
  git diff --no-renames --name-only -z "${MERGE_BASE}" HEAD &&
    git diff --no-renames --name-only -z HEAD &&
    git diff --no-renames --name-only -z --cached
} | sort -zu > "${CHANGED_PATHS_FILE}"; then
  echo "preflight: failed to collect changed paths" >&2
  exit 2
fi
mapfile -d '' -t CHANGED_PATHS < "${CHANGED_PATHS_FILE}"

list_is_query() {
  [[ ${#CHANGED_PATHS[@]} -eq 0 && -z "${ONLY_GROUPS}" && "${LIST}" != true ]]
}

if list_is_query; then
  echo "preflight: no changes against ${BASE}; nothing to check"
  exit 0
fi

if ! SELECTED="$(printf '%s\0' "${CHANGED_PATHS[@]}" | node .github/scripts/classify-changes.mjs)"; then
  echo "preflight: failed to classify changed paths" >&2
  exit 2
fi
if [[ -n "${ONLY_GROUPS}" ]]; then
  for requested in ${ONLY_GROUPS//,/ }; do
    if ! grep -q "^${requested}=" <<<"${SELECTED}"; then
      echo "preflight: unknown group in --groups: ${requested}" >&2
      exit 2
    fi
  done
  RESTRICTED=""
  while IFS='=' read -r group value; do
    [[ ",${ONLY_GROUPS}," == *",${group},"* ]] && value=true || value=false
    RESTRICTED+="${group}=${value}"$'\n'
  done <<<"${SELECTED}"
  SELECTED="${RESTRICTED%$'\n'}"
fi
group_selected() { grep -qx "$1=true" <<<"${SELECTED}"; }

echo "preflight: ${BASE}...HEAD"
echo "preflight: mode: ${MODE}"
echo "preflight: ${#CHANGED_PATHS[@]} changed path(s)"
echo "preflight: groups: $(tr '\n' ' ' <<<"${SELECTED}")"

if [[ -z "${JOBS}" ]]; then
  if [[ "${MODE}" == "final" ]]; then JOBS=0; else JOBS=1; fi
fi
if ! [[ "${JOBS}" =~ ^[0-9]+$ ]]; then
  echo "preflight: --jobs must be a non-negative integer" >&2
  exit 2
fi

PREFLIGHT_TARGET_ROOT="${PREFLIGHT_TARGET_ROOT:-${XDG_STATE_HOME:-${HOME}/.local/state}/wikijump/preflight-target}"

if [[ "${LIST}" != true ]]; then
  if { group_selected deepwell || group_selected wws; } && ! command -v cargo >/dev/null 2>&1; then
    echo "preflight: cargo not found on PATH; the Rust check groups need it — run from a login shell or add \$HOME/.cargo/bin to PATH" >&2
    exit 2
  fi
  if group_selected deepwell && ! command -v sqlx >/dev/null 2>&1; then
    echo "preflight: sqlx not found on PATH; the Deepwell test stack runs sqlx migrate — run from a login shell or add \$HOME/.cargo/bin to PATH" >&2
    exit 2
  fi
fi

FAILED=()
run() {
  local name="$1"; shift
  if "${LIST}"; then
    echo "  would run: ${name}"
    return 0
  fi
  echo ""
  echo "=== ${name}"
  local started="${SECONDS}"
  if "$@"; then
    echo "--- ${name}: ok ($((SECONDS - started))s)"
  else
    echo "--- ${name}: FAILED ($((SECONDS - started))s)"
    FAILED+=("${name}")
  fi
}

run_test() {
  local name="$1"; shift
  run "${name}" "${TEST_NETWORK_GUARD}" "$@"
}

run_checks_concurrent() {
  local dir fn pid
  dir="$(mktemp -d)" || return 1
  local -a pids=()
  for fn in "$@"; do
    (
      FAILED=()
      "${fn}"
      : > "${dir}/${fn}.failed"
      (( ${#FAILED[@]} == 0 )) || printf '%s\n' "${FAILED[@]}" > "${dir}/${fn}.failed"
    ) > "${dir}/${fn}.log" 2>&1 &
    pids+=("$!")
  done
  for pid in "${pids[@]}"; do wait "${pid}"; done
  for fn in "$@"; do
    cat "${dir}/${fn}.log"
    if [[ -s "${dir}/${fn}.failed" ]]; then
      local -a part=()
      mapfile -t part < "${dir}/${fn}.failed"
      FAILED+=("${part[@]}")
    fi
  done
  rm -rf -- "${dir}"
}

group_theme_lab() {
  if group_selected theme_lab; then
    run "Theme Lab tests" scripts/run-browser-test-no-external-network.sh npm --prefix install/local/theme-lab test
    if [[ "${MODE}" == "final" ]]; then
      run_test "Theme Lab Python tests" python3 -m unittest discover -s install/local/theme-lab/tests -p 'test_*.py'
    fi
  fi
}

group_workflow() {
  if group_selected workflow; then
    run "actionlint" bash -c \
      'command -v actionlint >/dev/null && actionlint || echo "actionlint not installed; skipped"'
    run_test "workflow policy" bash -c 'node --test .github/tests/*.test.mjs'
  fi
}

check_wikidot_verification_tests() {
  run_test "wikidot verification tests" pnpm --dir install/local/wikidot-verification test
}

check_standing_runtime_tests() {
  run_test "standing runtime tests" python3 -m unittest discover -s install/standing/tests -p 'test_*.py'
}

group_verification() {
  if group_selected verification && [[ "${MODE}" == "final" ]]; then
    if "${LIST}" || [[ "${JOBS}" == 1 ]]; then
      check_wikidot_verification_tests
      check_standing_runtime_tests
    else
      # Independent suites with separate outputs; in series they summed to
      # the wave's critical path while the other groups waited.
      run_checks_concurrent \
        check_wikidot_verification_tests \
        check_standing_runtime_tests
    fi
  fi
}

group_deepwell_lint() {
  # Clippy beside the test build needs its own target directory: cargo locks
  # a target directory, so a shared one would serialize the two.
  if [[ "${JOBS}" != 1 ]]; then export CARGO_TARGET_DIR="${PREFLIGHT_TARGET_ROOT}/deepwell-lint"; fi
  if group_selected deepwell; then
    run "deepwell fmt" cargo fmt --manifest-path deepwell/Cargo.toml --check
    if [[ "${MODE}" == "final" ]]; then
      run "deepwell dependencies" cargo machete deepwell
      run "deepwell clippy" cargo clippy --manifest-path deepwell/Cargo.toml --tests --no-deps -- -D warnings
    fi
  fi
}

group_deepwell() {
  # Beside the lint group, the test build needs its own target directory:
  # cargo locks a target directory, so a shared one would serialize the
  # two. The integration runner inherits CARGO_TARGET_DIR from here.
  if [[ "${JOBS}" != 1 ]]; then export CARGO_TARGET_DIR="${PREFLIGHT_TARGET_ROOT}/deepwell-test"; fi
  if group_selected deepwell && [[ "${MODE}" == "final" ]]; then
    # Nextest partitions, each on its own task-owned stack, side by side.
    run_test "deepwell full tests" env WIKIJUMP_DEEPWELL_TEST_SHARDS="${WIKIJUMP_DEEPWELL_TEST_SHARDS:-12}" node \
      install/local/wikidot-verification/scripts/run-deepwell-integration-validation.mjs
  fi
}

group_wws() {
  # Beside Deepwell, a Rust group builds in its own target directory: cargo
  # locks a target directory, so a shared one would serialize the groups.
  if [[ "${JOBS}" != 1 ]]; then export CARGO_TARGET_DIR="${PREFLIGHT_TARGET_ROOT}/wws"; fi
  if group_selected wws; then
    run "wws fmt" cargo fmt --manifest-path wws/Cargo.toml --check
    if [[ "${MODE}" == "final" ]]; then
      run "wws dependencies" cargo machete wws
      run "wws clippy" cargo clippy --manifest-path wws/Cargo.toml --tests --no-deps -- -D warnings
      run_test "wws full tests" cargo test --manifest-path wws/Cargo.toml --locked --all-features -- --nocapture --test-threads 1
      run_test "wws resize iframe tests" node --test wws/tests/resize-iframe.test.mjs
    fi
  fi
}

group_framerail_lint() {
  if group_selected framerail; then
    run "framerail lint" pnpm --dir framerail lint
  fi
}

group_framerail() {
  # The unit tests and the build both regenerate .svelte-kit, so they stay in
  # one job.
  if group_selected framerail; then
    run_test "framerail unit tests" pnpm --dir framerail test:unit
    if [[ "${MODE}" == "final" ]]; then
      run "framerail build" pnpm --dir framerail build
    fi
  fi
}

group_locales() {
  # Beside Deepwell, a Rust group builds in its own target directory: cargo
  # locks a target directory, so a shared one would serialize the groups.
  if [[ "${JOBS}" != 1 ]]; then export CARGO_TARGET_DIR="${PREFLIGHT_TARGET_ROOT}/locales"; fi
  if group_selected locales; then
    run "locales fmt" cargo fmt --manifest-path locales/validator/Cargo.toml --all -- --check
    if [[ "${MODE}" == "final" ]]; then
      run "locales clippy" cargo clippy --manifest-path locales/validator/Cargo.toml --locked --tests --no-deps -- -A unused -D warnings
      run "locales validator" cargo run --manifest-path locales/validator/Cargo.toml --locked
    fi
  fi
}

GROUP_ORDER=(theme_lab workflow verification deepwell_lint deepwell wws framerail_lint framerail locales)

if "${LIST}" || [[ "${JOBS}" == 1 ]]; then
  for group in "${GROUP_ORDER[@]}"; do "group_${group}"; done
else
  # Each group runs in its own job with its own log; logs are printed in the
  # fixed group order once every job has finished.
  GROUP_DIR="$(mktemp -d)" || exit 2
  trap 'rm -rf -- "${CHANGED_PATHS_FILE}" "${GROUP_DIR}"' EXIT
  declare -A GROUP_OF_PID=()
  running=0
  finish_one() {
    local pid
    wait -n -p pid
    running=$((running - 1))
    echo "preflight: finished group ${GROUP_OF_PID[${pid}]}"
  }
  # Two waves. The test suites that give subprocesses and timers wall-clock
  # deadlines run first, without the Deepwell shards: beside them they missed
  # those deadlines. The compile-only Deepwell lint group runs here too: its
  # full-crate Clippy build beside the shards starved them (in the
  # 2026-10-24 standing promotion the Deepwell tests took 893s against
  # ~160s of uncontended shard execution). The Deepwell tests then run
  # beside only the small Rust groups.
  WAVES=(
    "theme_lab workflow verification deepwell_lint framerail_lint framerail"
    "deepwell wws locales"
  )
  for wave in "${WAVES[@]}"; do
    for group in ${wave}; do
      if [[ "${JOBS}" != 0 ]] && (( running >= JOBS )); then finish_one; fi
      (
        FAILED=()
        "group_${group}"
        : > "${GROUP_DIR}/${group}.failed"
        (( ${#FAILED[@]} == 0 )) || printf '%s\n' "${FAILED[@]}" > "${GROUP_DIR}/${group}.failed"
      ) > "${GROUP_DIR}/${group}.log" 2>&1 &
      GROUP_OF_PID[$!]="${group}"
      running=$((running + 1))
    done
    while (( running > 0 )); do finish_one; done
  done
  for group in "${GROUP_ORDER[@]}"; do
    cat "${GROUP_DIR}/${group}.log"
    if [[ -s "${GROUP_DIR}/${group}.failed" ]]; then
      mapfile -t group_failed < "${GROUP_DIR}/${group}.failed"
      FAILED+=("${group_failed[@]}")
    elif [[ ! -e "${GROUP_DIR}/${group}.failed" ]]; then
      FAILED+=("${group} (group exited before reporting)")
    fi
  done
fi

if "${LIST}"; then
  exit 0
fi

echo ""
if [[ ${#FAILED[@]} -gt 0 ]]; then
  echo "preflight: FAILED: ${FAILED[*]}"
  exit 1
fi
echo "preflight: all selected checks passed"
