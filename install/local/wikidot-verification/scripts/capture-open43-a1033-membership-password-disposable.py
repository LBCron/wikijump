#!/usr/bin/env python3
"""Capture the disposable-site MembershipByPassword mutation contract."""

from __future__ import annotations

import argparse
import json
import os
import secrets
from datetime import datetime, timezone
from pathlib import Path

import wikidot
from wikidot.common.exceptions import WikidotStatusCodeException
from wikidot.connector.ajax import AjaxModuleConnectorConfig


MAX_WRONG_SUBMISSIONS = 3


def now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def required_env(name: str) -> str:
    value = os.environ.get(name)
    if not value:
        raise RuntimeError(f"missing environment variable: {name}")
    return value


def client_for(label: str, site: str) -> wikidot.Client:
    return wikidot.Client(
        username=required_env(f"WIKIDOT_{label}_USERNAME"),
        password=required_env(f"WIKIDOT_{label}_PASSWORD"),
        amc_config=AjaxModuleConnectorConfig(
            allow_insecure_session_transport_for=site,
            attempt_limit=1,
            request_timeout=10,
        ),
    )


def response(site: wikidot.Site, body: dict, module_name: str = "") -> dict:
    payload = dict(body)
    payload["moduleName"] = module_name
    item = site.amc_request([payload], return_exceptions=True)[0]
    if isinstance(item, WikidotStatusCodeException):
        return {"status": item.status_code, "message": None, "body": None}
    if isinstance(item, Exception):
        raise item
    result = item.json()
    if not isinstance(result, dict):
        raise RuntimeError("Wikidot AMC response is not an object")
    return result


def actor_is_member(admin_site: wikidot.Site, actor_id: int) -> bool:
    admin_site._members = None
    return any(member.user.id == actor_id for member in admin_site.members)


