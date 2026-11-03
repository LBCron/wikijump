#!/usr/bin/env python3
"""Build Theme Lab's renderable SCP-JP page fixture from a human-made port.

This keeps the original candidate untouched, removes its already-extracted CSS
modules from preview wikitext, opens the theme display gate, and expands JP
components that are not seeded in the local authoring site from retained JP
component source. The component markup contract is copied alongside this tool.
"""

from __future__ import annotations

import argparse
import re
from pathlib import Path


CSS_MODULE = re.compile(r"\[\[module\s+css\b[^\]]*\]\].*?\[\[/module\s*\]\]", re.I | re.S)
SQUARES_INCLUDE = re.compile(r"\[\[include\s+:scp-jp:component:theme-squares\b(.*?)\]\]", re.I | re.S)
INCLUDE_RE = re.compile(r"\[\[include\s+(?::scp-[a-z0-9-]+:)?([^\s|\]\r\n]+)[\s\S]*?\]\]", re.I)

# wikidot_page_preview does not execute PageRateWidgetModule. This local-only
# fixture uses the exact current saved-page DOM shape retained from the
# anonymous SCP-JP Wikidot capture at
# ../evidence/wikidot-runtime-surface-20260930.states/scp-jp-scp-173-runtime-states-20260930-f0a25196cec6/live.dom.html; it exercises
# CSS selectors without pretending that preview executed a rate action.
RATE_COMPONENT_FIXTURE = '''[[div class="creditRate"]]
[[div class="rateBox"]]
[[div class="rate-box-with-credit-button"]]
[[div class="page-rate-widget-box"]]
[[span class="rate-points"]]評価: +1[[/span]]
[[span class="rateup btn btn-default"]]+[[/span]]
[[span class="ratedown btn btn-default"]]–[[/span]]
[[span class="cancel btn btn-default"]]x[[/span]]
[[/div]]
[[/div]]
[[/div]]
[[/div]]'''


def parse_arguments(body: str) -> dict[str, str]:
    arguments: dict[str, str] = {}
    for line in body.splitlines():
        line = line.strip()
        if line.startswith("|"):
            line = line[1:].strip()
        if "=" not in line:
            continue
        key, value = line.split("=", 1)
        key, value = key.strip(), value.strip()
        if re.fullmatch(r"(?:color[1-6]|subcolor(?:[1-9]|1[0-2]))-(?:name|variable|info|has-light-text)", key):
            arguments[key] = value
    return arguments


def palette_markup(body: str) -> str:
    args = parse_arguments(body)
    if not args:
        return "[[div class=\"colors-container\"]]Theme color sample[[/div]]"

    def row(kind: str, index: int) -> str:
        name = args.get(f"{kind}{index}-name", "")
        variable = args.get(f"{kind}{index}-variable", "")
        info = args.get(f"{kind}{index}-info", "")
        light = args.get(f"{kind}{index}-has-light-text", "0") or "0"
        if not (name or variable or info):
            return ""
        if not variable:
            return ""
        rgb = info.strip().strip("()")
        color_value = f"rgb({rgb})" if re.fullmatch(r"\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*\d{1,3}\s*", rgb) else "transparent"
        return (
            f'[[div class="color" style="background-color: {color_value};" '
            f'data-variable="palette-{kind}{index}" data-has-light-text="{light}"]]\n'
            f"{name}[[span class=\"css-variable\"]]@@{variable}@@[[/span]]"
            f"[[span class=\"css-variable\"]]{info}[[/span]]\n[[/div]]"
        )

    colors = "\n".join(filter(None, (row("color", i) for i in range(1, 7))))
    subcolors = "\n".join(filter(None, (row("subcolor", i) for i in range(1, 13))))
    return (
        '[[div_ class="colors-container"]]\n'
        '[[div_ class="colors"]]\n' + colors + '\n[[/div]]\n'
        '[[div_ class="subcolors"]]\n' + subcolors + '\n[[/div]]\n'
        '[[/div]]'
    )


RAW_SPAN = re.compile(r"@@[\s\S]*?@@")


def mask_raw_spans(text):
    spans = []

    def hide(match):
        spans.append(match.group(0))
        return f"\x00RAW{len(spans) - 1}\x00"

    return RAW_SPAN.sub(hide, text), spans


def unmask_raw_spans(text, spans):
    return re.sub(r"\x00RAW(\d+)\x00", lambda match: spans[int(match.group(1))], text)


