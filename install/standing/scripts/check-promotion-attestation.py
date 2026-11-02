#!/usr/bin/env python3
"""Dry-run the attestation-mode validation stage of promote.py.

Runs exactly the two checks `--validation-mode attestation` performs -
merged-PR composition of the head since standing, and the per-head
attestation in the validation store - against an existing checkout and
store, without promoting anything. Prints a JSON verdict; exit code 0
when both checks pass, 1 otherwise.

    check-promotion-attestation.py --source-root <checkout> \
        --standing <standing sha> --head <target sha> [--store <dir>]
"""

from __future__ import annotations

import argparse
import importlib.util
import json
from pathlib import Path
import sys


STANDING_DIR = Path(__file__).resolve().parents[1]


def load_promote():
    sys.path.insert(0, str(STANDING_DIR))
    spec = importlib.util.spec_from_file_location("promote", STANDING_DIR / "promote.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--source-root", type=Path, required=True)
    parser.add_argument("--standing", required=True)
    parser.add_argument("--head", required=True)
    parser.add_argument("--store", type=Path, default=None)
    args = parser.parse_args()

    promote = load_promote()
    store = args.store if args.store is not None else promote.state_root() / "validation"
    tree = promote.run(
        "git", "rev-parse", f"{args.head}^{{tree}}", cwd=args.source_root
    ).strip()
    changed = promote.changed_paths(args.source_root, args.standing, args.head)
    required = promote.classify(args.source_root, changed)

    composition = promote.merged_pr_composition(args.source_root, args.standing, args.head)
    verdict = {"composition": composition, "required_groups": required}
    problems = [
        f"commit {sha} is not a merge and belongs to no merged pull request"
        for sha in composition["offenders"]
    ]
    path = promote.attestation_path(store, args.head)
    try:
        attestation = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        attestation = None
    if attestation is None:
        problems.append(f"no attestation for {args.head} in the validation store ({path})")
        verdict["attestation"] = {"present": False}
    else:
        checked = promote.verify_attestation(attestation, args.head, tree, required)
        verdict["attestation"] = {"present": True, **checked}
        problems.extend(checked["errors"])
    verdict["problems"] = problems
    verdict["pass"] = not problems
    print(json.dumps(verdict, indent=2))
    return 0 if verdict["pass"] else 1


if __name__ == "__main__":
    sys.exit(main())
