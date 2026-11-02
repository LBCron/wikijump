#!/usr/bin/env python3
"""Freeze a blocked MailForm evidence receipt when no controlled mail sink exists."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import subprocess
from pathlib import Path
from typing import Any


LANE_ID = "evidence-a1037-mailform-dom-submit"
SURFACE_IDS = [
    "open43-audit-case:A1037_MAILFORM_INITIAL_DOM_AND_SUBMIT",
    "catalog-feature:module-mailform",
]
RUN_ID = "a1037-mailform-20260810-001"
ACCOUNT_HELPER = Path(
    "/home/roku/codex-consultant-20260517/scripts/wikidot_sandbox_accounts.py"
)
CLIENT_ROOT = Path("/home/roku/src/Rokurolize/wikidot.py")


def sha256_file(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def run_json(command: list[str]) -> dict[str, Any]:
    result = subprocess.run(
        command,
        check=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
    )
    value = json.loads(result.stdout)
    if not isinstance(value, dict):
        raise ValueError("preflight helper did not return an object")
    return value


def client_identity() -> str:
    result = subprocess.run(
        ["git", "-C", str(CLIENT_ROOT), "rev-parse", "HEAD"],
        check=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
    )
    return result.stdout.strip()


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--fixture", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--run-id", required=True)
    args = parser.parse_args()

    fixture = json.loads(args.fixture.read_text(encoding="utf-8"))
    if fixture.get("lane_id") != LANE_ID:
        raise ValueError("fixture lane mismatch")
    if fixture.get("surface_ids") != SURFACE_IDS:
        raise ValueError("fixture surface mismatch")
    if args.run_id != RUN_ID or fixture.get("run_id") != RUN_ID:
        raise ValueError("run ID mismatch")
    if args.output.exists():
        raise FileExistsError(f"refusing to replace {args.output}")

    account_check = run_json(["python3", str(ACCOUNT_HELPER), "check"])
    account_summary = run_json(["python3", str(ACCOUNT_HELPER), "summary"])
    all_accounts_ready = (
        account_check.get("account_labels") == list("ABCDEFG")
        and account_check.get("sandbox_site_present") is True
        and account_check.get("sandbox_url_present") is True
    )
    accounts_with_recipient_identity = sum(
        1
        for record in account_summary.get("accounts", {}).values()
        if isinstance(record, dict) and record.get("email_present") is True
    )

    # Recipient identity alone is not a controlled sink. A future authorized run
    # must explicitly supply all three capabilities without exposing their values.
    sink_capability_presence = {
        "dedicated_sink": bool(os.environ.get("WIKIDOT_MAILFORM_SINK_READY")),
        "run_id_only_query": bool(os.environ.get("WIKIDOT_MAILFORM_SINK_QUERY_READY")),
        "run_id_message_deletion": bool(
            os.environ.get("WIKIDOT_MAILFORM_SINK_DELETE_READY")
        ),
    }
    sink_ready = all(sink_capability_presence.values())
    if sink_ready:
        raise RuntimeError(
            "sink capability flags are present, but this bounded blocked-capture lane "
            "has no reviewed sink adapter; refusing to send"
        )

    proved = []
    if all_accounts_ready:
        proved.extend(
            [
                "sandbox_account_credentials_present",
                "behavior_sandbox_identity_present",
            ]
        )
    if accounts_with_recipient_identity:
        proved.append("controlled_accounts_with_recipient_identity_present")

    missing = [
        "dedicated_run_owned_recipient_sink",
        "run_id_only_recipient_sink_query",
        "run_id_message_deletion",
        "zero_message_sink_baseline_readback",
        "zero_message_sink_cleanup_readback",
    ]

    script_path = Path(__file__).resolve()
    artifact = {
        "schema": "wikijump.compat.mailform_dom_submit_evidence.v1",
        "lane_id": LANE_ID,
        "surface_ids": SURFACE_IDS,
        "run_id": RUN_ID,
        "status": "blocked",
        "closure": "not_closed",
        "public_site": {
            "label": fixture["public_site"]["label"],
            "site": fixture["public_site"]["site"],
            "page_label": fixture["public_site"]["page_label"],
        },
        "fixture_sha256": sha256_file(args.fixture.resolve()),
        "capture_script_sha256": sha256_file(script_path),
        "dependency_identity": {
            "sandbox_account_helper_sha256": sha256_file(ACCOUNT_HELPER),
            "wikidot_py_revision": client_identity(),
        },
        "public_authority": {
            "proved": proved,
            "missing": missing,
            "recipient_identity_count": accounts_with_recipient_identity,
            "sink_capability_presence": sink_capability_presence,
            "decision": "mail hard stop before page setup, DOM capture, or submission",
        },
        "stop_reason": (
            "The account catalog provides controlled Wikidot identities but no "
            "run-ID-only recipient sink query and deletion authority. Recipient "
            "identity is not delivery-readback or cleanup authority."
        ),
        "submit_attempt_count": 0,
        "delivery_count": 0,
        "unexpected_delivery_count": 0,
        "mutation_attempt_count": 0,
        "budgets": {
            "submit_attempt_maximum": fixture["budgets"]["submit_attempt_maximum"],
            "expected_delivery_maximum": fixture["budgets"][
                "expected_delivery_maximum"
            ],
            "requests_per_control_maximum": fixture["budgets"][
                "requests_per_control_maximum"
            ],
            "retry_count": 0,
        },
        "observations": {"dom": [], "mutation": [], "delivery": []},
        "page_state": {
            "before": "not_read_because_sink_preflight_failed",
            "after": "not_read_because_sink_preflight_failed",
        },
        "sink_state": {
            "before": "not_queryable",
            "after": "not_queryable",
        },
        "cleanup": {
            "status": "not_started",
            "receipt": "No page or mail mutation was attempted.",
        },
        "claimed_rules": [],
        "unclaimed_observations": [
            "Controlled Wikidot accounts exist, including identities with an account email.",
            "No controlled sink query or deletion seam is supplied by the sandbox account helper.",
        ],
        "remaining_gaps": [
            "initial DOM for two valid and two invalid forms",
            "server-issued contract binding",
            "required-field validation and no-delivery readback",
            "anonymous and authenticated submission",
            "controlled delivery readback and deletion",
            "omitted-to and recipient resolution",
            "CSV formatting, successPage, retry, and replay behavior",
            "Wikijump implementation, candidate, and standing validation",
        ],
        "privacy": {
            "addresses_persisted": 0,
            "credentials_persisted": 0,
            "raw_hidden_values_persisted": 0,
            "mail_messages_persisted": 0,
            "unrelated_content_persisted": 0,
            "account_labels_persisted": 0,
        },
    }

    args.output.parent.mkdir(parents=True, exist_ok=True)
    with args.output.open("x", encoding="utf-8") as stream:
        json.dump(artifact, stream, indent=2, sort_keys=True)
        stream.write("\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
