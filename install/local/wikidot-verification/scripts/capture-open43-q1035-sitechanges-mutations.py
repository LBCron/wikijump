#!/usr/bin/env python3
from __future__ import annotations

import argparse
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
from typing import Any

from bs4 import BeautifulSoup


SCHEMA = "wikijump.open43_q1035_sitechanges_mutation_live.v1"
SITE = "sandbox-for-codex"
RUN_ID_RE = re.compile(r"issue1035-[0-9]{8}t[0-9]{6}z-[a-z0-9]{4,12}")
WIKIDOT_PY_ROOT = Path("/home/roku/src/Rokurolize/wikidot.py")


def sha256_text(value: str) -> str:
    return hashlib.sha256(value.encode()).hexdigest()


def wikidot_py_commit() -> str:
    return subprocess.check_output(
        ["git", "-C", str(WIKIDOT_PY_ROOT), "rev-parse", "HEAD"],
        text=True,
    ).strip()


def sitechanges_body(site: Any, options: str) -> str:
    response = site.amc_request(
        [
            {
                "moduleName": "changes/SiteChangesListModule",
                "page": "1",
                "perpage": "1000",
                "options": options,
            }
        ]
    )[0]
    payload = response.json()
    if payload.get("status") != "ok" or not isinstance(payload.get("body"), str):
        raise RuntimeError(f"SiteChanges returned unexpected status for {options}")
    return payload["body"]


def matching_rows(body: str, marker: str) -> list[dict[str, Any]]:
    soup = BeautifulSoup(body, "lxml")
    rows = []
    for index, item in enumerate(soup.select("div.changes-list-item")):
        title_link = item.select_one("td.title > a")
        comment_cell = item.select_one("td.comments") or item.select_one("div.comments")
        href = title_link.get("href") if title_link is not None else None
        title = title_link.get_text(" ", strip=True) if title_link is not None else ""
        comment = comment_cell.get_text(" ", strip=True) if comment_cell is not None else ""
        if marker not in str(href) and marker not in title and marker not in comment:
            continue
        flags = [node.get_text(" ", strip=True) for node in item.select("td.flags > span")]
        revision = item.select_one("td.revision-no")
        rows.append(
            {
                "index": index,
                "href": href,
                "title": title,
                "flags": flags,
                "revision": revision.get_text(" ", strip=True) if revision is not None else None,
                "comment": comment or None,
            }
        )
    return rows


def observe(site: Any, marker: str, options: str) -> dict[str, Any]:
    body = sitechanges_body(site, options)
    return {
        "request": {
            "moduleName": "changes/SiteChangesListModule",
            "page": "1",
            "perpage": "1000",
            "options": options,
        },
        "body_sha256": sha256_text(body),
        "matching_rows": matching_rows(body, marker),
    }


def absent(site: Any, fullname: str) -> bool:
    return site.page.get(fullname, raise_when_not_found=False) is None


