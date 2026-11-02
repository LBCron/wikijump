#!/usr/bin/env python3
import argparse
import hashlib
import json
import os
import subprocess
from datetime import datetime, timezone
from pathlib import Path
from typing import Any



LANE_ID = "FW-07-WIKIDOTPY-FORUM-REVISION-EVIDENCE"
BASE_HEAD = "d26a60418808668336ebf57c3429353e77ccd733"
CLIENT_REPOSITORY = Path("/home/roku/src/Rokurolize/wikidot.py")
ROOT = Path(__file__).resolve().parents[4]
DEFAULT_CASES = ROOT / "install/local/wikidot-verification/fixtures/wikidot-py-forum-revisions/cases.json"
DEFAULT_OUTPUT = ROOT / "install/local/wikidot-verification/artifacts/wikidot-py-forum-revisions-live-20260810.json"
ALLOWED_SITE = "sandbox-for-codex"


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def git(*args: str) -> str:
    return subprocess.run(
        ["git", "-C", str(CLIENT_REPOSITORY), *args],
        check=True,
        capture_output=True,
        text=True,
    ).stdout.strip()


def response_envelope(result: object) -> dict[str, Any]:
    if isinstance(result, BaseException):
        envelope: dict[str, Any] = {
            "kind": "exception",
            "exception_type": type(result).__name__,
            "message": str(result),
        }
        status_code = getattr(result, "status_code", None)
        if isinstance(status_code, (int, str)):
            envelope["status_code"] = status_code
        return envelope

    data = result.json()
    if not isinstance(data, dict):
        raise TypeError(f"AMC response must be an object, got {type(data).__name__}")
    return {"kind": "response", **data}


def validate_site(value: object) -> str:
    if value != ALLOWED_SITE:
        raise ValueError(f"forum revision capture site is outside the read/write allowlist: {value}")
    return value


def request_one(site: Any, request: dict[str, Any]) -> dict[str, Any]:
    result = site.amc_request([request], return_exceptions=True)[0]
    return response_envelope(result)


def classify(envelope: dict[str, Any]) -> dict[str, str]:
    if envelope["kind"] == "response":
        return {"classification": f"response_{envelope.get('status', 'missing_status')}"}
    status = envelope.get("status_code")
    suffix = f"_{status}" if status is not None else ""
    return {"classification": f"exception_{envelope['exception_type']}{suffix}"}


def parse_edit_form(envelope: dict[str, Any]) -> dict[str, Any]:
    from bs4 import BeautifulSoup, Tag

    body = envelope.get("body")
    if not isinstance(body, str):
        return classify(envelope)
    html = BeautifulSoup(body, "lxml")
    form = html.select_one("form#edit-post-form")
    if not isinstance(form, Tag):
        return {"classification": "response_ok_without_edit_form"}
    revision = form.select_one(":scope > input[name='currentRevisionId']")
    source = form.select_one(":scope textarea[name='source']")
    return {
        "classification": "parsed_edit_form",
        "form_id": str(form.get("id")),
        "current_revision_id": int(str(revision.get("value"))) if isinstance(revision, Tag) else None,
        "source": source.get_text() if isinstance(source, Tag) else None,
    }


def make_case(case_id: str, actor: str, request: dict[str, Any], envelope: dict[str, Any]) -> dict[str, Any]:
    return {
        "case_id": case_id,
        "actor": actor,
        "request": request,
        "response_envelope": envelope,
        "parser_result": parse_edit_form(envelope)
        if request["moduleName"] == "forum/sub/ForumEditPostFormModule"
        else classify(envelope),
    }