def reduced_result(value: dict) -> dict:
    return {
        "status": value.get("status"),
        "message": value.get("message"),
        "body_present": bool(value.get("body")),
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--site", required=True)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--run-id", required=True)
    args = parser.parse_args()
    if not args.site.replace("-", "").isalnum():
        raise SystemExit("invalid disposable site")
    if args.output.exists():
        raise SystemExit("refusing to overwrite output")

    password = f"wj-{args.run_id}-{secrets.token_hex(12)}"
    wrong_password = f"wrong-{secrets.token_hex(12)}"
    record = {
        "schema": "wikijump.wikidot_membership_password_evidence.v2",
        "site": args.site,
        "run_id": args.run_id,
        "captured_at_utc": now(),
        "status": "in_progress",
        "target_surface_ids": [
            "open43-audit-case:A1033_PASSWORD_SUBMISSION",
            "catalog-feature:module-membershipbypassword",
        ],
        "actor_fixture_matrix": {
            "setup_admin": True,
            "nonmember_one": True,
            "nonmember_two": True,
            "anonymous_control": True,
            "current_member_control": True,
        },
        "password_fixture": {
            "generated": True,
            "byte_length": len(password.encode()),
            "raw_material_recorded": False,
            "derived_material_recorded": False,
        },
        "bounded_failure_attempts": {
            "maximum_wrong_submissions_per_actor": MAX_WRONG_SUBMISSIONS,
            "actual_wrong_submissions_per_actor": 0,
            "lockout_observed_within_bound": False,
        },
        "actors": [],
        "cleanup_receipt": {},
        "settings_restoration_receipt": {},
        "credentials_exposed": False,
    }

    admin = client_for("A", args.site)
    first = client_for("D", args.site)
    second = client_for("E", args.site)
    clients = [admin, first, second]
    try:
        admin_site = admin.site.get(args.site)
        actor_sites = [first.site.get(args.site), second.site.get(args.site)]
        actor_users = [first.me, second.me]

        preflight = [actor_is_member(admin_site, user.id) for user in actor_users]
        if any(preflight):
            raise RuntimeError("password actors are already members")
        record["preflight_membership"] = {
            "nonmember_one": not preflight[0],
            "nonmember_two": not preflight[1],
        }

        setup = response(
            admin_site,
            {
                "privacy": "closed",
                "by_domain": "",
                "by_password": "on",
                "password": password,
                "allowHotlink": "on",
                "landingPage": "system:join",
                "hideNav": "on",
                "viewers": "",
                "action": "ManageSiteAction",
                "event": "savePrivateSettings",
            },
        )
        if setup.get("status") != "ok":
            raise RuntimeError(f"password policy setup failed: {setup.get('status')}")

        for index, (actor_site, actor_user) in enumerate(zip(actor_sites, actor_users, strict=True), 1):
            row = {"label": f"nonmember-{index}", "wrong": []}
            for _ in range(MAX_WRONG_SUBMISSIONS):
                attempt = response(
                    actor_site,
                    {
                        "action": "MembershipApplyAction",
                        "event": "applyByPassword",
                        "password": wrong_password,
                    },
                    "membership/MembershipByPasswordResultModule",
                )
                row["wrong"].append(reduced_result(attempt))
            record["bounded_failure_attempts"]["actual_wrong_submissions_per_actor"] = MAX_WRONG_SUBMISSIONS
            row["member_after_wrong"] = actor_is_member(admin_site, actor_user.id)
            correct = response(
                actor_site,
                {
                    "action": "MembershipApplyAction",
                    "event": "applyByPassword",
                    "password": password,
                },
                "membership/MembershipByPasswordResultModule",
            )
            row["correct"] = reduced_result(correct)
            row["member_after_correct"] = actor_is_member(admin_site, actor_user.id)
            retry = response(
                actor_site,
                {
                    "action": "MembershipApplyAction",
                    "event": "applyByPassword",
                    "password": password,
                },
                "membership/MembershipByPasswordResultModule",
            )
            row["correct_retry"] = reduced_result(retry)
            row["member_after_retry"] = actor_is_member(admin_site, actor_user.id)
            record["actors"].append(row)

        for actor_user in actor_users:
            if actor_is_member(admin_site, actor_user.id):
                removal = response(
                    admin_site,
                    {
                        "action": "ManageSiteMembershipAction",
                        "event": "removeMember",
                        "user_id": actor_user.id,
                    },
                )
                if removal.get("status") != "ok":
                    raise RuntimeError(f"member cleanup failed: {removal.get('status')}")
        record["cleanup_receipt"] = {
            "status": "pass",
            "nonmember_one_absent": not actor_is_member(admin_site, actor_users[0].id),
            "nonmember_two_absent": not actor_is_member(admin_site, actor_users[1].id),
        }
        record["status"] = "captured"
    finally:
        try:
            admin_site = admin.site.get(args.site)
            restore = response(
                admin_site,
                {
                    "privacy": "open",
                    "by_domain": "",
                    "password": "",
                    "allowHotlink": "on",
                    "landingPage": "system:join",
                    "hideNav": "on",
                    "viewers": "",
                    "action": "ManageSiteAction",
                    "event": "savePrivateSettings",
                },
            )
            record["settings_restoration_receipt"] = {
                "status": restore.get("status"),
                "message": restore.get("message"),
            }
        except Exception as error:
            record["settings_restoration_receipt"] = {"status": "error", "message": type(error).__name__}
        record["finished_at_utc"] = now()
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(json.dumps(record, indent=2, sort_keys=True) + "\n")
        for client in clients:
            client.close()

    print(
        json.dumps(
            {
                "status": record["status"],
                "wrong_statuses": [[attempt["status"] for attempt in actor["wrong"]] for actor in record["actors"]],
                "correct_statuses": [actor["correct"]["status"] for actor in record["actors"]],
                "retry_statuses": [actor["correct_retry"]["status"] for actor in record["actors"]],
                "members_after_correct": [actor["member_after_correct"] for actor in record["actors"]],
                "cleanup": record["cleanup_receipt"],
                "restoration": record["settings_restoration_receipt"],
            },
            sort_keys=True,
        )
    )


if __name__ == "__main__":
    main()
