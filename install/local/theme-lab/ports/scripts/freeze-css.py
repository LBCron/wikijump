#!/usr/bin/env python3
"""Flatten candidate CSS dependencies from Theme Lab's frozen cache.

The result is a local, replayable candidate stylesheet. It never fetches URLs;
uncached dependencies are removed from the injected copy and listed in the
asset manifest so a missing acquisition cannot become a false PASS.
"""

from __future__ import annotations

import argparse
import base64
import hashlib
import json
import mimetypes
import re
from pathlib import Path
from urllib.parse import unquote, urljoin, urlparse


# A trailing simple @import is terminated by EOF in native CSS even without a
# semicolon. Composed candidate files also concatenate separate [[module CSS]]
# leading @import lines, so a semicolon-less import is additionally terminated
# at the end of its line: otherwise the first import swallows every following
# import and its stylesheet as an accidental "prelude". The URL class must keep
# excluding ")" so an unquoted url(https://host/path) does not swallow the
# closing paren into the reference and miss the frozen cache. The optional
# prelude (media query list, layer(...) or supports(...)) is captured so
# flattening does not silently drop an import condition.
IMPORT_RE = re.compile(r"@import\s+(?:url\()?\s*(['\"]?)([^\s'\")]+)\1\s*\)?(?P<prelude>[^\n;{}@]*?)[ \t]*(?:;|\Z|\n)", re.I)
URL_RE = re.compile(r"url\(\s*(['\"]?)(.*?)\1\s*\)", re.I)
IMPORT_AT_RULE_RE = re.compile(r"@import\b", re.I)


def without_css_comments_and_strings(text: str) -> str:
    """Blank comments and quoted strings, preserving offsets.

    At-rule scans must not treat documentation text such as ``/* @import */``
    or a quoted ``content: "@import"`` as a live stylesheet import.
    """
    output: list[str] = []
    index = 0
    length = len(text)
    while index < length:
        char = text[index]
        if char == "/" and index + 1 < length and text[index + 1] == "*":
            end = text.find("*/", index + 2)
            end = length if end < 0 else end + 2
            output.append(" " * (end - index))
            index = end
        elif char in ("'", '"'):
            quote = char
            end = index + 1
            while end < length:
                if text[end] == "\\":
                    end += 2
                    continue
                if text[end] == quote:
                    end += 1
                    break
                end += 1
            end = min(end, length)
            output.append(" " * (end - index))
            index = end
        else:
            output.append(char)
            index += 1
    return "".join(output)



