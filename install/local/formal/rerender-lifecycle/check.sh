#!/usr/bin/env bash
# Checks the re-render / hosted text-block lifecycle against the source tree.
#   ./check.sh            current protocol: CommittedRowLive, the FIX restore
#                         and fan-out settling must PASS; NoDanglingRead and
#                         NoResurrect are known-failing findings (EXPECTED-FAIL
#                         with asserted trace shapes, model not tuned away);
#                         clone-paused must PASS, clone-unpaused and the CUR
#                         restore must FAIL with their shapes; crash, duplicate
#                         delivery, restore and clone witnesses must FAIL
#                         (reachable, so the passes above are not vacuous).
#   ./check.sh mutations  four one-element mutations must FAIL their property.
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

WORK="${RERENDER_LIFECYCLE_WORK:-$(mktemp -d)}"
mkdir -p "$WORK"
[[ -n "${RERENDER_LIFECYCLE_WORK:-}" ]] || trap 'rm -rf "$WORK"' EXIT
cp "$HERE/RerenderLifecycle.tla" "$WORK/"
python3 -I "$HERE/extract.py" || exit 2

tlc_run() { # name cfgfile [module] [dir]
  local dir="${4:-$WORK}"
  (cd "$dir" && java -XX:+UseParallelGC -cp "$JAR" tlc2.TLC -deadlock -workers 8 \
      -config "$2" -metadir "$dir/states-$1" "${3:-RerenderLifecycle}.tla") > "$WORK/$1.log" 2>&1
  return $?
}

expect_fail() { # name cfgfile [module] [dir]
  local start=$SECONDS
  tlc_run "$1" "$2" "${3:-}" "${4:-}"; local rc=$?
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
        return {k: v.strip().strip('"') for k, v in
                zip(("p1", "p2"), m.groups())} if m else {}
    def objs():
        m = re.search(r"/\\ objects = \{([^}]*)\}", chunk)
        return {int(x) for x in re.findall(r"\d+", m.group(1))} if m else set()
    states.append({
        "miss": scalar("miss") == "TRUE", "rPc": (scalar("rPc") or "").strip('"'),
        "rGen": int(scalar("rGen")), "objects": objs(),
        "blkVer": {k: int(v) for k, v in fmap("blkVer").items()},
        "maxBlk": {k: int(v) for k, v in fmap("maxBlk").items()},
        "rowGen": {k: int(v) for k, v in fmap("rowGen").items()},
        "cPc": (scalar("cPc") or "").strip('"'),
        "cloneGen": int(scalar("cloneGen")), "cloneDone": scalar("cloneDone") == "TRUE",
        "cloneObjs": objs(),
        "outTime": fmap("outTime"), "blkGen": fmap("blkGen"),
        "snapGen": (scalar("snapGen") or "").strip('"'),
        "restored": scalar("restored") == "TRUE", "rDone": scalar("rDone") == "TRUE",
        "snapOut": int(scalar("snapOut")),
    })
    m = re.search(r"/\\ cloneObjs = \{([^}]*)\}", chunk)
    states[-1]["cloneObjs"] = {int(x) for x in re.findall(r"\d+", m.group(1))} if m else set()
assert states, "no states parsed"
final = states[-1]
if kind == "dangling":
    # lookup of a live object, its post-commit deletion, then the fetch miss
    i = next(i for i, s in enumerate(states)
             if s["rPc"] == "fetch" and s["rGen"] in s["objects"])
    j = next(j for j, s in enumerate(states)
             if j > i and states[i]["rGen"] not in s["objects"])
    assert j > i and final["miss"], final
    print(f"dangling shape ok: lookup@{i} delete@{j} miss@{len(states)-1}")
elif kind == "resurrect":
    # a page first commits its newest output, then an older job commits over it
    assert any(final["blkVer"][p] < final["maxBlk"][p] for p in ("p1", "p2")), final
    p = next(p for p in ("p1", "p2") if final["blkVer"][p] < final["maxBlk"][p])
    assert any(s["blkVer"][p] == s["maxBlk"][p] == final["maxBlk"][p] for s in states), p
    print(f"resurrect shape ok: {p} newest committed, then overwritten by older job")
elif kind == "clone":
    # DB copy taken, a replacement commits and cleans up, bucket copy after
    i = next(i for i, s in enumerate(states) if s["cPc"] == "gotdb")
    assert final["cloneDone"] and final["cloneGen"] not in final["cloneObjs"], final
    assert any(s["rowGen"].get("p1") not in (None, final["cloneGen"]) for s in states[i:]), final
    print(f"clone shape ok: dbcopy@{i} clone names an object its bucket copy lacks")
elif kind == "restore":
    # a post-flip job replaced the blocks, then the unguarded restore
    # put the snapshot output back over the newer blocks
    assert final["rDone"] and final["restored"], final
    assert (final["blkVer"].get("p1") != final["snapOut"]
            or final["blkGen"].get("p1") != final["snapGen"]), final
    assert any(s["outTime"].get("p1") == "post" for s in states), final
    print("restore shape ok: snapshot output restored over post-flip blocks")
else:
    raise SystemExit(f"unknown shape {kind}")
PY
}

cfg() { # file restore clonepaused allowcrash cloneon restoreon readeron dupon fanout extra
  cat > "$1" <<EOF
CONSTANTS
  RestoreDesign = "$2"
  ClonePaused = $3
  AllowCrash = $4
  CloneOn = $5
  RestoreOn = $6
  ReaderOn = $7
  DupOn = $8
  FanoutOn = $9
SPECIFICATION Spec
INVARIANT TypeOK
${10}
EOF
}

if [[ "${1:-}" == "mutations" ]]; then
  python3 - "$WORK" <<'PY' || exit 2
