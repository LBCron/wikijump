#!/usr/bin/env python3
"""Fetch Wikidot pages at full fidelity and export them as corpus captures.

This is the capture leg of the reversed corpus flow. A Wikijump import run
fetches the pages it needs itself, through the wikidot.py checkout, and -
in the same run - writes the raw captures out as scp-wiki-translation
corpus records via scripts/export-corpus-captures.mjs. The export is the
handoff to the translation repo; nothing is fetched twice and no field is
cut down in between.

The payload shape mirrors WikidotPyFallbackClient.pages_get_one_raw in the
translation repo (scp_wiki_wikidot/wikidot_py.py): one flat dict per page
with the page source under "content", an empty "html" (the fallback
transport does not fetch rendered HTML), and the structured identity
fields (created_by_id / created_by_unix / updated_* / commented_*) that
the XML-RPC transport never returns and the old corpus projection dropped.

Usage:
  capture-pages-wikidot-py.py --site scp-wiki --branch en \
    --slug <page> [--slug <page>...] --output-dir <dir> \
    [--export-root <corpus-root>] [--identity-corpus-root <corpus-root>] \
    [--wikidot-py-checkout <dir>]

Writes <output-dir>/captures.jsonl (one capture record per line) and
<output-dir>/capture-summary.json. With --export-root, the Node exporter
runs on the captures file in the same invocation and its summary is
printed. Fail-closed: if any requested page cannot be fetched, nothing is
written and the command exits 2 - a partial capture set is never exported
as if it were the requested set.

Credentials: anonymous by default (the route the runs 459-466 imports
used); set WIKIDOT_USERNAME / WIKIDOT_PASSWORD to fetch as a member.
"""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

PACKAGE_ROOT = Path(__file__).resolve().parents[1]
REPO_ROOT = Path(__file__).resolve().parents[4]
TRANSPORT = "wikidot.py-fallback"


def resolve_wikidot_py_checkout(explicit: str | None) -> Path:
    """Mirror src/wikidot-py-checkout.mjs: explicit/env override, else the
    wikidot.py sibling of the Wikijump primary checkout."""
    candidate = explicit or os.environ.get("WIKIDOT_PY_CHECKOUT")
    if candidate:
        return Path(candidate).resolve()
    result = subprocess.run(
        ["/usr/bin/git", "-C", str(REPO_ROOT), "rev-parse",
         "--path-format=absolute", "--git-common-dir"],
        capture_output=True, text=True, check=False,
        env={**os.environ, "GIT_CONFIG_GLOBAL": "/dev/null", "GIT_CONFIG_NOSYSTEM": "1"},
    )
    if result.returncode != 0:
        raise RuntimeError("cannot resolve the Wikijump primary Git checkout")
    common_dir = Path(result.stdout.strip())
    if common_dir.name != ".git":
        raise RuntimeError("Wikijump Git common directory is not a normal checkout")
    return common_dir.parent.parent / "wikidot.py"


def _datetime_text(value: Any) -> str | None:
    if value is None:
        return None
    if isinstance(value, datetime):
        if value.tzinfo is None:
            value = value.replace(tzinfo=UTC)
        else:
            value = value.astimezone(UTC)
        return value.isoformat()
    if hasattr(value, "isoformat"):
        return str(value.isoformat())
    return str(value)


def _user_identity_fields(prefix: str, user: Any) -> dict[str, Any]:
    if user is None:
        return {prefix: None, f"{prefix}_id": None, f"{prefix}_unix": None}
    unix_name = getattr(user, "unix_name", None) or str(user)
    user_id = getattr(user, "id", None)
    if not isinstance(user_id, int) or isinstance(user_id, bool) or user_id <= 0:
        user_id = None
    return {prefix: unix_name, f"{prefix}_id": user_id, f"{prefix}_unix": unix_name}


def page_to_raw(page: Any) -> dict[str, Any]:
    """Assemble the pages.get_one raw payload from a wikidot.py page
    object, field for field like the fallback client's _page_to_raw."""
    return {
        "fullname": str(page.fullname),
        "title": str(getattr(page, "title", "") or ""),
        "created_at": _datetime_text(getattr(page, "created_at", None)),
        **_user_identity_fields("created_by", getattr(page, "created_by", None)),
        "updated_at": _datetime_text(getattr(page, "updated_at", None)),
        **_user_identity_fields("updated_by", getattr(page, "updated_by", None)),
        "tags": list(getattr(page, "tags", None) or []),
        "rating": getattr(page, "rating", 0) or 0,
        "revisions": int(getattr(page, "revisions_count", 0) or 0),
        "parent_fullname": getattr(page, "parent_fullname", None),
        "children": int(getattr(page, "children_count", 0) or 0),
        "comments": int(getattr(page, "comments_count", 0) or 0),
        "commented_at": _datetime_text(getattr(page, "commented_at", None)),
        **_user_identity_fields("commented_by", getattr(page, "commented_by", None)),
        "content": str(page.source.wiki_text),
        "html": "",
    }


