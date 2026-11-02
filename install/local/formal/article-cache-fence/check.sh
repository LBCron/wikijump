#!/usr/bin/env bash
# Checks the public-content fence of the anonymous article caches against
# the current source tree. Exit 0: every property holds. Exit 1: TLC found
# a violation (counterexample printed). Exit 2: the code drifted from the
# model's anchors, or the toolchain is missing.
set -uo pipefail

TLA_VERSION=1.7.4
TLA_SHA256=936a262061c914694dfd669a543be24573c45d5aa0ff20a8b96b23d01e050e88
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
JAR="${TLA2TOOLS_JAR:-$HOME/.cache/tlaplus/$TLA_VERSION/tla2tools.jar}"

command -v java >/dev/null || { echo "java not found (TLC needs Java 11+)" >&2; exit 2; }
if [[ ! -f "$JAR" ]]; then
  mkdir -p "$(dirname "$JAR")"
  curl -fsSL -o "$JAR" "https://github.com/tlaplus/tlaplus/releases/download/v$TLA_VERSION/tla2tools.jar" || exit 2
fi
echo "$TLA_SHA256  $JAR" | sha256sum -c --quiet - || { echo "tla2tools.jar checksum mismatch" >&2; exit 2; }

WORK="${ARTICLE_CACHE_FENCE_WORK:-$(mktemp -d)}"
mkdir -p "$WORK"
[[ -n "${ARTICLE_CACHE_FENCE_WORK:-}" ]] || trap 'rm -rf "$WORK"' EXIT
cp "$HERE/ArticleCacheFence.tla" "$WORK/"
python3 -I "$HERE/extract.py" "$WORK" || exit 2

status=0
for invariant in DeepwellCacheFresh FramerailCacheFresh; do
  { cat "$WORK/MC.cfg"; echo "INVARIANT TypeOK"; echo "INVARIANT $invariant"; } > "$WORK/$invariant.cfg"
  (cd "$WORK" && java -XX:+UseParallelGC -cp "$JAR" tlc2.TLC -deadlock -workers 1 \
      -config "$invariant.cfg" -metadir "$WORK/states-$invariant" MC.tla) > "$WORK/$invariant.log" 2>&1
  tlc=$?
  if [[ $tlc -eq 0 ]]; then
    echo "PASS  $invariant ($(grep -oE '[0-9]+ distinct states found' "$WORK/$invariant.log" | head -1))"
  elif grep -q 'is violated' "$WORK/$invariant.log"; then
    status=1
    echo "FAIL  $invariant"
    sed -n '/is violated/,/^[0-9]* states generated/p' "$WORK/$invariant.log"
  else
    echo "ERROR $invariant: TLC exited $tlc without a counterexample" >&2
    cat "$WORK/$invariant.log" >&2
    exit 2
  fi
done
exit $status