def build(source: str, squares_source: str = "") -> tuple[str, int, list[str]]:
    body = CSS_MODULE.sub("", source)
    # This is a theme-page preview independent of page tags, so remove every
    # conditional wrapper while retaining its visible contents. Leaving a
    # bare [[iftags]] after stripping only the condition leaks literal source.
    body = re.sub(r"\[\[/?iftags(?:\s+[^\]]*)?\]\]", "", body, flags=re.I)
    while True:
        at = body.find("interwiki-style")
        if at < 0:
            break
        start = body.rfind("[[div_", 0, at)
        end = body.find("[[/div]]", at)
        if start < 0 or end < 0:
            break
        body = body[:start] + body[end + len("[[/div]]") :]
    body, replaced = SQUARES_INCLUDE.subn(lambda m: palette_markup(m.group(1)), body)
    # The JP theme-squares include contributes both markup and its own CSS.
    # The local article preview expands its markup above, so preserve the
    # component's current CSS module in the preview fixture as well.
    squares_css = "\n".join(
        re.sub(r"^\[\[module\s+CSS\]\]|\[\[/module\]\]$", "", module, flags=re.I).strip()
        for module in CSS_MODULE.findall(squares_source)
    )
    if replaced and squares_css:
        body += f"\n[[module CSS]]\n{squares_css}\n[[/module]]\n"

    # Theme pages commonly demonstrate JP-only credit/components with includes.
    # The local authoring site does not contain those corpus pages, so Deepwell
    # otherwise renders a visible missing-include error and the verdict fails
    # for a fixture limitation. Preserve the untouched installable source in
    # candidate.wikidot.source.txt; this derived preview records and omits
    # unresolved include directives, while standard runtime surfaces below
    # exercise Rate, TOC, tabs, collapsibles, tables, quotes, and image blocks.
    # Wikidot @@...@@ spans are literal text. An include-like sample inside one
    # (for example a documented "[[include ...]]" example with a nested span) is
    # not a directive, so mask those spans before any include handling; removing
    # the sample's opening would otherwise corrupt the displayed text.
    masked, raw_spans = mask_raw_spans(body)
    omitted_includes = sorted({item.strip() for item in INCLUDE_RE.findall(masked)})
    masked = INCLUDE_RE.sub("", masked)
    unclosed = re.findall(r"\[\[include\b[^\]]*$", masked, flags=re.I | re.M)
    if unclosed:
        masked = re.sub(r"\[\[include\b[^\]]*(?:\n|$)(?:(?!\]\]).*(?:\n|$))*$", "", masked, flags=re.I | re.M)
        omitted_includes.extend(f"unterminated:{item.strip()}" for item in unclosed)
    body = unmask_raw_spans(masked, raw_spans)

    fixture = ["\n\n+ Theme Lab runtime fixture\n"]
    # Always render a genuine current SCP-JP rating DOM. Theme articles also
    # contain literal Rate markup in code samples, which must not satisfy this
    # runtime-surface requirement.
    # Block delimiters occupy separate lines. Combining them leaves unmatched
    # closes as literal text and incorrectly puts the article inside creditRate.
    fixture.append(RATE_COMPONENT_FIXTURE)
    fixture.append('[[span class="theme-lab-jp-font-probe"]]日本語の字形を確認する検体です。漢字、ひらがな、カタカナ。[[/span]]')
    fixture.extend([
        "[[toc]]",
        '[[tabview]]\n[[tab 日本語サンプル]]\nSCP-JPのタブ表示\n[[/tab]]\n[[tab 第二のタブ]]\n日本語の長文は文字送りと高さを確認します。\n[[/tab]]\n[[/tabview]]',
        '[[collapsible show="開く" hide="閉じる"]]\n折り畳みの日本語本文です。\n[[/collapsible]]',
        "||~ 項目 ||~ 表示 ||\n|| ページ || 日本語の表 ||",
        "> 引用ブロックの日本語本文です。",
        '[[div class="scp-image-block block-right"]]\n画像ブロックのJP runtime surface\n[[/div]]',
        '脚注の日本語本文[[footnote]]日本語フォントと折返しを確認する脚注です。[[/footnote]]',
        '[[code]]@media (max-width: 640px) { .sample { font-family: sans-serif; } }\n日本語コード例[[/code]]',
    ])
    if len(fixture) > 1:
        body += "\n".join(fixture) + "\n"
    return body, replaced, omitted_includes


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--squares-source", type=Path, required=True)
    parser.add_argument("--assets-manifest", type=Path)
    args = parser.parse_args()
    source = args.input.read_text(errors="replace")
    squares_source = args.squares_source.read_text(encoding="utf-8")
    output, count, omitted = build(source, squares_source)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(output, encoding="utf-8")
    if args.assets_manifest:
        import hashlib, json
        args.assets_manifest.parent.mkdir(parents=True, exist_ok=True)
        args.assets_manifest.write_text(json.dumps({"source_sha256": hashlib.sha256(source.encode()).hexdigest(), "squares_source_sha256": hashlib.sha256(squares_source.encode()).hexdigest(), "expanded_theme_squares": count, "expanded_theme_squares_css_modules": len(CSS_MODULE.findall(squares_source)) if count else 0, "omitted_unseeded_includes": sorted(set(omitted)), "standard_runtime_fixture": ["Rate", "Japanese glyph specimen", "TOC", "tabs", "collapsible", "table", "blockquote", "image block", "footnote", "code"]}, ensure_ascii=False, indent=2) + "\n")
    print(f"preview source written; JP theme-squares component fixtures={count}; omitted unseeded includes={len(omitted)}; source_sha256={__import__('hashlib').sha256(args.squares_source.read_bytes()).hexdigest()}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
