#!/usr/bin/env bash
# Checks promotion activation against concurrent writers.
#   ./check.sh            incident (D0) must FAIL, gate (D1) must FAIL,
#                         fixed (D2) must PASS. Exit 0 only then.
#   ./check.sh mutations  both Step-3 mutations of the fixed design must FAIL.
# Exit 2: code drifted from the model's anchors, or toolchain missing.
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

WORK="${PROMOTION_ACTIVATION_WORK:-$(mktemp -d)}"
mkdir -p "$WORK"
[[ -n "${PROMOTION_ACTIVATION_WORK:-}" ]] || trap 'rm -rf "$WORK"' EXIT
cp "$HERE/PromotionActivation.tla" "$WORK/"
python3 -I "$HERE/extract.py" || exit 2

tlc_run() { # name cfgfile -> tlc exit code; log at $WORK/<name>.log
  (cd "$WORK" && java -XX:+UseParallelGC -cp "$JAR" tlc2.TLC -deadlock -workers 1 \
      -config "$2" -metadir "$WORK/states-$1" PromotionActivation.tla) > "$WORK/$1.log" 2>&1
  return $?
}

expect_fail() { # name cfgfile
  local start=$SECONDS
  tlc_run "$1" "$2"; local rc=$?
  if [[ $rc -ne 0 ]] && grep -q 'is violated' "$WORK/$1.log"; then
    echo "EXPECTED-FAIL $1 ($((SECONDS-start))s, $(grep -oE '[0-9]+ distinct states found' "$WORK/$1.log" | head -1))"
    grep -m1 'is violated' "$WORK/$1.log"
    return 0
  fi
  echo "UNEXPECTED $1: expected a TLC violation, got exit $rc" >&2
  cat "$WORK/$1.log" >&2
  return 1
}

expect_pass() { # name cfgfile
  local start=$SECONDS
  tlc_run "$1" "$2"; local rc=$?
  if [[ $rc -eq 0 ]]; then
    echo "PASS $1 ($((SECONDS-start))s, $(grep -oE '[0-9]+ distinct states found' "$WORK/$1.log" | head -1))"
    return 0
  fi
  echo "UNEXPECTED $1: expected TLC pass, got exit $rc" >&2
  cat "$WORK/$1.log" >&2
  return 1
}

if [[ "${1:-}" == "mutations" ]]; then
  python3 - "$WORK" <<'PY' || exit 2
import pathlib, sys
work = pathlib.Path(sys.argv[1])
src = (work / "PromotionActivation.tla").read_text()
# M1: split atomic CheckFlip into CheckOnly + FlipOnly (writer lands between).
m1 = src.replace('pc\' = IF Design = "D2" THEN "checkflip" ELSE "flip"',
                 'pc\' = IF Design = "D2" THEN "checkonly" ELSE "flip"')
m1 = m1.replace("""CheckFlip ==""",
"""CheckOnly ==
    /\\ pc = "checkonly" /\\ outcome = "running" /\\ Design = "D2"
    /\\ pc' = "fliponly" /\\ fence' = "open"
    /\\ UNCHANGED <<rev, ahead, active, verifiedStale, gate, queue,
                   postFlipWrites, outcome, retries, crashed, flipClean,
                   impLeft, snap, rendered, cur>>
FlipOnly ==
    /\\ pc = "fliponly" /\\ outcome = "running"
    /\\ active' = "new" /\\ flipClean' = (StaleCount = 0)
    /\\ outcome' = "activated" /\\ pc' = "done"
    /\\ UNCHANGED <<rev, ahead, verifiedStale, gate, fence, queue,
                   postFlipWrites, retries, crashed, impLeft, snap,
                   rendered, cur>>
CheckFlip ==""")
m1 = m1.replace("CheckFlip \\/ CatchUp", "CheckFlip \\/ CheckOnly \\/ FlipOnly \\/ CatchUp")
if m1 == src: raise SystemExit("mutation M1 anchor not found")
(work / "M1.tla").write_text(m1.replace("MODULE PromotionActivation", "MODULE M1"))
# M2: remove the short fence: import ignores fence, CheckFlip trusts the
# pre-check snapshot (verifiedStale) instead of re-reading at flip time.
m2 = src.replace('/\\ impLeft > 0 /\\ fence = "open"', '/\\ impLeft > 0')
m2 = m2.replace("IF StaleCount = 0\n         THEN /\\ active' = \"new\" /\\ flipClean' = TRUE",
                "IF verifiedStale = 0\n         THEN /\\ active' = \"new\" /\\ flipClean' = (StaleCount = 0)")
