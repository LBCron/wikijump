#!/usr/bin/env bash
# Checks promotion activation against concurrent writers (real protocol).
#   ./check.sh            fixed (FIX) must PASS; incident (CUR) and restore
#                         (CUR) must FAIL with their own trace shapes; a
#                         no-rollback witness on FIX must FAIL (rollback is
#                         reachable in the fixed design, non-vacuity).
#   ./check.sh mutations  three one-element mutations of FIX must FAIL:
#                         catch-up moved before park, restore guard removed,
#                         receipt passing without the re-count.
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

tlc_run() { # name cfgfile [module]
  (cd "$WORK" && java -XX:+UseParallelGC -cp "$JAR" tlc2.TLC -deadlock -workers 8 \
      -config "$2" -metadir "$WORK/states-$1" "${3:-PromotionActivation}.tla") > "$WORK/$1.log" 2>&1
  return $?
}

expect_fail() { # name cfgfile [module]
  local start=$SECONDS
  tlc_run "$1" "$2" "${3:-}"; local rc=$?
  if [[ $rc -ne 0 ]] && grep -q 'violated' "$WORK/$1.log"; then
    echo "EXPECTED-FAIL $1 ($((SECONDS-start))s, $(grep -oE '[0-9,]+ distinct states found' "$WORK/$1.log" | head -1))"
    grep -m1 'violated' "$WORK/$1.log"
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
    echo "PASS $1 ($((SECONDS-start))s, $(grep -oE '[0-9,]+ distinct states found' "$WORK/$1.log" | head -1))"
    return 0
  fi
  echo "UNEXPECTED $1: expected TLC pass, got exit $rc" >&2
  cat "$WORK/$1.log" >&2
  return 1
}

# Trace-shape assertions: parse the TLC counterexample states, never a
# single grep value. Each must-fail config has its own shape.
shape_check() { # logfile kind
  python3 - "$1" "$2" <<'PY'
import re, sys
log, kind = open(sys.argv[1]).read(), sys.argv[2]
states = []
for chunk in re.split(r"^State \d+:.*$", log, flags=re.M)[1:]:
    def scalar(name):
        m = re.search(rf"/\\ {name} = (-?\d+|TRUE|FALSE|\"\w+\")", chunk)
        return m.group(1) if m else None
    def fmap(name):
        m = re.search(rf"/\\ {name} = \[p1 \|-> ([^,\]]+), p2 \|-> ([^\]]+)\]", chunk)
        if not m: return {}
        return {"p1": m.group(1).strip().strip('"'), "p2": m.group(2).strip().strip('"')}
    states.append({
        "verifiedStale": int(scalar("verifiedStale")), "preFlipWrite": scalar("preFlipWrite") == "TRUE",
        "flipped": scalar("flipped") == "TRUE", "outcome": (scalar("outcome") or "").strip('"'),
        "rev": {k: int(v) for k, v in fmap("rev").items()},
        "outVer": {k: int(v) for k, v in fmap("outVer").items()},
        "outGen": fmap("outGen"), "outTime": fmap("outTime"),
        "promoted": fmap("promoted"),
    })
assert states, "no states parsed"
final = states[-1]
if kind == "incident":
    # clean verify, then a write before the flip, ending in clean rollback
    iv = next(i for i, s in enumerate(states) if s["verifiedStale"] == 0)
    iw = next(i for i, s in enumerate(states) if i > iv and not s["flipped"] and s["rev"].get("p1", 1) >= 2)
    assert iw > iv and final["outcome"] == "rolledback" and final["preFlipWrite"], final
    print(f"incident shape ok: verify@{iv} write@{iw} rolledback@{len(states)-1}")
elif kind == "restore":
    # a post-flip rerender (new gen, post switch) regressed by the restore:
    # final state serves old-generator output older than the page's inputs
    regressed = [p for p in ("p1", "p2") if final["outGen"].get(p) == "old"
                 and final["outVer"].get(p, 0) < final["rev"].get(p, 0)]
    assert final["outcome"] == "rolledback" and regressed, final
    # the regressed page was promoted to the new generator at the flip,
    # then the restore put its older snapshot output back under the old one
    assert final["promoted"].get(regressed[0]) == "TRUE", final.get("promoted")
    assert any(s["flipped"] and s["outGen"].get(regressed[0]) == "new" for s in states), \
        "regressed page was never at the new generator in trace"
    print(f"restore shape ok: {regressed[0]} promoted, then restored to older output")
else:
    raise SystemExit(f"unknown shape {kind}")
PY
}

