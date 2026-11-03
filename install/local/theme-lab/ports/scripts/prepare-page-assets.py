#!/usr/bin/env python3
"""Freeze missing theme-demo page images as portable Wikidot attachments.

Consumes an offline Theme Lab DOM image finding and content-addressed one-time
acquisition records. It preserves the original human candidate, adds per-page
attachment bundles, converts only executable image references to local
attachments, and regenerates each local preview fixture.
"""
from __future__ import annotations
import argparse, hashlib, json, re, runpy, shutil
from pathlib import Path
from urllib.parse import unquote, urlsplit

IMAGE = re.compile(r"(\[\[(?:=)?image\s+)([^\s\]]+)", re.I)
FALLBACKS = {
    "overwatch_light-JP.png": "https://scp-wiki.wdfiles.com/local--files/theme:foxtrot/overwatch_light.png",
    "nightfall_light-JP.png": "https://scp-wiki.wdfiles.com/local--files/theme:foxtrot/nightfall_light.png",
    "alt_logo_tyrian.png": "https://scp-wiki.wdfiles.com/local--files/theme:flopstyle-dark/alt_logo_tyrian.png",
    "pancakes.png": "https://scp-wiki.wdfiles.com/local--files/theme:inkblot/pancakes.png",
    "table.png": "https://scp-wiki.wdfiles.com/local--files/theme:wikifot/table.png",
    "scpoffices_logo.svg": "https://scp-wiki.wdfiles.com/local--files/theme:scp-offices-theme/scpoffices_logo.svg",
}


def filename_for(value: str) -> str:
    parsed = urlsplit(value)
    return unquote(parsed.path.rsplit("/", 1)[-1])


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--root", type=Path, default=Path(__file__).resolve().parents[5])
    ap.add_argument("--findings", type=Path, required=True)
    ap.add_argument("--acquisition", type=Path, required=True)
    ap.add_argument("--fallback-acquisition", type=Path, required=True)
    ap.add_argument("--squares-source", type=Path, required=True)
    args = ap.parse_args()
    root = args.root.resolve()
    ports = root / "install/local/theme-lab/ports"
    findings = {row["slug"]: row for row in json.loads(args.findings.read_text())}
    acquired = json.loads(args.acquisition.read_text())["results"] + json.loads(args.fallback_acquisition.read_text())["results"]
    by_url = {row["url"]: row for row in acquired if row.get("ok")}
    pool = ports / "candidate-assets"
    preview_builder = runpy.run_path(str(ports / "scripts/build-preview-source.py"))["build"]
    packages = 0
    localized = 0
    for slug, finding in findings.items():
        broken = finding.get("broken", [])
        if not broken:
            continue
        directory = ports / slug.split(":", 1)[1]
        source_path = directory / "candidate.wikidot.source.txt"
        source = source_path.read_text(encoding="utf-8")
        attachments = {}
        for image in broken:
            original_name = image.get("alt") or filename_for(image["src"])
            target_url = image["src"]
            record = by_url.get(target_url)
            if not record:
                fallback_url = FALLBACKS.get(original_name)
                record = by_url.get(fallback_url) if fallback_url else None
            if not record:
                raise SystemExit(f"no frozen bytes for {slug} {original_name} ({target_url})")
            if not record.get("content_type", "").lower().startswith("image/"):
                raise SystemExit(f"non-image response cannot be packaged as {slug} attachment {original_name}: {record.get('content_type')}")
            pool_file = record["file"].split("/", 1)[1]
            bytes_path = pool / pool_file
            data = bytes_path.read_bytes()
            digest = hashlib.sha256(data).hexdigest()
            if digest != record["sha256"]:
                raise SystemExit(f"asset digest drift for {record['url']}")
            prior = attachments.get(original_name)
            if prior and prior["sha256"] != digest:
                raise SystemExit(f"attachment filename collision in {slug}: {original_name}")
            attachments[original_name] = {
                "filename": original_name,
                "sha256": digest,
                "bytes": len(data),
                "asset_file": pool_file,
                "source_urls": sorted(set((prior or {}).get("source_urls", []) + [target_url])),
                "acquired_from": record["url"],
                "classification": "localize-into-candidate-package",
                "reason": (
                    "The page-level image was broken in offline JP preview. Its bytes were already in the content-addressed acquisition cache; "
                    + ("the JP-hosted counterpart returned HTTP 500, so the current EN image with the same theme showcase role is bundled." if original_name in {"overwatch_light-JP.png", "nightfall_light-JP.png", "scpoffices_logo.svg"} else "")
                ),
            }
        def localize(match: re.Match[str]) -> str:
            target = match.group(2)
            name = filename_for(target)
            return match.group(1) + name if name in attachments else match.group(0)
        localized_source, count = IMAGE.subn(localize, source)
        if count < len(attachments):
            unresolved = [name for name in attachments if not re.search(rf"\[\[(?:=)?image\s+[^\]\s]*{re.escape(name)}(?:[\s\]])", source, re.I)]
            if unresolved:
                raise SystemExit(f"attachment references not found in {slug}: {unresolved}")
        source_path.write_text(localized_source, encoding="utf-8")
        asset_dir = directory / "page-assets"
        asset_dir.mkdir(exist_ok=True)
        for name, row in attachments.items():
            shutil.copyfile(pool / row["asset_file"], asset_dir / name)
        manifest = {
            "schema_version": 1,
            "slug": slug,
            "mode": "Wikidot page attachments; upload each named file to this theme page before publication",
            "assets": sorted(attachments.values(), key=lambda row: row["filename"]),
        }
        (directory / "page-assets.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        preview, expanded, omitted = preview_builder(localized_source)
        (directory / "candidate.wikidot.txt").write_text(preview, encoding="utf-8")
        fixture = json.loads((directory / "preview-fixture.json").read_text())
        fixture["source_sha256"] = hashlib.sha256(localized_source.encode()).hexdigest()
        fixture["page_assets"] = len(attachments)
        (directory / "preview-fixture.json").write_text(json.dumps(fixture, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        for name in ("manifest.json",):
            path = directory / name
            meta = json.loads(path.read_text())
            meta["candidate_source_hash"] = hashlib.sha256(localized_source.encode()).hexdigest()
            meta["page_assets"] = manifest["assets"]
            path.write_text(json.dumps(meta, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        packages += 1
        localized += len(attachments)
    print(json.dumps({"packages": packages, "localized_page_assets": localized}, ensure_ascii=False))
    return 0

if __name__ == "__main__":
    raise SystemExit(main())
