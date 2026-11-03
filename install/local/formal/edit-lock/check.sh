#!/usr/bin/env bash
# Checks the Wikidot edit-lock / save protocol model against the source tree.
#   ./check.sh            composition: the invariants I1-I5/I9, D5's
#                         one-commit-per-lease, the slot run's
#                         one-commit-per-request and D8's closure must
#                         PASS with SaveAtomic and no lease-less path;
#                         every witness (the RULING-2 outcome table,
#                         probes P1-P8, A-H and the PROBES3 presented-id
#                         batch) must FAIL its Never invariant, i.e.
#                         the probed trace is reachable with the probed
#                         outcome.
#   ./check.sh mutations  eight mutations must be caught: raw-latest move
#                         check (witnesses T3/C1 unreachable), swapped
#                         rejection priority (witness A unreachable),
#                         force keeps the old lease (I1 fails), SaveAtomic
#                         = FALSE (I3/I4 fail), expired leases block
#                         acquisition (witness I8 unreachable without
#                         force), LeaselessSave enabled (I3/I4 fail), a
#                         source-changing writer skipping lease removal
#                         (I9 fails), decide reading the client's
#                         mutable values instead of the frozen request
#                         (T7 unreachable; one-commit-per-request fails).
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

WORK="${EDIT_LOCK_WORK:-$(mktemp -d)}"
mkdir -p "$WORK"
[[ -n "${EDIT_LOCK_WORK:-}" ]] || trap 'rm -rf "$WORK"' EXIT
cp "$HERE/EditLock.tla" "$WORK/"
python3 -I "$HERE/extract.py" || exit 2

