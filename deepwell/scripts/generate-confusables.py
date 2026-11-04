#!/usr/bin/env python3
import sys
import unicodedata
import urllib.request
from pathlib import Path

UNICODE_VERSION = "16.0.0"
SOURCE_URL = f"https://www.unicode.org/Public/security/{UNICODE_VERSION}/confusables.txt"
OUTPUT_PATH = Path(__file__).resolve().parent.parent / "src" / "utils" / "slug" / "confusables.rs"

REPRESENTATIVES = {}


def _rep(name, rep, marks=()):
    base = unicodedata.lookup(name)
    REPRESENTATIVES[base] = rep
    for mark in marks:
        REPRESENTATIVES[base + mark] = rep


_rep("LATIN SMALL LETTER SHARP S", "b")
_rep("LATIN SMALL LETTER A WITH RING ABOVE", "a")
_rep("LATIN SMALL LETTER A WITH BREVE", "a")
_rep("LATIN SMALL LETTER E WITH BREVE", "e")
_rep("LATIN SMALL LETTER G WITH BREVE", "g")
_rep("LATIN SMALL LETTER G WITH CEDILLA", "g")
_rep("LATIN SMALL LETTER I WITH BREVE", "i")
_rep("LATIN SMALL LETTER O WITH BREVE", "o")
_rep("LATIN SMALL LETTER O WITH DOUBLE ACUTE", "o")
_rep("LATIN SMALL LETTER U WITH BREVE", "u")
_rep("LATIN SMALL LETTER A WITH HOOK ABOVE", "a")
_rep("LATIN SMALL LETTER O WITH STROKE AND ACUTE", "o")
_rep("LATIN SMALL LETTER KRA", "k", marks=("\u0329", "\u0335"))
_rep("LATIN SMALL LETTER C WITH HOOK", "c")
_rep("LATIN SMALL LETTER Q WITH HOOK TAIL", "q")
_rep("LATIN SMALL LETTER K WITH STROKE", "k")
_rep("LATIN SMALL LETTER R ROTUNDA", "r")
_rep("LATIN SMALL LETTER K WITH DESCENDER", "k")
_rep("LATIN SMALL LETTER H WITH DESCENDER", "h")
_rep("LATIN SMALL LETTER T WITH PALATAL HOOK", "t")
_rep("LATIN SMALL LETTER T WITH RETROFLEX HOOK", "t")
_rep("LATIN SMALL LETTER T WITH DIAGONAL STROKE", "t")
_rep("LATIN SMALL LETTER TURNED T", "t")
_rep("LATIN LETTER SMALL CAPITAL G", "g")
_rep("LATIN LETTER SMALL CAPITAL H", "h", marks=("\u0326", "\u0329"))
_rep("LATIN LETTER SMALL CAPITAL B", "b")
_rep("LATIN LETTER SMALL CAPITAL T", "t", marks=("\u0329",))
_rep("LATIN LETTER SMALL CAPITAL A", "a")
_rep("LATIN LETTER SMALL CAPITAL D", "d")
_rep("LATIN LETTER SMALL CAPITAL E", "e")
_rep("LATIN LETTER SMALL CAPITAL J", "j")
_rep("LATIN LETTER SMALL CAPITAL L", "l")
_rep("LATIN LETTER SMALL CAPITAL P", "p")
_rep("LATIN LETTER SMALL CAPITAL R", "r")
_rep("LATIN LETTER SMALL CAPITAL REVERSED N", "n")
_rep("LATIN LETTER SMALL CAPITAL REVERSED R", "r")
_rep("LATIN SMALL LETTER TURNED W", "m", marks=("\u0326",))
_rep("LATIN SMALL LETTER C WITH BAR", "e", marks=("\u0332",))
_rep("GREEK SMALL LETTER MU", "u")
_rep("GREEK SMALL LETTER PI", "n")
_rep("GREEK SMALL LETTER CHI", "x")
_rep("GREEK SMALL LETTER OMEGA", "w", marks=("\u0332",))
_rep("GREEK SMALL LETTER FINAL SIGMA", "o")
_rep("GREEK SMALL LETTER DIGAMMA", "f")
_rep("LATIN SMALL LETTER DELTA", "d", marks=("\u0332",))
_rep("LATIN SMALL LETTER REVERSED OPEN E", "3", marks=("\u0326",))
_rep("LATIN SMALL LETTER N WITH LEFT HOOK", "n")
_rep("LATIN SMALL LETTER U BAR", "u")
_rep("LATIN SMALL LETTER DOTLESS J", "j")
_rep("LATIN CAPITAL LETTER INSULAR D", "d")
_rep("LATIN SMALL LETTER J WITH CROSSED-TAIL", "j")
_rep("GREEK SMALL LETTER OMEGA WITH OXIA AND YPOGEGRAMMENI", "w")
_rep("TURNED SMALL F", "f")
_rep("CIRCLED LATIN SMALL LETTER C", "c")
_rep("CIRCLED LATIN SMALL LETTER I", "i")
_rep("CIRCLED LATIN SMALL LETTER P", "p")
_rep("CIRCLED LATIN SMALL LETTER R", "r")
_rep("FULLWIDTH LATIN SMALL LETTER B", "b")
_rep("FULLWIDTH LATIN SMALL LETTER K", "k")
_rep("FULLWIDTH LATIN SMALL LETTER M", "m")
_rep("FULLWIDTH LATIN SMALL LETTER N", "n")
_rep("FULLWIDTH LATIN SMALL LETTER T", "t")
_rep("FULLWIDTH LATIN SMALL LETTER Z", "z")
REPRESENTATIVES["d\u017e"] = "dz"
REPRESENTATIVES["o\u1d07"] = "oe"