fixed_cfg() { # file design extra-invariants
  cat > "$1" <<EOF
CONSTANTS
  Design = "$2"
SPECIFICATION Spec
INVARIANT TypeOK
$3
EOF
}

if [[ "${1:-}" == "mutations" ]]; then
  python3 - "$WORK" <<'PY' || exit 2
import pathlib, sys
work = pathlib.Path(sys.argv[1])
src = (work / "PromotionActivation.tla").read_text()
def one(name, old, new):
    assert src.count(old) >= 1, f"{name} anchor missing"
    out = src.replace(old, new)
    assert out != src
    (work / f"{name}.tla").write_text(out.replace("MODULE PromotionActivation", f"MODULE {name}"))
    print(f"mutation {name}: {old!r} -> {new!r} ({src.count(old)} site(s), one element)")
# MA: no post-flip catch-up (the count's catch-up branch becomes false);
# a post-verify write followed by quiet then ends in rollback, so
# QuietSuccess -- the property that justifies the loop -- must fail
one("MA", 'Design = "FIX" /\\ retries < 3', 'FALSE')
# MB: restore guard removed (the compiled-at guard, one logical element)
one("MB", '(Design = "CUR" \\/ outTime[p] = "pre")', "TRUE")
# MC: receipt passing without the re-count (restart goes straight to commit)
one("MC", 'aheadVer\' = [p \\in Pages |-> 0] /\\ pc\' = "count"',
          'aheadVer\' = [p \\in Pages |-> 0] /\\ pc\' = "commit"')
PY
  for m in MA MB MC; do
    mkdir -p "$WORK/$m-dir" && cp "$WORK/$m.tla" "$WORK/$m-dir/"
    if [[ "$m" == "MA" ]]; then
      fixed_cfg "$WORK/$m-dir/$m.cfg" FIX 'PROPERTY QuietSuccess'
    else
      fixed_cfg "$WORK/$m-dir/$m.cfg" FIX 'INVARIANT NoPassWithStale
INVARIANT RollbackNoRegression
PROPERTY Termination'
    fi
    start=$SECONDS
    (cd "$WORK/$m-dir" && java -XX:+UseParallelGC -cp "$JAR" tlc2.TLC -deadlock -workers 8 \
        -config "$m.cfg" -metadir "$WORK/$m-dir/states" "$m.tla") > "$WORK/mutation-$m.log" 2>&1
    rc=$?
    if [[ $rc -ne 0 ]] && grep -q 'violated' "$WORK/mutation-$m.log"; then
      echo "EXPECTED-FAIL mutation-$m ($((SECONDS-start))s)"
      grep -m1 'violated' "$WORK/mutation-$m.log"
      # MA's config checks QuietSuccess alone, so its temporal failure is
      # attributable to QuietSuccess (TLC does not name temporal properties).
    else
      echo "MUTATION $m DID NOT FAIL (exit $rc)" >&2; cat "$WORK/mutation-$m.log" >&2; exit 1
    fi
  done
  exit 0
fi

# Fixed configuration: the real protocol must pass safety and liveness.
fixed_cfg "$WORK/Fixed.cfg" FIX 'INVARIANT NoPassWithStale
INVARIANT RollbackNoRegression
PROPERTY Termination
PROPERTY QuietSuccess'
# Incident configuration: pre-fix activation must fail the incident shape.
fixed_cfg "$WORK/Incident.cfg" CUR 'INVARIANT CleanVerifyNoRollback'
# Restore configuration: pre-fix restore rule must regress a rerendered page.
fixed_cfg "$WORK/Restore.cfg" CUR 'INVARIANT RestoreRegressionFree'
# Non-vacuity witness: rollback must be reachable in the fixed design.
fixed_cfg "$WORK/Witness.cfg" FIX 'INVARIANT NeverRolledback'

status=0
expect_pass fixed Fixed.cfg || status=1
expect_fail incident Incident.cfg || status=1
shape_check "$WORK/incident.log" incident || status=1
expect_fail restore Restore.cfg || status=1
shape_check "$WORK/restore.log" restore || status=1
expect_fail witness Witness.cfg || status=1
exit $status