tlc_run() { # name cfgfile [module] [dir]
  local dir="${4:-$WORK}"
  (cd "$dir" && java -XX:+UseParallelGC -cp "$JAR" tlc2.TLC -deadlock -workers 8 \
      -config "$2" -metadir "$dir/states-$1" "${3:-EditLock}.tla") > "$WORK/$1.log" 2>&1
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

expect_pass() { # name cfgfile [module] [dir]
  local start=$SECONDS
  tlc_run "$1" "$2" "${3:-}" "${4:-}"; local rc=$?
  if [[ $rc -eq 0 ]]; then
    echo "PASS $1 ($((SECONDS-start))s, $(grep -oE '[0-9,]+ distinct states found' "$WORK/$1.log" | head -1))"
    return 0
  fi
  echo "UNEXPECTED $1: expected TLC pass, got exit $rc" >&2
  cat "$WORK/$1.log" >&2
  return 1
}

expect_no_witness() { # name cfgfile module dir: mutation made the trace unreachable
  local start=$SECONDS
  tlc_run "$1" "$2" "$3" "$4"; local rc=$?
  if [[ $rc -eq 0 ]]; then
    echo "MUTATION CAUGHT $1 ($((SECONDS-start))s, witness unreachable)"
    return 0
  fi
  echo "MUTATION NOT CAUGHT $1: witness trace still reachable" >&2
  cat "$WORK/$1.log" >&2
  return 1
}

# Trace-shape assertions on TLC counterexample states (never a single
# grep value): the witness predicate is the Never invariant; these check
# the trace that satisfied it is the probed one, not an accidental one.
shape_check() { # logfile kind
  python3 - "$1" "$2" <<'PY'
import re, sys
log, kind = open(sys.argv[1]).read(), sys.argv[2]
states, headers = [], []
parts = re.split(r"^State \d+: <(.*?)>\n", log, flags=re.M)
# parts: [prefix, header1, body1, header2, body2, ...]
for i in range(1, len(parts) - 1, 2):
    headers.append(parts[i])
    body = parts[i + 1]
    def fmap(name):
        m = re.search(rf"/\\ {name} = \[([^\]]*)\]", body)
        if m:
            out = {}
            for k, v in re.findall(r"(\w+) \|-> (\"[^\"]*\"|-?\d+|TRUE|FALSE)", m.group(1)):
                out[k] = v.strip('"')
            return out
        m = re.search(rf"/\\ {name} = <<([^>]*)>>", body)
        if m:
            vals = [v.strip().strip('"') for v in m.group(1).split(",")]
            return {str(i + 1): v for i, v in enumerate(vals)}
        m = re.search(rf"/\\ {name} = \(([^)]*)\)", body)
        if m:
            out = {}
            for k, v in re.findall(r"(\w+) :> (\"[^\"]*\"|-?\d+|TRUE|FALSE)", m.group(1)):
                out[k] = v.strip('"')
            return out
        return {}
    def scalar(name):
        m = re.search(rf"/\\ {name} = (-?\d+|TRUE|FALSE)", body)
        return m.group(1) if m else None
    states.append({"outcome": fmap("outcome"), "lstate": fmap("lstate"),
                   "lclient": fmap("lclient"), "lmode": fmap("lmode"),
                   "lbase": fmap("lbase"), "pres": fmap("pres"),
                   "regionRev": fmap("regionRev"), "latest": scalar("latest"),
                   "pageGone": scalar("pageGone")})
assert states, "no states parsed"
final = states[-1]
if kind == "t2":
    assert any(s["lstate"].get(l) == "expired" and s["lclient"].get(l) == "A"
               for s in states for l in s["lstate"]), "no expired A lease seen"
    assert final["outcome"].get("A") == "commit", final
    print("t2 shape ok: A's lease expired, then A's save committed")
elif kind == "t3":
    assert any({s["lmode"].get(l) for l in s["lstate"]
                if s["lstate"].get(l) == "live"} >= {"s1", "s2"}
               for s in states), "disjoint section leases never coexisted"
    assert final["outcome"].get("B") == "commit", final
    print("t3 shape ok: disjoint sections coexisted; B committed over A's move")
elif kind == "wg1":
    assert any(s["pres"].get("A") == "0"
               and any(s["lstate"].get(l) == "live"
                       and s["lclient"].get(l) == "A"
                       and int(s["lbase"].get(l, "0")) >= 1
                       for l in s["lstate"]) for s in states), \
        "no state with a stale presented id under a live lease"
    assert final["outcome"].get("A") == "commit", final
    print("wg1 shape ok: presented id ignored; the server-side base decided")
elif kind == "wh2":
    assert any({s["lmode"].get(l) for l in s["lstate"]
                if s["lstate"].get(l) == "live"} >= {"s1", "append"}
               for s in states), "append never coexisted with a section lease"
    assert final["outcome"].get("A") == "commit" \
        and final["outcome"].get("B") == "commit", final
    print("wh2 shape ok: append coexisted with a section lease; both committed")
elif kind == "we2":
    assert any(s["lstate"].get(l) == "expired" and s["lclient"].get(l) == "A"
               for s in states for l in s["lstate"]), "no expired A lease seen"
    assert final["outcome"].get("A") == "renewed" \
        and final["latest"] == "0", final
    print("we2 shape ok: synchronize on an expired lease re-created it, no revision")
elif kind == "m5":
    # caught iff every violating trace had to force: plain Acquire of B
    # over A's expired lease is gone, only ForceAcquire reaches it
    assert any("ForceAcquire" in h for h in headers), headers
    print("m5 shape ok: the I8 trace survives only through ForceAcquire")
else:
    raise SystemExit(f"unknown shape {kind}")
PY
}

cfg() { # file atomic leaseless aux oracles pres maxrev maxl clients slots symm invariant...
  local file="$1" atomic="$2" leaseless="$3" aux="$4" oracles="$5" pres="$6" maxrev="$7" maxl="$8" clients="$9" slots="${10}" symm="${11}"; shift 11
  {
    echo "CONSTANTS"
    echo "  SaveAtomic = $atomic"
    echo "  LeaselessOn = $leaseless"
    echo "  AuxOn = $aux"
    echo "  OraclesOn = $oracles"
    echo "  PresOn = $pres"
    echo "  MaxRev = $maxrev"
    echo "  MaxL = $maxl"
    echo "  A = A"
    echo "  B = B"
    echo "  C = C"
    echo "  Clients = {$clients}"
    echo "  Slots = {$slots}"
    echo "SPECIFICATION Spec"
    if [[ "$symm" == "yes" ]]; then echo "SYMMETRY ClientSymm"; fi
    echo "INVARIANT TypeOK"
    for inv in "$@"; do echo "INVARIANT $inv"; done
  } > "$file"
}

MAIN_INVS="Exclusion ChainLinear NoSilentOverwrite RivalBlocks OneCommitPerCreds OneCommitPerRequest SourceWriterKillsLease TotalOutcome"

if [[ "${1:-}" == "mutations" ]]; then
  python3 - "$WORK" <<'PY' || exit 2
import pathlib, sys
work = pathlib.Path(sys.argv[1])
src = (work / "EditLock.tla").read_text()
def one(name, old, new):
    assert src.count(old) >= 1, f"{name} anchor missing"
    out = src.replace(old, new)
    assert out != src
    (work / f"{name}.tla").write_text(out.replace("MODULE EditLock", f"MODULE {name}"))
    print(f"mutation {name}: {old!r} -> {new!r} ({src.count(old)} site(s))")
# M1: moved = raw latest moved (the check_last_revision shape)
one("M1", "regionRev[r] > base", "latest > base")
# M2: lease problem reported before the source move (priority swapped)
one("M2", 'IF moved THEN "page_changed"\n    ELSE IF conflict THEN "other_locks" ELSE "commit"',
          'IF conflict THEN "other_locks"\n    ELSE IF moved THEN "page_changed" ELSE "commit"')
# M3: force keeps the displaced leases
one("M3", 'IF l = nextL THEN "live"\n                      ELSE IF lstate[l] = "live" /\\ Conflicts(lmode[l], m)\n                      THEN "none" ELSE lstate[l]',
          'IF l = nextL THEN "live" ELSE lstate[l]')
# M5: expired leases block acquisition like live ones
one("M5", '/\\ ~\\E l \\in LeaseIds : lstate[l] = "live" /\\ Conflicts(lmode[l], m)',
          '/\\ ~\\E l \\in LeaseIds : lstate[l] # "none" /\\ Conflicts(lmode[l], m)')
# M7: forced revert leaves the leases it passes in place
one("M7", 'IF lstate[l] = "live" THEN "none" ELSE lstate[l]', "lstate[l]")
# M8: SaveDecide reads the client's mutable values, not the frozen request
import re
m8 = src
assert m8.count("THEN FrozenBaseOf(x)") == 1, "M8 base anchor"
m8 = m8.replace("THEN FrozenBaseOf(x)", "THEN BaseOf(c)")
m8, n = re.subn(r"LeaseConflictAt\(snapMode\[x\], snapCid\[x\],\s*\n\s*snapSec\[x\]\)",
                "LeaseConflictAt(cmode[c], cid[c], csec[c])", m8)
assert n == 2, f"M8 conflict anchor: {n} sites"
assert m8.count("MovedFrom(base, snapMode[x])") == 2, "M8 moved anchor"
m8 = m8.replace("MovedFrom(base, snapMode[x])", "MovedFrom(base, cmode[c])")
(work / "M8.tla").write_text(m8.replace("MODULE EditLock", "MODULE M8"))
print("mutation M8: SaveDecide reads mutable client values (3 anchors, 5 sites)")
PY
  status=0
  for m in M1 M2 M3 M5 M7 M8; do mkdir -p "$WORK/$m-dir" && cp "$WORK/$m.tla" "$WORK/$m-dir/"; done
  cfg "$WORK/M1-dir/M1.cfg" TRUE FALSE FALSE TRUE FALSE 2 2 "A, B" "1" yes NeverCommitDisjoint
  expect_no_witness mut-m1-t3 M1.cfg M1 "$WORK/M1-dir" || status=1
  cfg "$WORK/M1-dir/M1b.cfg" TRUE FALSE FALSE TRUE FALSE 2 2 "A" "1" yes NeverCommitAfterMeta
  expect_no_witness mut-m1-c1 M1b.cfg M1 "$WORK/M1-dir" || status=1
  cfg "$WORK/M2-dir/M2.cfg" TRUE FALSE FALSE TRUE FALSE 1 2 "A, B" "1" yes NeverDecideBothPC
  expect_no_witness mut-m2-a M2.cfg M2 "$WORK/M2-dir" || status=1
  cfg "$WORK/M3-dir/M3.cfg" TRUE FALSE FALSE FALSE FALSE 2 2 "A, B" "1" yes $MAIN_INVS
  expect_fail mut-m3 M3.cfg M3 "$WORK/M3-dir" || status=1
  cfg "$WORK/M4.cfg" FALSE FALSE FALSE FALSE FALSE 2 2 "A, B" "1" yes NoSilentOverwrite RivalBlocks
  expect_fail mut-m4 M4.cfg || status=1
  cfg "$WORK/M5-dir/M5.cfg" TRUE FALSE FALSE TRUE FALSE 1 2 "A, B" "1" yes NeverAcqOverExpired
  expect_no_witness mut-m5 M5.cfg M5 "$WORK/M5-dir" || status=1
  cfg "$WORK/M6.cfg" TRUE TRUE TRUE FALSE TRUE 2 2 "A, B" "1" yes NoSilentOverwrite RivalBlocks
  expect_fail mut-m6 M6.cfg || status=1
  cfg "$WORK/M7-dir/M7.cfg" TRUE FALSE FALSE FALSE FALSE 2 2 "A, B" "1" yes $MAIN_INVS
  expect_fail mut-m7 M7.cfg M7 "$WORK/M7-dir" || status=1
  cfg "$WORK/M8-dir/M8.cfg" TRUE FALSE TRUE FALSE FALSE 2 1 "A" "1, 2" no NeverT7
  expect_no_witness mut-m8-t7 M8.cfg M8 "$WORK/M8-dir" || status=1
  cfg "$WORK/M8-dir/M8b.cfg" TRUE FALSE FALSE FALSE FALSE 2 1 "A" "1, 2" no OneCommitPerRequest
  expect_fail mut-m8-inv M8b.cfg M8 "$WORK/M8-dir" || status=1
  exit $status
fi

cfg "$WORK/Main.cfg" TRUE FALSE FALSE FALSE FALSE 2 2 "A, B" "1" yes $MAIN_INVS
expect_pass main Main.cfg || exit 1

wparams() { # witness -> maxrev maxl aux pres clients slots symm
  case $1 in
    T1) echo "1 1 TRUE FALSE A,B 1 no" ;;
    T2) echo "1 1 TRUE FALSE A,B 1 no" ;;
    T3) echo "2 2 TRUE FALSE A,B 1 no" ;;
    T4) echo "1 2 FALSE FALSE A,B 1 no" ;;
    T5) echo "1 2 FALSE FALSE A,B 1 no" ;;
    T6) echo "2 2 TRUE FALSE A,B 1 no" ;;
    T8) echo "2 1 FALSE FALSE A,B 1 no" ;;
    WA) echo "2 3 FALSE FALSE A,B 1 no" ;;
    WB) echo "1 2 FALSE FALSE A,B 1 no" ;;
    WC1) echo "2 1 FALSE FALSE A,B 1 no" ;;
    WC2) echo "2 1 FALSE FALSE A,B 1 no" ;;
    WD) echo "3 3 FALSE FALSE A,B,C 1 yes" ;;
    WE1) echo "2 2 TRUE FALSE A,B 1 no" ;;
    WE2) echo "1 2 TRUE FALSE A,B 1 no" ;;
    WE3) echo "1 2 FALSE FALSE A,B 1 no" ;;
    WF1) echo "2 1 TRUE FALSE A,B 1 no" ;;
    WF2) echo "1 2 FALSE FALSE A,B 1 no" ;;
    WG1) echo "2 2 TRUE TRUE A,B 1 no" ;;
    WG2) echo "1 1 FALSE TRUE A,B 1 no" ;;
    WG3) echo "1 2 FALSE TRUE A,B 1 no" ;;
    WH1) echo "1 1 FALSE FALSE A,B 1 no" ;;
    WH2) echo "2 2 FALSE FALSE A,B 1 no" ;;
    WH3) echo "1 1 FALSE FALSE A,B 1 no" ;;
    WP1) echo "1 1 FALSE FALSE A,B 1 no" ;;
    WP5) echo "1 1 FALSE FALSE A,B 1 no" ;;
    WRename) echo "1 1 FALSE FALSE A,B 1 no" ;;
    WRevert) echo "1 1 FALSE FALSE A,B 1 no" ;;
    WI8) echo "1 2 FALSE FALSE A,B 1 no" ;;
    WX1) echo "1 1 TRUE FALSE A 1,2 no" ;;
    WX2) echo "2 2 TRUE TRUE A,B 1 no" ;;
    WX3) echo "1 1 TRUE TRUE A 1,2 no" ;;
    *) echo "unconfigured witness $1" >&2; return 1 ;;
  esac
}

