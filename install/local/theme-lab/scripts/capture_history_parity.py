#!/usr/bin/env python3
"""Capture anonymous, read-only Wikidot History AMC responses for EN and JP."""

from __future__ import annotations

import argparse
import hashlib
import importlib.metadata
import json
import os
import re
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

SITES = (("en", "scp-wiki"), ("jp", "scp-jp"))
PAGE_SLUG = "scp-173"
HISTORY_REQUEST = {
    "moduleName": "history/PageRevisionListModule",
    "perpage": "10",
    "options": "",
}


def sha256(content: bytes) -> str:
    return hashlib.sha256(content).hexdigest()


def write_exclusive(path: Path, content: bytes, mode: int = 0o644) -> None:
    descriptor = os.open(path, os.O_CREAT | os.O_EXCL | os.O_WRONLY, mode)
    try:
        with os.fdopen(descriptor, "wb") as stream:
            stream.write(content)
            stream.flush()
            os.fsync(stream.fileno())
    except BaseException:
        path.unlink(missing_ok=True)
        raise
    fsync_directory(path.parent)


def fsync_directory(directory: Path) -> None:
    descriptor = os.open(directory, os.O_RDONLY | getattr(os, "O_DIRECTORY", 0))
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def canonical_json(value: object) -> bytes:
    return (json.dumps(value, ensure_ascii=False, sort_keys=True, indent=2) + "\n").encode()


def verify_history_contract(body: str) -> dict[str, Any]:
    from bs4 import BeautifulSoup

    document = BeautifulSoup(body, "lxml")
    tables = document.select("table.page-history")
    if len(tables) != 1:
        raise ValueError(f"expected one table.page-history; observed {len(tables)}")
    table = tables[0]
    rows = table.find_all("tr")
    if len(rows) < 2:
        raise ValueError("History response has no revision rows")
    header_cells = rows[0].find_all(["td", "th"], recursive=False)
    if len(header_cells) != 7:
        raise ValueError(f"expected seven History header cells; observed {len(header_cells)}")
    revision_rows = []
    for row in rows[1:]:
        cells = row.find_all(["td", "th"], recursive=False)
        if len(cells) != 7:
            raise ValueError(f"expected seven revision cells; observed {len(cells)}")
        if not row.get("id", "").startswith("revision-row-"):
            raise ValueError("revision row is missing its revision-row-* identity")
        comparison = cells[1]
        radios = {radio.get("name") for radio in comparison.select('input[type="radio"]')}
        if not {"from", "to"}.issubset(radios):
            raise ValueError("comparison cell is missing from/to radio controls")
        action_labels = [link.get_text(" ", strip=True) for link in cells[3].select("a")]
        if not {"V", "S"}.issubset(action_labels):
            raise ValueError("action cell is missing View Version/Source links")
        if not cells[2].select(".spantip"):
            # Regular revisions can have an empty flags cell. The direct cell
            # itself is the contract; only record the optional visible flag.
            flag_text = cells[2].get_text(" ", strip=True)
        else:
            flag_text = cells[2].get_text(" ", strip=True)
        if not cells[4].select_one(".printuser"):
            raise ValueError("author cell is missing .printuser")
        if not cells[5].select_one(".odate"):
            raise ValueError("date cell is missing .odate")
        revision_rows.append(
            {
                "id": row["id"],
                "class": row.get("class", []),
                "cell_classes": [cell.get("class", []) for cell in cells],
                "radio_names": sorted(radios),
                "action_labels": action_labels,
                "flag_text": flag_text,
                "author_selector": ".printuser",
                "date_selector": ".odate",
                "comments_text": cells[6].get_text(" ", strip=True),
            }
        )
    return {
        "table_count": len(tables),
        "table_class": table.get("class", []),
        "row_parent_tags": sorted({row.parent.name for row in rows}),
        "header_cells": [cell.get_text(" ", strip=True) for cell in header_cells],
        "header_cell_classes": [cell.get("class", []) for cell in header_cells],
        "revision_rows": revision_rows,
        "column_order": [
            "revision-number",
            "from-to-radios",
            "flags",
            "view-version-source-actions",
            "author",
            "date",
            "comments",
        ],
    }


class ReadOnlyRecorder:
    """Seal each wikidot.py AMC response before allowing the next request."""

    def __init__(self, output: Path, site_label: str, domain: str) -> None:
        self.output = output
        self.site_label = site_label
        self.domain = domain
        self.responses_dir = output.with_name(output.stem + ".responses")
        self.responses_dir.mkdir(mode=0o755, exist_ok=True)
        fsync_directory(self.responses_dir.parent)
        self.sequence = 0
        self.records: list[dict[str, Any]] = []

    def request(self, original: Any, bodies: list[dict[str, Any]], return_exceptions: bool = False):
        if len(bodies) != 1:
            raise RuntimeError("capture permits exactly one read-only AMC request at a time")
        body = bodies[0]
        module = body.get("moduleName")
        if module not in {"list/ListPagesModule", "history/PageRevisionListModule"}:
            raise RuntimeError(f"capture refuses unexpected AMC module: {module}")

        self.sequence += 1
        request_id = f"{self.site_label}-{self.sequence:02d}"
        barrier = self.output.with_name(self.output.name + ".acquisition-barrier.json")
        if barrier.exists():
            raise RuntimeError(f"unfinished acquisition barrier exists: {barrier}")
        safe_request = {key: value for key, value in body.items() if key != "wikidot_token7"}
        barrier_record = {
            "schema": "theme_lab_wikidot_history_acquisition_barrier.v1",
            "request_id": request_id,
            "site": self.site_label,
            "host": self.domain,
            "path": "/ajax-module-connector.php",
            "request": safe_request,
            "created_at": datetime.now(UTC).isoformat(),
            "retry_policy": "none",
        }
        write_exclusive(barrier, canonical_json(barrier_record), 0o600)

        responses = original(bodies, return_exceptions=return_exceptions)
        if len(responses) != 1:
            raise RuntimeError("wikidot.py returned an unexpected AMC response count")
        response = responses[0]
        if isinstance(response, Exception):
            raise response
        if response.request.url.scheme != "https" or response.request.url.host != self.domain:
            raise RuntimeError("wikidot.py response resolved outside the exact HTTPS site identity")
        if response.request.url.path != "/ajax-module-connector.php":
            raise RuntimeError("wikidot.py response came from an unexpected path")

        raw_path = self.responses_dir / f"{request_id}.json"
        raw = response.content
        write_exclusive(raw_path, raw)
        record = {
            "request_id": request_id,
            "site": self.site_label,
            "host": self.domain,
            "method": response.request.method,
            "path": response.request.url.path,
            "request": safe_request,
            "status": response.status_code,
            "response_file": raw_path.name,
            "response_sha256": sha256(raw),
            "response_bytes": len(raw),
        }
        self.records.append(record)
        barrier.unlink()
        fsync_directory(barrier.parent)
        return responses


