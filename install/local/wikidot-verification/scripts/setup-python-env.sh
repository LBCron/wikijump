#!/bin/sh
set -eu

ROOT=$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)
VENV="$ROOT/.venv"
SOURCE_ROOT=$(mktemp -d "${TMPDIR:-/tmp}/wikidot-python-source.XXXXXX")
SETUP_COMPLETE=0
UV_BIN=${UV_BIN:-uv}
PYPI_INDEX_URL=https://pypi.org/simple/

cleanup() {
  rm -rf -- "$SOURCE_ROOT"
  if [ "$SETUP_COMPLETE" -ne 1 ]; then
    rm -rf -- "$VENV"
  fi
}
trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

WIKIDOT_REQUIREMENT=$(grep -E '^wikidot @ git\+https://github\.com/Rokurolize/wikidot\.py@[0-9a-f]{40}$' "$ROOT/requirements.txt" || true)
WIKIDOT_REQUIREMENT_COUNT=$(printf '%s\n' "$WIKIDOT_REQUIREMENT" | sed '/^$/d' | wc -l | tr -d ' ')
if [ "$WIKIDOT_REQUIREMENT_COUNT" -ne 1 ]; then
  echo "requirements.txt must contain exactly one full Rokurolize/wikidot.py commit pin" >&2
  exit 1
fi

WIKIDOT_COMMIT=${WIKIDOT_REQUIREMENT##*@}
WIKIDOT_REPOSITORY=${WIKIDOT_REQUIREMENT#*git+}
WIKIDOT_REPOSITORY=${WIKIDOT_REPOSITORY%@*}

grep -v '^wikidot @ git+' "$ROOT/requirements.txt" >"$SOURCE_ROOT/requirements-pypi.expected"
if ! cmp -s "$SOURCE_ROOT/requirements-pypi.expected" "$ROOT/requirements-pypi.txt"; then
  echo "requirements-pypi.txt must match requirements.txt except for the wikidot.py source pin" >&2
  exit 1
fi
rm -f -- "$SOURCE_ROOT/requirements-pypi.expected"

if ! command -v "$UV_BIN" >/dev/null 2>&1; then
  echo "uv >= 0.13.4 is required to bootstrap a current TLS trust bundle" >&2
  exit 1
fi
UV_VERSION=$("$UV_BIN" --version | awk 'NR == 1 { print $2 }')
if [ "$(printf '%s\n' 0.13.4 "$UV_VERSION" | sort -V | head -n 1)" != "0.13.4" ]; then
  echo "uv >= 0.13.4 is required; found ${UV_VERSION:-unknown}" >&2
  exit 1
fi

python3 -m venv --clear "$VENV"

"$UV_BIN" pip install \
  --python "$VENV/bin/python" \
  --default-index "$PYPI_INDEX_URL" \
  --require-hashes \
  --requirements "$ROOT/requirements-bootstrap.lock"

"$VENV/bin/python" -m pip install \
  --require-hashes \
  --index-url "$PYPI_INDEX_URL" \
  --requirement "$ROOT/requirements.lock"

git init --quiet "$SOURCE_ROOT"
git -C "$SOURCE_ROOT" remote add origin "$WIKIDOT_REPOSITORY"
git -C "$SOURCE_ROOT" fetch --quiet --depth 1 origin "$WIKIDOT_COMMIT"
git -C "$SOURCE_ROOT" checkout --quiet --detach FETCH_HEAD

ACTUAL_COMMIT=$(git -C "$SOURCE_ROOT" rev-parse HEAD)
if [ "$ACTUAL_COMMIT" != "$WIKIDOT_COMMIT" ]; then
  echo "fetched wikidot.py commit does not match requirements.txt" >&2
  exit 1
fi

"$VENV/bin/python" -m pip install --no-deps --no-build-isolation "$SOURCE_ROOT"
SETUP_COMPLETE=1
