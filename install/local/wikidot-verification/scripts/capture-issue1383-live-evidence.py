#!/usr/bin/env python3
"""Capture one bounded, run-owned live evidence record for issue 1383."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import stat
import subprocess
import sys
import tempfile
import time
from contextlib import contextmanager
from datetime import UTC, datetime
from pathlib import Path
from typing import Any
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit

from capture_wikidot_listpages_campaign import remove_exact, sha256, snapshot_page
from capture_wikidot_preview_references import preview_body

PLAN_SCHEMA = "wikijump.listpages_section_zero_generated_html_live_run_plan.v1"
ARTIFACT_SCHEMA = "wikijump.listpages_section_zero_generated_html_live_run.v1"
SITE = "wjc260907a1f7"
DOMAIN = f"{SITE}.wikidot.com"
ORIGIN = f"http://{DOMAIN}"
SAVED_SITE = "scpaiueouiuiuiui"
SAVED_DOMAIN = f"{SAVED_SITE}.wikidot.com"
REPO_ROOT = Path(__file__).resolve().parents[4]
REQUIREMENTS_PATH = REPO_ROOT / "install/local/wikidot-verification/requirements.txt"
COMPAT_ARCHIVE_ROOT = Path(
    os.environ.get(
        "WIKIJUMP_COMPAT_ARCHIVE_ROOT",
        str(
            Path(os.environ.get("XDG_STATE_HOME", Path.home() / ".local/state"))
            / "wikijump"
            / "compatibility-archive"
        ),
    )
).expanduser()
RETAINED_EVIDENCE_ROOT = (
    COMPAT_ARCHIVE_ROOT / "evidence" / "issue1383-listpages-generated-html-20260815"
)
EXPECTED_CASE_LABELS = [
    "section-zero",
    "section-out-of-range",
    "section-one",
    "invalid-opener",
]
PLAN_RELATIVE_PATH = Path("install/local/wikidot-verification/fixtures/issue1383-live-evidence-plan.json")
EXPECTED_BROWSER_ROOT = Path("framerail")
GIT_EXECUTABLE = "/usr/bin/git"
GIT_ENVIRONMENT = {
    "HOME": "/nonexistent",
    "PATH": "/usr/bin:/bin",
    "GIT_CONFIG_NOSYSTEM": "1",
    "GIT_CONFIG_GLOBAL": "/dev/null",
    "GIT_CONFIG_SYSTEM": "/dev/null",
    "GIT_TERMINAL_PROMPT": "0",
    "GIT_OPTIONAL_LOCKS": "0",
    "LANG": "C",
    "LC_ALL": "C",
}
SAFE_CASE_ID = re.compile(r"^[a-z0-9]+(?:-[a-z0-9]+)*$")
SENSITIVE_HEADERS = {"authorization", "cookie", "proxy-authorization", "set-cookie", "x-csrf-token"}
SENSITIVE_FORM_FIELDS = {
    "authorization",
    "csrf",
    "csrf_token",
    "password",
    "session",
    "session_token",
    "token",
    "username",
    "wikidot_token7",
}
TRAFFIC_KEYS = ("requests", "request_bytes", "response_bytes", "redirects", "retries")


def sha256_bytes(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def canonical_sha256(value: Any) -> str:
    return sha256_bytes(json.dumps(value, sort_keys=True, separators=(",", ":")).encode("utf-8"))


def repo_path(value: Any, label: str) -> Path:
    if not isinstance(value, str) or not value or Path(value).is_absolute() or ".." in Path(value).parts:
        raise RuntimeError(f"issue 1383 {label} must be a safe repository-relative path")
    return REPO_ROOT / Path(value)


def safe_headers(headers: Any) -> dict[str, str]:
    return {
        str(name).lower(): str(value)
        for name, value in dict(headers).items()
        if str(name).lower() not in SENSITIVE_HEADERS
    }


def request_body(request: Any) -> bytes:
    body = getattr(request, "content", None)
    if body is None:
        body = getattr(request, "read", lambda: b"")()
    if isinstance(body, str):
        return body.encode("utf-8")
    return bytes(body or b"")


def safe_request_url(value: str) -> str:
    target = urlsplit(value)
    netloc = target.netloc.rsplit("@", 1)[-1]
    query = urlencode(
        [
            (name, "[REDACTED]" if name.lower() in SENSITIVE_FORM_FIELDS else item)
            for name, item in parse_qsl(target.query, keep_blank_values=True)
        ]
    )
    return urlunsplit((target.scheme, netloc, target.path, query, target.fragment))


def request_wire_bytes(request: Any, include_sensitive: bool = False, body: bytes | None = None) -> bytes:
    target = urlsplit(str(request.url))
    path = target.path or "/"
    if target.query:
        path += f"?{target.query}"
    headers = dict(getattr(request, "headers", {})) if include_sensitive else safe_headers(getattr(request, "headers", {}))
    lines = [f"{request.method} {path} HTTP/1.1"]
    lines.extend(f"{name}: {value}" for name, value in sorted(headers.items()))
    return ("\r\n".join(lines) + "\r\n\r\n").encode("utf-8") + (request_body(request) if body is None else body)


def redacted_form_body(request: Any) -> tuple[bytes, list[str]]:
    raw = request_body(request)
    content_type = next(
        (str(value) for name, value in dict(getattr(request, "headers", {})).items() if str(name).lower() == "content-type"),
        "",
    )
    if "application/x-www-form-urlencoded" not in content_type.lower():
        return b"[REDACTED_PAGEPREVIEW_FORM_BODY]", ["*body*"]
    try:
        pairs = parse_qsl(raw.decode("utf-8"), keep_blank_values=True)
    except UnicodeDecodeError:
        return b"[REDACTED_PAGEPREVIEW_FORM_BODY]", ["*body*"]
    redacted = []
    fields = []
    for name, value in pairs:
        if name.lower() in SENSITIVE_FORM_FIELDS:
            redacted.append((name, "[REDACTED]"))
            fields.append(name)
        else:
            redacted.append((name, value))
    return urlencode(redacted).encode("utf-8"), sorted(set(fields))


def redacted_request_wire_bytes(request: Any) -> tuple[bytes, list[str]]:
    body, fields = redacted_form_body(request)
    target = urlsplit(safe_request_url(str(request.url)))
    path = target.path or "/"
    if target.query:
        path += f"?{target.query}"
    headers = safe_headers(getattr(request, "headers", {}))
    if "content-length" in headers:
        headers["content-length"] = str(len(body))
    lines = [f"{request.method} {path} HTTP/1.1"]
    lines.extend(f"{name}: {value}" for name, value in sorted(headers.items()))
    return ("\r\n".join(lines) + "\r\n\r\n").encode("utf-8") + body, fields


def observe_http(usage: dict[str, int], budgets: dict[str, int], started: float, request: Any, response: Any | None) -> None:
    wire = request_wire_bytes(request, include_sensitive=True)
    usage["requests"] += 1
    usage["request_bytes"] += len(wire)
    if response is not None:
        usage["response_bytes"] += len(response.content)
        usage["redirects"] += len(getattr(response, "history", ()))
    budget_check(usage, budgets, started)


@contextmanager
def account_requests(usage: dict[str, int], budgets: dict[str, int], started: float):
    import httpx

    original_async = httpx.AsyncClient.request
    original_sync = httpx.Client.request

    def failed_request(args: tuple[Any, ...], kwargs: dict[str, Any]) -> Any:
        return type(
            "Request",
            (),
            {
                "content": kwargs.get("content", kwargs.get("data", b"")),
                "headers": kwargs.get("headers", {}),
                "url": args[0] if args else kwargs.get("url", "/"),
                "method": kwargs.get("method", "GET"),
            },
        )()

    async def counted(session: Any, *args: Any, **kwargs: Any) -> Any:
        try:
            response = await original_async(session, *args, **kwargs)
        except Exception:
            usage["requests"] += 1
            usage["request_bytes"] += len(request_wire_bytes(failed_request(args, kwargs), include_sensitive=True))
            budget_check(usage, budgets, started)
            raise
        observe_http(usage, budgets, started, response.request, response)
        return response

    def counted_sync(session: Any, *args: Any, **kwargs: Any) -> Any:
        try:
            response = original_sync(session, *args, **kwargs)
        except Exception:
            usage["requests"] += 1
            usage["request_bytes"] += len(request_wire_bytes(failed_request(args, kwargs), include_sensitive=True))
            budget_check(usage, budgets, started)
            raise
        observe_http(usage, budgets, started, response.request, response)
        return response

    httpx.AsyncClient.request = counted
    httpx.Client.request = counted_sync
    try:
        yield
    finally:
        httpx.AsyncClient.request = original_async
        httpx.Client.request = original_sync


def write_bytes_no_replace(path: Path, value: bytes) -> dict[str, Any]:
    path.parent.mkdir(parents=True, exist_ok=True)
    descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    try:
        with os.fdopen(descriptor, "wb") as stream:
            descriptor = -1
            stream.write(value)
            stream.flush()
            os.fsync(stream.fileno())
    finally:
        if descriptor != -1:
            os.close(descriptor)
    return {"path": str(path.resolve()), "bytes": len(value), "sha256": sha256_bytes(value)}


def budget_check(usage: dict[str, int], budgets: dict[str, int], started: float) -> None:
    usage["wall_clock_ms"] = round((time.monotonic() - started) * 1000)
    for key in TRAFFIC_KEYS:
        if usage[key] > budgets[f"max_{key}"]:
            raise RuntimeError(f"issue 1383 {key} budget exceeded")
    if usage["wall_clock_ms"] > budgets["max_wall_clock_ms"]:
        raise RuntimeError("issue 1383 wall-clock budget exceeded")


def git_value_at(repository: Path, *arguments: str) -> str:
    return subprocess.run(
        [GIT_EXECUTABLE, "-C", str(repository), *arguments],
        check=True,
        capture_output=True,
        text=True,
        env=GIT_ENVIRONMENT,
    ).stdout.strip()


def git_value(*arguments: str) -> str:
    return git_value_at(REPO_ROOT, *arguments)


def page_plan(key: str, fullname: str, title: str, source: str) -> dict[str, Any]:
    return {
        "key": key,
        "fullname": fullname,
        "title": title,
        "sources": [source],
        "account": None,
        "tags": [],
        "parent": None,
        "votes": [],
    }


def source_for(case: dict[str, Any], target_slug: str) -> str:
    return (
        f'[[div class="issue1383-case issue1383-{case["label"]}"]]\n'
        f'[[module ListPages category="*" fullname="{target_slug}" separate="no" wrapper="no"]]\n'
        "ROW_EVALUATED:%%title%%\n"
        f'[[%%content{{{case["section"]}}}%%{case["opener"]}]]\n'
        f'<b>{case["marker"]}</b>\n'
        "[[/html]]\n"
        "[[/module]]\n"
        "[[/div]]"
    )


def saved_self_selection_source(cases: list[dict[str, Any]]) -> str:
    """Build the saved-view control on the same ListPages page.

    The live scp-jp authority uses ``range=\".\"`` and selects the current
    page.  A separate target selected by fullname preserves the generated
    ``[[html]]`` text literally on save and therefore does not exercise the
    live saved-page reparse boundary owned by
    """
    parts = ["+ Section One", "SECTION_ONE_BODY", "+ Evidence"]
    for case in cases:
        parts.extend(
            [
                f'CASE_LABEL_{case["label"]}',
                '[[module ListPages limit="1" range="."]] ',
                f'[[%%content{{{case["section"]}}}%%{case["opener"]}]]',
                f'<b>{case["marker"]}</b>',
                "<span>TARGET_TITLE:%%title%%</span>",
                "[[/html]]",
                "[[/module]]",
            ]
        )
    return "\n".join(parts).replace('range="."]] \n', 'range="."]]\n')


def path_is_under(path: Path, roots: list[Path]) -> bool:
    try:
        resolved = path.resolve()
    except OSError:
        return False
    return any(resolved.is_relative_to(root.resolve()) for root in roots)


def validate_scanner_checks(value: Any, denominator_sha256: str, retained_roots: Any) -> bool:
    if (
        not isinstance(retained_roots, list)
        or not retained_roots
        or any(
            not isinstance(root, str)
            or not Path(root).is_absolute()
            or ".." in Path(root).parts
            for root in retained_roots
        )
    ):
        raise RuntimeError("issue 1383 scanner retained roots are invalid")
    roots = [Path(root).resolve() for root in retained_roots]
    if any(not path_is_under(root, [RETAINED_EVIDENCE_ROOT]) for root in roots):
        raise RuntimeError("issue 1383 scanner retained roots must stay under the retained evidence root")
    if not isinstance(value, list) or [item.get("name") for item in value if isinstance(item, dict)] != ["corpus-pinned-literals", "wikijump-identifier-leaks"]:
        raise RuntimeError("issue 1383 scanner records are incomplete")
    available = True
    for item in value:
        if not isinstance(item, dict) or set(item) != {"name", "status", "result_artifact", "denominator_sha256"} or item["denominator_sha256"] != denominator_sha256:
            raise RuntimeError("issue 1383 scanner record contract is invalid")
        if item["status"] == "not_available":
            if item["result_artifact"] is not None:
                raise RuntimeError("issue 1383 unavailable scanner result has an artifact")
            available = False
            continue
        if item["status"] != "captured":
            raise RuntimeError("issue 1383 scanner result status is invalid")
        artifact = item["result_artifact"]
        if item["status"] != "captured" or not isinstance(artifact, dict) or set(artifact) != {"path", "sha256", "input_sha256", "denominator_sha256"} or artifact["denominator_sha256"] != denominator_sha256:
            raise RuntimeError("issue 1383 scanner result artifact is missing its input or denominator identity")
        path = Path(artifact["path"])
        if not path.is_absolute() or not path_is_under(path, roots) or not path.is_file() or not re.fullmatch(r"[0-9a-f]{64}", artifact["sha256"]) or not re.fullmatch(r"[0-9a-f]{64}", artifact["input_sha256"]):
            raise RuntimeError("issue 1383 scanner result artifact identity is invalid")
        if sha256_bytes(path.read_bytes()) != artifact["sha256"]:
            raise RuntimeError("issue 1383 scanner result artifact changed")
    return available


def require_complete_scanners(scanner_ready: bool) -> None:
    if not scanner_ready:
        raise RuntimeError("issue 1383 complete receipt is unavailable while scanners are unavailable")


def preview_only_unresolved_rows(scanner_ready: bool, installed_tree_ready: bool) -> list[dict[str, str]]:
    rows = [
        {
            "surface": "listpages-target",
            "status": "unresolved",
            "reason": "preview-only capture does not create or read the target page for generated-row controls",
        },
        {
            "surface": "saved-page",
            "status": "unresolved",
            "reason": "preview-only capture performs no saved-page read or mutation",
        },
        {
            "surface": "actor",
            "status": "unresolved",
            "reason": "anonymous PagePreview capture does not observe actor behavior",
        },
        {
            "surface": "browser",
            "status": "unresolved",
            "reason": "preview-only capture does not launch a browser",
        },
    ]
    if not scanner_ready:
        rows.append(
            {
                "surface": "scanner",
                "status": "unresolved",
                "reason": "scanner result artifacts are unavailable",
            }
        )
    if not installed_tree_ready:
        rows.append(
            {
                "surface": "browser-dependency-tree",
                "status": "unresolved",
                "reason": "installed browser dependency tree is unavailable",
            }
        )
    return rows


def validate_authorities(plan: dict[str, Any], case_ids: list[str]) -> dict[str, Any]:
    authority = plan.get("authority")
    if not isinstance(authority, dict):
        raise RuntimeError("issue 1383 specification authority is missing")
    specifications = authority.get("specifications")
    if (
        not isinstance(specifications, list)
        or [item.get("path") for item in specifications if isinstance(item, dict)]
        != [
            "docs/wikidot-specifications/specifications/module/module-listpages.md",
            "docs/wikidot-specifications/specifications/wiki-syntax/syntax-html-blocks.md",
        ]
    ):
        raise RuntimeError("issue 1383 specification identity is incomplete")
    for item in specifications:
        if not isinstance(item, dict) or set(item) != {"path", "sha256"}:
            raise RuntimeError("issue 1383 specification identity is invalid")
        path = repo_path(item["path"], "specification path")
        if not path.is_file() or sha256_bytes(path.read_bytes()) != item["sha256"]:
            raise RuntimeError("issue 1383 specification changed after review")
    for key, feature_ids in {
        "catalog": {"module-listpages", "syntax-html-blocks"},
        "ledger": {"module-listpages", "syntax-html-blocks"},
    }.items():
        item = authority.get(key)
        if not isinstance(item, dict) or set(item) != {"path", "sha256"}:
            raise RuntimeError(f"issue 1383 {key} identity is invalid")
        path = repo_path(item["path"], f"{key} path")
        if not path.is_file() or sha256_bytes(path.read_bytes()) != item["sha256"]:
            raise RuntimeError(f"issue 1383 {key} changed after review")
        record = json.loads(path.read_text(encoding="utf-8"))
        if key == "catalog":
            actual_ids = {entry.get("id") for entry in record.get("features", []) if isinstance(entry, dict)}
        else:
            actual_ids = set(record.get("features", {}))
        if not feature_ids.issubset(actual_ids):
            raise RuntimeError(f"issue 1383 {key} does not contain the required feature identities")
    denominator = authority.get("denominator")
    if (
        not isinstance(denominator, dict)
        or set(denominator) != {"source", "case_ids", "sha256"}
        or denominator["source"] != "plan.cases[].case_id"
        or denominator["case_ids"] != case_ids
        or denominator["sha256"] != canonical_sha256(case_ids)
    ):
        raise RuntimeError("issue 1383 denominator identity is invalid")
    return authority


def validate_node_identity(dependencies: dict[str, Any]) -> None:
    if (
        not isinstance(dependencies.get("node_executable"), str)
        or not isinstance(dependencies.get("node_executable_sha256"), str)
        or not isinstance(dependencies.get("node_version"), str)
    ):
        raise RuntimeError("issue 1383 Node identity is incomplete")
    path = Path(dependencies["node_executable"])
    if (
        not path.is_absolute()
        or ".." in path.parts
        or path.is_symlink()
        or not path.is_file()
        or sha256_bytes(path.read_bytes()) != dependencies["node_executable_sha256"]
    ):
        raise RuntimeError("issue 1383 Node executable identity changed")
    result = subprocess.run(
        [str(path), "--version"],
        check=True,
        capture_output=True,
        text=True,
        env={"HOME": "/nonexistent", "PATH": "/usr/bin:/bin", "LANG": "C", "LC_ALL": "C"},
    )
    if result.stdout.strip() != dependencies["node_version"]:
        raise RuntimeError("issue 1383 Node version changed")


def validate_plan(plan: dict[str, Any], plan_path: Path, runner_path: Path) -> tuple[str, str, str, str, str, dict[str, int], bool, bool, dict[str, Any]]:
    if plan_path != (REPO_ROOT / PLAN_RELATIVE_PATH).resolve():
        raise RuntimeError("issue 1383 plan is not the committed plan path")
    repository = plan.get("repository")
    if (
        not isinstance(repository, dict)
        or set(repository) != {"reviewed_commit", "reviewed_tree", "reviewed_plan_blob_sha1", "git_executable", "git_executable_sha256", "clean_tree_required"}
        or repository["git_executable"] != GIT_EXECUTABLE
        or repository["clean_tree_required"] is not True
        or not re.fullmatch(r"[0-9a-f]{40}", str(repository["reviewed_commit"]))
        or not re.fullmatch(r"[0-9a-f]{40}", str(repository["reviewed_tree"]))
        or not re.fullmatch(r"[0-9a-f]{40}", str(repository["reviewed_plan_blob_sha1"]))
        or not re.fullmatch(r"[0-9a-f]{64}", str(repository["git_executable_sha256"]))
        or not Path(GIT_EXECUTABLE).is_file()
        or sha256_bytes(Path(GIT_EXECUTABLE).read_bytes()) != repository["git_executable_sha256"]
    ):
        raise RuntimeError("issue 1383 reviewed repository identity is invalid")
    if git_value("rev-parse", repository["reviewed_commit"]) != repository["reviewed_commit"]:
        raise RuntimeError("issue 1383 reviewed commit is unavailable")
    if git_value("rev-parse", f"{repository['reviewed_commit']}^{{tree}}") != repository["reviewed_tree"]:
        raise RuntimeError("issue 1383 reviewed repository tree changed")
    if git_value("rev-parse", f"{repository['reviewed_commit']}:{PLAN_RELATIVE_PATH.as_posix()}") != repository["reviewed_plan_blob_sha1"]:
        raise RuntimeError("issue 1383 reviewed plan blob changed")
    if git_value("status", "--porcelain=v1", "--untracked-files=all"):
        raise RuntimeError("issue 1383 repository must be clean before live access")
    for diff_arguments in (("diff", "--quiet", "HEAD", "--"), ("diff", "--cached", "--quiet", "--")):
        if subprocess.run([GIT_EXECUTABLE, "-C", str(REPO_ROOT), *diff_arguments, str(PLAN_RELATIVE_PATH)], env=GIT_ENVIRONMENT).returncode != 0:
            raise RuntimeError("issue 1383 plan has uncommitted changes")
    if plan.get("schema") != PLAN_SCHEMA or plan.get("site") != SITE or plan.get("saved_site") != SAVED_SITE:
        raise RuntimeError("issue 1383 plan schema or site is unsupported")
    if plan.get("current_result") != {
        "status": "complete",
        "reason": "source-bound preview, saved self-selection browser, iframe payload, scanner, and cleanup evidence is retained",
    }:
        raise RuntimeError("issue 1383 current result must describe the retained terminal capture")
    source = plan.get("source")
    cases = plan.get("cases")
    if not isinstance(source, dict) or not isinstance(cases, list) or len(cases) != 4:
        raise RuntimeError("issue 1383 plan denominator is not exactly four cases")
    if any(not isinstance(case, dict) for case in cases):
        raise RuntimeError("issue 1383 plan cases are not objects")
    if [case.get("label") for case in cases] != EXPECTED_CASE_LABELS:
        raise RuntimeError("issue 1383 plan case order is not the public test order")
    if any(not isinstance(case.get("case_id"), str) or SAFE_CASE_ID.fullmatch(case["case_id"]) is None for case in cases):
        raise RuntimeError("issue 1383 plan case IDs are unsafe")
    if len({case.get("case_id") for case in cases}) != len(cases):
        raise RuntimeError("issue 1383 plan case IDs are not unique")
    if sum(case.get("classification") == "positive" for case in cases) != 2 or sum(case.get("classification") == "negative" for case in cases) != 2:
        raise RuntimeError("issue 1383 plan must contain exactly two positive and two negative controls")
    case_ids = [case.get("case_id") for case in cases]
    denominator = plan.get("denominator")
    if (
        not isinstance(denominator, dict)
        or denominator.get("case_ids") != case_ids
        or denominator.get("sha256") != canonical_sha256(case_ids)
    ):
        raise RuntimeError("issue 1383 denominator is not fixed to the four planned case IDs")
    for case in cases:
        if case.get("classification") not in {"positive", "negative"}:
            raise RuntimeError("issue 1383 plan case classification is invalid")
        if not isinstance(case.get("section"), int) or case.get("opener") not in {"html", "htmlx"}:
            raise RuntimeError("issue 1383 plan control is invalid")
        if not isinstance(case.get("marker"), str) or not case["marker"]:
            raise RuntimeError("issue 1383 plan marker is invalid")
        if not isinstance(case.get("saved_executes"), bool):
            raise RuntimeError("issue 1383 plan saved expectation is invalid")
        if case["classification"] == "negative" and case["saved_executes"]:
            raise RuntimeError("issue 1383 negative control cannot execute saved HTML")
    authority = validate_authorities(plan, case_ids)

    owner_path = repo_path(source.get("owner_path"), "source owner path")
    owner_commit = source.get("owner_commit")
    owner_tree = source.get("owner_tree")
    owner_blob_sha1 = source.get("owner_blob_sha1")
    if (
        not owner_path.is_file()
        or not isinstance(owner_commit, str)
        or not isinstance(owner_tree, str)
        or not isinstance(owner_blob_sha1, str)
        or git_value("rev-parse", f"{owner_commit}^{{tree}}") != owner_tree
        or git_value("rev-parse", f"{owner_commit}:{source['owner_path']}") != owner_blob_sha1
        or git_value("hash-object", "--no-filters", str(owner_path)) != owner_blob_sha1
    ):
        raise RuntimeError("issue 1383 source owner identity changed")
    if source.get("public_regression_commit") != owner_commit or source.get("public_regression_tree") != owner_tree:
        raise RuntimeError("issue 1383 public regression commit is not bound to its source owner")

    runner_plan_path = plan.get("runner", {}).get("path")
    if runner_plan_path != runner_path.relative_to(REPO_ROOT).as_posix():
        raise RuntimeError("issue 1383 runner path is not the planned runner")
    if sha256_bytes(runner_path.read_bytes()) != plan.get("runner", {}).get("sha256"):
        raise RuntimeError("issue 1383 runner changed after plan review")

    dependencies = plan.get("dependencies")
    if not isinstance(dependencies, dict):
        raise RuntimeError("issue 1383 dependency identity is missing")
    requirements_path = repo_path(dependencies.get("requirements_path"), "requirements path")
    if not requirements_path.is_file() or sha256_bytes(requirements_path.read_bytes()) != dependencies.get("requirements_sha256"):
        raise RuntimeError("issue 1383 requirements.txt changed after plan review")
    requirements_lock_path = repo_path(dependencies.get("requirements_lock_path"), "requirements.lock path")
    cargo_manifest_path = repo_path(dependencies.get("cargo_manifest_path"), "Cargo.toml path")
    for path, key, label in (
        (requirements_lock_path, "requirements_lock_sha256", "requirements.lock"),
        (cargo_manifest_path, "cargo_manifest_sha256", "Cargo.toml"),
    ):
        if not path.is_file() or not re.fullmatch(r"[0-9a-f]{64}", str(dependencies.get(key))) or sha256_bytes(path.read_bytes()) != dependencies[key]:
            raise RuntimeError(f"issue 1383 {label} changed after plan review")
    lock_path = repo_path(dependencies.get("cargo_lock_path"), "Cargo.lock path")
    lock_bytes = lock_path.read_bytes()
    if sha256_bytes(lock_bytes) != dependencies.get("cargo_lock_sha256"):
        raise RuntimeError("issue 1383 Cargo.lock changed after plan review")
    lock_text = lock_bytes.decode("utf-8")
    ftml_match = re.search(
        r'source = "git\+https://github\.com/Rokurolize/ftml\?rev=([0-9a-f]{40})#([0-9a-f]{40})"',
        lock_text,
    )
    if (
        ftml_match is None
        or ftml_match.group(1) != dependencies.get("ftml_revision")
        or ftml_match.group(2) != dependencies.get("ftml_revision")
        or dependencies.get("ftml_tree") != "fc1856286c81ea2a5b5a2c0f73ce68d09fb7d4b4"
    ):
        raise RuntimeError("issue 1383 FTML revision or tree is not pinned to Cargo.lock")

    budgets = plan.get("budgets")
    if (
        not isinstance(budgets, dict)
        or set(budgets) != {"max_requests", "max_request_bytes", "max_response_bytes", "max_redirects", "max_retries", "max_wall_clock_ms"}
        or any(not isinstance(value, int) or isinstance(value, bool) or value <= 0 for value in budgets.values())
    ):
        raise RuntimeError("issue 1383 aggregate budgets are invalid")
    scanner_ready = validate_scanner_checks(plan.get("scanner_checks"), plan["denominator"]["sha256"], plan.get("scanner_artifact_roots"))

    revision = git_value("rev-parse", "HEAD")
    tree = git_value("rev-parse", "HEAD^{tree}")
    test_path = repo_path(source.get("test_path"), "public regression test path")
    test_bytes = test_path.read_bytes()
    if sha256_bytes(test_bytes) != source.get("test_sha256"):
        raise RuntimeError("public regression source file changed after plan review")
    test_text = test_bytes.decode("utf-8")
    anchor = f"async fn {source.get('test_anchor')}()"
    if anchor not in test_text:
        raise RuntimeError("public regression test anchor is missing")
    body_start = test_text.index(anchor)
    body_end = test_text.index("#[tokio::test]", body_start)
    if sha256(test_text[body_start:body_end]) != source.get("test_body_sha256"):
        raise RuntimeError("public regression test body changed after plan review")
    positions = [test_text.find(f'"{label}"') for label in EXPECTED_CASE_LABELS]
    if any(position < 0 for position in positions) or positions != sorted(positions):
        raise RuntimeError("public regression denominator is not present in order")
    artifact = repo_path(plan["historical_artifact"].get("path"), "historical artifact path")
    if sha256_bytes(artifact.read_bytes()) != plan["historical_artifact"]["sha256"]:
        raise RuntimeError("immutable historical artifact changed")
    terminal = plan.get("terminal_evidence")
    terminal_path = Path(terminal.get("path", "")) if isinstance(terminal, dict) else Path()
    if (
        not isinstance(terminal, dict)
        or set(terminal) != {"path", "sha256", "status", "wikijump_head"}
        or terminal.get("status") != "pass"
        or terminal.get("wikijump_head") != "5052bc1dbab5b5c0a7579ecc29caab1f3598285d"
        or not terminal_path.is_absolute()
        or ".." in terminal_path.parts
        or not terminal_path.is_file()
        or sha256_bytes(terminal_path.read_bytes()) != terminal.get("sha256")
    ):
        raise RuntimeError("issue 1383 terminal evidence identity is invalid")
    terminal_receipt = json.loads(terminal_path.read_text(encoding="utf-8"))
    if (
        terminal_receipt.get("schema") != "wikijump.issue1383_terminal_evidence.v1"
        or terminal_receipt.get("status") != "pass"
        or terminal_receipt.get("issue") != 1383
        or terminal_receipt.get("wikijump_head") != terminal["wikijump_head"]
        or terminal_receipt.get("denominator", {}).get("case_ids") != case_ids
        or terminal_receipt.get("denominator", {}).get("sha256") != plan["denominator"]["sha256"]
        or terminal_receipt.get("saved", {}).get("settled_iframes") != 2
        or terminal_receipt.get("preview", {}).get("cleanup", {}).get("all_absent") is not True
    ):
        raise RuntimeError("issue 1383 terminal evidence contract is invalid")
    terminal_head = terminal["wikijump_head"]
    if subprocess.run(
        [GIT_EXECUTABLE, "-C", str(REPO_ROOT), "merge-base", "--is-ancestor", terminal_head, "HEAD"],
        env=GIT_ENVIRONMENT,
    ).returncode != 0:
        raise RuntimeError("issue 1383 terminal evidence source is not an ancestor of HEAD")
    verification_only_paths = {
        PLAN_RELATIVE_PATH.as_posix(),
        "install/local/wikidot-verification/scripts/capture-issue1383-live-evidence.py",
        "install/local/wikidot-verification/tests/capture_issue1383_live_evidence_test.py",
    }
    changed_since_terminal = {
        line
        for line in git_value("diff", "--name-only", f"{terminal_head}..HEAD", "--").splitlines()
        if line
    }
    if not changed_since_terminal.issubset(verification_only_paths):
        raise RuntimeError("issue 1383 product source changed after terminal evidence capture")
    browser = plan.get("browser")
    package_path = repo_path(browser.get("package_path") if isinstance(browser, dict) else None, "browser package path")
    browser_lock_path = repo_path(browser.get("lock_path") if isinstance(browser, dict) else None, "browser lock path")
    installed_tree = browser.get("installed_dependency_tree") if isinstance(browser, dict) else None
    installed_tree_ready = False
    if (
        not isinstance(browser, dict)
        or browser.get("root") != EXPECTED_BROWSER_ROOT.as_posix()
        or not re.fullmatch(r"[0-9a-f]{64}", str(browser.get("package_sha256")))
        or not re.fullmatch(r"[0-9a-f]{64}", str(browser.get("lock_sha256")))
        or not re.fullmatch(r"[0-9a-f]{64}", str(browser.get("executable_sha256")))
        or not package_path.is_file()
        or not browser_lock_path.is_file()
        or sha256_bytes(package_path.read_bytes()) != browser["package_sha256"]
        or sha256_bytes(browser_lock_path.read_bytes()) != browser["lock_sha256"]
        or not isinstance(browser.get("executable_path"), str)
        or not Path(browser["executable_path"]).is_absolute()
        or Path(browser["executable_path"]).is_symlink()
        or not Path(browser["executable_path"]).is_file()
        or sha256_bytes(Path(browser["executable_path"]).read_bytes()) != browser["executable_sha256"]
        or not isinstance(browser.get("version"), str)
        or browser.get("node_executable") != dependencies.get("node_executable")
        or browser.get("node_version") != dependencies.get("node_version")
        or not isinstance(installed_tree, dict)
        or set(installed_tree) != {"path", "status", "sha256"}
        or installed_tree.get("status") not in {"captured", "not_available"}
    ):
        raise RuntimeError("planned browser dependency identity is missing")
    if installed_tree["status"] == "captured":
        installed_tree_path = repo_path(installed_tree.get("path"), "installed browser dependency tree path")
        if not re.fullmatch(r"[0-9a-f]{64}", str(installed_tree.get("sha256"))) or not installed_tree_path.is_file() or sha256_bytes(installed_tree_path.read_bytes()) != installed_tree["sha256"]:
            raise RuntimeError("installed browser dependency tree changed after review")
        installed_tree_ready = True
    elif installed_tree.get("sha256") is not None:
        raise RuntimeError("unavailable installed browser dependency tree has an identity")
    plan_blob_sha1 = git_value("hash-object", "--no-filters", str(plan_path))
    return revision, tree, sha256_bytes(test_bytes), sha256_bytes(plan_path.read_bytes()), plan_blob_sha1, budgets, scanner_ready, installed_tree_ready, authority


def dependency_identity() -> dict[str, Any]:
    requirements = REQUIREMENTS_PATH.read_text(encoding="utf-8")
    match = re.search(r"Rokurolize/wikidot\.py@([0-9a-f]{40})", requirements)
    if match is None:
        raise RuntimeError("wikidot.py dependency is not pinned")
    import importlib

    modules = [
        ("wikidot", importlib.import_module("wikidot")),
        ("wikidot.connector.ajax", importlib.import_module("wikidot.connector.ajax")),
    ]

    module_path = Path(modules[0][1].__file__).resolve()
    if not module_path.is_file():
        raise RuntimeError("imported wikidot module has no file")
    try:
        module_checkout = Path(git_value_at(module_path.parent, "rev-parse", "--show-toplevel")).resolve()
        status = git_value_at(module_checkout, "status", "--porcelain", "--untracked-files=all")
        module_revision = git_value_at(module_checkout, "rev-parse", "HEAD")
        module_tree = git_value_at(module_checkout, "rev-parse", "HEAD^{tree}")
    except (OSError, subprocess.CalledProcessError) as error:
        raise RuntimeError("imported wikidot module is not from a git checkout") from error
    if status:
        raise RuntimeError("imported wikidot checkout is dirty")
    if module_revision != match.group(1):
        raise RuntimeError("imported wikidot checkout does not match its pinned commit")

    module_files = []
    for module_name, module in modules:
        path = Path(module.__file__).resolve()
        try:
            relative_path = path.relative_to(module_checkout).as_posix()
        except ValueError as error:
            raise RuntimeError(f"imported {module_name} module is outside its checkout") from error
        expected_blob = git_value_at(module_checkout, "rev-parse", f"{module_revision}:{relative_path}")
        actual_blob = git_value_at(module_checkout, "hash-object", "--no-filters", relative_path)
        if actual_blob != expected_blob:
            raise RuntimeError(f"imported {module_name} module bytes do not match its pinned revision")
        module_files.append(
            {
                "module": module_name,
                "path": str(path),
                "relative_path": relative_path,
                "sha256": sha256_bytes(path.read_bytes()),
                "git_blob_sha1": actual_blob,
            }
        )

    return {
        "requirements_path": str(REQUIREMENTS_PATH),
        "requirements_sha256": sha256_bytes(REQUIREMENTS_PATH.read_bytes()),
        "wikidot_py_commit": match.group(1),
        "wikidot_py_version": modules[0][1].__version__,
        "wikidot_py_module_path": str(module_path),
        "wikidot_py_checkout": str(module_checkout),
        "wikidot_py_checkout_revision": module_revision,
        "wikidot_py_checkout_tree": module_tree,
        "wikidot_py_module_files": module_files,
    }


def preview_records(
    cases: list[dict[str, Any]],
    target_slug: str,
    target_title: str,
    evidence_dir: Path,
    budgets: dict[str, int],
    started: float,
    usage: dict[str, int],
    strict: bool = True,
) -> list[dict[str, Any]]:
    import wikidot

    evidence_dir.mkdir(parents=True, exist_ok=True)
    records = []
    with wikidot.Client(logging_level="CRITICAL") as anonymous_client:
        anonymous_site = anonymous_client.site.get(SITE)
        if anonymous_site.unix_name != SITE or anonymous_site.domain != DOMAIN:
            raise RuntimeError("anonymous PagePreview site is outside the exact sandbox allowlist")
        for case in cases:
            budget_check(usage, budgets, started)
            retry_ceiling = 3
            if usage["retries"] + retry_ceiling > budgets["max_retries"]:
                raise RuntimeError("issue 1383 PagePreview retry budget exceeded")
            usage["retries"] += retry_ceiling
            source = source_for(case, target_slug)
            body = preview_body({
                "source": source,
                "title": f"Issue 1383 {case['label']} preview",
            })
            responses = anonymous_site.amc_request_with_retry([body], batch_size=1, max_retries=3)
            response = responses[0]
            if response is None:
                raise RuntimeError(f"PagePreview retry exhausted for {case['case_id']}")
            response_raw = bytes(response.content)
            original_request_body = request_body(response.request)
            request_raw, redacted_fields = redacted_request_wire_bytes(response.request)
            request_ref = write_bytes_no_replace(evidence_dir / f"{case['case_id']}.request.bin", request_raw)
            response_ref = write_bytes_no_replace(evidence_dir / f"{case['case_id']}.response.bin", response_raw)
            try:
                response_json = json.loads(response_raw)
            except json.JSONDecodeError as error:
                raise RuntimeError("PagePreview response is not JSON") from error
            if not isinstance(response_json, dict):
                raise RuntimeError("PagePreview response is not a JSON object")
            budget_check(usage, budgets, started)
            preview_html = response_json.get("body")
            if not isinstance(preview_html, str):
                raise RuntimeError(f"PagePreview returned no body for {case['case_id']}")
            escaped_marker = f"&lt;b&gt;{case['marker']}&lt;/b&gt;"
            expected_literal = "[[html]]" if case["saved_executes"] else (
                "[[SECTION_ONEhtml]]" if case["section"] == 1 else "[[htmlx]]"
            )
            if strict and (
                expected_literal not in preview_html
                or escaped_marker not in preview_html
                or "ROW_EVALUATED:" not in preview_html
                or "html-block-iframe" in preview_html
                or "<iframe" in preview_html
            ):
                raise RuntimeError(f"PagePreview control did not satisfy its expected literal shape: {case['case_id']}")
            records.append(
                {
                    "case_id": case["case_id"],
                    "classification": case["classification"],
                    "section": case["section"],
                    "opener": case["opener"],
                    "source": source,
                    "source_sha256": sha256(source),
                    "request": {
                        "method": response.request.method,
                        "url": safe_request_url(str(response.request.url)),
                        "headers": safe_headers(response.request.headers),
                        "raw": request_ref,
                        "body_sha256": sha256_bytes(original_request_body),
                        "body_bytes": len(original_request_body),
                        "redacted_fields": redacted_fields,
                    },
                    "response": {
                        "status": response.status_code,
                        "url": safe_request_url(str(response.url)),
                        "headers": safe_headers(response.headers),
                        "raw": response_ref,
                        "preview_html_sha256": sha256(preview_html),
                    },
                    "observed": {
                        "literal_opener": expected_literal,
                        "escaped_marker": escaped_marker,
                        "iframe_count": preview_html.count("<iframe"),
                        "target_title": target_title,
                    },
                }
            )
    return records


def saved_http_record(
    consumer_slug: str,
    cases: list[dict[str, Any]],
    consumer_source: str,
    evidence_dir: Path,
    budgets: dict[str, int],
    started: float,
    usage: dict[str, int],
) -> dict[str, Any]:
    import httpx

    budget_check(usage, budgets, started)
    url = f"{ORIGIN}/{consumer_slug}"
    with httpx.Client(follow_redirects=False, timeout=30.0, trust_env=False) as client:
        request = client.build_request("GET", url)
        response = client.send(request)
    raw = bytes(response.content)
    observe_http(usage, budgets, started, request, response)
    budget_check(usage, budgets, started)
    request_ref = write_bytes_no_replace(evidence_dir / "saved-page.request.bin", request_wire_bytes(request))
    response_ref = write_bytes_no_replace(evidence_dir / "saved-page.response.bin", raw)
    html = raw.decode("utf-8")
    if response.status_code != 200:
        raise RuntimeError("saved page returned a non-200 status")
    if html.count("html-block-iframe") != sum(case["saved_executes"] for case in cases):
        raise RuntimeError("saved page iframe count does not match the two positive controls")
    for case in cases:
        marker = case["marker"]
        if case["saved_executes"]:
            if marker in html:
                raise RuntimeError(f"saved positive control marker leaked into the outer page: {case['case_id']}")
        elif f"&lt;b&gt;{marker}&lt;/b&gt;" not in html:
            raise RuntimeError(f"saved negative control lost its literal marker: {case['case_id']}")
    return {
        "request": {"method": "GET", "url": url, "headers": safe_headers(request.headers), "raw": request_ref},
        "response": {
            "status": response.status_code,
            "url": safe_request_url(str(response.url)),
            "headers": safe_headers(response.headers),
            "raw": response_ref,
            "body_sha256": sha256_bytes(raw),
            "body_bytes": len(raw),
        },
        "consumer_source_sha256": sha256(consumer_source),
    }


NODE_BROWSER_CAPTURE = r'''
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { captureDocumentObservation, waitForBrowserParitySettledResources } from "./install/local/wikidot-verification/src/standing-browser-parity-observation.mjs";
import { capturePng } from "./install/local/wikidot-verification/src/standing-browser-screenshot.mjs";
import { acquireBrowserCaptureLock, createPersistentBrowserRequestGate } from "./install/local/wikidot-verification/src/browser-request-gate.mjs";
import { startCaptureEgressProxy } from "./install/local/wikidot-verification/src/capture-egress-proxy.mjs";
import { launchParityBrowser } from "./install/local/wikidot-verification/src/standing-browser-parity-browser-session.mjs";
import { loadPlaywright } from "./install/local/wikidot-verification/src/browser-session.mjs";

const input = JSON.parse(await new Promise((resolve, reject) => {
  let value = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => { value += chunk; });
  process.stdin.on("end", () => resolve(value));
  process.stdin.on("error", reject);
}));
const root = path.resolve(input.repo_root);
const browserRoot = path.resolve(root, input.browser_root);
const evidenceDir = path.resolve(input.evidence_dir);
const url = input.url;
const sha256 = (value) => crypto.createHash("sha256").update(value).digest("hex");
const sensitiveHeaders = new Set(["authorization", "cookie", "proxy-authorization", "set-cookie", "x-csrf-token"]);
const safeHeaders = (headers) => Object.fromEntries(Object.entries(headers).filter(([name]) => !sensitiveHeaders.has(name.toLowerCase())));
const safeRequestUrl = (value) => {
  const target = new URL(value);
  target.username = "";
  target.password = "";
  for (const key of [...target.searchParams.keys()]) {
    if (["authorization", "csrf", "csrf_token", "password", "session", "session_token", "token", "username", "wikidot_token7"].includes(key.toLowerCase())) target.searchParams.set(key, "[REDACTED]");
  }
  return target.toString();
};
const requestWireBytes = (request, includeSensitive = false) => {
  const target = new URL(request.url());
  const path = `${target.pathname || "/"}${target.search}`;
  const headers = includeSensitive ? request.headers() : safeHeaders(request.headers());
  const lines = [`${request.method()} ${path} HTTP/1.1`, ...Object.entries(headers).sort(([left], [right]) => left.localeCompare(right)).map(([name, value]) => `${name}: ${value}`)];
  return Buffer.concat([Buffer.from(`${lines.join("\r\n")}\r\n\r\n`, "utf8"), request.postDataBuffer?.() ?? Buffer.alloc(0)]);
};
const contract = {
  geometry_selectors: ["#page-content"],
  first_paint_geometry_selectors: ["#page-content"],
  presence_probes: [{id: "html-block-iframes", selector: "iframe.html-block-iframe", minimum_count: 0, require_rendered: false}],
};
const phaseControls = (cases) => cases.map((row) => {
  const element = document.querySelector(`.issue1383-${CSS.escape(row.label)}`);
  const html = element?.outerHTML ?? "";
  const iframe = element?.querySelector("iframe.html-block-iframe") ?? null;
  const frameDocument = iframe?.contentDocument ?? null;
  const frameDocumentHtml = frameDocument?.documentElement?.outerHTML ?? null;
  const frameVisibleText = frameDocument?.body?.innerText ?? "";
  return {
    case_id: row.case_id,
    classification: row.classification,
    marker_in_outer_dom: html.includes(row.marker),
    outer_literal: html.includes(`&lt;b&gt;${row.marker}&lt;/b&gt;`),
    iframe_count: element?.querySelectorAll("iframe.html-block-iframe").length ?? 0,
    frame_marker_rendered: frameVisibleText.includes(row.marker) && frameDocumentHtml?.includes(row.marker) === true,
    frame_url: frameDocument?.URL ?? iframe?.src ?? null,
    frame_response_status: null,
    frame_document_html: frameDocumentHtml,
  };
});
const phaseControlsSource = phaseControls.toString();
if (phaseControls.length !== 1 || !phaseControlsSource.includes("cases") || phaseControlsSource.includes("input.cases")) {
  throw new Error("phaseControls must receive cases as an explicit evaluation argument");
}
if (browserRoot !== path.resolve(root, "framerail")) throw new Error("issue 1383 browser root is not the committed framerail root");
const packageBytes = await fs.readFile(path.join(browserRoot, "package.json"));
const lockBytes = await fs.readFile(path.join(browserRoot, "pnpm-lock.yaml"));
const dependencyTreePath = path.resolve(root, input.browser_dependency_tree_path);
const dependencyTreeBytes = await fs.readFile(dependencyTreePath);
if (sha256(packageBytes) !== input.browser_package_sha256 || sha256(lockBytes) !== input.browser_lock_sha256 || sha256(dependencyTreeBytes) !== input.browser_dependency_tree_sha256) throw new Error("issue 1383 browser dependency identity changed after plan review");
const browserEnvironment = {root: browserRoot, package_json_sha256: sha256(packageBytes), pnpm_lock_sha256: sha256(lockBytes), installed_dependency_tree_path: dependencyTreePath, installed_dependency_tree_sha256: sha256(dependencyTreeBytes)};
const runId = input.run_id;
const runEvidenceDir = path.resolve(input.run_evidence_dir);
await fs.mkdir(evidenceDir, {recursive: true});
let lock = null;
let gate = null;
let proxy = null;
let browser = null;
let page = null;
let browserIdentity = null;
const failures = [];
const consoleErrors = [];
const pageErrors = [];
const httpErrors = [];
const iframeHttp = [];
const iframeHttpErrors = [];
const iframeHttpTasks = [];
const requestEvents = [];
const usage = {requests: 0, request_bytes: 0, response_bytes: 0, redirects: 0, retries: 0};
const nodeStarted = Date.now();
const checkWallClock = () => {
  if (Date.now() - nodeStarted > input.budgets.max_wall_clock_ms) throw new Error("issue 1383 Node wall-clock budget exceeded");
};
const checkBrowserBudget = () => {
  checkWallClock();
  if (usage.requests > input.budgets.max_requests || usage.request_bytes > input.budgets.max_request_bytes || usage.response_bytes > input.budgets.max_response_bytes || usage.redirects > input.budgets.max_redirects || usage.retries > input.budgets.max_retries) {
    throw new Error("issue 1383 browser network budget exceeded");
  }
};
const writeExclusive = async (name, bytes) => {
  const destination = path.join(evidenceDir, name);
  const handle = await fs.open(destination, "wx", 0o600);
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
  return {path: destination, bytes: bytes.byteLength, sha256: sha256(bytes)};
};
const captureScreenshot = async (name, fullPage) => {
  const destination = path.join(evidenceDir, name);
  try {
    await fs.access(destination);
    throw new Error(`evidence path already exists: ${destination}`);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  await capturePng(page, destination, {fullPage});
  const bytes = await fs.readFile(destination);
  return {path: destination, bytes: bytes.byteLength, sha256: sha256(bytes), full_page: fullPage};
};
const capturePhase = async (interval, phase, screenshotName, fullPage) => {
  checkBrowserBudget();
  const rawHtml = await page.content();
  const controls = await page.evaluate(phaseControls, input.cases);
  for (const control of controls) {
    if (control.frame_document_html === null) {
      control.frame_document = null;
    } else {
      control.frame_document = await writeExclusive(
        `${interval}-frame-${control.case_id.replace(/[^a-z0-9-]/giu, "-")}.html`,
        Buffer.from(control.frame_document_html, "utf8"),
      );
    }
    delete control.frame_document_html;
  }
  const document = await captureDocumentObservation(page, {contract, phase, viewport: {width: 1366, height: 900}});
  return {
    interval,
    document,
    controls,
    raw_dom: await writeExclusive(`${interval}.html`, Buffer.from(rawHtml, "utf8")),
    screenshot: await captureScreenshot(screenshotName, fullPage),
  };
};
const captureIframeResponse = async (response) => {
  const request = response.request();
  if (request.resourceType() !== "document") return;
  const frame = request.frame();
  if (frame === page.mainFrame()) return;
  const frameUrl = safeRequestUrl(frame.url() || request.url());
  const sequence = String(iframeHttp.length + iframeHttpTasks.length + 1).padStart(4, "0");
  const responseBody = await response.body();
  iframeHttp.push({
    frame_url: frameUrl,
    request: {method: request.method(), url: safeRequestUrl(request.url()), headers: safeHeaders(request.headers()), raw: await writeExclusive(`iframe-${sequence}.request.bin`, requestWireBytes(request))},
    response: {status: response.status(), url: safeRequestUrl(response.url()), headers: safeHeaders(response.headers()), raw: await writeExclusive(`iframe-${sequence}.response.bin`, responseBody)},
  });
};
const captureResponse = async (response) => {
  const body = await response.body();
  usage.response_bytes += body.byteLength;
  checkBrowserBudget();
  if (response.request().resourceType() === "document" && response.request().frame() !== page.mainFrame()) await captureIframeResponse(response);
};
const eventFrame = (request) => {
  try {
    const frame = request.frame();
    return {frame_role: frame === page?.mainFrame() ? "main" : "child", frame_url: frame?.url?.() ? safeRequestUrl(frame.url()) : null};
  } catch {
    return {frame_role: null, frame_url: null};
  }
};
try {
  lock = await acquireBrowserCaptureLock({runId});
  gate = await createPersistentBrowserRequestGate({statePath: lock.statePath});
  proxy = await startCaptureEgressProxy();
  const controls = {gate, proxy};
  const chromium = loadPlaywright(browserRoot).chromium;
  browser = await launchParityBrowser({
    browserRoot,
    browserExecutable: input.browser_executable ?? null,
    controls,
    local: false,
    viewport: {width: 1366, height: 900},
  });
  browserIdentity = browser.environment;
  if (browserIdentity.executable_sha256 !== input.browser_executable_sha256) throw new Error("issue 1383 browser executable does not match the planned identity");
  page = await browser.context.newPage();
  page.on("request", (request) => {
    usage.requests += 1;
    usage.request_bytes += requestWireBytes(request, true).byteLength;
    requestEvents.push({method: request.method(), url: safeRequestUrl(request.url()), resource_type: request.resourceType()});
    checkBrowserBudget();
  });
  page.on("console", (message) => {
    if (message.type() !== "error") return;
    const location = typeof message.location === "function" ? message.location() : {};
    consoleErrors.push({kind: "console_error", message: message.text(), url: location?.url ? safeRequestUrl(location.url) : null});
  });
  page.on("pageerror", (error) => { pageErrors.push({kind: "page_error", message: error.message ?? String(error), url: null}); });
  page.on("requestfailed", (request) => failures.push({kind: "request_failed", url: safeRequestUrl(request.url()), resource_type: request.resourceType(), error: request.failure()?.errorText ?? "request failed", ...eventFrame(request)}));
  page.on("response", (response) => {
    if (response.status() >= 300 && response.status() < 400) usage.redirects += 1;
    if (response.status() >= 400) {
      httpErrors.push({kind: "http_error", url: safeRequestUrl(response.url()), status: response.status(), resource_type: response.request().resourceType(), ...eventFrame(response.request())});
    }
    const task = captureResponse(response).catch((error) => {
      iframeHttpErrors.push({kind: "iframe_http_capture_error", url: safeRequestUrl(response.url()), error: error?.message ?? String(error), ...eventFrame(response.request())});
    });
    iframeHttpTasks.push(task);
  });
  const previewStart = {requests: requestEvents.length, failures: failures.length, httpErrors: httpErrors.length, consoleErrors: consoleErrors.length, pageErrors: pageErrors.length, iframeHttp: iframeHttp.length};
  const previewHtml = (await Promise.all(input.preview_records.map(async (record) => {
    const responseRawPath = path.resolve(record.response_raw_path);
    if (!responseRawPath.startsWith(`${runEvidenceDir}${path.sep}`)) throw new Error("issue 1383 PagePreview response is outside the run evidence directory");
    const response = JSON.parse((await fs.readFile(responseRawPath)).toString("utf8"));
    if (record.case_id !== response.case_id && response.case_id !== undefined) throw new Error("issue 1383 PagePreview response case binding changed");
    if (typeof response.body !== "string") throw new Error("issue 1383 PagePreview response has no browser body");
    return response.body;
  }))).join("\n");
  await page.setContent(`<div id="issue1383-preview-browser">${previewHtml}</div>`, {waitUntil: "domcontentloaded", timeout: input.timeout_ms});
  const previewDomContentLoaded = await capturePhase("preview_domcontentloaded", "preview_domcontentloaded", "preview-domcontentloaded.png", false);
  await waitForBrowserParitySettledResources(page, input.timeout_ms);
  await page.waitForTimeout(input.settle_ms);
  const previewSettled = await capturePhase("preview_settled", "preview_settled", "preview-settled.png", true);
  const preview = {
    domcontentloaded: previewDomContentLoaded,
    settled: previewSettled,
    network_requests: requestEvents.slice(previewStart.requests),
    failed_requests: failures.slice(previewStart.failures),
    http_errors: httpErrors.slice(previewStart.httpErrors),
    console_errors: consoleErrors.slice(previewStart.consoleErrors),
    page_errors: pageErrors.slice(previewStart.pageErrors),
    iframe_http: iframeHttp.slice(previewStart.iframeHttp),
  };
  const navigation = await page.goto(url, {waitUntil: "domcontentloaded", timeout: input.timeout_ms});
  const domcontentloaded = await capturePhase("domcontentloaded", "domcontentloaded_immediate_observation", "domcontentloaded.png", false);
  domcontentloaded.navigation_status = navigation?.status?.() ?? null;
  const resourceCompletion = await waitForBrowserParitySettledResources(page, input.timeout_ms);
  await page.waitForTimeout(input.settle_ms);
  const settled = await capturePhase("settled", "settled", "settled.png", true);
  settled.resource_completion = resourceCompletion;
  await Promise.all(iframeHttpTasks);
  for (const control of settled.controls.filter((item) => item.classification === "positive")) {
    const matches = iframeHttp.filter((record) => record.frame_url === control.frame_url);
    if (matches.length !== 1) throw new Error(`issue 1383 settled iframe HTTP binding is ambiguous for ${control.case_id}`);
    matches[0].case_id = control.case_id;
    control.frame_response_status = matches[0].response.status;
  }
  const positiveCaseIds = settled.controls.filter((item) => item.classification === "positive").map((item) => item.case_id);
  if (iframeHttp.some((record) => !record.case_id) || iframeHttp.length !== positiveCaseIds.length) throw new Error("issue 1383 iframe HTTP records omit or duplicate a positive case");
  iframeHttp.sort((left, right) => positiveCaseIds.indexOf(left.case_id) - positiveCaseIds.indexOf(right.case_id));
  checkBrowserBudget();
  const finalUrl = page.url();
  const targetFrameUrls = new Set(
    [domcontentloaded, settled]
      .flatMap((phase) => phase.controls.map((control) => control.frame_url))
      .filter(Boolean),
  );
  const targetUrls = new Set([url, finalUrl, ...targetFrameUrls]);
  const classify = (event) => {
    const target = event.kind === "page_error" || event.frame_role === "main" || event.frame_role === "child" ||
      (event.kind === "console_error" && !event.url) ||
      [event.url, event.frame_url].some((candidate) => candidate && targetUrls.has(candidate));
    return {...event, classification: target ? "target_or_frame_error" : "unrelated_noise"};
  };
  const allEvents = [...failures, ...httpErrors, ...consoleErrors, ...pageErrors, ...iframeHttpErrors].map(classify);
  const targetErrors = allEvents.filter((event) => event.classification === "target_or_frame_error");
  const unrelatedNoise = allEvents.filter((event) => event.classification === "unrelated_noise");
  await page.close();
  page = null;
  await browser.close();
  browser = null;
  await gate.flush();
  await lock.confirmState();
  const gateSnapshot = gate.snapshot();
  usage.retries = gateSnapshot.retry_after_honored ?? 0;
  checkBrowserBudget();
  await proxy.close();
  await lock.release();
  process.stdout.write(JSON.stringify({evidence_dir: evidenceDir, url, final_url: finalUrl, browser: {...browserIdentity, ...browserEnvironment, node_version: process.version, service_workers: "blocked", storage_state: "none", response_cache: "none"}, preview, domcontentloaded, settled, iframe_http: iframeHttp, iframe_http_errors: iframeHttpErrors.map(classify), failed_requests: failures.map(classify), http_errors: httpErrors.map(classify), console_errors: consoleErrors.map(classify), page_errors: pageErrors.map(classify), target_errors: targetErrors, unrelated_noise: unrelatedNoise, request_gate: gateSnapshot, usage}));
} catch (error) {
  await page?.close().catch(() => {});
  await browser?.close().catch(() => {});
  await proxy?.close().catch(() => {});
  await gate?.flush().catch(() => {});
  await lock?.confirmState().catch(() => {});
  await lock?.release().catch(() => {});
  process.stdout.write(JSON.stringify({error: {name: error?.name ?? "Error", message: error?.message ?? String(error)}, failed_requests: failures, console_errors: consoleErrors, page_errors: pageErrors, usage}));
  process.exitCode = 1;
}
'''


def browser_capture(
    repo_root: Path,
    consumer_url: str,
    cases: list[dict[str, Any]],
    preview_records: list[dict[str, Any]],
    browser: dict[str, Any],
    run_id: str,
    evidence_dir: Path,
    budgets: dict[str, int],
    browser_plan: dict[str, Any],
    aggregate_usage: dict[str, int],
    started: float,
) -> dict[str, Any]:
    payload = {
        "repo_root": str(repo_root),
        "browser_root": browser.get("root", "framerail"),
        "browser_executable": browser.get("executable"),
        "browser_package_sha256": browser_plan["package_sha256"],
        "browser_lock_sha256": browser_plan["lock_sha256"],
        "browser_executable_sha256": browser_plan["executable_sha256"],
        "browser_dependency_tree_path": browser_plan["installed_dependency_tree"]["path"],
        "browser_dependency_tree_sha256": browser_plan["installed_dependency_tree"]["sha256"],
        "node_executable": browser_plan["node_executable"],
        "node_version": browser_plan["node_version"],
        "run_id": run_id,
        "evidence_dir": str(evidence_dir),
        "run_evidence_dir": str(evidence_dir.parent),
        "url": consumer_url,
        "cases": cases,
        "preview_records": [
            {"case_id": record["case_id"], "response_raw_path": record["response"]["raw"]["path"]}
            for record in preview_records
        ],
        "timeout_ms": browser.get("timeout_ms", 120000),
        "settle_ms": browser.get("settle_ms", 1000),
        "budgets": budgets,
    }
    remaining = max(0.001, (budgets["max_wall_clock_ms"] - round((time.monotonic() - started) * 1000)) / 1000)
    try:
        result = subprocess.run(
            [browser_plan["node_executable"], "--input-type=module", "-e", NODE_BROWSER_CAPTURE],
            cwd=repo_root,
            input=json.dumps(payload),
            capture_output=True,
            text=True,
            check=False,
            timeout=remaining,
        )
    except subprocess.TimeoutExpired as error:
        raise RuntimeError("issue 1383 Node wall-clock budget exceeded") from error
    if not result.stdout.strip():
        raise RuntimeError("browser capture produced no receipt")
    value = json.loads(result.stdout)
    browser_usage = value.get("usage")
    if (
        not isinstance(browser_usage, dict)
        or set(browser_usage) != set(TRAFFIC_KEYS)
        or any(not isinstance(browser_usage[key], int) or isinstance(browser_usage[key], bool) or browser_usage[key] < 0 for key in TRAFFIC_KEYS)
    ):
        raise RuntimeError("browser capture did not return aggregate usage")
    for key in TRAFFIC_KEYS:
        aggregate_usage[key] += browser_usage[key]
    budget_check(aggregate_usage, budgets, started)
    if result.returncode != 0:
        raise RuntimeError(f"browser capture failed: {value.get('error', {}).get('name', 'Error')}")
    validate_browser_capture(value, consumer_url, cases, evidence_dir, budgets, browser_plan)
    return value


def validate_evidence_file(
    value: Any,
    label: str,
    evidence_dir: Path,
    full_page: bool | None = None,
    allow_empty: bool = False,
) -> None:
    expected_keys = {"path", "bytes", "sha256"} | ({"full_page"} if full_page is not None else set())
    if not isinstance(value, dict) or set(value) != expected_keys:
        raise RuntimeError(f"browser capture {label} evidence reference is incomplete")
    if (
        not isinstance(value["path"], str)
        or not isinstance(value["bytes"], int)
        or isinstance(value["bytes"], bool)
        or not isinstance(value["sha256"], str)
        or (full_page is not None and not isinstance(value["full_page"], bool))
    ):
        raise RuntimeError(f"browser capture {label} evidence metadata is invalid")
    path = Path(value["path"])
    root = evidence_dir.resolve()
    try:
        resolved = path.resolve()
        resolved.relative_to(root)
    except (OSError, ValueError) as error:
        raise RuntimeError(f"browser capture {label} evidence path is outside its run directory") from error
    if not path.is_absolute() or (value["bytes"] < 0 if allow_empty else value["bytes"] <= 0) or not re.fullmatch(r"[0-9a-f]{64}", value["sha256"]):
        raise RuntimeError(f"browser capture {label} evidence metadata is invalid")
    try:
        content = path.read_bytes()
    except OSError as error:
        raise RuntimeError(f"browser capture {label} evidence file is missing") from error
    if len(content) != value["bytes"] or sha256_bytes(content) != value["sha256"]:
        raise RuntimeError(f"browser capture {label} evidence digest does not match its file")
    if full_page is not None and value["full_page"] is not full_page:
        raise RuntimeError(f"browser capture {label} screenshot interval is invalid")


def validate_headers(value: Any, label: str) -> None:
    if not isinstance(value, dict) or any(
        not isinstance(name, str)
        or not isinstance(header_value, str)
        or name.lower() in SENSITIVE_HEADERS
        for name, header_value in value.items()
    ):
        raise RuntimeError(f"{label} headers are incomplete or contain sensitive fields")


def validate_browser_capture(
    value: dict[str, Any],
    consumer_url: str,
    cases: list[dict[str, Any]],
    evidence_dir: Path,
    budgets: dict[str, int],
    browser_plan: dict[str, str],
) -> None:
    if "error" in value or value.get("url") != consumer_url or value.get("final_url") != consumer_url:
        raise RuntimeError("browser capture did not return the requested page without an error")
    if (
        not isinstance(value.get("target_errors"), list)
        or any(not isinstance(item, dict) or item.get("classification") != "target_or_frame_error" for item in value["target_errors"])
        or value["target_errors"]
    ):
        raise RuntimeError("browser capture recorded target, frame, or network errors")
    if not isinstance(value.get("unrelated_noise"), list) or any(
        not isinstance(item, dict) or item.get("classification") != "unrelated_noise" for item in value["unrelated_noise"]
    ):
        raise RuntimeError("browser capture unrelated noise is not classified")
    if value.get("evidence_dir") != str(evidence_dir.resolve()):
        raise RuntimeError("browser capture evidence directory is not run-owned")
    for key in ("failed_requests", "http_errors", "console_errors", "page_errors"):
        events = value.get(key)
        if not isinstance(events, list) or any(
            not isinstance(event, dict) or event.get("classification") not in {"target_or_frame_error", "unrelated_noise"}
            for event in events
        ):
            raise RuntimeError(f"browser capture {key} is not classified")
    iframe_http_errors = value.get("iframe_http_errors")
    if not isinstance(iframe_http_errors, list) or any(
        not isinstance(event, dict) or event.get("classification") not in {"target_or_frame_error", "unrelated_noise"}
        for event in iframe_http_errors
    ):
        raise RuntimeError("browser capture iframe HTTP errors are not classified")
    browser = value.get("browser")
    if (
        not isinstance(browser, dict)
        or browser.get("engine") != "chromium"
        or not isinstance(browser.get("version"), str)
        or not re.fullmatch(r"[0-9a-f]{64}", browser.get("executable_sha256", ""))
        or not re.fullmatch(r"[0-9a-f]{64}", browser.get("package_json_sha256", ""))
        or not re.fullmatch(r"[0-9a-f]{64}", browser.get("pnpm_lock_sha256", ""))
        or browser.get("root") != str((REPO_ROOT / EXPECTED_BROWSER_ROOT).resolve())
        or browser.get("package_json_sha256") != browser_plan["package_sha256"]
        or browser.get("pnpm_lock_sha256") != browser_plan["lock_sha256"]
        or browser.get("executable_sha256") != browser_plan["executable_sha256"]
        or browser.get("version") != browser_plan["version"]
        or browser.get("node_version") != browser_plan["node_version"]
        or browser.get("installed_dependency_tree_path") != str(repo_path(browser_plan["installed_dependency_tree"]["path"], "installed browser dependency tree path"))
        or browser.get("installed_dependency_tree_sha256") != browser_plan["installed_dependency_tree"]["sha256"]
    ):
        raise RuntimeError("browser capture is missing its executable or package identity")
    usage = value.get("usage")
    if (
        not isinstance(usage, dict)
        or set(usage) != {"requests", "request_bytes", "response_bytes", "redirects", "retries"}
        or any(not isinstance(usage[key], int) or isinstance(usage[key], bool) or usage[key] < 0 for key in usage)
        or any(usage[key] > budgets[f"max_{key}"] for key in ("requests", "request_bytes", "response_bytes", "redirects", "retries"))
    ):
        raise RuntimeError("browser capture network budget usage is invalid")
    expected_ids = [case["case_id"] for case in cases]
    expected = {case["case_id"]: case for case in cases}
    preview = value.get("preview")
    if not isinstance(preview, dict):
        raise RuntimeError("browser capture PagePreview intervals are missing")
    if any(preview.get(key) != [] for key in ("network_requests", "failed_requests", "http_errors", "console_errors", "page_errors", "iframe_http")):
        raise RuntimeError("browser capture PagePreview recorded network, frame, or page errors")
    for phase_name in ("preview_domcontentloaded", "preview_settled"):
        phase = preview.get("domcontentloaded" if phase_name.endswith("domcontentloaded") else "settled")
        controls = phase.get("controls") if isinstance(phase, dict) else None
        if (
            not isinstance(phase, dict)
            or phase.get("interval") != phase_name
            or not isinstance(controls, list)
            or len(controls) != len(expected)
            or [actual.get("case_id") if isinstance(actual, dict) else None for actual in controls] != expected_ids
        ):
            raise RuntimeError(f"browser capture {phase_name} PagePreview controls are incomplete")
        validate_evidence_file(phase["raw_dom"], f"{phase_name} PagePreview raw DOM", evidence_dir)
        validate_evidence_file(phase["screenshot"], f"{phase_name} PagePreview screenshot", evidence_dir, phase_name.endswith("settled"))
        for actual in controls:
            if (
                not isinstance(actual, dict)
                or set(actual) != {
                    "case_id", "classification", "marker_in_outer_dom", "outer_literal",
                    "iframe_count", "frame_marker_rendered", "frame_url", "frame_response_status", "frame_document",
                }
                or not isinstance(actual.get("case_id"), str)
                or not isinstance(actual.get("classification"), str)
                or not isinstance(actual.get("marker_in_outer_dom"), bool)
                or not isinstance(actual.get("outer_literal"), bool)
                or not isinstance(actual.get("iframe_count"), int)
                or isinstance(actual.get("iframe_count"), bool)
                or not isinstance(actual.get("frame_marker_rendered"), bool)
                or actual.get("classification") != expected[actual["case_id"]]["classification"]
                or actual.get("iframe_count") != 0
                or actual.get("frame_marker_rendered") is not False
                or actual.get("frame_document") is not None
                or actual.get("frame_url") is not None
                or actual.get("frame_response_status") is not None
                or actual.get("outer_literal") is not True
            ):
                raise RuntimeError(f"browser capture {phase_name} PagePreview control is not literal and iframe-free")
    interval_keys = []
    for phase_name in ("domcontentloaded", "settled"):
        phase = value.get(phase_name)
        controls = phase.get("controls") if isinstance(phase, dict) else None
        if (
            not isinstance(phase, dict)
            or phase.get("interval") != phase_name
            or not isinstance(controls, list)
            or len(controls) != len(expected)
            or not isinstance(phase.get("raw_dom"), dict)
            or not isinstance(phase.get("screenshot"), dict)
        ):
            raise RuntimeError(f"browser capture {phase_name} controls are incomplete")
        actual_ids = [actual.get("case_id") if isinstance(actual, dict) else None for actual in controls]
        if actual_ids != expected_ids or len(set(actual_ids)) != len(expected_ids):
            raise RuntimeError(f"browser capture {phase_name} controls omit or duplicate a case ID")
        interval_keys.extend((phase_name, case_id) for case_id in actual_ids)
        validate_evidence_file(phase["raw_dom"], f"{phase_name} raw DOM", evidence_dir)
        validate_evidence_file(phase["screenshot"], f"{phase_name} screenshot", evidence_dir, phase_name.endswith("settled"))
        for actual in controls:
            wanted = expected[actual["case_id"]]
            if (
                not isinstance(actual, dict)
                or set(actual) != {
                    "case_id", "classification", "marker_in_outer_dom", "outer_literal",
                    "iframe_count", "frame_marker_rendered", "frame_url", "frame_response_status", "frame_document",
                }
                or not isinstance(actual["case_id"], str)
                or not isinstance(actual["classification"], str)
                or not isinstance(actual["marker_in_outer_dom"], bool)
                or not isinstance(actual["outer_literal"], bool)
                or not isinstance(actual["iframe_count"], int)
                or isinstance(actual["iframe_count"], bool)
                or not isinstance(actual["frame_marker_rendered"], bool)
                or (actual["frame_response_status"] is not None and (not isinstance(actual["frame_response_status"], int) or isinstance(actual["frame_response_status"], bool)))
                or actual["classification"] != wanted["classification"]
                or actual["marker_in_outer_dom"] != (not wanted["saved_executes"])
                or actual["outer_literal"] != (not wanted["saved_executes"])
            ):
                raise RuntimeError(f"browser capture {phase_name} control shape is invalid")
            if wanted["classification"] == "negative":
                if actual["iframe_count"] != 0 or actual["frame_marker_rendered"] or actual["frame_document"] is not None or actual["frame_url"] is not None or actual["frame_response_status"] is not None:
                    raise RuntimeError(f"browser capture {phase_name} negative control is executable")
            elif phase_name == "domcontentloaded":
                if (
                    not isinstance(actual["iframe_count"], int)
                    or isinstance(actual["iframe_count"], bool)
                    or actual["iframe_count"] < 0
                    or not isinstance(actual["frame_marker_rendered"], bool)
                ):
                    raise RuntimeError(f"browser capture {phase_name} positive interval shape is invalid")
                if actual["frame_document"] is not None:
                    if not isinstance(actual["frame_document"], dict) or not isinstance(actual["frame_url"], str):
                        raise RuntimeError(f"browser capture {phase_name} positive frame evidence is incomplete")
                    validate_evidence_file(actual["frame_document"], f"{phase_name} {actual['case_id']} frame document", evidence_dir)
            else:
                if actual["iframe_count"] != 1 or not actual["frame_marker_rendered"] or not isinstance(actual["frame_url"], str) or actual["frame_response_status"] != 200:
                    raise RuntimeError(f"browser capture {phase_name} positive frame is not executable")
                frame_document = actual["frame_document"]
                if not isinstance(frame_document, dict):
                    raise RuntimeError(f"browser capture {phase_name} positive frame evidence is missing")
                validate_evidence_file(frame_document, f"{phase_name} {actual['case_id']} frame document", evidence_dir)
                if wanted["marker"] not in Path(frame_document["path"]).read_text(encoding="utf-8"):
                    raise RuntimeError(f"browser capture {phase_name} positive frame marker is missing")
    if interval_keys != [(phase, case_id) for phase in ("domcontentloaded", "settled") for case_id in expected_ids]:
        raise RuntimeError("browser capture interval keys are omitted or duplicated")
    iframe_http = value.get("iframe_http")
    if not isinstance(iframe_http, list):
        raise RuntimeError("browser capture iframe HTTP records are missing")
    positive_ids = [case["case_id"] for case in cases if case["saved_executes"]]
    for index, record in enumerate(iframe_http):
        if (
            not isinstance(record, dict)
            or set(record) != {"case_id", "frame_url", "request", "response"}
            or not isinstance(record["case_id"], str)
            or not isinstance(record["frame_url"], str)
            or not isinstance(record["request"], dict)
            or set(record["request"]) != {"method", "url", "headers", "raw"}
            or not isinstance(record["response"], dict)
            or set(record["response"]) != {"status", "url", "headers", "raw"}
            or not isinstance(record["request"]["method"], str)
            or not isinstance(record["request"]["url"], str)
            or not isinstance(record["response"]["status"], int)
            or isinstance(record["response"]["status"], bool)
            or not isinstance(record["response"]["url"], str)
        ):
            raise RuntimeError(f"browser capture iframe HTTP record {index} is invalid")
        validate_headers(record["request"]["headers"], f"iframe HTTP request {index}")
        validate_headers(record["response"]["headers"], f"iframe HTTP response {index}")
        validate_evidence_file(record["request"]["raw"], f"iframe HTTP request {index}", evidence_dir, allow_empty=True)
        validate_evidence_file(record["response"]["raw"], f"iframe HTTP response {index}", evidence_dir)
    if [record.get("case_id") for record in iframe_http] != positive_ids:
        raise RuntimeError("browser capture iframe HTTP case IDs are omitted, duplicated, or reordered")
    for case in cases:
        if not case["saved_executes"]:
            continue
        settled_control = next(control for control in value["settled"]["controls"] if control["case_id"] == case["case_id"])
        matches = [record for record in iframe_http if record["case_id"] == case["case_id"]]
        if len(matches) != 1 or matches[0]["frame_url"] != settled_control["frame_url"] or matches[0]["response"]["status"] != settled_control["frame_response_status"]:
            raise RuntimeError(f"browser capture has no replayable iframe HTTP pair for {case['case_id']}")


def cleanup_pages(
    site: Any,
    planned: list[dict[str, Any]],
    snapshots: dict[str, dict[str, Any]],
    preexisting: dict[str, bool] | None,
) -> dict[str, Any]:
    rows = []
    failures = []
    for item in reversed(planned):
        fullname = item["fullname"]
        expected_source_sha256 = item["source_sha256"]
        snapshot = snapshots.get(fullname)
        row = {
            "fullname": fullname,
            "identity": snapshot.get("identity") if snapshot else None,
            "title": item["title"],
            "source_sha256": expected_source_sha256,
            "stored_snapshot": snapshot is not None,
            "removed": False,
            "page_absent_after_removal": False,
            "status": "not_attempted",
        }
        if preexisting is None:
            row["status"] = "preexisting_absence_unproven"
            failures.append({"fullname": fullname, "error_type": row["status"]})
            rows.append(row)
            continue
        if not preexisting.get(fullname, False):
            row["status"] = "preexisting_not_absent"
            failures.append({"fullname": fullname, "error_type": row["status"]})
            rows.append(row)
            continue
        try:
            page = site.page.get(fullname, raise_when_not_found=False)
            if page is None:
                row["status"] = "absent_before_cleanup"
                row["page_absent_after_removal"] = True
                row["mismatch_reason"] = "deletion_not_observed"
                failures.append({"fullname": fullname, "error_type": row["status"], "reason": row["mismatch_reason"]})
                rows.append(row)
                continue
            page.refresh_source()
            actual_source_sha256 = sha256(page.source.wiki_text)
            if page.title != item["title"] or actual_source_sha256 != expected_source_sha256:
                row["status"] = "ambiguous_mismatch"
                row["mismatch_reason"] = "current_title_or_source_hash_does_not_match_planned_page"
                failures.append({"fullname": fullname, "error_type": row["status"], "reason": row["mismatch_reason"]})
                rows.append(row)
                continue
            if snapshot is not None:
                if (
                    snapshot["title"] != item["title"]
                    or snapshot["source_sha256"] != expected_source_sha256
                    or snapshot["identity"] != page.id
                ):
                    row["status"] = "ambiguous_mismatch"
                    row["mismatch_reason"] = "stored_snapshot_does_not_match_planned_page_or_current_identity"
                    failures.append({"fullname": fullname, "error_type": row["status"], "reason": row["mismatch_reason"]})
                    rows.append(row)
                    continue
                remove_exact(site, snapshot)
            else:
                remove_exact(
                    site,
                    {
                        "fullname": fullname,
                        "identity": page.id,
                        "title": page.title,
                        "source_sha256": actual_source_sha256,
                    },
                )
            row["removed"] = True
            row["status"] = "removed"
            row["page_absent_after_removal"] = site.page.get(fullname, raise_when_not_found=False) is None
            if not row["page_absent_after_removal"]:
                raise RuntimeError("page remained after removal")
        except Exception as error:
            row["status"] = "cleanup_error"
            failures.append({"fullname": fullname, "error_type": type(error).__name__})
        rows.append(row)
    return {"planned_pages": rows, "failures": failures, "all_absent": not failures and all(row["page_absent_after_removal"] for row in rows)}


def validate_output_path(output: Path, run_id: str) -> None:
    try:
        relative = output.relative_to(RETAINED_EVIDENCE_ROOT)
    except ValueError as error:
        raise RuntimeError(f"output must be retained below {RETAINED_EVIDENCE_ROOT}") from error
    if relative.parts != (run_id, "artifact.json"):
        raise RuntimeError("output must be <retained-root>/<run-id>/artifact.json")
    try:
        output.parent.resolve().relative_to(RETAINED_EVIDENCE_ROOT.resolve())
    except ValueError as error:
        raise RuntimeError("output parent resolves outside the retained evidence root") from error


def write_receipt_no_replace(output: Path, artifact: dict[str, Any]) -> None:
    output.parent.mkdir(parents=True, exist_ok=True)
    payload = json.dumps(artifact, ensure_ascii=False, indent=2) + "\n"
    temporary_path = None
    try:
        with tempfile.NamedTemporaryFile(
            mode="w",
            encoding="utf-8",
            dir=output.parent,
            prefix=f".{output.name}.",
            suffix=".tmp",
            delete=False,
        ) as temporary:
            temporary_path = Path(temporary.name)
            temporary.write(payload)
            temporary.flush()
            os.fsync(temporary.fileno())
        os.chmod(temporary_path, 0o600)
        try:
            os.link(temporary_path, output)
        except FileExistsError as error:
            raise RuntimeError("receipt path appeared before atomic no-replace creation") from error
    finally:
        if temporary_path is not None:
            temporary_path.unlink(missing_ok=True)


def validate_case_records(records: Any, cases: list[dict[str, Any]], label: str) -> None:
    expected = [case["case_id"] for case in cases]
    actual = [record.get("case_id") if isinstance(record, dict) else None for record in records] if isinstance(records, list) else None
    if actual != expected or len(set(actual or ())) != len(expected):
        raise RuntimeError(f"issue 1383 {label} case IDs are omitted, duplicated, or reordered")


def validate_preview_records(records: Any, cases: list[dict[str, Any]], evidence_dir: Path) -> None:
    validate_case_records(records, cases, "PagePreview")
    for record in records:
        if (
            set(record) != {"case_id", "classification", "section", "opener", "source", "source_sha256", "request", "response", "observed"}
            or not isinstance(record["request"], dict)
            or set(record["request"]) != {"method", "url", "headers", "raw", "body_sha256", "body_bytes", "redacted_fields"}
            or not isinstance(record["response"], dict)
            or set(record["response"]) != {"status", "url", "headers", "raw", "preview_html_sha256"}
            or not isinstance(record["observed"], dict)
            or set(record["observed"]) != {"literal_opener", "escaped_marker", "iframe_count", "target_title"}
            or record["response"]["status"] != 200
            or record["source_sha256"] != sha256(record["source"])
            or not re.fullmatch(r"[0-9a-f]{64}", record["request"]["body_sha256"])
            or not isinstance(record["request"]["body_bytes"], int)
            or isinstance(record["request"]["body_bytes"], bool)
            or not isinstance(record["request"]["redacted_fields"], list)
            or any(not isinstance(field, str) for field in record["request"]["redacted_fields"])
        ):
            raise RuntimeError("PagePreview report schema is invalid")
        validate_headers(record["request"]["headers"], f"PagePreview request {record['case_id']}")
        validate_headers(record["response"]["headers"], f"PagePreview response {record['case_id']}")
        validate_evidence_file(record["request"]["raw"], f"PagePreview request {record['case_id']}", evidence_dir)
        validate_evidence_file(record["response"]["raw"], f"PagePreview response {record['case_id']}", evidence_dir)


def validate_saved_http_record(record: Any, evidence_dir: Path) -> None:
    if (
        not isinstance(record, dict)
        or set(record) != {"request", "response", "consumer_source_sha256"}
        or not isinstance(record["request"], dict)
        or set(record["request"]) != {"method", "url", "headers", "raw"}
        or not isinstance(record["response"], dict)
        or set(record["response"]) != {"status", "url", "headers", "raw", "body_sha256", "body_bytes"}
    ):
        raise RuntimeError("saved page HTTP record is incomplete")
    validate_headers(record["request"]["headers"], "saved page request")
    validate_headers(record["response"]["headers"], "saved page response")
    validate_evidence_file(record["request"]["raw"], "saved page request", evidence_dir, allow_empty=True)
    validate_evidence_file(record["response"]["raw"], "saved page response", evidence_dir)
    if (
        not isinstance(record["request"]["method"], str)
        or not isinstance(record["request"]["url"], str)
        or not isinstance(record["response"]["status"], int)
        or isinstance(record["response"]["status"], bool)
        or not isinstance(record["response"]["url"], str)
        or record["response"]["status"] != 200
        or not isinstance(record["response"]["body_sha256"], str)
        or not isinstance(record["response"]["body_bytes"], int)
        or isinstance(record["response"]["body_bytes"], bool)
        or record["response"]["body_sha256"] != record["response"]["raw"]["sha256"]
        or record["response"]["body_bytes"] != record["response"]["raw"]["bytes"]
    ):
        raise RuntimeError("saved page HTTP response body identity is invalid")


def capture(args: argparse.Namespace) -> dict[str, Any]:
    run_id = args.run_id
    if re.fullmatch(r"[0-9]{8}-[a-z0-9][a-z0-9-]{0,31}", run_id) is None:
        raise RuntimeError("run ID must be YYYYMMDD-lowercase-label")
    if args.plan.is_absolute() or ".." in args.plan.parts or args.plan != PLAN_RELATIVE_PATH:
        raise RuntimeError("issue 1383 --plan must be the exact committed relative plan path")
    requested_output = args.output
    output = requested_output.absolute()
    validate_output_path(output, run_id)
    if os.path.lexists(requested_output) or os.path.lexists(output):
        raise RuntimeError("receipt path already exists")
    started = time.monotonic()
    usage = {"requests": 0, "request_bytes": 0, "response_bytes": 0, "redirects": 0, "retries": 0, "wall_clock_ms": 0}
    plan_path = (REPO_ROOT / PLAN_RELATIVE_PATH).resolve()
    plan = json.loads(plan_path.read_text(encoding="utf-8"))
    runner_path = Path(__file__).resolve()
    revision, tree, test_sha256, plan_sha256, plan_blob_sha1, budgets, scanner_ready, installed_tree_ready, authority = validate_plan(plan, plan_path, runner_path)
    if not args.preview_only:
        require_complete_scanners(scanner_ready)
    if not args.preview_only and not installed_tree_ready:
        raise RuntimeError("issue 1383 complete receipt is unavailable while the installed browser dependency tree is unavailable")
    validate_node_identity(plan["dependencies"])
    runner_sha256 = sha256_bytes(runner_path.read_bytes())
    dependencies = dependency_identity()
    dependencies["requirements_path"] = str(repo_path(plan["dependencies"]["requirements_path"], "requirements path"))
    dependencies["requirements_sha256"] = plan["dependencies"]["requirements_sha256"]
    dependencies["requirements_lock_path"] = str(repo_path(plan["dependencies"]["requirements_lock_path"], "requirements.lock path"))
    dependencies["requirements_lock_sha256"] = plan["dependencies"]["requirements_lock_sha256"]
    dependencies["cargo_manifest_path"] = str(repo_path(plan["dependencies"]["cargo_manifest_path"], "Cargo.toml path"))
    dependencies["cargo_manifest_sha256"] = plan["dependencies"]["cargo_manifest_sha256"]
    dependencies["cargo_lock_path"] = str(repo_path(plan["dependencies"]["cargo_lock_path"], "Cargo.lock path"))
    dependencies["cargo_lock_sha256"] = plan["dependencies"]["cargo_lock_sha256"]
    dependencies["ftml_revision"] = plan["dependencies"]["ftml_revision"]
    dependencies["ftml_tree"] = plan["dependencies"]["ftml_tree"]
    dependencies["node_executable"] = plan["dependencies"]["node_executable"]
    dependencies["node_executable_sha256"] = plan["dependencies"]["node_executable_sha256"]
    dependencies["node_version"] = plan["dependencies"]["node_version"]
    browser_plan = plan["browser"]
    browser_executable = None
    if not args.preview_only:
        if (
            Path(args.browser_root).is_absolute()
            or ".." in Path(args.browser_root).parts
            or Path(args.browser_root) != EXPECTED_BROWSER_ROOT
            or not args.browser_executable
            or args.browser_executable != browser_plan["executable_path"]
        ):
            raise RuntimeError("issue 1383 browser root or executable is not the committed identity")
        executable_input = Path(args.browser_executable)
        executable_stat = executable_input.lstat()
        browser_executable = executable_input.resolve()
        if not stat.S_ISREG(executable_stat.st_mode) or executable_input.is_symlink() or sha256_bytes(browser_executable.read_bytes()) != browser_plan["executable_sha256"]:
            raise RuntimeError("issue 1383 browser executable does not match the planned identity")
    budget_check(usage, budgets, started)
    target_slug = f"run-owned:issue-1383-{run_id}-target"
    consumer_slug = f"run-owned:issue-1383-{run_id}-consumer"
    target_source = plan["target"]["source"]
    target_title = plan["target"]["title"]
    consumer_title = plan["consumer"]["title"]
    cases = plan["cases"]
    sources = [source_for(case, target_slug) for case in cases]
    consumer_source = "\n\n".join(sources)
    target = page_plan("target", target_slug, target_title, target_source)
    consumer = page_plan("consumer", consumer_slug, consumer_title, consumer_source)
    planned = [target, consumer]
    for item in planned:
        item["source_sha256"] = sha256(item["sources"][0])
    snapshots: dict[str, dict[str, Any]] = {}
    preview = None
    saved_http = None
    browser = None
    cleanup = {"planned_pages": [], "failures": [], "all_absent": False}
    preexisting = None
    status = "failed"
    capture_error = None
    unresolved = []
    mutation_policy = "run-owned pages only"
    if args.preview_only:
        mutation_policy = "none"
        unresolved = preview_only_unresolved_rows(scanner_ready, installed_tree_ready)
        try:
            preview = preview_records(
                cases,
                target_slug,
                target_title,
                output.parent / "page-preview",
                budgets,
                started,
                usage,
                strict=False,
            )
            validate_preview_records(preview, cases, output.parent / "page-preview")
            cleanup = {
                "planned_pages": [],
                "failures": [],
                "all_absent": True,
                "status": "not_applicable",
                "mutation_attempted": False,
            }
            status = "partial"
        except Exception as error:
            capture_error = {"error_type": type(error).__name__}
            cleanup = {
                "planned_pages": [],
                "failures": [],
                "all_absent": True,
                "status": "not_applicable",
                "mutation_attempted": False,
            }
    else:
        import wikidot
        from wikidot.connector.ajax import AjaxModuleConnectorConfig

        username = os.environ.get("WIKIDOT_USERNAME")
        password = os.environ.get("WIKIDOT_PASSWORD")
        if not username or not password:
            raise RuntimeError("WIKIDOT_USERNAME and WIKIDOT_PASSWORD are required")
        config = AjaxModuleConnectorConfig(allow_insecure_session_transport_for=SITE)
        with account_requests(usage, budgets, started):
            with wikidot.Client(username=username, password=password, amc_config=config, logging_level="CRITICAL") as client:
                site = client.site.get(SITE)
                if site.unix_name != SITE or site.domain != DOMAIN:
                    raise RuntimeError("resolved Wikidot site is outside the exact sandbox allowlist")
                preexisting = {item["fullname"]: site.page.get(item["fullname"], raise_when_not_found=False) is None for item in planned}
                if not all(preexisting.values()):
                    raise RuntimeError("run-owned fixture slug already exists")
                try:
                    for item in planned:
                        site.page.create(fullname=item["fullname"], title=item["title"], source=item["sources"][0], comment="run-owned issue 1383 live evidence")
                        snapshot = snapshot_page(site, item)
                        snapshots[item["fullname"]] = snapshot
                    preview = preview_records(cases, target_slug, target_title, output.parent / "page-preview", budgets, started, usage)
                    validate_preview_records(preview, cases, output.parent / "page-preview")
                    saved_http = saved_http_record(consumer_slug, cases, consumer_source, output.parent / "saved-page", budgets, started, usage)
                    validate_saved_http_record(saved_http, output.parent / "saved-page")
                    browser = browser_capture(
                        REPO_ROOT,
                        f"{ORIGIN}/{consumer_slug}",
                        cases,
                        preview,
                        {"root": args.browser_root, "executable": str(browser_executable), "settle_ms": args.settle_ms, "timeout_ms": args.timeout_ms},
                        run_id,
                        output.parent / "browser",
                        budgets,
                        browser_plan,
                        usage,
                        started,
                    )
                    budget_check(usage, budgets, started)
                    status = "complete"
                except Exception as error:
                    capture_error = {"error_type": type(error).__name__}
                finally:
                    cleanup = cleanup_pages(site, planned, snapshots, preexisting)
    if cleanup["failures"]:
        status = "cleanup_failed"
    try:
        budget_check(usage, budgets, started)
    except Exception as error:
        if capture_error is None:
            capture_error = {"error_type": type(error).__name__}
        status = "failed"
    artifact = {
        "schema": ARTIFACT_SCHEMA,
        "issue": plan["issue"],
        "status": status,
        "captured_at_utc": datetime.now(UTC).isoformat(),
        "run_id": run_id,
        "receipt_path": str(output),
        "runner": {"path": str(runner_path), "sha256": runner_sha256},
        "site": {"unix_name": SITE, "domain": DOMAIN, "mutation": mutation_policy},
        "repository": {
            "reviewed_commit": plan["repository"]["reviewed_commit"],
            "reviewed_tree": plan["repository"]["reviewed_tree"],
            "reviewed_plan_blob_sha1": plan["repository"]["reviewed_plan_blob_sha1"],
            "actual_head": revision,
            "actual_tree": tree,
            "clean": True,
        },
        "authority": authority,
        "preflight": {
            "wikijump_head": revision,
            "wikijump_tree": tree,
            "repository": {"reviewed_commit": plan["repository"]["reviewed_commit"], "reviewed_tree": plan["repository"]["reviewed_tree"], "reviewed_plan_blob_sha1": plan["repository"]["reviewed_plan_blob_sha1"], "actual_head": revision, "actual_tree": tree, "clean": True},
            "source_owner": {key: plan["source"][key] for key in ("owner_path", "owner_commit", "owner_tree", "owner_blob_sha1")},
            "ftml": {key: plan["dependencies"][key] for key in ("ftml_revision", "ftml_tree")},
            "requirements": {"path": dependencies["requirements_path"], "sha256": dependencies["requirements_sha256"]},
            "requirements_lock": {"path": dependencies["requirements_lock_path"], "sha256": dependencies["requirements_lock_sha256"]},
            "cargo_manifest": {"path": dependencies["cargo_manifest_path"], "sha256": dependencies["cargo_manifest_sha256"]},
            "cargo_lock": {"path": dependencies["cargo_lock_path"], "sha256": plan["dependencies"]["cargo_lock_sha256"]},
            "node": {"path": dependencies["node_executable"], "sha256": dependencies["node_executable_sha256"], "version": dependencies["node_version"]},
            "browser_dependency_tree": plan["browser"]["installed_dependency_tree"],
            "authority": authority,
            "runner": {"path": str(runner_path), "sha256": runner_sha256},
            "plan": {"path": str(plan_path), "sha256": plan_sha256, "blob_sha1": plan_blob_sha1},
        },
        "source": {"repository_revision": revision, "repository_tree": tree, "owner_path": plan["source"]["owner_path"], "owner_commit": plan["source"]["owner_commit"], "owner_tree": plan["source"]["owner_tree"], "owner_blob_sha1": plan["source"]["owner_blob_sha1"], "public_regression_commit": plan["source"]["public_regression_commit"], "public_regression_tree": plan["source"]["public_regression_tree"], "test_path": plan["source"]["test_path"], "test_sha256": test_sha256, "test_anchor": plan["source"]["test_anchor"], "test_body_sha256": plan["source"]["test_body_sha256"], "denominator_case_ids": [case["case_id"] for case in cases], "denominator_sha256": plan["denominator"]["sha256"]},
        "dependencies": dependencies,
        "browser_dependencies": {
            "root": str((REPO_ROOT / EXPECTED_BROWSER_ROOT).resolve()),
            "package_path": str(repo_path(plan["browser"]["package_path"], "browser package path")),
            "package_sha256": browser_plan["package_sha256"],
            "lock_path": str(repo_path(plan["browser"]["lock_path"], "browser lock path")),
            "lock_sha256": browser_plan["lock_sha256"],
            "executable_path": None if browser_executable is None else str(browser_executable),
            "executable_sha256": browser_plan["executable_sha256"],
            "version": browser_plan["version"],
            "installed_dependency_tree": browser_plan["installed_dependency_tree"],
            "node_executable": dependencies["node_executable"],
            "node_version": dependencies["node_version"],
        },
        "plan": {"path": str(plan_path), "sha256": plan_sha256, "blob_sha1": plan_blob_sha1},
        "historical_artifact": plan["historical_artifact"],
        "budgets": {"limits": budgets, "usage": usage},
        "scanner_checks": plan["scanner_checks"],
        "controls": {"count": len(cases), "ordered_cases": [{"case_id": case["case_id"], "test_label": case["label"], "classification": case["classification"]} for case in cases], "positive_count": 2, "negative_count": 2},
        "target": {"fullname": target_slug, "title": target_title, "source_sha256": sha256(target_source)},
        "preview": preview,
        "saved_page": saved_http,
        "browser": browser,
        "unresolved": unresolved,
        "capture_error": capture_error,
        "cleanup": {**cleanup, "preexisting_slug_absence": preexisting},
        "redactions": ["WIKIDOT_USERNAME", "WIKIDOT_PASSWORD", "cookies", "session identifiers", "CSRF tokens"],
    }
    write_receipt_no_replace(output, artifact)
    if status != "complete" and not (args.preview_only and status == "partial"):
        raise RuntimeError(f"issue 1383 evidence run did not complete: {status}")
    return artifact


def run_static_self_check() -> None:
    class Request:
        method = "POST"
        url = "https://user:secret@sandbox-for-codex.wikidot.com/ajax-module-connector.php?token=secret"
        headers = {"Content-Type": "application/x-www-form-urlencoded", "Cookie": "session=secret"}
        content = b"source=SAFE&wikidot_token7=SECRET"

    persisted, fields = redacted_request_wire_bytes(Request())
    assert b"SECRET" not in persisted
    assert b"SAFE" in persisted
    assert fields == ["wikidot_token7"]
    assert "secret" not in safe_request_url(Request.url)
    assert "page.evaluate(phaseControls, input.cases)" in NODE_BROWSER_CAPTURE
    assert "phaseControlsSource.includes(\"input.cases\")" in NODE_BROWSER_CAPTURE

    def rejected(callback: Any) -> None:
        try:
            callback()
        except RuntimeError:
            return
        raise AssertionError("expected fail-closed rejection")

    cases = [{"case_id": "one"}, {"case_id": "two"}]
    rejected(lambda: repo_path("../outside", "static unsafe path"))
    rejected(lambda: validate_case_records([{"case_id": "one"}, {"case_id": "one"}], cases, "static duplicate"))
    rejected(lambda: validate_case_records([{"case_id": "one"}, {"case_id": "replacement"}], cases, "static replacement"))
    rejected(lambda: validate_scanner_checks([], "0" * 64, ["/tmp/issue1383-scanner"]))
    rejected(lambda: require_complete_scanners(False))


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--plan", type=Path)
    parser.add_argument("--run-id")
    parser.add_argument("--output", type=Path)
    parser.add_argument("--self-check", action="store_true")
    parser.add_argument("--preview-only", action="store_true")
    parser.add_argument("--browser-root", default="framerail")
    parser.add_argument("--browser-executable")
    parser.add_argument("--timeout-ms", type=int, default=120000)
    parser.add_argument("--settle-ms", type=int, default=1000)
    args = parser.parse_args()
    if args.self_check:
        try:
            run_static_self_check()
        except Exception as error:
            print(f"issue 1383 static self-check failed: {type(error).__name__}", file=sys.stderr)
            return 1
        print("issue 1383 static self-check passed")
        return 0
    if args.plan is None or args.run_id is None or args.output is None:
        parser.error("--plan, --run-id, and --output are required unless --self-check is used")
    if args.timeout_ms <= 0 or args.settle_ms < 0:
        parser.error("--timeout-ms must be positive and --settle-ms must be non-negative")
    try:
        artifact = capture(args)
    except Exception as error:
        print(f"issue 1383 live evidence not captured: {type(error).__name__}", file=sys.stderr)
        return 1
    print(json.dumps({"status": artifact["status"], "output": artifact["receipt_path"], "controls": artifact["controls"]["count"], "pages_removed": artifact["cleanup"]["all_absent"]}, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
