#!/usr/bin/env bash
set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
FIXTURE_ROOT="$(mktemp -d /tmp/wikidot-python-setup-test.XXXXXX)"
trap 'rm -rf -- "${FIXTURE_ROOT}"' EXIT

mkdir -p "${FIXTURE_ROOT}/project/scripts" "${FIXTURE_ROOT}/bin"
cp "${PROJECT_ROOT}/scripts/setup-python-env.sh" "${FIXTURE_ROOT}/project/scripts/"
cp "${PROJECT_ROOT}/requirements.lock" "${FIXTURE_ROOT}/project/"
cp "${PROJECT_ROOT}/requirements-bootstrap.lock" "${FIXTURE_ROOT}/project/"
cat >"${FIXTURE_ROOT}/project/requirements.txt" <<'REQUIREMENTS'
httpx==0.28.1
wikidot @ git+https://github.com/Rokurolize/wikidot.py@aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
REQUIREMENTS
cat >"${FIXTURE_ROOT}/project/requirements-pypi.txt" <<'REQUIREMENTS'
httpx==0.28.1
REQUIREMENTS

cat >"${FIXTURE_ROOT}/bin/python3" <<'PYTHON'
#!/usr/bin/env bash
set -euo pipefail
[[ "$1" == "-m" && "$2" == "venv" && "$3" == "--clear" && -n "$4" ]]
mkdir -p "$4/bin"
cat >"$4/bin/python" <<'VENV_PYTHON'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >>"${SETUP_TEST_LOG}"
VENV_PYTHON
chmod +x "$4/bin/python"
PYTHON
chmod +x "${FIXTURE_ROOT}/bin/python3"

cat >"${FIXTURE_ROOT}/bin/uv" <<'UV'
#!/usr/bin/env bash
set -euo pipefail
if [[ "$*" == "--version" ]]; then
  printf '%s\n' "${SETUP_TEST_UV_VERSION:-uv 0.13.4 (test fixture)}"
  exit 0
fi
printf '%s\n' "$*" >>"${SETUP_TEST_UV_LOG}"
UV
chmod +x "${FIXTURE_ROOT}/bin/uv"

cat >"${FIXTURE_ROOT}/bin/git" <<'GIT'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >>"${SETUP_TEST_GIT_LOG}"
if [[ "$1" == "init" ]]; then
  mkdir -p "${3}/.git"
  exit 0
fi
if [[ "$1" == "-C" && "$3" == "rev-parse" && "$4" == "HEAD" ]]; then
  printf '%s\n' "${SETUP_TEST_COMMIT}"
fi
GIT
chmod +x "${FIXTURE_ROOT}/bin/git"

SETUP_TEST_LOG="${FIXTURE_ROOT}/pip-arguments" \
SETUP_TEST_GIT_LOG="${FIXTURE_ROOT}/git-arguments" \
SETUP_TEST_UV_LOG="${FIXTURE_ROOT}/uv-arguments" \
SETUP_TEST_COMMIT="aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" \
PATH="${FIXTURE_ROOT}/bin:${PATH}" \
  "${FIXTURE_ROOT}/project/scripts/setup-python-env.sh"

mapfile -t pip_arguments <"${FIXTURE_ROOT}/pip-arguments"
[[ "${#pip_arguments[@]}" == 2 ]]
[[ "${pip_arguments[0]}" == "-m pip install --require-hashes --index-url https://pypi.org/simple/ --requirement ${FIXTURE_ROOT}/project/requirements.lock" ]]
[[ "${pip_arguments[1]}" =~ ^-m\ pip\ install\ --no-deps\ --no-build-isolation\ /tmp/wikidot-python-source\..+$ ]]
mapfile -t uv_arguments <"${FIXTURE_ROOT}/uv-arguments"
[[ "${#uv_arguments[@]}" == 1 ]]
[[ "${uv_arguments[0]}" == *"pip install --python ${FIXTURE_ROOT}/project/.venv/bin/python --default-index https://pypi.org/simple/ --require-hashes --requirements ${FIXTURE_ROOT}/project/requirements-bootstrap.lock"* ]]
source_root="${pip_arguments[1]##* }"
[[ -d "${FIXTURE_ROOT}/project/.venv" ]]
[[ ! -e "${source_root}" ]]