def capture(output: Path) -> dict[str, Any]:
    import wikidot
    from wikidot.connector.ajax import AjaxModuleConnectorConfig
    from wikidot.module.site import Site

    output = output.resolve()
    barrier = output.with_name(output.name + ".acquisition-barrier.json")
    responses_dir = output.with_name(output.stem + ".responses")
    if output.exists() or barrier.exists() or responses_dir.exists():
        raise FileExistsError("capture output or acquisition barrier already exists; inspect before retrying")
    output.parent.mkdir(parents=True, exist_ok=True)
    fsync_directory(output.parent)

    dependency_path = Path(__file__).parents[2] / "wikidot-verification" / "requirements.txt"
    dependency_text = dependency_path.read_text()
    pinned_commit = re.search(r"Rokurolize/wikidot\.py@([0-9a-f]{40})", dependency_text)
    if pinned_commit is None:
        raise RuntimeError("repository requirements do not contain the pinned wikidot.py commit")

    config = AjaxModuleConnectorConfig(
        request_timeout=20,
        attempt_limit=1,
        retry_interval=0,
        retry_max_retries=0,
        semaphore_limit=1,
    )
    site_records = []
    with wikidot.Client(amc_config=config) as client:
        # The API request contract only needs Wikidot's site-unix-name routing.
        # Use Site's public client abstraction with the known public host and
        # avoid a separate homepage fetch before this narrowly scoped capture.
        for label, unix_name in SITES:
            domain = f"{unix_name}.wikidot.com"
            site = Site(
                client=client,
                id=0,
                title=unix_name,
                unix_name=unix_name,
                domain=domain,
                ssl_supported=True,
            )
            recorder = ReadOnlyRecorder(output, label, domain)
            original_amc_request = site.amc_request

            def recorded_request(bodies, return_exceptions=False, *, _original=original_amc_request, _recorder=recorder):
                return _recorder.request(_original, bodies, return_exceptions)

            site.amc_request = recorded_request
            page = site.page.get(PAGE_SLUG)
            if page is None or page.id <= 0:
                raise RuntimeError(f"wikidot.py could not resolve the public page {unix_name}:{PAGE_SLUG}")

            request = {**HISTORY_REQUEST, "page_id": str(page.id)}
            (response,) = site.amc_request([request])
            try:
                envelope = response.json()
            except Exception as error:
                raise RuntimeError(f"History AMC response was not JSON for {label}") from error
            if not isinstance(envelope, dict) or not isinstance(envelope.get("body"), str):
                raise RuntimeError(f"History AMC response had no HTML body for {label}")
            contract = verify_history_contract(envelope["body"])
            site_records.append(
                {
                    "label": label,
                    "site": {"unix_name": unix_name, "domain": domain, "transport": "anonymous HTTPS"},
                    "page": {"slug": page.fullname, "page_id": page.id, "title": page.title},
                    "acquisition_requests": recorder.records,
                    "history_request": request,
                    "history_contract": contract,
                    "mobile_behavior": {
                        "status": "not_observable_in_AMC_fragment",
                        "reason": "The AMC response contains table markup only; responsive CSS and browser states require a separate source browser capture.",
                    },
                }
            )

    result = {
        "schema": "theme_lab_wikidot_history_parity_evidence.v1",
        "captured_at": datetime.now(UTC).isoformat(),
        "actor": {"authenticated": False, "mutations": 0},
        "wikidot_py": {
            "version": wikidot.__version__,
            "pinned_commit": pinned_commit.group(1),
            "requirements_sha256": sha256(dependency_path.read_bytes()),
        },
        "capture_script_sha256": sha256(Path(__file__).read_bytes()),
        "raw_response_directory": responses_dir.name,
        "sites": site_records,
        "limits": [
            "Only the first ten rows from each current PageRevisionListModule response are requested.",
            "AMC fragment evidence does not establish source-side mobile styling or interaction states.",
        ],
    }
    write_exclusive(output, canonical_json(result))
    return result


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    result = capture(args.output)
    print(
        json.dumps(
            {
                "output": str(args.output.resolve()),
                "site_count": len(result["sites"]),
                "request_count": sum(len(row["acquisition_requests"]) for row in result["sites"]),
                "mutations": 0,
            },
            sort_keys=True,
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
