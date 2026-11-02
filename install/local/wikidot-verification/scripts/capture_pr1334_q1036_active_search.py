#!/usr/bin/env python3

import argparse
import hashlib
import ipaddress
import json
import os
import socket
import time
from pathlib import Path
from urllib.parse import urljoin, urlparse

import httpx


SCHEMA = "wikijump.pr1334.q1036_active_search_backend_live.v1"
SAFE_HEADERS = ("content-type", "cache-control", "date", "etag", "last-modified")
CHALLENGE_MARKERS = (
    "captcha",
    "cf-chl-",
    "cloudflare ray id",
    "verify you are human",
    "attention required",
)
EXPECTED_INITIAL_HOSTS = frozenset(("scp-wiki.wikidot.com", "www.wikidot.com"))
MAX_BUDGETS = {
    "max_requests": 24,
    "max_pages_per_query": 2,
    "max_rows_per_response": 10,
    "max_rows_per_query": 20,
    "max_response_bytes": 524288,
    "max_aggregate_bytes": 4194304,
    "connect_timeout_seconds": 5,
    "request_deadline_seconds": 15,
    "max_same_origin_redirects": 2,
    "max_idempotent_retries": 1,
    "max_retry_after_seconds": 10,
    "stability_interval_seconds": 10,
    "max_wall_clock_seconds": 180,
}


def sha256(data):
    return hashlib.sha256(data).hexdigest()


def validate_public_url(value, allowed_hosts):
    try:
        parsed = urlparse(value)
        hostname = parsed.hostname
        port = parsed.port
    except (TypeError, ValueError) as error:
        raise ValueError("public URL is malformed") from error
    if parsed.scheme != "https" or hostname not in allowed_hosts or port not in (None, 443) or parsed.username or parsed.password or parsed.query or parsed.fragment:
        raise ValueError("public URL is outside the declared HTTPS host policy")
    try:
        addresses = {ipaddress.ip_address(result[4][0]) for result in socket.getaddrinfo(hostname, 443, type=socket.SOCK_STREAM)}
    except OSError as error:
        raise ValueError("public URL host could not be resolved") from error
    if not addresses or any(not address.is_global for address in addresses):
        raise ValueError("public URL host resolved to a non-public address")
    return value


def validate_budgets(value):
    if not isinstance(value, dict):
        raise ValueError("fixture budgets are not an object")
    for name, maximum in MAX_BUDGETS.items():
        current = value.get(name)
        if isinstance(current, bool) or not isinstance(current, (int, float)) or current < 0 or current > maximum:
            raise ValueError(f"fixture budget {name} exceeds the committed bound")
    return value


def validate_fixture(value):
    if not isinstance(value, dict) or value.get("schema") != SCHEMA:
        raise ValueError("fixture schema is invalid")
    budgets = validate_budgets(value.get("budgets"))
    cases = value.get("canary_cases")
    if not isinstance(cases, list) or not cases:
        raise ValueError("fixture canary cases are invalid")
    for case in cases:
        if not isinstance(case, dict):
            raise ValueError("fixture canary case is invalid")
        validate_public_url(case.get("url"), EXPECTED_INITIAL_HOSTS)
    return value, budgets


def parse_args():
    parser = argparse.ArgumentParser()
    parser.add_argument("--fixture", required=True)
    parser.add_argument("--output", required=True)
    return parser.parse_args()


def bounded_body(response, maximum):
    chunks = []
    size = 0
    for chunk in response.iter_bytes():
        size += len(chunk)
        if size > maximum:
            raise ValueError("response_budget_exceeded")
        chunks.append(chunk)
    return b"".join(chunks)


def fetch(client, url, budgets, deadline):
    validate_public_url(url, EXPECTED_INITIAL_HOSTS)
    redirects = []
    retries = 0
    current = url
    expected_host = urlparse(url).hostname
    while True:
        if time.monotonic() > deadline:
            raise TimeoutError("wall_clock_budget_exceeded")
        with client.stream("GET", current) as response:
            status = response.status_code
            if status in (301, 302, 303, 307, 308):
                location = response.headers.get("location")
                if not location:
                    raise RuntimeError("redirect_without_location")
                target = urljoin(current, location)
                parsed = urlparse(target)
                if parsed.hostname != expected_host:
                    return {
                        "status": status,
                        "body": b"",
                        "headers": {},
                        "redirect_chain": redirects + [target],
                        "terminal_url": current,
                        "forced_reason": "cross_origin_redirect",
                        "retries": retries,
                    }
                validate_public_url(target, {expected_host})
                redirects.append(target)
                if len(redirects) > budgets["max_same_origin_redirects"]:
                    raise RuntimeError("redirect_budget_exceeded")
                current = target
                continue

            if status == 429 or status >= 500:
                if retries < budgets["max_idempotent_retries"]:
                    retry_after = response.headers.get("retry-after", "0")
                    try:
                        delay = int(retry_after)
                    except ValueError:
                        delay = 0
                    if delay <= budgets["max_retry_after_seconds"]:
                        bounded_body(response, budgets["max_response_bytes"])
                        retries += 1
                        if delay:
                            time.sleep(delay)
                        continue

            body = bounded_body(response, budgets["max_response_bytes"])
            return {
                "status": status,
                "body": body,
                "headers": {name: response.headers[name] for name in SAFE_HEADERS if name in response.headers},
                "redirect_chain": redirects,
                "terminal_url": str(response.url),
                "forced_reason": None,
                "retries": retries,
            }