class CacheCSS:
    def __init__(self, cache: Path, assets: Path, replacements: dict[str, str] | None = None, omissions: dict[str, str] | None = None, transforms: list[dict] | None = None) -> None:
        self.cache = cache
        self.assets = assets
        self.replacements = replacements or {}
        self.omissions = omissions or {}
        self.transforms = transforms or []
        self.omitted_assets: list[dict[str, str]] = []
        self.manifest = json.loads((cache / "manifest.json").read_text())
        self.urls = self.manifest.get("urls", {})
        self.objects = self.manifest.get("objects", {})
        self.seen_imports: set[str] = set()
        self.import_rows: dict[str, dict] = {}
        self.asset_rows: dict[str, dict] = {}
        self.missing: dict[str, str] = {}
        self.pruned_fonts: list[dict[str, str]] = []
        self.template_placeholders: list[dict[str, str]] = []
        self.applied_transforms: list[dict[str, object]] = []

    def apply_localization_transforms(self, text: str) -> str:
        """Apply exact, fail-closed JP localization transforms to flattened CSS.

        These transforms exist for a small number of accepted campaign ports
        whose historical JP fix edited an imported rule in place instead of
        adding a normal override. Each transform is deliberately exact: an
        upstream byte/text change that invalidates the anchor must stop the
        rebuild rather than silently applying the old JP assumption elsewhere.
        """
        for transform in self.transforms:
            transform_id = str(transform.get("id", "")).strip()
            reason = str(transform.get("reason", "")).strip()
            before = transform.get("before")
            after = transform.get("after")
            expected = transform.get("expected_matches", 1)
            if not transform_id or not reason or not isinstance(before, str) or not isinstance(after, str):
                raise ValueError("localization transform requires id, reason, before, and after")
            if not isinstance(expected, int) or expected < 1:
                raise ValueError(f"{transform_id}: expected_matches must be a positive integer")
            matches = text.count(before)
            if matches != expected:
                raise RuntimeError(
                    f"localization transform {transform_id!r} expected {expected} exact match(es), found {matches}; "
                    "upstream/localized CSS changed and requires review"
                )
            text = text.replace(before, after, expected)
            self.applied_transforms.append({
                "id": transform_id,
                "reason": reason,
                "matches": matches,
                "before_sha256": hashlib.sha256(before.encode("utf-8")).hexdigest(),
                "after_sha256": hashlib.sha256(after.encode("utf-8")).hexdigest(),
            })
        return text

    def lookup(self, url: str) -> tuple[bytes, str, str] | None:
        entry = self.urls.get(url)
        if not entry:
            return None
        digest = entry.get("digest")
        info = self.objects.get(digest, {})
        path = self.cache / "objects" / digest[:2] / digest
        if not path.is_file():
            return None
        return path.read_bytes(), info.get("content_type", "application/octet-stream").split(";", 1)[0], entry.get("final_url", url)

    def flatten_imports(self, text: str, base: str, depth: int = 0) -> str:
        if depth > 12:
            self.missing[base] = "import-depth-limit"
            return ""

        def repl(match: re.Match[str]) -> str:
            ref = match.group(2).strip()
            if ref.startswith("data:"):
                self.missing[ref[:120]] = "unsupported-data-css-import"
                return ""
            target = urljoin(base, ref)
            prelude = (match.group("prelude") or "").strip()
            if prelude and re.search(r"(?:^|\s)layer\b|(?:^|\s)supports\s*\(", prelude, re.I):
                # layer()/supports() change cascade order or feature gating in a
                # way this flattener does not reproduce. Fail closed instead of
                # applying the stylesheet unconditionally.
                self.missing[target] = "css-import-prelude-unsupported"
                return ""
            if re.search(r"fonts\.(?:googleapis|bunny|coollabs)\.com/", target, re.I) and re.search(r"(?:Noto(?:\+|\s)Sans(?:\+|\s)SC|Noto(?:\+|\s)Serif(?:\+|\s)SC|Noto(?:\+|\s)Sans(?:\+|\s)TC|Noto(?:\+|\s)Sans(?:\+|\s)KR|Noto(?:\+|\s)Sans(?:\+|\s)Thai|Kanit)", target, re.I):
                self.pruned_fonts.append({"url": target, "reason": "non-JP locale-specific font import; candidate uses Japanese fallback"})
                return ""
            if target in self.seen_imports:
                return ""
            self.seen_imports.add(target)
            item = self.lookup(target)
            if item is None:
                self.missing[target] = "css-import-not-in-frozen-reference-cache"
                return ""
            body, kind, final = item
            decoded = body.decode("utf-8", errors="replace")
            # Wikidot local--code serves executable stylesheet bodies as
            # text/plain on some branch/CDN routes. The browser still treats
            # them as CSS when reached through @import, so preserve that
            # evidenced MIME quirk only when the body has an unmistakable CSS
            # rule/at-rule shape. Ordinary prose remains fail-closed.
            looks_like_css = bool(re.search(r"(?:^|[;}\s])(?:@(?:charset|import|media|font-face|supports|layer|keyframes)\b|[-.#*:]?[\w\[\]:().,#>+~* -]+\s*\{)", decoded[:20000], re.I | re.M))
            if "css" not in kind and not (kind == "text/plain" and looks_like_css):
                self.missing[target] = f"import-not-css:{kind}"
                return ""
            digest = hashlib.sha256(body).hexdigest()
            name = f"{digest}.css"
            self.assets.mkdir(parents=True, exist_ok=True)
            target_path = self.assets / name
            if not target_path.exists():
                target_path.write_bytes(body)
            self.import_rows[target] = {
                "source_url": target,
                "final_url": final,
                "sha256": digest,
                "normalized_text_sha256": hashlib.sha256(decoded.replace("\r\n", "\n").replace("\r", "\n").encode("utf-8")).hexdigest(),
                "bytes": len(body),
                "content_type": kind,
                "asset_file": name,
                "provenance_basis": "frozen-cache-exact-at-build",
            }
            flattened = self.flatten_imports(decoded, final, depth + 1)
            if prelude and flattened.strip():
                # @import media conditions apply to the imported stylesheet, so
                # keep them by wrapping the flattened body instead of dropping
                # the condition.
                return f"@media {prelude} {{\n{flattened}\n}}"
            return flattened

        while IMPORT_RE.search(text):
            old = text
            text = IMPORT_RE.sub(repl, text)
            if text == old:
                break
        # Any surviving @import is an unflattened remote dependency. Leaving it
        # in the frozen stylesheet would make the browser fetch it (blocked
        # offline) while the manifest still claimed complete import provenance.
        # Record it so flattening fails closed instead of silently omitting CSS.
        for match in IMPORT_AT_RULE_RE.finditer(without_css_comments_and_strings(text)):
            snippet = re.sub(r"\s+", " ", text[match.start() : match.start() + 160]).strip()
            self.missing.setdefault(snippet, "css-import-not-flattened")
        return self.resolve_urls(text, base)

    @staticmethod
    def resolve_urls(text: str, base: str) -> str:
        def repl(match: re.Match[str]) -> str:
            ref = match.group(2).strip()
            if not ref or ref.startswith(("data:", "#", "blob:")):
                return match.group(0)
            return f'url("{urljoin(base, ref)}")'

        return URL_RE.sub(repl, text)

    def localize_urls(self, text: str, base: str) -> str:
        def repl(match: re.Match[str]) -> str:
            ref = match.group(2).strip()
            if not ref or ref.startswith(("data:", "#", "blob:")):
                return match.group(0)
            target = urljoin(base, ref)
            if target in self.omissions:
                self.omitted_assets.append({"url": target, "reason": self.omissions[target]})
                return 'url("data:,")'
            if re.search(r"(?:URLはここ|ここにURL)", target):
                self.template_placeholders.append({"url": target, "reason": "documentation template placeholder, not a runtime asset"})
                return 'url("data:,")'
            replacement = self.replacements.get(target)
            resolved_target = replacement or target
            item = self.lookup(resolved_target)
            if item is None:
                self.missing[target] = "asset-not-in-frozen-reference-cache"
                return 'url("data:,")'
            body, kind, final = item
            ext = Path(urlparse(final).path).suffix.lower()
            if not ext or len(ext) > 8:
                ext = mimetypes.guess_extension(kind) or ".bin"
            digest = hashlib.sha256(body).hexdigest()
            name = f"{digest}{ext}"
            self.assets.mkdir(parents=True, exist_ok=True)
            target_path = self.assets / name
            if not target_path.exists():
                target_path.write_bytes(body)
            self.asset_rows[name] = {"sha256": digest, "bytes": len(body), "content_type": kind, "original_url": target, "final_url": final, **({"replaced_from": target, "replacement_url": resolved_target} if replacement else {})}
            return f'url("{name}")'

        return URL_RE.sub(repl, text)

    def build(self, source_text: str, source_url: str) -> tuple[str, dict]:
        text = self.flatten_imports(source_text, source_url)
        text = self.strip_non_jp_font_faces(text)
        text = self.apply_localization_transforms(text)
        text = self.localize_urls(text, source_url)
        missing = [{"url": u, "reason": r} for u, r in sorted(self.missing.items())]
        import_failures = [row for row in missing if "import" in row["reason"]]
        return text, {"assets": list(self.asset_rows.values()), "missing": missing, "imports": sorted(self.seen_imports), "import_provenance_status": "incomplete" if import_failures else "complete", "import_provenance": [self.import_rows[url] for url in sorted(self.import_rows)], "localization_transforms": self.applied_transforms, "pruned_fonts": self.pruned_fonts, "template_placeholders": self.template_placeholders, "asset_replacements": self.replacements, "omitted_assets": self.omitted_assets}

    def strip_non_jp_font_faces(self, text: str) -> str:
        excluded = re.compile(r"(?:Noto\s+(?:Sans|Serif)\s+(?:SC|TC|KR|Thai)|Nanum\s+Gothic|Kanit)", re.I)
        removed: list[tuple[int, int]] = []
        for match in re.finditer(r"@font-face\s*\{", text, re.I):
            end = text.find("}", match.end())
            if end < 0:
                continue
            block = text[match.start() : end + 1]
            family = re.search(r"font-family\s*:\s*([^;}]+)", block, re.I)
            if family and excluded.search(family.group(1)):
                removed.append((match.start(), end + 1))
                self.pruned_fonts.append({"font_family": family.group(1).strip(), "reason": "font targets a non-JP locale; Japanese runtime uses a verified JP stack"})
        for start, end in reversed(removed):
            text = text[:start] + text[end:]
        return text