import pathlib, sys
work = pathlib.Path(sys.argv[1])
src = (work / "RerenderLifecycle.tla").read_text()
def one(name, old, new):
    assert src.count(old) >= 1, f"{name} anchor missing"
    out = src.replace(old, new)
    assert out != src
    (work / f"{name}.tla").write_text(out.replace("MODULE RerenderLifecycle", f"MODULE {name}"))
    print(f"mutation {name}: {old!r} -> {new!r} ({src.count(old)} site(s), one element)")
# MA: delete before commit (cleanup runs on the uploaded, uncommitted job)
one("MA", 'jPc[j] = "committed"\n    /\\ objects\' = objects \\ {jPrev[j]}',
          'jPc[j] = "up"\n    /\\ objects\' = objects \\ {jPrev[j]}')
# MB: restore guard removed (the compiled-at guard, one logical element)
one("MB", '(RestoreDesign = "CUR" \\/ outTime["p1"] = "pre")', "TRUE")
# MC: skip the pause (writers are never frozen for the clone)
one("MC", 'Frozen == ClonePaused /\\ cPc = "gotdb"', "Frozen == FALSE")
# MD: drop the fresh-name guard (replacements reuse the live object name)
one("MD", "jNew' = [jNew EXCEPT ![j] = nextGen] /\\ nextGen' = nextGen + 1",
          "jNew' = [jNew EXCEPT ![j] = rowGen[JobPage[j]]] /\\ nextGen' = nextGen")
PY
  for m in MA MB MC MD; do
    mkdir -p "$WORK/$m-dir" && cp "$WORK/$m.tla" "$WORK/$m-dir/"
    case "$m" in
      MA|MD) cfg "$WORK/$m-dir/$m.cfg" FIX TRUE TRUE FALSE FALSE FALSE TRUE FALSE 'INVARIANT CommittedRowLive' ;;
      MB)    cfg "$WORK/$m-dir/$m.cfg" FIX TRUE FALSE FALSE TRUE FALSE FALSE FALSE 'INVARIANT RestorePairsOwnBlocks' ;;
      MC)    cfg "$WORK/$m-dir/$m.cfg" FIX TRUE FALSE TRUE FALSE FALSE FALSE FALSE 'INVARIANT CloneConsistent' ;;
    esac
    if expect_fail "mutation-$m" "$m.cfg" "$m" "$WORK/$m-dir"; then :; else
      echo "MUTATION $m DID NOT FAIL" >&2; exit 1
    fi
  done
  exit 0
fi

# Current protocol, safety that must hold.
cfg "$WORK/Committed.cfg" FIX TRUE TRUE FALSE FALSE FALSE TRUE TRUE 'INVARIANT CommittedRowLive'
cfg "$WORK/RestoreFix.cfg" FIX TRUE FALSE FALSE TRUE FALSE FALSE FALSE 'INVARIANT RestorePairsOwnBlocks'
cfg "$WORK/ClonePaused.cfg" FIX TRUE FALSE TRUE FALSE FALSE FALSE FALSE 'INVARIANT CloneConsistent'
# Fan-out settling: liveness, with crashes disabled (a crash may strand a job).
cfg "$WORK/Settles.cfg" FIX TRUE FALSE FALSE FALSE FALSE FALSE TRUE 'PROPERTY FanOutSettles'
# Known findings in the current protocol (recorded, not tuned away).
cfg "$WORK/Dangling.cfg" FIX TRUE TRUE FALSE FALSE TRUE TRUE FALSE 'INVARIANT NoDanglingRead'
cfg "$WORK/Resurrect.cfg" FIX TRUE TRUE FALSE FALSE FALSE TRUE FALSE 'INVARIANT NoResurrect'
# Clone without the pause, and the unguarded (pre-#3456) restore rule.
cfg "$WORK/CloneUnpaused.cfg" FIX FALSE FALSE TRUE FALSE FALSE FALSE FALSE 'INVARIANT CloneConsistent'
cfg "$WORK/RestoreCur.cfg" CUR TRUE FALSE FALSE TRUE FALSE FALSE FALSE 'INVARIANT RestorePairsOwnBlocks'
# Non-vacuity witnesses on the current protocol.
cfg "$WORK/WCrash.cfg" FIX TRUE TRUE FALSE FALSE FALSE TRUE FALSE 'INVARIANT NeverCrashed'
cfg "$WORK/WDup.cfg" FIX TRUE TRUE FALSE FALSE FALSE TRUE FALSE 'INVARIANT NeverDupDone'
cfg "$WORK/WRestore.cfg" FIX TRUE FALSE FALSE TRUE FALSE FALSE FALSE 'INVARIANT NeverRestored'
cfg "$WORK/WClone.cfg" FIX TRUE FALSE TRUE FALSE FALSE FALSE FALSE 'INVARIANT NeverCloned'

status=0
expect_pass committed Committed.cfg || status=1
expect_pass restorefix RestoreFix.cfg || status=1
expect_pass clonepaused ClonePaused.cfg || status=1
expect_pass settles Settles.cfg || status=1
expect_fail dangling Dangling.cfg || status=1
shape_check "$WORK/dangling.log" dangling || status=1
expect_fail resurrect Resurrect.cfg || status=1
shape_check "$WORK/resurrect.log" resurrect || status=1
expect_fail cloneunpaused CloneUnpaused.cfg || status=1
shape_check "$WORK/cloneunpaused.log" clone || status=1
expect_fail restorecur RestoreCur.cfg || status=1
shape_check "$WORK/restorecur.log" restore || status=1
expect_fail wcrash WCrash.cfg || status=1
expect_fail wdup WDup.cfg || status=1
expect_fail wrestore WRestore.cfg || status=1
expect_fail wclone WClone.cfg || status=1
exit $status