status=0
for w in T1 T2 T3 T4 T5 T6 T8 WA WB WC1 WC2 WD WE1 WE2 WE3 WF1 WF2 \
         WG1 WG2 WG3 WH1 WH2 WH3 WP1 WP5 WRename WRevert WI8 WX1 WX2 WX3; do
  set -- $(wparams $w)
  cfg "$WORK/W$w.cfg" TRUE FALSE $3 FALSE $4 $1 $2 "$5" "$6" $7 "Never$w"
  [[ $w == WD ]] && echo "CONSTRAINT WitnessPrune" >> "$WORK/W$w.cfg"
  expect_fail "witness-$w" "W$w.cfg" || status=1
done
# T7 (P7b) restated over save slots (RULING-3): one client, two slots,
# MaxRev 2, MaxL 1, exhaustive. The same frozen credentials and
# presented id in both slots: one commits, the other is page_changed,
# latest = 1. The slot run also proves the D5 race invariant over the
# two-slot graph: at most one commit per frozen (lock id, presented id).
cfg "$WORK/SlotInv.cfg" TRUE FALSE TRUE FALSE FALSE 2 1 "A" "1, 2" no OneCommitPerRequest
expect_pass slot-inv SlotInv.cfg || status=1
cfg "$WORK/WT7.cfg" TRUE FALSE TRUE FALSE FALSE 2 1 "A" "1, 2" no NeverT7
expect_fail witness-T7 WT7.cfg || status=1
for pair in "t2 T2" "t3 T3" "wg1 WG1" "wh2 WH2" "we2 WE2"; do
  set -- $pair
  shape_check "$WORK/witness-$2.log" "$1" || status=1
done
exit $status
