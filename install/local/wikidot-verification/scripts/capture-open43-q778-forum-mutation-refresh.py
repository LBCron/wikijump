#!/usr/bin/env python3
"""Capture the bounded, run-owned Q778 forum mutation refresh seam.

This producer is deliberately non-closing unless every requested observation
is present.  In particular, a post recreate is not called a restore, and a
fresh holder GET is not treated as proof that the independently cached mini
module was invalidated.  All writes are marker-owned and the finally block
verifies cleanup before publishing the artifact.

The script is prepared for a live run; importing it or passing ``--dry-run``
performs no mutation.  Credentials, cookies, authenticated response bodies,
and request bodies are never persisted.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import threading
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import httpx
import wikidot
from wikidot.connector.ajax import AjaxModuleConnectorConfig


EXPECTED_PUBLIC_ORIGIN = "http://sandbox-for-codex.wikidot.com"
SITE = "sandbox-for-codex"
THREAD_ID = 18029831
MAX_REFRESH_SECONDS = 120
MAX_READS_PER_STAGE = 8
CONCURRENT_READERS = 2
MODULE_SOURCE = '[[module MiniRecentPosts limit="100"]]'


def utcnow() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def sha256_text(value: str) -> str:
    return hashlib.sha256(value.encode()).hexdigest()


def public_url(path: str) -> str:
    if not path.startswith("/"):
        path = "/" + path
    return EXPECTED_PUBLIC_ORIGIN + path


def session_cookies(actor: wikidot.Client) -> dict[str, str]:
    return {
        str(name): str(value)
        for name, value in dict(actor.amc_client.header.cookie).items()
    }


def client(label: str) -> wikidot.Client:
    return wikidot.Client(
        username=os.environ[f"WIKIDOT_{label}_USERNAME"],
        password=os.environ[f"WIKIDOT_{label}_PASSWORD"],
        amc_config=AjaxModuleConnectorConfig(
            allow_insecure_session_transport_for=SITE,
            attempt_limit=1,
            request_timeout=20,
        ),
    )


def redact_amc_call(body: dict[str, Any]) -> dict[str, Any]:
    """Keep the action shape without retaining source or CSRF material."""

    allowed = {
        key: body[key]
        for key in ("action", "event", "moduleName", "postId", "threadId", "currentRevisionId")
        if key in body
    }
    for key in ("source", "title"):
        if key in body:
            allowed[f"{key}_sha256"] = sha256_text(str(body[key]))
    return allowed


def post_summary(post: Any) -> dict[str, Any]:
    author = getattr(post, "created_by", None)
    return {
        "id": int(post.id),
        "title": str(post.title),
        "parent_id": getattr(post, "parent_id", None),
        "created_by_id": getattr(author, "id", None),
        "created_by_name": getattr(author, "name", None),
        "created_at": post.created_at.isoformat() if post.created_at else None,
        "edited_at": post.edited_at.isoformat() if post.edited_at else None,
    }


def thread_snapshot(site: Any) -> dict[str, Any]:
    thread = site.get_thread(THREAD_ID)
    posts = [post_summary(post) for post in thread.posts]
    return {
        "observed_at": utcnow(),
        "thread_id": int(thread.id),
        "thread_title": str(thread.title),
        "post_ids": [post["id"] for post in posts],
        "posts": posts,
    }


def document_observation(
    client_http: httpx.Client,
    name: str,
    path: str,
    cookies: dict[str, str] | None,
    marker: str,
    created_marker: str,
    edited_marker: str,
    recreated_marker: str,
) -> dict[str, Any]:
    started = utcnow()
    response = client_http.get(
        public_url(path),
        cookies=cookies,
        headers={"Cache-Control": "no-cache", "User-Agent": "wikijump-compatibility-evidence/1"},
    )
    body = response.content
    text = body.decode("utf-8", errors="replace")
    marker_index = text.find(marker)
    anchor = f"#post-"
    return {
        "name": name,
        "authenticated": cookies is not None,
        "started_at": started,
        "finished_at": utcnow(),
        "status_code": response.status_code,
        "headers": {
            key: response.headers.get(key)
            for key in ("cache-control", "etag", "retry-after", "x-wikidot-static-cache")
        },
        "body_sha256": hashlib.sha256(body).hexdigest(),
        "body_bytes": len(body),
        "marker_present": marker in text,
        "markers": {
            "created": created_marker in text,
            "edited": edited_marker in text,
            "recreated": recreated_marker in text,
        },
        "post_anchor_present": marker_index >= 0 and anchor in text[max(0, marker_index - 2500):marker_index + 2500],
        "module_wrapper_sha256": sha256_text(text[text.find("forum-mini-stat"):]) if "forum-mini-stat" in text else None,
        "module_item_count": text.count('class="item"'),
    }


def observe_holder(
    http_client: httpx.Client,
    holder: str,
    cookies: dict[str, str] | None,
    marker: str,
    created_marker: str,
    edited_marker: str,
    recreated_marker: str,
    max_refresh_seconds: int,
    expected_marker_state: str,
) -> dict[str, Any]:
    """Poll only within the declared budget; timeout is an explicit block."""

    started = time.monotonic()
    observations: list[dict[str, Any]] = []
    while len(observations) < MAX_READS_PER_STAGE:
        observation = document_observation(
            http_client,
            f"holder-{len(observations) + 1}",
            f"/{holder}",
            cookies,
            marker,
            created_marker,
            edited_marker,
            recreated_marker,
        )
        observations.append(observation)
        state = (
            "edited" if observation["markers"]["edited"]
            else "created" if observation["markers"]["created"]
            else "recreated" if observation["markers"]["recreated"]
            else "absent"
        )
        if state == expected_marker_state:
            return {
                "status": "observed",
                "expected_marker_state": expected_marker_state,
                "observed_marker_state": state,
                "elapsed_ms": round((time.monotonic() - started) * 1000),
                "observations": observations,
            }
        if time.monotonic() - started >= max_refresh_seconds:
            break
        time.sleep(min(2.0, max(0.0, max_refresh_seconds - (time.monotonic() - started))))
    return {
        "status": "blocked",
        "expected_marker_state": expected_marker_state,
        "observed_marker_state": (
            "edited" if observations[-1]["markers"]["edited"]
            else "created" if observations[-1]["markers"]["created"]
            else "recreated" if observations[-1]["markers"]["recreated"]
            else "absent"
        ) if observations else "no_observation",
        "elapsed_ms": round((time.monotonic() - started) * 1000),
        "observations": observations,
        "missing_authority": "cache invalidation or expiry within the bounded refresh window",
    }


def summarize_document_pair(pair: dict[str, dict[str, Any]]) -> dict[str, Any]:
    return {
        name: {
            "status_code": value["status_code"],
            "body_sha256": value["body_sha256"],
            "cache": value["headers"].get("x-wikidot-static-cache"),
            "marker_present": value["marker_present"],
            "post_anchor_present": value["post_anchor_present"],
        }
        for name, value in pair.items()
    }


def public_thread_observation(
    http_client: httpx.Client,
    name: str,
    cookie: dict[str, str] | None,
    marker: str,
    created_marker: str,
    edited_marker: str,
    recreated_marker: str,
) -> dict[str, Any]:
    return document_observation(
        http_client,
        name,
        f"/forum/t-{THREAD_ID}/",
        cookie,
        marker,
        created_marker,
        edited_marker,
        recreated_marker,
    )


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--run-id", required=True)
    parser.add_argument("--max-refresh-seconds", type=int, default=20)
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()
    if args.output.exists():
        raise SystemExit("refusing to overwrite output")
    if not 0 <= args.max_refresh_seconds <= MAX_REFRESH_SECONDS:
        raise SystemExit(f"--max-refresh-seconds must be between 0 and {MAX_REFRESH_SECONDS}")

    marker = f"Q778-MUTATION-{args.run_id}"
    created_marker = f"{marker}-CREATED"
    edited_marker = f"{marker}-EDITED"
    recreated_marker = f"{marker}-RECREATED"
    title = f"{marker}-TITLE"
    holder = f"q778-mutation-{sha256_text(args.run_id)[:12]}"
    record: dict[str, Any] = {
        "schema": "wikijump.open43.q778_forum_mutation_refresh_live.v2",
        "site": SITE,
        "site_url": EXPECTED_PUBLIC_ORIGIN,
        "thread_id": THREAD_ID,
        "holder_page": holder,
        "run_id": args.run_id,
        "marker": marker,
        "marker_sha256": sha256_text(marker),
        "module_source_sha256": sha256_text(MODULE_SOURCE),
        "credentials_persisted": False,
        "started_at": utcnow(),
        "budgets": {
            "max_refresh_seconds": args.max_refresh_seconds,
            "max_reads_per_stage": MAX_READS_PER_STAGE,
            "max_mutated_posts": 2,
        },
        "mutations": [],
        "observations": {},
        "cleanup": {"defined_before_write": True, "holder_page": holder, "marker": marker},
        "restore": {
            "status": "blocked",
            "mechanism": None,
            "public_restore_event_available": False,
            "missing_authority": "No public ForumAction restore/undelete event is exposed by the retained client surface",
        },
    }
    actor_a: wikidot.Client | None = None
    actor_b: wikidot.Client | None = None
    site: Any = None
    holder_page: Any = None
    created_post_ids: list[int] = []
    concurrent: dict[str, Any] = {}
    http_client = httpx.Client(follow_redirects=False, trust_env=False, timeout=30)

    def record_mutation(event: str, request: dict[str, Any], response: Any) -> None:
        data = response.json()
        record["mutations"].append({
            "event": event,
            "request": redact_amc_call(request),
            "status_code": response.status_code,
            "response_status": data.get("status") if isinstance(data, dict) else None,
            "response_keys": sorted(data) if isinstance(data, dict) else None,
        })

    try:
        actor_a = client("A")
        actor_b = client("B")
        site = actor_a.site.get(SITE)
        baseline = thread_snapshot(site)
        record["baseline_thread"] = baseline
        if any(marker in post["title"] for post in baseline["posts"]):
            raise RuntimeError("run marker already exists in the target thread")
        if site.page.get(holder, raise_when_not_found=False) is not None:
            raise RuntimeError("run-owned holder page already exists")
        if args.dry_run:
            record["status"] = "dry_run"
            record["dry_run"] = {"mutation_started": False}
        else:
            holder_page = site.page.create(
                holder,
                title=f"Q778 mutation holder {args.run_id}",
                source=MODULE_SOURCE,
                comment=f"run-owned Q778 mutation holder {args.run_id}",
            )
            record["holder_created"] = True
            cookies_a = session_cookies(actor_a)
            cookies_b = session_cookies(actor_b)
            record["observations"]["holder_before"] = summarize_document_pair({
                "anonymous": document_observation(http_client, "holder-before-anonymous", f"/{holder}", None, marker, created_marker, edited_marker, recreated_marker),
                "authenticated_a": document_observation(http_client, "holder-before-authenticated-a", f"/{holder}", cookies_a, marker, created_marker, edited_marker, recreated_marker),
            })

            thread = site.get_thread(THREAD_ID)
            thread.reply(created_marker, title=title)
            post = next(post for post in site.get_thread(THREAD_ID).posts if post.title == title)
            created_post_ids.append(int(post.id))
            record["observations"]["create"] = {
                "post_id": int(post.id),
                "thread": thread_snapshot(site),
                "public_thread": public_thread_observation(http_client, "thread-after-create", None, marker, created_marker, edited_marker, recreated_marker),
                "holder": observe_holder(http_client, holder, None, marker, created_marker, edited_marker, recreated_marker, args.max_refresh_seconds, "created"),
            }

            original_amc_request = site.amc_request

            concurrent_reads: list[dict[str, Any]] = []
            concurrent_reads_lock = threading.Lock()

            def concurrent_reader(reader_id: int) -> None:
                started = utcnow()
                try:
                    response = http_client.get(
                        public_url(f"/forum/t-{THREAD_ID}/"),
                        cookies=cookies_b,
                        headers={"Cache-Control": "no-cache", "User-Agent": "wikijump-compatibility-evidence/1"},
                    )
                    body = response.content.decode("utf-8", errors="replace")
                    observation = {
                        "reader_id": reader_id,
                        "status": "observed",
                        "started_at": started,
                        "finished_at": utcnow(),
                        "status_code": response.status_code,
                        "body_sha256": sha256_text(body),
                        "created_marker_present": created_marker in body,
                        "edited_marker_present": edited_marker in body,
                    }
                    with concurrent_reads_lock:
                        concurrent_reads.append(observation)
                except Exception as error:
                    with concurrent_reads_lock:
                        concurrent_reads.append({
                            "reader_id": reader_id,
                            "status": "error",
                            "started_at": started,
                            "finished_at": utcnow(),
                            "error_type": type(error).__name__,
                            "error_message": str(error)[:300],
                        })

            def recorded_amc_request(bodies: list[dict[str, Any]], return_exceptions: bool = False):
                if any(body.get("event") == "saveEditPost" for body in bodies):
                    started = utcnow()
                    readers = [
                        threading.Thread(target=concurrent_reader, args=(reader_id,), daemon=True)
                        for reader_id in range(1, CONCURRENT_READERS + 1)
                    ]
                    for reader in readers:
                        reader.start()
                    try:
                        responses = original_amc_request(bodies, return_exceptions=return_exceptions)
                    finally:
                        finished = utcnow()
                        for reader in readers:
                            reader.join(timeout=30)
                    concurrent["mutation_window"] = {"started_at": started, "finished_at": finished}
                    concurrent["readers"] = sorted(concurrent_reads, key=lambda value: value["reader_id"])
                    concurrent["overlap"] = all(
                        reader.get("status") == "observed"
                        and reader.get("started_at", "") <= finished
                        and reader.get("finished_at", "") >= started
                        for reader in concurrent["readers"]
                    ) and len(concurrent["readers"]) == CONCURRENT_READERS
                    for body, response in zip(bodies, responses):
                        if not isinstance(response, Exception):
                            record_mutation(str(body.get("event")), body, response)
                    return responses
                responses = original_amc_request(bodies, return_exceptions=return_exceptions)
                for body, response in zip(bodies, responses):
                    if not isinstance(response, Exception) and body.get("event") in {"savePost", "deletePost"}:
                        record_mutation(str(body.get("event")), body, response)
                return responses

            site.amc_request = recorded_amc_request
            post = site.get_thread(THREAD_ID).posts.find(created_post_ids[0])
            if post is None:
                raise RuntimeError("created post disappeared before edit")
            post.edit(edited_marker, title=title)
            record["observations"]["edit"] = {
                "post_id": created_post_ids[0],
                "thread": thread_snapshot(site),
                "public_thread": public_thread_observation(http_client, "thread-after-edit", None, marker, created_marker, edited_marker, recreated_marker),
                "holder": observe_holder(http_client, holder, None, marker, created_marker, edited_marker, recreated_marker, args.max_refresh_seconds, "edited"),
                "concurrent": concurrent,
            }

            delete_request = {"action": "ForumAction", "event": "deletePost", "postId": created_post_ids[0], "moduleName": ""}
            response = site.amc_request([delete_request])[0]
            if response.json().get("status") != "ok":
                raise RuntimeError("deletePost did not return status=ok")
            record["observations"]["delete"] = {
                "post_id": created_post_ids[0],
                "thread": thread_snapshot(site),
                "public_thread": public_thread_observation(http_client, "thread-after-delete", None, marker, created_marker, edited_marker, recreated_marker),
                "holder": observe_holder(http_client, holder, None, marker, created_marker, edited_marker, recreated_marker, args.max_refresh_seconds, "absent"),
            }
            record["status"] = "captured_non_closing"
    except Exception as error:
        record["status"] = "aborted"
        record["error"] = {"type": type(error).__name__, "message": str(error)[:1000]}
    finally:
        cleanup = record["cleanup"]
        try:
            if site is not None and actor_a is not None:
                for post in list(site.get_thread(THREAD_ID).posts):
                    if marker in str(post.title):
                        request = {"action": "ForumAction", "event": "deletePost", "postId": int(post.id), "moduleName": ""}
                        response = site.amc_request([request], return_exceptions=True)[0]
                        cleanup.setdefault("delete_attempts", []).append({
                            "post_id": int(post.id),
                            "response_status": None if isinstance(response, Exception) else response.json().get("status"),
                        })
                final_snapshot = thread_snapshot(site)
                cleanup["final_thread"] = final_snapshot
                cleanup["marker_posts_remaining"] = [post for post in final_snapshot["posts"] if marker in post["title"]]
                cleanup["post_ids_restored_to_baseline"] = final_snapshot["post_ids"] == record.get("baseline_thread", {}).get("post_ids")
                final_public_thread = public_thread_observation(http_client, "thread-after-cleanup", None, marker, created_marker, edited_marker, recreated_marker)
                cleanup["public_thread_after_cleanup"] = {
                    "status_code": final_public_thread["status_code"],
                    "marker_present": final_public_thread["marker_present"],
                    "body_sha256": final_public_thread["body_sha256"],
                }
                cleanup["public_thread_marker_absent"] = not final_public_thread["marker_present"]
        except Exception as error:
            cleanup["thread_cleanup_error"] = {"type": type(error).__name__, "message": str(error)[:500]}
        try:
            if holder_page is not None:
                holder_page.destroy()
                cleanup["holder_delete_attempted"] = True
            cleanup["holder_absent"] = site is not None and site.page.get(holder, raise_when_not_found=False) is None
        except Exception as error:
            cleanup["holder_cleanup_error"] = {"type": type(error).__name__, "message": str(error)[:500]}
        cleanup["live_state_debt"] = not (
            cleanup.get("marker_posts_remaining") == []
            and cleanup.get("post_ids_restored_to_baseline") is True
            and cleanup.get("public_thread_marker_absent") is True
            and cleanup.get("holder_absent") is True
        )
        record["finished_at"] = utcnow()
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(json.dumps(record, indent=2, sort_keys=True) + "\n")
        http_client.close()
        for actor in (actor_a, actor_b):
            if actor is not None:
                actor.close()

    print(json.dumps({"status": record.get("status"), "restore": record["restore"], "cleanup": record["cleanup"]}, indent=2, sort_keys=True))


if __name__ == "__main__":
    main()