def representative(value):
    if value in REPRESENTATIVES:
        return REPRESENTATIVES[value]
    if any(c.isascii() and c.isalpha() for c in value) and all(
        c.isascii() or unicodedata.category(c) in ("Mn", "Me") for c in value
    ):
        return "".join(c for c in value if ord(c) < 0x80)
    return value


def load_source():
    if len(sys.argv) > 1:
        return Path(sys.argv[1]).read_text(encoding="utf-8")
    with urllib.request.urlopen(SOURCE_URL) as response:
        return response.read().decode("utf-8")


def main():
    table = {}
    for line in load_source().splitlines():
        body = line.split("#")[0].strip()
        if not body:
            continue
        fields = [p.strip() for p in body.split(";")]
        source = "".join(chr(int(x, 16)) for x in fields[0].split())
        target = "".join(chr(int(x, 16)) for x in fields[1].split())
        assert fields[2] == "MA", fields
        assert len(source) == 1, fields
        assert source not in table, fields
        table[source] = target
    dataset_entries = len(table)

    def one_pass(text, mapping):
        out = []
        for ch in text:
            for lowered in ch.lower():
                out.append(mapping.get(lowered, lowered))
        return "".join(out)

    def fixpoint(text):
        current = text
        for _ in range(32):
            nxt = one_pass(current, table)
            if nxt == current:
                return current
            current = nxt
        raise AssertionError(f"no fixpoint for {text!r}")

    def final(char):
        value = fixpoint(char) if char in table else char
        return representative(value)

    candidates = set(table)
    for target in table.values():
        candidates.update(target)
    for source in table:
        candidates.update(fixpoint(source))

    def strong_opinion(char):
        opinion = representative(fixpoint(char)) if char in table else representative(char)
        return None if opinion == char else opinion

    groups = {}
    dropped = []
    for char in sorted(candidates):
        if ord(char) < 0x80 and char not in "01":
            continue
        key = char.lower()
        if len(key) != 1:
            dropped.append((char, "multi-char lowercase"))
            continue
        groups.setdefault(key, []).append((char, strong_opinion(char)))

    emitted = {}
    for key, opinions in sorted(groups.items()):
        strong = {opinion for _, opinion in opinions if opinion is not None}
        if len(strong) > 1:
            raise AssertionError(
                f"key conflict for {key!r}: {strong!r} from {[hex(ord(c)) for c, _ in opinions]}"
            )
        if not strong:
            continue
        value = strong.pop()
        if value == key:
            continue
        if key.isascii() and key.isalpha():
            dropped.append((key, f"non-identity ASCII letter key -> {value!r}"))
            continue
        emitted[key] = value

    def runtime(text):
        return one_pass(text, emitted)

    failures = []
    for source in table:
        if ord(source) < 0x80:
            continue
        if runtime(source) != final(source):
            failures.append(
                f"source U+{ord(source):04X}: runtime {runtime(source)!r} != final {final(source)!r}"
            )
    for char in candidates:
        if ord(char) < 0x80:
            continue
        opinion = strong_opinion(char)
        if opinion is not None and runtime(char) != opinion:
            failures.append(
                f"candidate U+{ord(char):04X}: runtime {runtime(char)!r} != opinion {opinion!r}"
            )
    if failures:
        raise AssertionError("self-check failed:\n" + "\n".join(failures[:20]))

    vectors = [
        ("cycle2-\u0432ob", "cycle2-bob"),
        ("cycle2-\u0412en", "cycle2-ben"),
        ("cycle2-\u0454ve", "cycle2-eve"),
        ("cycle2-\u04afara", "cycle2-yara"),
        ("cycle2-m0do", "cycle2-modo"),
        ("sectest-\u0435ve", "sectest-eve"),
        ("\u03b1\u03c1\u03c4", "apt"),
        ("\u0440\u0430\u0441", "pac"),
        ("\u0434mitry", "\u0434mitry"),
        ("user1", "userl"),
        ("\u03c3", "o"),
        ("\u0585", "o"),
        ("\u043d", "h"),
        ("abcdefghijklmnopqrstuvwxyz", "abcdefghijklmnopqrstuvwxyz"),
        ("23456789", "23456789"),
    ]
    for text, expected in vectors:
        actual = runtime(text)
        if actual != expected:
            raise AssertionError(f"vector failed: {text!r} -> {actual!r} != {expected!r}")

    def rust_char(ch):
        return "'\\u{%x}'" % ord(ch)

    def rust_str(text):
        out = []
        for ch in text:
            if ch == '"':
                out.append('\\"')
            elif ch == "\\":
                out.append("\\\\")
            elif 0x20 <= ord(ch) < 0x7F:
                out.append(ch)
            else:
                out.append("\\u{%x}" % ord(ch))
        return '"' + "".join(out) + '"'

    lines = []
    lines.append("/*")
    lines.append(" * utils/slug/confusables.rs")
    lines.append(" *")
    lines.append(" * DEEPWELL - Wikijump API provider and database manager")
    lines.append(" * Copyright (C) 2019-2026 Wikijump Team")
    lines.append(" *")
    lines.append(" * This program is free software: you can redistribute it and/or modify")
    lines.append(" * it under the terms of the GNU Affero General Public License as published by")
    lines.append(" * the Free Software Foundation, either version 3 of the License, or")
    lines.append(" * (at your option) any later version.")
    lines.append(" *")
    lines.append(" * This program is distributed in the hope that it will be useful,")
    lines.append(" * but WITHOUT ANY WARRANTY; without even the implied warranty of")
    lines.append(" * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the")
    lines.append(" * GNU Affero General Public License for more details.")
    lines.append(" *")
    lines.append(" * You should have received a copy of the GNU Affero General Public License")
    lines.append(" * along with this program. If not, see <http://www.gnu.org/licenses/>.")
    lines.append(" */")
    lines.append("")
    lines.append(
        f"// Generated by deepwell/scripts/generate-confusables.py from Unicode {UNICODE_VERSION} confusables.txt (UTS #39). Do not edit by hand."
    )
    lines.append("#[allow(dead_code)]")
    lines.append(f"pub(crate) const CONFUSABLES_DATASET_ENTRIES: usize = {dataset_entries};")
    lines.append("")
    lines.append("pub(crate) const CONFUSABLE_SKELETON_MAP: &[(char, &str)] = &[")
    for key in sorted(emitted):
        entry = f"    ({rust_char(key)}, {rust_str(emitted[key])}),"
        if len(entry) > 100:
            lines.append("    (")
            lines.append(f"        {rust_char(key)},")
            lines.append(f"        {rust_str(emitted[key])},")
            lines.append("    ),")
        else:
            lines.append(entry)
    lines.append("];")
    lines.append("")
    output_path = Path(sys.argv[2]) if len(sys.argv) > 2 else OUTPUT_PATH
    output_path.write_text("\n".join(lines), encoding="utf-8")
    print(f"dataset entries: {dataset_entries}")
    print(f"emitted entries: {len(emitted)}")
    print(f"dropped candidates: {dropped}")
    print(f"wrote {output_path}")


if __name__ == "__main__":
    main()
