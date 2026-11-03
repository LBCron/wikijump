#!/usr/bin/env python3
"""Acquire anonymous, read-only Wikidot Files and ViewSource module responses."""

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
ALLOWED_MODULES = {
    "list/ListPagesModule",
    "files/PageFilesModule",
    "viewsource/ViewSourceModule",
}


def sha256(content: bytes) -> str:
    return hashlib.sha256(content).hexdigest()


def fsync_directory(directory: Path) -> None:
    descriptor = os.open(directory, os.O_RDONLY | getattr(os, "O_DIRECTORY", 0))
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


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


def canonical_json(value: object) -> bytes:
    return (json.dumps(value, ensure_ascii=False, sort_keys=True, indent=2) + "\n").encode()


class ReadOnlyRecorder:
    """Seal one exact anonymous AMC response before permitting the next request."""

    def __init__(self, output: Path, site_label: str, domain: str) -> None:
        self.output = output
        self.site_label = site_label
        self.domain = domain
        self.responses_dir = output.with_name(output.stem + ".responses")
        self.responses_dir.mkdir(mode=0o755, exist_ok=True)
        fsync_directory(self.responses_dir.parent)
        self.sequence = 0
        self.records: list[dict[str, Any]] = []

    def request(self, original, bodies: list[dict[str, Any]], return_exceptions: bool = False):
        if len(bodies) != 1:
            raise RuntimeError("capture permits exactly one read-only AMC request at a time")
        body = bodies[0]
        module = body.get("moduleName")
        if module not in ALLOWED_MODULES:
            raise RuntimeError(f"capture refuses unexpected AMC module: {module}")

        self.sequence += 1
        request_id = f"{self.site_label}-{self.sequence:02d}"
        barrier = self.output.with_name(self.output.name + ".acquisition-barrier.json")
        if barrier.exists():
            raise RuntimeError(f"unfinished acquisition barrier exists: {barrier}")
        safe_request = {key: value for key, value in body.items() if key != "wikidot_token7"}
        write_exclusive(
            barrier,
            canonical_json(
                {
                    "schema": "theme_lab_runtime_surface_module_acquisition_barrier.v1",
                    "request_id": request_id,
                    "site": self.site_label,
                    "host": self.domain,
                    "path": "/ajax-module-connector.php",
                    "request": safe_request,
                    "created_at": datetime.now(UTC).isoformat(),
                    "retry_policy": "none",
                }
            ),
            0o600,
        )

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

        raw = response.content
        raw_path = self.responses_dir / f"{request_id}.json"
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


def summarize_body(module: str, body: str) -> dict[str, Any]:
    from bs4 import BeautifulSoup

    soup = BeautifulSoup(body, "lxml")
    if module == "files/PageFilesModule":
        files = soup.select(".file-list .file-row, .page-files .file-row")
        return {
            "module": module,
            "body_sha256": sha256(body.encode()),
            "body_bytes": len(body.encode()),
            "page_files_count": len(soup.select(".page-files")),
            "file_list_count": len(soup.select(".file-list")),
            "file_rows": [
                {
                    "classes": row.get("class", []),
                    "name_text": row.select_one(".file-name").get_text(" ", strip=True) if row.select_one(".file-name") else None,
                    "name_classes": row.select_one(".file-name").get("class", []) if row.select_one(".file-name") else [],
                    "attributes_classes": row.select_one(".file-attribute").get("class", []) if row.select_one(".file-attribute") else [],
                    "links": [link.get("href") for link in row.select("a[href]")],
                }
                for row in files
            ],
        }
    source = soup.select(".page-source")
    return {
        "module": module,
        "body_sha256": sha256(body.encode()),
        "body_bytes": len(body.encode()),
        "page_source_count": len(source),
        "page_source_classes": [node.get("class", []) for node in source],
        "source_text_bytes": [len(node.get_text().encode()) for node in source],
        "textarea_count": len(soup.select("textarea")),
        "anchors": [link.get("href") for node in source for link in node.select("a[href]")],
    }


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

    requirements = Path(__file__).parents[2] / "wikidot-verification" / "requirements.txt"
    requirement_text = requirements.read_text()
    pinned = re.search(r"Rokurolize/wikidot\.py@([0-9a-f]{40})", requirement_text)
    if pinned is None:
        raise RuntimeError("repository requirements do not contain the pinned wikidot.py commit")

    config = AjaxModuleConnectorConfig(
        request_timeout=20,
        attempt_limit=1,
        retry_interval=0,
        retry_max_retries=0,
        semaphore_limit=1,
    )
    sites = []
    with wikidot.Client(amc_config=config) as client:
        for label, unix_name in SITES:
            domain = f"{unix_name}.wikidot.com"
            site = Site(client=client, id=0, title=unix_name, unix_name=unix_name, domain=domain, ssl_supported=True)
            recorder = ReadOnlyRecorder(output, label, domain)
            original = site.amc_request

            def recorded(bodies, return_exceptions=False, *, _original=original, _recorder=recorder):
                return _recorder.request(_original, bodies, return_exceptions)

            site.amc_request = recorded
            page = site.page.get(PAGE_SLUG)
            if page is None or page.id <= 0:
                raise RuntimeError(f"wikidot.py could not resolve the public page {unix_name}:{PAGE_SLUG}")
            files = page.files
            source = page.source
            modules = {}
            for request_record in recorder.records:
                response = json.loads((responses_dir / request_record["response_file"]).read_bytes())
                body = response.get("body") if isinstance(response, dict) else None
                if isinstance(body, str):
                    modules[request_record["request"]["moduleName"]] = summarize_body(request_record["request"]["moduleName"], body)
            sites.append(
                {
                    "site": {"unix_name": unix_name, "domain": domain, "transport": "anonymous HTTPS"},
                    "page": {
                        "slug": page.fullname,
                        "page_id": page.id,
                        "title": page.title,
                        "revision_count": page.revisions_count,
                        "file_count": len(files),
                    },
                    "acquisition_requests": recorder.records,
                    "files_collection": [
                        {"id": item.id, "name": item.name, "url": item.url, "mime_type": item.mime_type, "size": item.size}
                        for item in files
                    ],
                    "source_wikitext_sha256": sha256(source.wiki_text.encode()),
                    "source_wikitext_bytes": len(source.wiki_text.encode()),
                    "module_summaries": modules,
                }
            )

    result = {
        "schema": "theme_lab_wikidot_runtime_surface_module_evidence.v1",
        "captured_at": datetime.now(UTC).isoformat(),
        "actor": {"authenticated": False, "mutations": 0},
        "wikidot_py": {
            "version": wikidot.__version__,
            "pinned_commit": pinned.group(1),
            "requirements_sha256": sha256(requirements.read_bytes()),
        },
        "capture_script_sha256": sha256(Path(__file__).read_bytes()),
        "raw_response_directory": responses_dir.name,
        "sites": sites,
        "limits": [
            "Only anonymous read-only ListPages, PageFiles, and ViewSource AMC modules are admitted.",
            "The source identity is SCP-173 on each current site; the captured Files result may be empty and is not generalized to other pages.",
            "AMC markup records source module DOM, not browser CSS, interaction timing, or computed layout.",
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
                "request_count": sum(len(site["acquisition_requests"]) for site in result["sites"]),
                "mutations": 0,
            },
            sort_keys=True,
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
