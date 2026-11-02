#!/usr/bin/env python3
"""Capture the bounded, non-browser Wikidot upload naming matrix for

This command is deliberately mutation-gated. It is prepared for the parent
run, but must not be invoked without --allow-run-owned-upload-mutation.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import sys
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urljoin, urlparse


SITE = "sandbox-for-codex"
SCHEMA = "wikidot.live.open43.m1062.upload-policy.v1"
FIXTURE_SCHEMA = "wikidot.live.open43.m1062.upload-policy.cases.v1"
MUTATION_FLAG = "--allow-run-owned-upload-mutation"


def sha256_bytes(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def timestamp() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def redacted_error(error: BaseException) -> str:
    return type(error).__name__


def validate_args(args: argparse.Namespace, fixture: dict) -> None:
    if fixture.get("schema") != FIXTURE_SCHEMA or fixture.get("site") != SITE:
        raise RuntimeError("fixture is not the allowlisted #1062 sandbox contract")
    if fixture.get("preflight", {}).get("mutation_requires_explicit_flag") is not True:
        raise RuntimeError("fixture does not require an explicit mutation gate")
    if not args.allow_run_owned_upload_mutation:
        raise RuntimeError(f"refusing live upload mutation; rerun only in the parent run with {MUTATION_FLAG}")
    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9-]{0,63}", args.run_id):
        raise RuntimeError("run ID is invalid")
    if not re.fullmatch(r"[0-9a-f]{40}", args.source_revision):
        raise RuntimeError("source revision must be a lowercase 40-hex commit")


def response_record(response) -> dict:
    body = response.content
    return {
        "http_status": response.status_code,
        "content_type": response.headers.get("content-type"),
        "location": response.headers.get("location"),
        "body_size": len(body),
        "body_sha256": sha256_bytes(body),
    }


def inventory(page) -> list[dict]:
    page._files = None
    return [
        {
            "file_id": file.id,
            "name": file.name,
            "url": file.url,
            "mime_type": file.mime_type,
            "size": file.size,
        }
        for file in page.files
    ]


def upload_form(site, page):
    from bs4 import BeautifulSoup

    response = site.amc_request([{"moduleName": "files/FileUploadModule", "page_id": page.id}])[0]
    payload = response.json()
    body = payload.get("body")
    if not isinstance(body, str):
        raise RuntimeError("FileUploadModule did not return an HTML body")
    soup = BeautifulSoup(body, "html.parser")
    form = soup.find("form")
    file_input = form.find("input", attrs={"type": "file"}) if form else None
    if form is None or file_input is None or not file_input.get("name"):
        raise RuntimeError("FileUploadModule did not expose a complete multipart form")
    text_inputs = [
        element.get("name")
        for element in form.find_all("input")
        if element.get("name") and element.get("type", "text").lower() == "text"
    ]
    candidates = [name for name in text_inputs if name in {"name", "filename", "file_name"}]
    if len(candidates) != 1:
        raise RuntimeError(f"multipart form has no unique supported filename override field: {text_inputs!r}")
    fields = {
        element["name"]: element.get("value", "")
        for element in form.find_all("input")
        if element.get("name") and element.get("type", "text").lower() != "file"
    }
    action = urljoin(site.url + "/", form.get("action") or "")
    parsed = urlparse(action)
    site_url = urlparse(site.url)
    if parsed.scheme not in {"http", "https"} or parsed.netloc != site_url.netloc:
        raise RuntimeError("multipart upload action escaped the allowlisted site origin")
    return action, fields, file_input["name"], candidates[0]


def upload_case(site, page, client, case_definition) -> dict:
    before = inventory(page)
    action, fields, file_field, override_field = upload_form(site, page)
    override_name = case_definition["override_name"]
    if override_name is not None:
        fields[override_field] = override_name
    payload = case_definition["payload_utf8"].encode("utf-8")
    response = client.post(
        action,
        data=fields,
        files={file_field: (case_definition["source_filename"], payload, "text/plain")},
        follow_redirects=False,
    )
    after = inventory(page)
    before_ids = {row["file_id"] for row in before}
    new_ids = sorted(row["file_id"] for row in after if row["file_id"] not in before_ids)
    if response.status_code < 200 or response.status_code >= 600:
        result = "unknown"
    elif new_ids:
        result = "accepted"
    elif after == before:
        result = "unchanged"
    else:
        result = "unknown"
    return {
        "case_id": case_definition["case_id"],
        "request": {
            "source_filename": case_definition["source_filename"],
            "override_name": override_name,
            "byte_length": len(payload),
            "payload_sha256": sha256_bytes(payload),
        },
        "response": response_record(response),
        "inventory_before": before,
        "inventory_after": after,
        "new_file_ids": new_ids,
        "displayed_names": [row["name"] for row in after],
        "result": result,
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--fixture", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--run-id", required=True)
    parser.add_argument("--source-revision", required=True)
    parser.add_argument(MUTATION_FLAG, action="store_true", dest="allow_run_owned_upload_mutation")
    args = parser.parse_args()
    fixture_bytes = args.fixture.read_bytes()
    fixture = json.loads(fixture_bytes)
    validate_args(args, fixture)
    producer_bytes = Path(__file__).resolve().read_bytes()
    artifact = {
        "schema": SCHEMA,
        "status": "failed",
        "run_id": args.run_id,
        "site": SITE,
        "target_surface_ids": fixture["target_surface_ids"],
        "source_identity": {"wikijump_commit": args.source_revision},
        "fixture_sha256": sha256_bytes(fixture_bytes),
        "producer_sha256": sha256_bytes(producer_bytes),
        "started_at": timestamp(),
        "mutation_performed": False,
        "baseline_inventory": [],
        "cases": [],
        "policy_observations": "recorded_without_promotion",
        "promoted_rules": [],
        "cleanup": {"verified": False, "page_absent": False, "remaining_run_owned_objects": []},
    }
    page = None
    cleanup_errors: list[str] = []
    try:
        import httpx
        import wikidot
        from wikidot.connector.ajax import AjaxModuleConnectorConfig

        run_page = f"open43-m1062-{args.run_id}"
        marker = f"Open43 #1062 upload policy {args.run_id}"
        config = AjaxModuleConnectorConfig(allow_insecure_session_transport_for=SITE)
        with wikidot.Client(username=os.environ["WIKIDOT_USERNAME"], password=os.environ["WIKIDOT_PASSWORD"], amc_config=config) as client:
            site = client.site.get(SITE)
            if site.page.get(run_page, raise_when_not_found=False) is not None:
                raise RuntimeError("run-owned #1062 page already exists")
            page = site.page.create(run_page, title=marker, source=marker, comment="Open43 #1062 upload policy")
            artifact["mutation_performed"] = True
            artifact["page_fullname"] = run_page
            artifact["page_id"] = page.id
            artifact["baseline_inventory"] = inventory(page)
            if artifact["baseline_inventory"]:
                raise RuntimeError("new run-owned page unexpectedly has existing attachments")
            cookies = dict(client.amc_client.header.cookie)
            with httpx.Client(trust_env=False, cookies=cookies, headers={"User-Agent": "wikijump-compatibility-evidence/1"}) as http_client:
                for case_definition in fixture["cases"]:
                    artifact["cases"].append(upload_case(site, page, http_client, case_definition))
            artifact["status"] = "observed"
    except Exception as error:
        artifact["error"] = redacted_error(error)
    finally:
        if page is not None:
            try:
                page.destroy()
            except Exception as error:
                cleanup_errors.append(redacted_error(error))
        if page is not None:
            try:
                remaining = page.site.page.get(page.fullname, raise_when_not_found=False)
                if remaining is not None:
                    cleanup_errors.append("run-owned page remained present after cleanup")
            except Exception as error:
                cleanup_errors.append(redacted_error(error))
        artifact["cleanup"] = {"verified": not cleanup_errors and page is not None, "page_absent": page is not None and not cleanup_errors, "remaining_run_owned_objects": [] if not cleanup_errors else [artifact.get("page_fullname", "run-owned-page")], "errors": cleanup_errors}
        if artifact["status"] == "observed" and not artifact["cleanup"]["verified"]:
            artifact["status"] = "failed"
        artifact["finished_at"] = timestamp()
    args.output.parent.mkdir(parents=True, exist_ok=True)
    with args.output.open("x", encoding="utf-8") as handle:
        json.dump(artifact, handle, ensure_ascii=False, indent=2, sort_keys=True)
        handle.write("\n")
    print(json.dumps({"output": str(args.output), "status": artifact["status"], "mutation_performed": artifact["mutation_performed"], "cleanup_verified": artifact["cleanup"]["verified"]}, sort_keys=True))
    return 0 if artifact["status"] == "observed" and artifact["cleanup"]["verified"] else 1


if __name__ == "__main__":
    sys.exit(main())
