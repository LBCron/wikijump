#!/usr/bin/env python3
"""Rebuild the local Deepwell preview wikitext from all preserved port sources."""
from __future__ import annotations
import argparse, hashlib, json, runpy, re
from pathlib import Path


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--root", type=Path, default=Path(__file__).resolve().parents[5])
    parser.add_argument("--theme", action="append", default=[])
    args = parser.parse_args()
    root = args.root.resolve()
    ports = root / "install/local/theme-lab/ports"
    build = runpy.run_path(str(ports / "scripts/build-preview-source.py"))["build"]
    squares_source = (ports / "shared-fixtures/component-theme-squares.jp.wikidot.txt").read_text(encoding="utf-8")
    manifest = json.loads((ports / "en-theme-campaign.json").read_text())
    count = 0
    for theme in manifest["themes"]:
        if args.theme and theme["slug"].split(":", 1)[1] not in args.theme:
            continue
        package = ports / theme["slug"].split(":", 1)[1]
        source = (package / "candidate.wikidot.source.txt").read_text(encoding="utf-8")
        preview, expanded, omitted = build(source, squares_source)
        (package / "candidate.wikidot.txt").write_text(preview, encoding="utf-8")
        fixture_path = package / "preview-fixture.json"
        fixture = json.loads(fixture_path.read_text())
        fixture.update({
            "source_sha256": hashlib.sha256(source.encode()).hexdigest(),
            "expanded_theme_squares": expanded,
            "omitted_unseeded_includes": sorted(set(omitted)),
            "expanded_theme_squares_css_modules": len(re.findall(r"\[\[module\s+CSS\s*\]\].*?\[\[/module\s*\]\]", squares_source, flags=re.I | re.S)) if expanded else 0,
        })
        fixture_path.write_text(json.dumps(fixture, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        count += 1
    print(json.dumps({"rebuilt_previews": count}, ensure_ascii=False))
    return 0

if __name__ == "__main__":
    raise SystemExit(main())