assert m2.count("verifiedStale = 0\n") >= 1
if m2 == src: raise SystemExit("mutation M2 anchor not found")
(work / "M2.tla").write_text(m2.replace("MODULE PromotionActivation", "MODULE M2"))
print("mutations generated")
PY
  for m in M1 M2; do
    cat > "$WORK/$m.cfg" <<EOF
CONSTANTS
  Design = "D2"
  MaxRetries = 2
SPECIFICATION Spec
INVARIANT TypeOK
INVARIANT NoStaleFlip
EOF
    # TLC needs the module file named after the module in its own dir.
    mkdir -p "$WORK/$m-dir" && cp "$WORK/$m.tla" "$WORK/$m-dir/" && cp "$WORK/$m.cfg" "$WORK/$m-dir/"
    start=$SECONDS
    (cd "$WORK/$m-dir" && java -XX:+UseParallelGC -cp "$JAR" tlc2.TLC -deadlock -workers 1 \
        -config "$m.cfg" -metadir "$WORK/$m-dir/states" "$m.tla") > "$WORK/$m.log" 2>&1
    rc=$?
    if [[ $rc -ne 0 ]] && grep -q 'is violated' "$WORK/$m.log"; then
      echo "EXPECTED-FAIL mutation $m ($((SECONDS-start))s)"
      grep -m1 'is violated' "$WORK/$m.log"
    else
      echo "MUTATION $m DID NOT FAIL (exit $rc) -- pilot result, see FINDINGS.md" >&2
      cat "$WORK/$m.log" >&2
      exit 1
    fi
  done
  exit 0
fi

# Incident configuration: current behavior (Step 0 finds no gate in the code).
cat > "$WORK/Incident.cfg" <<'EOF'
CONSTANTS
  Design = "D0"
  MaxRetries = 2
SPECIFICATION Spec
INVARIANT TypeOK
INVARIANT CleanVerifyNoAbort
EOF
# Gate configuration: cooperating-lane gate only (fan-out stays ungated).
cat > "$WORK/Gate.cfg" <<'EOF'
CONSTANTS
  Design = "D1"
  MaxRetries = 2
SPECIFICATION Spec
INVARIANT TypeOK
INVARIANT CleanVerifyNoAbort
EOF
# Fixed configuration: catch-up + atomic check-and-flip under a short fence.
cat > "$WORK/Fixed.cfg" <<'EOF'
CONSTANTS
  Design = "D2"
  MaxRetries = 2
SPECIFICATION Spec
INVARIANT TypeOK
INVARIANT NoStaleFlip
INVARIANT RollbackRestores
INVARIANT NoLostWrite
PROPERTY Termination
PROPERTY QuietSuccess
PROPERTY FenceReopens
EOF

status=0
expect_fail incident Incident.cfg || status=1
# The incident counterexample must show a clean verify (0 stale) first.
if ! grep -q 'verifiedStale = 0' "$WORK/incident.log"; then
  echo "incident trace lacks verifiedStale = 0; wrong counterexample shape" >&2
  status=1
fi
expect_fail gate Gate.cfg || status=1
expect_pass fixed Fixed.cfg || status=1
exit $status
