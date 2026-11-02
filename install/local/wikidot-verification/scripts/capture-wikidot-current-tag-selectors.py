#!/usr/bin/env python3
"""Capture saved-holder ListPages current-tag selector behavior on Wikidot."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import time
import urllib.request
import uuid
from datetime import datetime, timezone
from pathlib import Path

import wikidot
from bs4 import BeautifulSoup
from wikidot.connector.ajax import AjaxModuleConnectorConfig


SELECTORS = {
    "current": "=",
    "exact_current": "==",
    "positive_current": "+=",
    "negative_current": "-=",
    "positive_exact_current": "+==",
    "negative_exact_current": "-==",
}

TARGETS = {
    "none": [],
    "alpha": ["alpha"],
    "beta": ["beta"],
    "alpha-beta": ["alpha", "beta"],
    "hidden": ["_hidden"],
    "alpha-hidden": ["alpha", "_hidden"],
}

HOLDERS = {
    "zero": [],
    "one": ["alpha"],
    "multiple": ["alpha", "beta"],
    "hidden-only": ["_hidden"],
    "mixed": ["alpha", "_hidden"],
}


def sha256_text(value: str) -> str:
    return hashlib.sha256(value.encode()).hexdigest()


def holder_source(prefix: str) -> str:
    sections: list[str] = []
    for case_name, selector in SELECTORS.items():
        sections.extend(
            [
                f'[[div class="lp-current-tags-{case_name}"]]',
                (
                    '[[module ListPages category="run-owned" '
                    f'name="{prefix}-target-*" tags="{selector}" '
                    'order="name" separate="no" wrapper="no" perPage="250"]]'
                ),
                "%%name%%|",
                "[[/module]]",
                "[[/div]]",
            ]
        )
    return "\n".join(sections)


def fetch_page_content(site_name: str, fullname: str) -> tuple[str, str]:
    url = f"http://{site_name}.wikidot.com/{fullname}?run={uuid.uuid4().hex}"
    last_error: Exception | None = None
    for attempt in range(5):
        try:
            request = urllib.request.Request(
                url,
                headers={"User-Agent": "Wikijump-compatibility-probe/1.0"},
            )
            with urllib.request.urlopen(request, timeout=30) as response:
                html = response.read().decode("utf-8")
            soup = BeautifulSoup(html, "lxml")
            content = soup.select_one("#page-content")
            if content is None:
                raise RuntimeError("saved page response lacks #page-content")
            return url, str(content)
        except Exception as error:
            last_error = error
            if attempt < 4:
                time.sleep(2)
    raise RuntimeError(f"failed to fetch saved page {fullname}") from last_error


def parse_cases(content_html: str) -> dict[str, dict[str, object]]:
    soup = BeautifulSoup(content_html, "lxml")
    cases: dict[str, dict[str, object]] = {}
    for case_name in SELECTORS:
        element = soup.select_one(f".lp-current-tags-{case_name}")
        if element is None:
            raise RuntimeError(f"saved page lacks case wrapper {case_name}")
        text = element.get_text(" ", strip=True)
        names = [part for part in text.split("|") if part]
        cases[case_name] = {
            "selector": SELECTORS[case_name],
            "names": names,
            "outer_html": str(element),
            "outer_html_sha256": sha256_text(str(element)),
        }
    return cases


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", required=True)
    parser.add_argument("--site", default="sandbox-for-codex")
    return parser.parse_args()


def create_run_owned_page(
    site: wikidot.Site,
    anonymous_site: wikidot.Site,
    *,
    fullname: str,
    title: str,
    source: str,
    comment: str,
    tags: list[str],
) -> wikidot.Page:
    page = wikidot.Page.create_or_edit(
        site=site,
        fullname=fullname,
        title=title,
        source=source,
        comment=comment,
        raise_on_exists=True,
    )
    anonymous_page = None
    for attempt in range(5):
        anonymous_page = anonymous_site.page.get(
            fullname,
            raise_when_not_found=False,
        )
        if anonymous_page is not None:
            break
        if attempt < 4:
            time.sleep(2)
    if anonymous_page is None:
        raise RuntimeError(f"cannot resolve newly created page {fullname}")
    page.id = anonymous_page.id
    try:
        page.set_metadata(tags=tags)
        if anonymous_page.refresh_source().wiki_text != source:
            raise RuntimeError(f"saved source verification failed for {fullname}")
    except Exception:
        page.destroy()
        raise
    return page


def main() -> int:
    args = parse_args()
    output = Path(args.output).resolve()
    if output.exists():
        raise FileExistsError(f"frozen Wikidot reference already exists: {output}")

    username = os.environ["WIKIDOT_USERNAME"]
    password = os.environ["WIKIDOT_PASSWORD"]
    run_id = datetime.now(timezone.utc).strftime("%Y%m%d%H%M%S") + "-" + uuid.uuid4().hex[:8]
    prefix = "lpct-" + datetime.now(timezone.utc).strftime("%y%m%d%H%M") + "-" + uuid.uuid4().hex[:6]
    created_pages: list[wikidot.Page] = []
    published: list[dict[str, object]] = []
    holder_records: list[dict[str, object]] = []
    cleanup_errors: list[str] = []

    config = AjaxModuleConnectorConfig(
        allow_insecure_session_transport_for=args.site,
    )
    with (
        wikidot.Client() as anonymous_client,
        wikidot.Client(
            username=username,
            password=password,
            amc_config=config,
        ) as client,
    ):
        anonymous_site = anonymous_client.site.get(args.site)
        site = client.site.get(args.site)
        try:
            for target_name, tags in TARGETS.items():
                fullname = f"run-owned:{prefix}-target-{target_name}"
                page = create_run_owned_page(
                    site,
                    anonymous_site,
                    fullname=fullname,
                    title=f"ListPages current-tags target {target_name}",
                    source=f"TARGET {target_name}",
                    comment=f"Run-owned ListPages current-tag probe {run_id}",
                    tags=tags,
                )
                created_pages.append(page)
                published.append(
                    {
                        "role": "target",
                        "name": target_name,
                        "fullname": fullname,
                        "tags": tags,
                        "created": True,
                        "source_matches": True,
                    }
                )

            source = holder_source(prefix)
            for holder_name, tags in HOLDERS.items():
                fullname = f"run-owned:{prefix}-holder-{holder_name}"
                page = create_run_owned_page(
                    site,
                    anonymous_site,
                    fullname=fullname,
                    title=f"ListPages current-tags holder {holder_name}",
                    source=source,
                    comment=f"Run-owned ListPages current-tag probe {run_id}",
                    tags=tags,
                )
                created_pages.append(page)
                published.append(
                    {
                        "role": "holder",
                        "name": holder_name,
                        "fullname": fullname,
                        "tags": tags,
                        "created": True,
                        "source_matches": True,
                    }
                )
                url, content_html = fetch_page_content(args.site, fullname)
                holder_records.append(
                    {
                        "name": holder_name,
                        "fullname": fullname,
                        "tags": tags,
                        "anonymous_url": url,
                        "source_sha256": sha256_text(source),
                        "page_content_html_sha256": sha256_text(content_html),
                        "cases": parse_cases(content_html),
                    }
                )
        finally:
            for page in reversed(created_pages):
                try:
                    page.destroy()
                except Exception as error:
                    cleanup_errors.append(f"{page.fullname}: {type(error).__name__}: {error}")

    artifact = {
        "schema": "wikijump.wikidot_listpages_current_tags.v1",
        "captured_at": datetime.now(timezone.utc).isoformat(),
        "provenance": {
            "site": args.site,
            "authenticated_mutation": True,
            "anonymous_saved_page_fetch": True,
            "run_owned": True,
            "wikidot_py_version": wikidot.__version__,
            "selectors": SELECTORS,
        },
        "run_id": run_id,
        "prefix": prefix,
        "published": published,
        "holders": holder_records,
        "cleanup": {
            "attempted": len(created_pages),
            "deleted": len(created_pages) - len(cleanup_errors),
            "errors": cleanup_errors,
            "retained": len(cleanup_errors),
        },
    }
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(artifact, ensure_ascii=False, indent=2) + "\n")
    if cleanup_errors:
        raise RuntimeError(
            f"failed to clean {len(cleanup_errors)} run-owned Wikidot pages; see {output}"
        )
    print(
        json.dumps(
            {
                "output": str(output),
                "holders": len(holder_records),
                "cleanup": artifact["cleanup"],
            }
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