def main() -> int:
    import wikidot
    from wikidot.connector.ajax import AjaxModuleConnectorConfig

    parser = argparse.ArgumentParser()
    parser.add_argument("--run-id", required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    if not RUN_ID_RE.fullmatch(args.run_id):
        raise ValueError("run ID must be issue1035-YYYYMMDDtHHMMSSz-<suffix>")
    if args.output.exists():
        raise FileExistsError(f"refusing to replace {args.output}")
    username = os.environ.get("WIKIDOT_USERNAME")
    password = os.environ.get("WIKIDOT_PASSWORD")
    if not username or not password:
        raise RuntimeError("WIKIDOT_USERNAME and WIKIDOT_PASSWORD are required")

    marker = args.run_id
    parent_name = f"run-owned:{marker}-parent"
    child_name = f"run-owned:{marker}-child"
    moved_name = f"run-owned:{marker}-moved"
    plan = {
        "site": SITE,
        "actor": "sandbox account A",
        "run_owned_fullnames": [parent_name, child_name, moved_name],
        "mutation_order": ["create-parent", "create-child", "edit-source-title", "set-parent", "rename-move", "delete-child-cleanup", "delete-parent-cleanup"],
        "post_mutation_reads": ["all", "source", "files"],
        "delete_observation_read": "all",
        "restore": "not_attempted_no_repository_pinned_safe_live_restore_operation",
        "file_action": "not_attempted_no_cleanup_safe_authenticated_upload_operation_in_repository_pinned_client",
    }
    artifact: dict[str, Any] = {
        "schema": SCHEMA,
        "captured_at": datetime.now(timezone.utc).isoformat(),
        "run_id": args.run_id,
        "wikidot_py_commit": wikidot_py_commit(),
        "plan": plan,
        "mutated": False,
        "baseline": None,
        "after_mutations": None,
        "after_delete": None,
        "cleanup": {"attempted": False, "child_absent": False, "parent_absent": False},
        "error": None,
    }
    current_child_name = child_name
    parent = None
    child = None
    failure: BaseException | None = None

    config = AjaxModuleConnectorConfig(allow_insecure_session_transport_for=SITE)
    try:
        with wikidot.Client(username=username, password=password, amc_config=config) as client:
            site = client.site.get(SITE)
            if not all(absent(site, fullname) for fullname in (parent_name, child_name, moved_name)):
                raise RuntimeError("run-owned fullname collision before mutation")
            artifact["baseline"] = observe(site, marker, '{"all":true}')
            if artifact["baseline"]["matching_rows"]:
                raise RuntimeError("run marker already appears in SiteChanges baseline")

            parent = site.page.create(
                parent_name,
                title=f"{marker} parent",
                source=f"{marker} parent baseline",
                comment=f"{marker} create parent",
            )
            artifact["mutated"] = True
            child = site.page.create(
                child_name,
                title=f"{marker} child",
                source=f"{marker} child baseline",
                comment=f"{marker} create child",
            )
            child = child.edit(
                title=f"{marker} edited title",
                source=f"{marker} edited source",
                comment=f"{marker} edit source title",
            )
            child.set_parent(parent_name)
            child.rename(moved_name)
            current_child_name = moved_name

            artifact["after_mutations"] = {
                "all": observe(site, marker, '{"all":true}'),
                "source": observe(site, marker, '{"source":true}'),
                "files": observe(site, marker, '{"files":true}'),
            }

            child.destroy()
            child = None
            artifact["after_delete"] = observe(site, marker, '{"all":true}')
            artifact["cleanup"]["attempted"] = True
            artifact["cleanup"]["child_absent"] = absent(site, current_child_name)
            parent.destroy()
            parent = None
            artifact["cleanup"]["parent_absent"] = absent(site, parent_name)
    except BaseException as error:
        failure = error
        artifact["error"] = {"type": type(error).__name__, "message": str(error)}
        try:
            with wikidot.Client(username=username, password=password, amc_config=config) as client:
                site = client.site.get(SITE)
                artifact["cleanup"]["attempted"] = True
                for fullname in (current_child_name, child_name):
                    page = site.page.get(fullname, raise_when_not_found=False)
                    if page is not None:
                        page.destroy()
                page = site.page.get(parent_name, raise_when_not_found=False)
                if page is not None:
                    page.destroy()
                artifact["cleanup"]["child_absent"] = absent(site, current_child_name) and absent(site, child_name)
                artifact["cleanup"]["parent_absent"] = absent(site, parent_name)
        except BaseException as cleanup_error:
            artifact["cleanup"]["error"] = {"type": type(cleanup_error).__name__, "message": str(cleanup_error)}

    artifact["completed"] = failure is None and artifact["cleanup"]["child_absent"] is True and artifact["cleanup"]["parent_absent"] is True
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(artifact, ensure_ascii=False, indent=2) + "\n")
    args.output.chmod(0o600)
    if failure is not None:
        raise failure
    if not artifact["completed"]:
        raise RuntimeError("live mutation probe did not verify cleanup")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