def classify(module, result, known_error):
    if result["forced_reason"]:
        return result["forced_reason"], None
    text = result["body"].decode("utf-8", errors="replace")
    lowered = text.lower()
    if known_error in text:
        return "backend_unavailable", known_error
    if result["status"] in (401, 403, 429) or any(marker in lowered for marker in CHALLENGE_MARKERS):
        return "challenge_or_rate_limit", None
    if result["status"] != 200:
        return "result_contract_not_machine_identifiable", None
    return "result_contract_not_machine_identifiable", None


def main():
    args = parse_args()
    fixture_path = Path(args.fixture)
    output_path = Path(args.output)
    fixture_bytes = fixture_path.read_bytes()
    fixture, budgets = validate_fixture(json.loads(fixture_bytes))
    capture_bytes = Path(__file__).read_bytes()
    started = time.monotonic()
    deadline = started + budgets["max_wall_clock_seconds"]
    attempts = []
    aggregate_bytes = 0
    blocked_reasons = []

    timeout = httpx.Timeout(
        budgets["request_deadline_seconds"],
        connect=budgets["connect_timeout_seconds"],
    )
    with httpx.Client(
        timeout=timeout,
        follow_redirects=False,
        trust_env=False,
        headers={"User-Agent": "wikijump-compatibility-evidence/1.0"},
    ) as client:
        for case in fixture["canary_cases"]:
            if len(attempts) >= budgets["max_requests"]:
                blocked_reasons.append("response_budget_exceeded")
                break
            try:
                result = fetch(client, case["url"], budgets, deadline)
                aggregate_bytes += len(result["body"])
                if aggregate_bytes > budgets["max_aggregate_bytes"]:
                    blocked_reasons.append("response_budget_exceeded")
                    break
                classification, error_fragment = classify(
                    case["module"],
                    result,
                    fixture["known_unavailable_errors"][case["module"]],
                )
                blocked_reasons.append(classification)
                attempts.append(
                    {
                        "case_id": case["case_id"],
                        "module": case["module"],
                        "query_id": case["query_id"],
                        "request_url": case["url"],
                        "terminal_url": result["terminal_url"],
                        "method": "GET",
                        "actor": "anonymous",
                        "http_status": result["status"],
                        "redirect_chain": result["redirect_chain"],
                        "safe_response_headers": result["headers"],
                        "response_bytes": len(result["body"]),
                        "raw_body_sha256": sha256(result["body"]),
                        "classification": classification,
                        "error_fragment": error_fragment,
                        "retries": result["retries"],
                        "result_rows": [],
                    }
                )
            except (httpx.HTTPError, TimeoutError, RuntimeError, ValueError) as error:
                reason = str(error)
                classification = (
                    "response_budget_exceeded"
                    if "budget" in reason or "wall_clock" in reason
                    else "result_contract_not_machine_identifiable"
                )
                blocked_reasons.append(classification)
                attempts.append(
                    {
                        "case_id": case["case_id"],
                        "module": case["module"],
                        "query_id": case["query_id"],
                        "request_url": case["url"],
                        "terminal_url": case["url"],
                        "method": "GET",
                        "actor": "anonymous",
                        "http_status": None,
                        "redirect_chain": [],
                        "safe_response_headers": {},
                        "response_bytes": 0,
                        "raw_body_sha256": sha256(b""),
                        "classification": classification,
                        "error_fragment": None,
                        "retries": 0,
                        "result_rows": [],
                    }
                )

    elapsed = time.monotonic() - started
    artifact = {
        "schema": SCHEMA,
        "base_commit": fixture["base_commit"],
        "feature_ids": fixture["feature_ids"],
        "audit_case_id": fixture["audit_case_id"],
        "fixture_sha256": sha256(fixture_bytes),
        "capture_script_sha256": sha256(capture_bytes),
        "disposition": "blocked",
        "blocked_reasons": sorted(set(blocked_reasons)),
        "stable_authority_gate": "failed",
        "full_matrix_started": False,
        "attempts": attempts,
        "claims": {
            "ranking": "unobserved",
            "counts": "unobserved",
            "pagination": "unobserved",
            "permission_filtering": "unobserved",
        },
        "actor_scope": {
            "site_search": "anonymous_canary_only",
            "search_all": "anonymous_only",
            "private_behavior": "unobserved",
        },
        "budgets": {
            "limit": budgets,
            "actual": {
                "requests": len(attempts),
                "mutations": 0,
                "aggregate_response_bytes": aggregate_bytes,
                "wall_clock_seconds": round(elapsed, 6),
            },
        },
        "local_output_used": False,
        "private_output_retained": False,
        "promotable_rules": [],
        "cleanup": {"status": "not_needed", "mutated": False},
        "remaining_gap": "Successful result rows, ranking, counts, pagination, and permission filtering remain unobserved.",
    }

    serialized = json.dumps(artifact, indent=2, sort_keys=True).encode() + b"\n"
    output_path.parent.mkdir(parents=True, exist_ok=True)
    descriptor = os.open(output_path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o644)
    with os.fdopen(descriptor, "wb") as output:
        output.write(serialized)


if __name__ == "__main__":
    main()