def normalize_css_transport(css: str) -> str:
    """Normalize generated transport whitespace, preserving quoted CSS text."""
    output: list[str] = []
    quote = None
    escaped = False
    comment = False
    for char in css.replace("\r\n", "\n"):
        if quote:
            output.append(char)
            if escaped:
                escaped = False
            elif char == "\\":
                escaped = True
            elif char == quote:
                quote = None
        else:
            if comment and char == "/" and output and output[-1] == "*":
                comment = False
                output.append(char)
                continue
            if not comment and char == "*" and output and output[-1] == "/":
                comment = True
            if not comment and char in ("'", '"'):
                quote = char
            if char == "\n":
                while output and output[-1] in (" ", "\t"):
                    output.pop()
            output.append(char)
    return "".join(output).rstrip() + "\n"


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", type=Path, required=True, help="candidate.css as authored in the port package")
    parser.add_argument("--output", type=Path, required=True, help="flattened stylesheet for Theme Lab and reproduction")
    parser.add_argument("--assets", type=Path, required=True, help="local output asset directory")
    parser.add_argument("--assets-manifest", type=Path, required=True, help="asset-localization manifest JSON")
    parser.add_argument("--base-url", required=True, help="candidate page whose imports are being frozen")
    parser.add_argument("--cache", type=Path, default=Path.home() / ".cache/wikijump/theme-lab")
    parser.add_argument("--transforms", type=Path, help="exact fail-closed flattened-CSS localization transform manifest")
    parser.add_argument("--replace-url", action="append", default=[], metavar="OLD=NEW", help="evidence-backed URL replacement using already frozen target bytes")
    parser.add_argument("--omit-url", action="append", default=[], metavar="URL=REASON", help="remove a proven unavailable decorative asset and record the source failure")
    args = parser.parse_args()
    replacements = {}
    for spec in args.replace_url:
        if "=" not in spec:
            parser.error("--replace-url must use OLD=NEW")
        old, new = spec.split("=", 1)
        replacements[old] = new
    omissions = {}
    for spec in args.omit_url:
        if "=" not in spec:
            parser.error("--omit-url must use URL=REASON")
        url, reason = spec.split("=", 1)
        omissions[url] = reason
    transforms: list[dict] = []
    transform_manifest_sha256 = None
    if args.transforms:
        transform_bytes = args.transforms.read_bytes()
        transform_manifest = json.loads(transform_bytes)
        if transform_manifest.get("schema_version") != 1 or not isinstance(transform_manifest.get("transforms"), list):
            parser.error("--transforms requires schema_version=1 and a transforms array")
        transforms = transform_manifest["transforms"]
        transform_manifest_sha256 = hashlib.sha256(transform_bytes).hexdigest()
    engine = CacheCSS(args.cache, args.assets, replacements, omissions, transforms)
    css, manifest = engine.build(args.input.read_text(errors="replace"), args.base_url)
    if args.transforms:
        manifest["localization_transform_manifest"] = {
            "path": args.transforms.name,
            "sha256": transform_manifest_sha256,
        }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(normalize_css_transport(css), encoding="utf-8")
    args.assets_manifest.parent.mkdir(parents=True, exist_ok=True)
    args.assets_manifest.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"output": str(args.output), "assets": len(manifest["assets"]), "missing": len(manifest["missing"]), "imports": len(manifest["imports"])}))
    return 0 if not manifest["missing"] else 2


if __name__ == "__main__":
    raise SystemExit(main())