def capture(cases_path: Path, output_path: Path) -> None:
    import wikidot
    from wikidot.connector.ajax import AjaxModuleConnectorConfig

    cases_bytes = cases_path.read_bytes()
    manifest = json.loads(cases_bytes)
    fixture = manifest["fixture"]
    site_name = validate_site(manifest["site"])
    config = AjaxModuleConnectorConfig(
        allow_insecure_session_transport_for=site_name,
    )
    client_commit = git("rev-parse", "HEAD")
    dirty = bool(git("status", "--porcelain=v1"))
    if dirty:
        raise RuntimeError("pinned wikidot.py checkout must be clean")

    required_env = [
        "WIKIDOT_A_USERNAME",
        "WIKIDOT_A_PASSWORD",
        "WIKIDOT_B_USERNAME",
        "WIKIDOT_B_PASSWORD",
    ]
    missing_env = [name for name in required_env if not os.environ.get(name)]
    if missing_env:
        raise RuntimeError(f"missing sandbox account environment: {', '.join(missing_env)}")

    captured_cases: list[dict[str, Any]] = []
    cleanup_receipts: list[dict[str, Any]] = []
    threads: list[Any] = []
    posts: list[Any] = []
    primary_post: Any = None
    revision_ids: list[int] = []
    capture_error: BaseException | None = None

    with wikidot.Client(
        username=os.environ["WIKIDOT_A_USERNAME"],
        password=os.environ["WIKIDOT_A_PASSWORD"],
        amc_config=config,
    ) as owner_client, wikidot.Client(
        username=os.environ["WIKIDOT_B_USERNAME"],
        password=os.environ["WIKIDOT_B_PASSWORD"],
        amc_config=config,
    ) as unauthorized_client:
        owner_site = owner_client.site.get(site_name)
        unauthorized_site = unauthorized_client.site.get(site_name)
        source_category = owner_site.forum.categories.find(fixture["source_category_id"])
        deleted_category = owner_site.forum.categories.find(fixture["deleted_category_id"])
        if source_category is None or deleted_category is None:
            raise RuntimeError("configured forum categories were not found")

        try:
            primary = source_category.create_thread(
                fixture["primary_title"],
                "Run-owned FW07 live evidence fixture",
                fixture["initial_source"],
            )
            threads.append(primary)
            primary_post = primary.posts[0]
            posts.append(primary_post)
            secondary = source_category.create_thread(
                fixture["secondary_title"],
                "Run-owned FW07 wrong-thread control",
                "FW07 secondary source",
            )
            threads.append(secondary)
            secondary_post = secondary.posts[0]
            posts.append(secondary_post)
            for source in fixture["revision_sources"]:
                primary_post.edit(source)

            edit_request = {
                "moduleName": "forum/sub/ForumEditPostFormModule",
                "threadId": primary.id,
                "postId": primary_post.id,
            }
            edit_envelope = request_one(owner_site, edit_request)
            captured_cases.append(make_case("EDIT_FORM_PERMITTED", "account_A", edit_request, edit_envelope))

            revision_list_request = {
                "moduleName": "forum/sub/ForumPostRevisionsModule",
                "postId": primary_post.id,
            }
            revision_list_envelope = request_one(owner_site, revision_list_request)
            revisions = primary_post.revisions
            revision_ids = [revision.id for revision in revisions]
            captured_cases.append(
                {
                    "case_id": "REVISION_LIST_KNOWN_POST",
                    "actor": "account_A",
                    "request": revision_list_request,
                    "response_envelope": revision_list_envelope,
                    "parser_result": {
                        "classification": "parsed_revision_list",
                        "revision_ids": revision_ids,
                        "revision_numbers": [revision.rev_no for revision in revisions],
                    },
                }
            )

            revision_requests = [
                {"moduleName": "forum/sub/ForumPostRevisionModule", "revisionId": revision_id}
                for revision_id in revision_ids
            ]
            revision_results = owner_site.amc_request(revision_requests, return_exceptions=True)
            revision_envelopes = [
                {"revision_id": revision_id, **response_envelope(result)}
                for revision_id, result in zip(revision_ids, revision_results, strict=True)
            ]
            revisions.get_htmls()
            captured_cases.append(
                {
                    "case_id": "REVISION_BODY_EACH_KNOWN_REVISION",
                    "actor": "account_A",
                    "requests": revision_requests,
                    "response_envelopes": revision_envelopes,
                    "parser_results": [
                        {
                            "classification": "parsed_revision_body",
                            "revision_id": revision.id,
                            "content": revision.html,
                        }
                        for revision in revisions
                    ],
                }
            )

            negative_cases = [
                (
                    "EDIT_FORM_WRONG_THREAD",
                    "account_A",
                    owner_site,
                    {
                        "moduleName": "forum/sub/ForumEditPostFormModule",
                        "threadId": secondary.id,
                        "postId": primary_post.id,
                    },
                ),
                (
                    "EDIT_FORM_NONEXISTENT_POST",
                    "account_A",
                    owner_site,
                    {
                        "moduleName": "forum/sub/ForumEditPostFormModule",
                        "threadId": primary.id,
                        "postId": fixture["nonexistent_numeric_id"],
                    },
                ),
                (
                    "REVISION_LIST_NONEXISTENT_POST",
                    "account_A",
                    owner_site,
                    {
                        "moduleName": "forum/sub/ForumPostRevisionsModule",
                        "postId": fixture["nonexistent_numeric_id"],
                    },
                ),
                (
                    "REVISION_BODY_NONEXISTENT_REVISION",
                    "account_A",
                    owner_site,
                    {
                        "moduleName": "forum/sub/ForumPostRevisionModule",
                        "revisionId": fixture["nonexistent_numeric_id"],
                    },
                ),
                (
                    "EDIT_FORM_UNAUTHORIZED",
                    "account_B",
                    unauthorized_site,
                    {
                        "moduleName": "forum/sub/ForumEditPostFormModule",
                        "threadId": primary.id,
                        "postId": primary_post.id,
                    },
                ),
                (
                    "REVISION_LIST_UNAUTHORIZED",
                    "account_B",
                    unauthorized_site,
                    {"moduleName": "forum/sub/ForumPostRevisionsModule", "postId": primary_post.id},
                ),
                (
                    "REVISION_BODY_UNAUTHORIZED",
                    "account_B",
                    unauthorized_site,
                    {
                        "moduleName": "forum/sub/ForumPostRevisionModule",
                        "revisionId": revision_ids[-1],
                    },
                ),
                (
                    "EDIT_FORM_MALFORMED_NUMERIC",
                    "account_A",
                    owner_site,
                    {
                        "moduleName": "forum/sub/ForumEditPostFormModule",
                        "threadId": primary.id,
                        "postId": fixture["malformed_numeric"],
                    },
                ),
                (
                    "REVISION_LIST_MALFORMED_NUMERIC",
                    "account_A",
                    owner_site,
                    {
                        "moduleName": "forum/sub/ForumPostRevisionsModule",
                        "postId": fixture["malformed_numeric"],
                    },
                ),
                (
                    "REVISION_BODY_MALFORMED_NUMERIC",
                    "account_A",
                    owner_site,
                    {
                        "moduleName": "forum/sub/ForumPostRevisionModule",
                        "revisionId": fixture["malformed_numeric"],
                    },
                ),
            ]
            for case_id, actor, site, request in negative_cases:
                envelope = request_one(site, request)
                captured_cases.append(make_case(case_id, actor, request, envelope))
        except BaseException as exc:
            capture_error = exc
        finally:
            for thread, post in zip(threads, posts, strict=True):
                request = {
                    "moduleName": "Empty",
                    "action": "ForumAction",
                    "event": "moveThread",
                    "threadId": thread.id,
                    "categoryId": fixture["deleted_category_id"],
                }
                envelope = request_one(owner_site, request)
                cleanup_receipts.append(
                    {
                        "thread_id": thread.id,
                        "post_id": post.id,
                        "request": request,
                        "response_status": envelope.get("status"),
                        "response_kind": envelope["kind"],
                        "verified_deleted_category": False,
                    }
                )
            deleted_thread_ids = {thread.id for thread in deleted_category.reload_threads()}
            for receipt in cleanup_receipts:
                receipt["verified_deleted_category"] = receipt["thread_id"] in deleted_thread_ids

        if capture_error is not None:
            raise capture_error
        if any(
            receipt["response_status"] != "ok" or not receipt["verified_deleted_category"]
            for receipt in cleanup_receipts
        ):
            raise RuntimeError("run-owned forum fixture cleanup did not verify")

    artifact = {
        "schema": "wikijump.wikidot_py_forum_revisions.live.v1",
        "lane_id": LANE_ID,
        "base_head": BASE_HEAD,
        "captured_at": datetime.now(timezone.utc).isoformat(),
        "site": site_name,
        "case_manifest_sha256": hashlib.sha256(cases_bytes).hexdigest(),
        "surface_ids": [
            "wikidot-py-amc-module:forum/sub/ForumEditPostFormModule:parameters=postId,threadId",
            "wikidot-py-amc-module:forum/sub/ForumPostRevisionsModule:parameters=postId",
            "wikidot-py-amc-module:forum/sub/ForumPostRevisionModule:parameters=revisionId",
        ],
        "pinned_client_identity": {
            "repository": "Rokurolize/wikidot.py",
            "path": str(CLIENT_REPOSITORY),
            "commit": client_commit,
            "dirty": dirty,
            "version": wikidot.__version__,
            "pyproject_sha256": sha256(CLIENT_REPOSITORY / "pyproject.toml"),
            "uv_lock_sha256": sha256(CLIENT_REPOSITORY / "uv.lock"),
            "forum_post_source": "src/wikidot/module/forum_post.py",
            "forum_post_source_sha256": sha256(CLIENT_REPOSITORY / "src/wikidot/module/forum_post.py"),
            "forum_post_revision_source": "src/wikidot/module/forum_post_revision.py",
            "forum_post_revision_source_sha256": sha256(
                CLIENT_REPOSITORY / "src/wikidot/module/forum_post_revision.py"
            ),
            "parity_record_commit": "551fe7f05cac0c3322f9c69f43fbd4866d3fdfd2",
        },
        "fixture_identities": {
            "ownership": "run-owned",
            "source_category_id": fixture["source_category_id"],
            "deleted_category_id": fixture["deleted_category_id"],
            "thread_ids": [thread.id for thread in threads],
            "post_ids": [primary_post.id, secondary_post.id],
            "known_revision_ids": revision_ids,
            "actor_labels": ["account_A", "account_B"],
        },
        "cases": captured_cases,
        "cleanup": {
            "method": "ForumAction/moveThread",
            "authority": "install/local/wikidot-verification/artifacts/lane4-page-discussion-20260730/cleanup-receipts.json",
            "status": "complete",
            "receipts": cleanup_receipts,
        },
        "promotion_boundary": {
            "promotable": [
                "ForumEditPostFormModule uses postId and threadId with that exact casing and returns an edit-post-form containing postId, currentRevisionId, title, and source for the permitted owner.",
                "For the captured valid post, substituting another run-owned valid threadId returns the same edit form and currentRevisionId, so threadId does not constrain this read.",
                "ForumPostRevisionsModule uses postId with that exact casing; its DOM orders the current revision first while the pinned client parser returns revision numbers 0, 1, 2 in oldest-first order.",
                "ForumPostRevisionModule uses revisionId with that exact casing and returns title, content, postId, and body for every revision listed by ForumPostRevisionsModule.",
                "The captured nonexistent and malformed numeric identifiers return Wikidot status no_post for all three modules.",
                "Account B is denied ForumEditPostFormModule for Account A's post but receives status ok from ForumPostRevisionsModule and ForumPostRevisionModule.",
            ],
            "not_inferred": [
                "saveEditPost semantics",
                "post or thread deletion semantics",
                "thread locking or moving semantics beyond cleanup",
                "CSRF semantics",
            ],
            "remaining_gap": "No evidence was captured for edit saves, post or thread deletion semantics, locking, non-cleanup moves, CSRF, other actor roles, hidden or deleted posts, or revision pagination and limits.",
        },
    }
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(json.dumps(artifact, ensure_ascii=False, indent=2) + "\n")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--cases", type=Path, default=DEFAULT_CASES)
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT)
    args = parser.parse_args()
    capture(args.cases.resolve(), args.output.resolve())


if __name__ == "__main__":
    main()