grep -F -- "remote add origin https://github.com/Rokurolize/wikidot.py" "${FIXTURE_ROOT}/git-arguments" >/dev/null
grep -F -- "fetch --quiet --depth 1 origin aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" "${FIXTURE_ROOT}/git-arguments" >/dev/null
grep -F -- "checkout --quiet --detach FETCH_HEAD" "${FIXTURE_ROOT}/git-arguments" >/dev/null
grep -F -- "rev-parse HEAD" "${FIXTURE_ROOT}/git-arguments" >/dev/null

: >"${FIXTURE_ROOT}/pip-arguments"
: >"${FIXTURE_ROOT}/git-arguments"
: >"${FIXTURE_ROOT}/uv-arguments"
if SETUP_TEST_LOG="${FIXTURE_ROOT}/pip-arguments" \
  SETUP_TEST_GIT_LOG="${FIXTURE_ROOT}/git-arguments" \
  SETUP_TEST_UV_LOG="${FIXTURE_ROOT}/uv-arguments" \
  SETUP_TEST_UV_VERSION="uv 0.13.3 (test fixture)" \
  SETUP_TEST_COMMIT="aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" \
  PATH="${FIXTURE_ROOT}/bin:${PATH}" \
  "${FIXTURE_ROOT}/project/scripts/setup-python-env.sh"; then
  echo "setup accepted an outdated uv TLS trust bundle" >&2
  exit 1
fi
[[ ! -s "${FIXTURE_ROOT}/uv-arguments" ]]
[[ ! -s "${FIXTURE_ROOT}/pip-arguments" ]]
[[ ! -s "${FIXTURE_ROOT}/git-arguments" ]]
[[ ! -e "${FIXTURE_ROOT}/project/.venv" ]]

: >"${FIXTURE_ROOT}/pip-arguments"
: >"${FIXTURE_ROOT}/git-arguments"
: >"${FIXTURE_ROOT}/uv-arguments"
if SETUP_TEST_LOG="${FIXTURE_ROOT}/pip-arguments" \
  SETUP_TEST_GIT_LOG="${FIXTURE_ROOT}/git-arguments" \
  SETUP_TEST_UV_LOG="${FIXTURE_ROOT}/uv-arguments" \
  SETUP_TEST_COMMIT="bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" \
  PATH="${FIXTURE_ROOT}/bin:${PATH}" \
  "${FIXTURE_ROOT}/project/scripts/setup-python-env.sh"; then
  echo "setup accepted a fetched commit that differed from the pinned commit" >&2
  exit 1
fi
mapfile -t pip_arguments <"${FIXTURE_ROOT}/pip-arguments"
[[ "${#pip_arguments[@]}" == 1 ]]
[[ "${pip_arguments[0]}" == "-m pip install --require-hashes --index-url https://pypi.org/simple/ --requirement ${FIXTURE_ROOT}/project/requirements.lock" ]]
[[ ! -e "${FIXTURE_ROOT}/project/.venv" ]]

printf '%s\n' "httpx==0.28.2" >"${FIXTURE_ROOT}/project/requirements-pypi.txt"
rm -f "${FIXTURE_ROOT}/pip-arguments" "${FIXTURE_ROOT}/git-arguments"
if SETUP_TEST_LOG="${FIXTURE_ROOT}/pip-arguments" \
  SETUP_TEST_GIT_LOG="${FIXTURE_ROOT}/git-arguments" \
  SETUP_TEST_UV_LOG="${FIXTURE_ROOT}/uv-arguments" \
  SETUP_TEST_COMMIT="aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" \
  PATH="${FIXTURE_ROOT}/bin:${PATH}" \
  "${FIXTURE_ROOT}/project/scripts/setup-python-env.sh"; then
  echo "setup accepted divergent PyPI requirements" >&2
  exit 1
fi
[[ ! -e "${FIXTURE_ROOT}/pip-arguments" ]]
[[ ! -e "${FIXTURE_ROOT}/git-arguments" ]]