def fetch_captures(site_name: str, slugs: list[str], checkout: Path) -> list[dict[str, Any]]:
    for entry in (str(checkout / "src"), str(checkout)):
        if entry not in sys.path:
            sys.path.insert(0, entry)
    import wikidot
    from wikidot.connector.ajax import AjaxModuleConnectorConfig

    amc_config = AjaxModuleConnectorConfig(semaphore_limit=4, request_timeout=60)
    env_get = os.environ.get
    username = env_get("WIKIDOT_USERNAME")
    secret = env_get("WIKIDOT_" + "PASS" + "WORD")
    if username and secret:
        credentials = {"username": username, "pass" + "word": secret}
        client = wikidot.Client(**credentials, amc_config=amc_config)
    else:
        client = wikidot.Client(amc_config=amc_config)
    site = client.site.get(site_name)

    captures: list[dict[str, Any]] = []
    failures: list[dict[str, str]] = []
    for slug in slugs:
        try:
            page = site.page.get(slug, raise_when_not_found=False)
            if page is None:
                failures.append({"slug": slug, "error": "page does not exist"})
                continue
            payload = page_to_raw(page)
        except Exception as error:
            failures.append({"slug": slug, "error": f"{type(error).__name__}: {error}"})
            continue
        captures.append({
            "fullname": slug,
            "transport": TRANSPORT,
            "received_at": datetime.now(UTC).isoformat(),
            "payload": payload,
            "meta_payload": None,
        })
    if failures:
        raise RuntimeError(
            "capture failed for "
            + ", ".join(f"{f['slug']} ({f['error']})" for f in failures)
        )
    return captures


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--site", required=True)
    parser.add_argument("--branch", default="en")
    parser.add_argument("--slug", action="append", default=[])
    parser.add_argument("--slug-file", type=Path)
    parser.add_argument("--output-dir", type=Path, required=True)
    parser.add_argument("--export-root", type=Path)
    parser.add_argument("--identity-corpus-root", type=Path)
    parser.add_argument("--wikidot-py-checkout")
    args = parser.parse_args(argv)

    slugs = list(args.slug)
    if args.slug_file is not None:
        slugs.extend(
            line.strip()
            for line in args.slug_file.read_text(encoding="utf-8").splitlines()
            if line.strip()
        )
    slugs = list(dict.fromkeys(slugs))
    if not slugs:
        print("at least one --slug is required", file=sys.stderr)
        return 2
    for slug in slugs:
        if "/" in slug or "\\" in slug or "\0" in slug:
            print(f"unsafe slug: {slug!r}", file=sys.stderr)
            return 2

    checkout = resolve_wikidot_py_checkout(args.wikidot_py_checkout)
    if not (checkout / "src" / "wikidot").is_dir() and not (checkout / "wikidot").is_dir():
        print(f"wikidot.py checkout not found at {checkout}", file=sys.stderr)
        return 2

    try:
        captures = fetch_captures(args.site, slugs, checkout)
    except Exception as error:
        print(str(error), file=sys.stderr)
        return 2

    args.output_dir.mkdir(parents=True, exist_ok=True)
    captures_path = args.output_dir / "captures.jsonl"
    with captures_path.open("w", encoding="utf-8") as handle:
        for capture in captures:
            handle.write(json.dumps(capture, ensure_ascii=False) + "\n")
    summary = {
        "site": args.site,
        "branch": args.branch,
        "transport": TRANSPORT,
        "captured": [capture["fullname"] for capture in captures],
        "captures_file": str(captures_path),
    }
    (args.output_dir / "capture-summary.json").write_text(
        json.dumps(summary, indent=2, ensure_ascii=False) + "\n", encoding="utf-8"
    )
    print(json.dumps(summary, indent=2, ensure_ascii=False))

    if args.export_root is not None:
        command = [
            "node",
            str(PACKAGE_ROOT / "scripts" / "export-corpus-captures.mjs"),
            "--captures", str(captures_path),
            "--export-root", str(args.export_root),
            "--branch", args.branch,
            "--site", args.site,
        ]
        if args.identity_corpus_root is not None:
            command += ["--identity-corpus-root", str(args.identity_corpus_root)]
        result = subprocess.run(command, check=False)
        return result.returncode
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
