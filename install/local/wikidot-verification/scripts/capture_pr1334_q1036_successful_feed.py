#!/usr/bin/env python3
"""Capture Q1036 Feed evidence, failing closed before an unsafe provider request."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
from datetime import UTC, datetime
from pathlib import Path
from typing import Any


SCHEMA = "wikijump.pr1334.q1036_successful_feed_adapter_live.v1"
EXPECTED_FIXTURE_SCHEMA = "wikijump.pr1334.q1036_successful_feed_adapter_cases.v1"
SCRIPT_PATH = Path(__file__).resolve()
REPOSITORY_ROOT = SCRIPT_PATH.parents[4]
SCRIPT_RELATIVE_PATH = SCRIPT_PATH.relative_to(REPOSITORY_ROOT).as_posix()
FIXTURE_RELATIVE_PATH = "install/local/wikidot-verification/fixtures/pr1334-q1036-successful-feed-adapter.json"
PREVIEW_CLIENT_RELATIVE_PATH = "install/local/wikidot-verification/scripts/capture_wikidot_preview_references.py"


def sha256_bytes(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--fixture", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    return parser.parse_args()


def load_fixture(path: Path) -> dict[str, Any]:
    fixture = json.loads(path.read_text(encoding="utf-8"))
    if fixture.get("schema") != EXPECTED_FIXTURE_SCHEMA:
        raise ValueError("unsupported fixture schema")
    if fixture.get("base_commit") != "898e57da57c964893380a44e8b9b7765f274351c":
        raise ValueError("unexpected integration base")
    return fixture


def build_blocked_artifact(fixture_path: Path, fixture: dict[str, Any]) -> dict[str, Any]:
    environment_keys = list(fixture["provider_environment"].values())
    present_keys = sorted(key for key in environment_keys if key in os.environ)
    missing_keys = sorted(key for key in environment_keys if key not in os.environ)

    # The producer gate must pass before loading any provider credential value or
    # issuing any request. This run has no complete run-owned producer contract.
    reason = "missing_safe_public_producer" if missing_keys else "producer_not_bounded"
    if reason not in fixture["blocked_reason_codes"]:
        raise ValueError("blocked reason is not declared by the fixture")

    preview_client_path = REPOSITORY_ROOT / PREVIEW_CLIENT_RELATIVE_PATH
    artifact = {
        "schema": SCHEMA,
        "disposition": "blocked",
        "base_commit": fixture["base_commit"],
        "feature_id": fixture["feature_id"],
        "audit_case_id": fixture["audit_case_id"],
        "captured_at": datetime.now(UTC).isoformat(),
        "fixture": {
            "path": FIXTURE_RELATIVE_PATH,
            "sha256": sha256_bytes(fixture_path.read_bytes()),
        },
        "capture_script": {
            "path": SCRIPT_RELATIVE_PATH,
            "sha256": sha256_bytes(SCRIPT_PATH.read_bytes()),
        },
        "authority": {
            "specification_path": fixture["authority"]["specification_path"],
            "specification_sha256": fixture["authority"]["specification_sha256"],
            "existing_observation_path": fixture["authority"]["existing_observation_path"],
            "existing_observation_sha256": fixture["authority"]["existing_observation_sha256"],
            "existing_observation_id": fixture["authority"]["existing_observation_id"],
            "existing_observation_scope": fixture["authority"]["existing_observation_scope"],
            "preview_client_path": PREVIEW_CLIENT_RELATIVE_PATH,
            "preview_client_sha256": sha256_bytes(preview_client_path.read_bytes()),
        },
        "public_seams": fixture["public_seams"],
        "blocker": {
            "reason": reason,
            "stage": "safe_producer_gate",
            "missing_environment_keys": missing_keys,
            "present_environment_keys": present_keys,
            "detail": "No complete run-owned public HTTPS producer contract with run-scoped receipts and cleanup authority was available, so no provider or Wikidot request was made.",
        },
        "provider_setup": {
            "attempted": False,
            "namespace_created": False,
            "reason": "safe_producer_gate_failed",
        },
        "wikidot_preview": {
            "attempted": False,
            "reason": "producer_gate_failed_before_preview",
            "module_name": "edit/PagePreviewModule",
        },
        "module_and_provider_matrix": {
            "required_case_ids": fixture["required_cases"],
            "attempted_case_ids": [],
        },
        "provider_requests": [],
        "preview_requests": [],
        "observed_cases": [],
        "server_fetch_vs_rendered_output": {
            "provider_input": None,
            "provider_receipt": None,
            "amc_envelope": None,
            "rendered_output": None,
            "status": "unobserved_provider_gate_failed",
        },
        "cache_and_failure_observations": {
            "status": "unobserved_provider_gate_failed",
            "cache_intervals_seconds": [],
            "failure_case_ids": [],
        },
        "request_counts": {
            "total": 0,
            "provider": 0,
            "preview": 0,
            "provider_mutations": 0,
        },
        "payload_counts": {
            "aggregate_retained_bytes": 0,
            "largest_provider_body_bytes": 0,
            "largest_preview_body_bytes": 0,
        },
        "elapsed_seconds": 0,
        "unsafe_requests": 0,
        "cleanup": {
            "status": "not_needed",
            "mutation_count": 0,
            "proof": "The producer gate failed before setup and before any network request.",
        },
        "secret_scan": {
            "performed": True,
            "in_memory_credential_values_loaded": 0,
            "matches": 0,
            "scope": "No provider or Wikidot secret value was loaded on the pre-mutation blocked path.",
        },
        "budgets": fixture["budgets"],
        "safety": fixture["safety"],
        "promotable_rules": [],
        "rule_boundaries": [
            "Existing inaccessible-source evidence does not establish successful Feed rendering.",
            "No Wikidot SSRF, cache, timeout, sanitization, or provider policy is inferred from this blocked run.",
            "Arbitrary authored URLs remain unauthorized.",
        ],
        "remaining_gap": "A safe run-owned public HTTPS feed producer with request receipts and verified cleanup authority is still required before successful Feed rendering can be observed.",
    }
    return artifact


def write_no_replace(path: Path, artifact: dict[str, Any]) -> None:
    serialized = json.dumps(artifact, ensure_ascii=False, indent=2, sort_keys=True) + "\n"
    prohibited_literals = (
        "http://localhost",
        "https://localhost",
        "127.0.0.1",
        "169.254.169.254",
        "Authorization:",
        "Cookie:",
        "Set-Cookie:",
        "Bearer ",
    )
    matches = [literal for literal in prohibited_literals if literal in serialized]
    if matches:
        raise ValueError(f"final artifact contains prohibited literals: {matches}")
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("x", encoding="utf-8") as output:
        output.write(serialized)


def main() -> int:
    args = parse_args()
    fixture_path = args.fixture.resolve()
    output_path = args.output.resolve()
    expected_fixture_path = REPOSITORY_ROOT / FIXTURE_RELATIVE_PATH
    if fixture_path != expected_fixture_path:
        raise ValueError("unexpected fixture path")
    fixture = load_fixture(fixture_path)
    artifact = build_blocked_artifact(fixture_path, fixture)
    write_no_replace(output_path, artifact)
    print(json.dumps({"disposition": "blocked", "output": str(output_path), "requests": 0}, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
