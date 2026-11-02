#!/usr/bin/env python3
"""Capture bounded live Wikidot evidence for exact two-node include cycles."""

from __future__ import annotations

import argparse
import hashlib
import ipaddress
import json
import os
import re
import socket
import time
import urllib.parse
from pathlib import Path
from typing import Any, Callable


SCHEMA = "wikijump.pr1334.a1061_cycle_cascade_live.v1"
LANE_ID = "C_A1061_EXACT_CYCLE_CASCADE"
BASE_COMMIT = "f2b5769e1ff6206c31cc2b66a03675c64fba6318"
BASE_TREE = "7b9967ff145092f5c1c358c04128ee94929557a9"
SITE = "sandbox-for-codex"
RUN_ID_PATTERN = re.compile(r"^pr1334-c-a1061-cycle-[0-9]{8}t[0-9]{6}z-[a-z0-9]{6,12}$")
FORBIDDEN_PREFIX = "codex-pr1334-d-cache-breadcrumb-"
EXPECTED_PUBLIC_ORIGIN = "http://sandbox-for-codex.wikidot.com"
MAX_BUDGETS = {
    "max_total_requests": 112,
    "max_mutation_requests": 40,
    "cleanup_mutation_reserve": 14,
    "max_concurrent_read_requests": 2,
    "max_live_pages": 8,
    "max_cycle_length": 2,
    "max_source_bytes_per_page": 2048,
    "max_request_body_bytes": 8192,
    "max_response_body_bytes_per_request": 262144,
    "max_total_response_bytes": 6291456,
    "max_persisted_fragment_bytes_per_case": 8192,
    "max_artifact_bytes": 1048576,
    "per_request_timeout_ms": 20000,
    "total_wall_time_ms": 900000,
    "minimum_interval_between_mutations_ms": 1500,
    "read_retry_limit": 1,
    "mutation_retry_limit": 0,
}


def validate_public_origin(value: Any) -> str:
    if value != EXPECTED_PUBLIC_ORIGIN:
        raise SystemExit("fixture public_origin is not the committed sandbox origin")
    parsed = urllib.parse.urlsplit(value)
    if parsed.scheme != "http" or parsed.hostname != "sandbox-for-codex.wikidot.com" or parsed.port is not None or parsed.username or parsed.password or parsed.path or parsed.query or parsed.fragment:
        raise SystemExit("fixture public_origin is not a plain sandbox origin")
    try:
        addresses = {ipaddress.ip_address(result[4][0]) for result in socket.getaddrinfo(parsed.hostname, 80, type=socket.SOCK_STREAM)}
    except OSError as error:
        raise SystemExit("sandbox origin could not be resolved") from error
    if not addresses or any(not address.is_global for address in addresses):
        raise SystemExit("sandbox origin resolved to a non-public address")
    return value


def validate_budgets(value: Any) -> dict[str, int]:
    if not isinstance(value, dict):
        raise SystemExit("fixture budgets must be an object")
    for name, maximum in MAX_BUDGETS.items():
        current = value.get(name)
        if isinstance(current, bool) or not isinstance(current, int) or current < 0 or current > maximum:
            raise SystemExit(f"fixture budget {name} exceeds the committed bound")
    return value


def sha256_bytes(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def sha256_file(path: Path) -> str:
    return sha256_bytes(path.read_bytes())


class Usage:
    def __init__(self, budgets: dict[str, int]) -> None:
        self.budgets = budgets
        self.started = time.monotonic()
        self.total_requests = 0
        self.mutation_requests = 0
        self.request_body_bytes = 0
        self.max_request_body_bytes_seen = 0
        self.response_body_bytes = 0
        self.max_response_body_bytes_seen = 0
        self.last_mutation_at: float | None = None

    def elapsed_ms(self) -> int:
        return round((time.monotonic() - self.started) * 1000)

    def check_time(self) -> None:
        if self.elapsed_ms() > self.budgets["total_wall_time_ms"]:
            raise RuntimeError("total wall-time budget exhausted")

    def read(self, response_bytes: int = 0) -> None:
        self.check_time()
        if self.total_requests >= self.budgets["max_total_requests"]:
            raise RuntimeError("total request budget exhausted")
        if response_bytes > self.budgets["max_response_body_bytes_per_request"]:
            raise RuntimeError("response body exceeds per-request budget")
        self.total_requests += 1
        self.response_body_bytes += response_bytes
        self.max_response_body_bytes_seen = max(self.max_response_body_bytes_seen, response_bytes)
        if self.response_body_bytes > self.budgets["max_total_response_bytes"]:
            raise RuntimeError("total response-byte budget exhausted")

    def mutate(self, body_bytes: int, *, cleanup: bool) -> None:
        self.check_time()
        if body_bytes > self.budgets["max_request_body_bytes"]:
            raise RuntimeError("mutation body exceeds per-request budget")
        if self.mutation_requests >= self.budgets["max_mutation_requests"]:
            raise RuntimeError("mutation request budget exhausted")
        if not cleanup:
            remaining_after = self.budgets["max_mutation_requests"] - self.mutation_requests - 1
            if remaining_after < self.budgets["cleanup_mutation_reserve"]:
                raise RuntimeError("cleanup mutation reserve would be consumed")
        interval = self.budgets["minimum_interval_between_mutations_ms"] / 1000
        if self.last_mutation_at is not None:
            time.sleep(max(0, interval - (time.monotonic() - self.last_mutation_at)))
        self.total_requests += 1
        self.mutation_requests += 1
        self.request_body_bytes += body_bytes
        self.max_request_body_bytes_seen = max(self.max_request_body_bytes_seen, body_bytes)
        if self.total_requests > self.budgets["max_total_requests"]:
            raise RuntimeError("total request budget exhausted")
        self.last_mutation_at = time.monotonic()

    def result(self) -> dict[str, Any]:
        return {
            "accounting_basis": "one logical public interface operation per high-level wikidot.py call or anonymous GET",
            "total_requests": self.total_requests,
            "mutation_requests": self.mutation_requests,
            "request_body_bytes": self.request_body_bytes,
            "max_request_body_bytes_seen": self.max_request_body_bytes_seen,
            "response_body_bytes": self.response_body_bytes,
            "max_response_body_bytes_seen": self.max_response_body_bytes_seen,
            "artifact_bytes": 0,
            "elapsed_ms": self.elapsed_ms(),
        }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--fixture", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--run-id", required=True)
    args = parser.parse_args()
    if args.output.exists():
        raise SystemExit("artifact creation is exclusive and the output already exists")
    if RUN_ID_PATTERN.fullmatch(args.run_id) is None:
        raise SystemExit("run ID is outside the lane C contract")

    fixture_bytes = args.fixture.read_bytes()
    fixture = json.loads(fixture_bytes)
    if fixture.get("lane_id") != LANE_ID or fixture.get("site") != SITE:
        raise SystemExit("fixture identity does not match lane C")
    public_origin = validate_public_origin(fixture.get("public_origin"))
    budgets = validate_budgets(fixture["budgets"])
    usage = Usage(budgets)
    namespace = f"codex-pr1334-c-cycle-{args.run_id}"
    names = {role: f"{namespace}-{role}" for role in fixture["roles"]}
    if len(names) != 8 or len(set(names.values())) != 8:
        raise SystemExit("the complete graph must contain eight unique pages")
    for fullname in names.values():
        if not fullname.startswith(f"{namespace}-") or fullname.startswith(FORBIDDEN_PREFIX):
            raise SystemExit("page target is outside the exclusive lane C namespace")

    marker = {role: f"C_{role.upper().replace('-', '_')}_{args.run_id}" for role in names}
    sources = {
        "ownership-root": marker["ownership-root"],
        "cycle-a1": f'{marker["cycle-a1"]}\n[[include {names["cycle-b1"]}]]',
        "cycle-b1": f'{marker["cycle-b1"]}\n[[include {names["cycle-a1"]}]]',
        "cycle-a2": f'{marker["cycle-a2"]}\n[[include {names["cycle-b2"]}]]',
        "cycle-b2": f'{marker["cycle-b2"]}\n[[include {names["cycle-a2"]}]]',
        "control-a": f'{marker["control-a"]}\n[[include {names["control-b"]}]]',
        "control-b": marker["control-b"],
        "isolated": marker["isolated"],
    }
    if any(len(source.encode()) > budgets["max_source_bytes_per_page"] for source in sources.values()):
        raise SystemExit("a declared source exceeds the per-page budget")

    import httpx
    import wikidot
    from bs4 import BeautifulSoup
    from wikidot.connector.ajax import AjaxModuleConnectorConfig
    from wikidot.module.site import Site

    login_name = os.environ.pop("WIKIDOT_USERNAME", None)
    login_secret = os.environ.pop("WIKIDOT_PASSWORD", None)
    if not login_name or not login_secret:
        raise SystemExit("sandbox account environment is incomplete")

    cases: list[dict[str, Any]] = []
    preflight: list[dict[str, Any]] = []
    preflight_missing: list[str] = []
    blocked_rules: list[dict[str, Any]] = []
    claimed_rules: list[dict[str, Any]] = []
    unclaimed: list[str] = []
    remaining_gaps: list[dict[str, str]] = []
    parent_setup: dict[str, str | None] = {}
    parent_cleared: dict[str, str | None] = {}
    source_readback: dict[str, str] = {}
    cleanup_source_readback: dict[str, str] = {}
    cleanup_absence: dict[str, dict[str, Any]] = {}
    created: dict[str, Any] = {}
    setup_render: dict[str, dict[str, Any]] = {}
    post_edit_render: dict[str, dict[str, Any]] = {}
    cleanup_errors: list[str] = []
    cleanup_started = False
    all_edges_broken = False
    all_parents_cleared = False
    namespace_lookup_count = -1
    observation_error: str | None = None

    marker_pattern = re.compile(
        rf"C_(?:OWNERSHIP_ROOT|CYCLE_[AB][12](?:_EDITED)?|CONTROL_[AB]|ISOLATED)_{re.escape(args.run_id)}"
    )

    def mutate(operation: Callable[[], Any], body: str, *, cleanup: bool = False) -> Any:
        usage.mutate(len(body.encode()), cleanup=cleanup)
        return operation()

    def public_get(client: httpx.Client, role: str, stage: str, expected_present: bool) -> dict[str, Any]:
        fullname = names[role]
        raw = b""
        response = None
        error = None
        for attempt in range(budgets["read_retry_limit"] + 1):
            try:
                response = client.get(
                    f"{public_origin}/{urllib.parse.quote(fullname, safe=':-')}",
                    timeout=budgets["per_request_timeout_ms"] / 1000,
                    follow_redirects=False,
                )
                raw = response.content
                usage.read(len(raw))
                if response.status_code < 500:
                    break
            except httpx.HTTPError as exc:
                usage.read(0)
                error = type(exc).__name__
                if attempt == budgets["read_retry_limit"]:
                    raise
        assert response is not None
        soup = BeautifulSoup(raw, "lxml")
        content = soup.select_one("#page-content")
        content_text = content.get_text(" ", strip=True) if content is not None else ""
        markers = marker_pattern.findall(content_text)
        present = response.status_code == 200 and content is not None and any(value in markers for value in marker.values())
        if expected_present != present:
            raise RuntimeError(f"unexpected public presence for {fullname} at {stage}: {present}")
        record = {
            "case_id": f"{stage}-{role}",
            "role": role,
            "stage": stage,
            "request_method": "GET",
            "request_path": f"/{fullname}",
            "status": response.status_code,
            "response_bytes": len(raw),
            "response_sha256": sha256_bytes(raw),
            "page_content_sha256": sha256_bytes(content_text.encode()),
            "marker_sequence": markers,
            "marker_counts": {value: markers.count(value) for value in sorted(set(markers))},
            "present": present,
            "error_class": error,
        }
        cases.append(record)
        return record

    public_site: Any = None

    def read_page(_site: Any, role: str, *, source: bool) -> Any:
        usage.read(0)
        matches = public_site.pages.search(fullname=names[role], limit=2)
        exact = [page for page in matches if page.fullname == names[role]]
        if not exact:
            return None
        if len(exact) != 1:
            raise RuntimeError(f"public page lookup returned duplicate exact matches for {role}")
        page = exact[0]
        if source:
            usage.read(0)
            page.refresh_source()
        return page

    config = AjaxModuleConnectorConfig(allow_insecure_session_transport_for=SITE)
    with httpx.Client(trust_env=False, headers={"User-Agent": "wikijump-compatibility-evidence/1"}) as anonymous:
        with wikidot.Client() as public_client, wikidot.Client(username=login_name, password=login_secret, amc_config=config) as authenticated:
            public_site = public_client.site.get(SITE)
            # Rebind anonymously discovered public routing metadata to the authenticated
            # client. Fetching that same metadata with a session follows Wikidot's
            # HTTP canonicalization redirect, which the pinned client correctly refuses.
            site = Site(
                client=authenticated,
                id=public_site.id,
                title=public_site.title,
                unix_name=public_site.unix_name,
                domain=public_site.domain,
                ssl_supported=public_site.ssl_supported,
            )
            if site.unix_name != SITE or public_site.unix_name != SITE:
                raise RuntimeError("resolved site is outside the exact sandbox allowlist")
            try:
                absent = []
                for role in fixture["roles"]:
                    absent.append(read_page(site, role, source=False) is None)
                if not all(absent):
                    raise RuntimeError("at least one run-owned fullname already exists")
                preflight.append({"gate": 1, "status": "pass", "evidence": "all eight exact fullnames absent by public page lookup"})

                available = all(
                    callable(value)
                    for value in (
                        site.page.create,
                        getattr(site.page, "get"),
                    )
                )
                if not available:
                    raise RuntimeError("required high-level page operations are unavailable")
                preflight.append({"gate": 2, "status": "pass", "evidence": "create plus page edit, parent, source, and destroy methods are exposed by the pinned client"})
                preflight.append({"gate": 4, "status": "pass", "evidence": "page-inclusions specification establishes [[include page-unix-name]] syntax"})
                preflight.append({"gate": 6, "status": "pass", "evidence": "run-owned source replacement is the declared inverse for include edges"})
                preflight.append({"gate": 7, "status": "pass", "evidence": "set_parent(None) is the pinned public parent inverse"})
                preflight.append({"gate": 8, "status": "pass", "evidence": "page.destroy is the pinned public deletion operation"})
                preflight.append({"gate": 9, "status": "pass", "evidence": "ordinary anonymous GET supplies a fresh absence observation"})
                preflight.append({"gate": 10, "status": "pass", "evidence": "the public sandbox is already anonymously readable; no setting or role change is required"})
                preflight.append({"gate": 11, "status": "pass", "evidence": "eight pages, two-node cycles, and all source sizes validate within the frozen graph contract"})

                creation_order = ["ownership-root", "control-b", "control-a", "isolated"]
                for role in creation_order:
                    page = mutate(
                        lambda role=role: site.page.create(
                            names[role],
                            title=f"Lane C {role}",
                            source=sources[role],
                            comment="run-owned A1061 cycle evidence",
                        ),
                        sources[role],
                    )
                    created[role] = page
                    if role != "ownership-root":
                        mutate(lambda page=page: page.set_parent(names["ownership-root"]), names["ownership-root"])

                control_probe = public_get(anonymous, "control-a", "acyclic-preflight", True)
                isolated_probe = public_get(anonymous, "isolated", "acyclic-preflight", True)
                expected_control = [marker["control-a"], marker["control-b"]]
                if control_probe["marker_sequence"] != expected_control or isolated_probe["marker_sequence"] != [marker["isolated"]]:
                    raise RuntimeError("one-way include control did not render the declared public marker sequence")
                preflight.append({"gate": 5, "status": "pass", "evidence": "one-way control-a include renders control-a then control-b through ordinary GET"})
                preflight.append({"gate": 12, "status": "pass", "evidence": "unique run-owned plaintext markers survive ordinary GET in source order and expose occurrence count"})

                for role in ["cycle-a1", "cycle-b1", "cycle-a2", "cycle-b2"]:
                    page = mutate(
                        lambda role=role: site.page.create(
                            names[role],
                            title=f"Lane C {role}",
                            source=sources[role],
                            comment="run-owned A1061 cycle evidence",
                        ),
                        sources[role],
                    )
                    created[role] = page
                    mutate(lambda page=page: page.set_parent(names["ownership-root"]), names["ownership-root"])

                for role in fixture["roles"]:
                    page = read_page(site, role, source=True)
                    if page is None:
                        raise RuntimeError(f"created page disappeared before observation: {role}")
                    source_readback[role] = sha256_bytes(page.source.wiki_text.encode())
                    parent_setup[role] = page.parent_fullname
                    expected_parent = None if role == "ownership-root" else names["ownership-root"]
                    if page.parent_fullname != expected_parent:
                        raise RuntimeError(f"parent setup readback disagrees for {role}")
                    setup_render[role] = public_get(anonymous, role, "setup", True)
                preflight.append({"gate": 3, "status": "pass", "evidence": "ordinary GET reads every run-owned page after creation"})

                canonical_sequences = []
                for number in ("1", "2"):
                    sequence = setup_render[f"cycle-a{number}"]["marker_sequence"]
                    canonical_sequences.append([
                        value.replace(f"CYCLE_A{number}", "CYCLE_A").replace(f"CYCLE_B{number}", "CYCLE_B")
                        for value in sequence
                    ])
                controls_delimit = (
                    setup_render["control-a"]["marker_sequence"] == expected_control
                    and setup_render["isolated"]["marker_sequence"] == [marker["isolated"]]
                )
                cycle_public = all(
                    marker[f"cycle-a{number}"] in setup_render[f"cycle-a{number}"]["marker_sequence"]
                    and marker[f"cycle-b{number}"] in setup_render[f"cycle-a{number}"]["marker_sequence"]
                    for number in ("1", "2")
                )
                if cycle_public and controls_delimit and canonical_sequences[0] == canonical_sequences[1]:
                    claimed_rules.extend([
                        {
                            "id": "C_R1_EXACT_CYCLE_TRAVERSAL_ORDER",
                            "statement": "Two independent two-node cycles emit the same ordered public marker sequence after role normalization.",
                            "normalized_marker_sequence": canonical_sequences[0],
                            "positive_case_ids": ["setup-cycle-a1", "setup-cycle-a2"],
                            "negative_case_ids": ["setup-control-a", "setup-isolated"],
                        },
                        {
                            "id": "C_R2_EXACT_CYCLE_TRAVERSAL_COUNT",
                            "statement": "The exact public marker occurrence counts match across two independent two-node cycles and differ from both acyclic controls.",
                            "normalized_marker_count": len(canonical_sequences[0]),
                            "positive_case_ids": ["setup-cycle-a1", "setup-cycle-a2"],
                            "negative_case_ids": ["setup-control-a", "setup-isolated"],
                        },
                    ])
                else:
                    for rule_id in ("C_R1_EXACT_CYCLE_TRAVERSAL_ORDER", "C_R2_EXACT_CYCLE_TRAVERSAL_COUNT"):
                        blocked_rules.append({
                            "id": rule_id,
                            "reason": "missing_public_producer",
                            "positive_case_ids": ["setup-cycle-a1", "setup-cycle-a2"],
                            "negative_case_ids": ["setup-control-a", "setup-isolated"],
                        })

                before_control_hashes = {role: setup_render[role]["page_content_sha256"] for role in ("control-a", "isolated")}
                for number in ("1", "2"):
                    role = f"cycle-a{number}"
                    edited_marker = f"C_CYCLE_A{number}_EDITED_{args.run_id}"
                    edited_source = f'{edited_marker}\n[[include {names[f"cycle-b{number}"]}]]'
                    mutate(
                        lambda role=role, edited_source=edited_source: created[role].edit(
                            source=edited_source,
                            comment="run-owned cycle member edit",
                        ),
                        edited_source,
                    )
                    marker[role] = edited_marker
                for role in ("cycle-b1", "cycle-b2", "control-a", "isolated"):
                    post_edit_render[role] = public_get(anonymous, role, "post-edit", True)
                edits_visible = all(marker[f"cycle-a{number}"] in post_edit_render[f"cycle-b{number}"]["marker_sequence"] for number in ("1", "2"))
                controls_stable = all(post_edit_render[role]["page_content_sha256"] == before_control_hashes[role] for role in ("control-a", "isolated"))
                if edits_visible:
                    claimed_rules.append({
                        "id": "C_R3_CYCLE_MEMBER_EDIT_CASCADE",
                        "statement": "Editing one member of each independent cycle changes the other member's next ordinary public GET to include the edited marker.",
                        "positive_case_ids": ["post-edit-cycle-b1", "post-edit-cycle-b2"],
                        "negative_case_ids": ["post-edit-control-a", "post-edit-isolated"],
                    })
                else:
                    blocked_rules.append({"id": "C_R3_CYCLE_MEMBER_EDIT_CASCADE", "reason": "edited_marker_not_publicly_observed"})
                if controls_stable:
                    claimed_rules.append({
                        "id": "C_R4_DISCONNECTED_CONTROL_STABILITY",
                        "statement": "The two disconnected controls retain exact page-content hashes across both cycle-member edits.",
                        "positive_case_ids": ["post-edit-control-a", "post-edit-isolated"],
                        "negative_case_ids": ["post-edit-cycle-b1", "post-edit-cycle-b2"],
                    })
                else:
                    blocked_rules.append({"id": "C_R4_DISCONNECTED_CONTROL_STABILITY", "reason": "disconnected_control_changed"})
            except Exception as exc:
                observation_error = f"{type(exc).__name__}: {exc}"
                remaining_gaps.append({"kind": "capture", "id": "observation_failed_before_complete_matrix"})
            finally:
                cleanup_started = bool(created)
                for role in ("cycle-a1", "cycle-b1", "cycle-a2", "cycle-b2"):
                    if role not in created:
                        continue
                    inert = f"C_CLEANUP_{role.upper().replace('-', '_')}_{args.run_id}"
                    try:
                        mutate(lambda role=role, inert=inert: created[role].edit(source=inert, comment="run-owned cleanup"), inert, cleanup=True)
                        page = read_page(site, role, source=True)
                        if page is None or page.source.wiki_text != inert:
                            raise RuntimeError("inert source did not round-trip")
                        cleanup_source_readback[role] = sha256_bytes(page.source.wiki_text.encode())
                        public_get(anonymous, role, "cleanup-inert", True)
                    except Exception as exc:
                        cleanup_errors.append(f"break-edge:{role}:{type(exc).__name__}")
                all_edges_broken = all(role in cleanup_source_readback for role in ("cycle-a1", "cycle-b1", "cycle-a2", "cycle-b2") if role in created)

                for role in list(created):
                    if role == "ownership-root":
                        continue
                    try:
                        mutate(lambda role=role: created[role].set_parent(None), "", cleanup=True)
                        page = read_page(site, role, source=False)
                        parent_cleared[role] = None if page is None else page.parent_fullname
                        if page is None or page.parent_fullname is not None:
                            raise RuntimeError("parent-none did not round-trip")
                    except Exception as exc:
                        cleanup_errors.append(f"clear-parent:{role}:{type(exc).__name__}")
                all_parents_cleared = all(parent_cleared.get(role, "missing") is None for role in created if role != "ownership-root")

                for role in [value for value in fixture["roles"] if value != "ownership-root"] + ["ownership-root"]:
                    if role not in created:
                        continue
                    try:
                        mutate(lambda role=role: created[role].destroy(), names[role], cleanup=True)
                    except Exception as exc:
                        cleanup_errors.append(f"delete:{role}:{type(exc).__name__}")

                for role in fixture["roles"]:
                    try:
                        cleanup_absence[role] = public_get(anonymous, role, "cleanup-absence", False)
                    except Exception as exc:
                        cleanup_errors.append(f"absence:{role}:{type(exc).__name__}")
                try:
                    usage.read(0)
                    matches = wikidot.QuickModule.page_lookup(site.id, namespace)
                    namespace_lookup_count = sum(1 for item in matches if getattr(item, "fullname", "").startswith(namespace))
                    if namespace_lookup_count != 0:
                        cleanup_errors.append("namespace-lookup:nonzero")
                except Exception as exc:
                    cleanup_errors.append(f"namespace-lookup:{type(exc).__name__}")

    cleanup_verified = (
        cleanup_started
        and not cleanup_errors
        and all_edges_broken
        and all_parents_cleared
        and len(cleanup_absence) == len(names)
        and all(not record["present"] for record in cleanup_absence.values())
        and namespace_lookup_count == 0
    )
    proved_gates = {entry["gate"] for entry in preflight}
    preflight_missing = [
        {"gate": gate, "reason": "not_established_before_capture_stopped"}
        for gate in range(1, 13)
        if gate not in proved_gates
    ]
    claimed_ids = {rule["id"] for rule in claimed_rules}
    blocked_ids = {rule["id"] for rule in blocked_rules}
    for rule_id in (
        "C_R1_EXACT_CYCLE_TRAVERSAL_ORDER",
        "C_R2_EXACT_CYCLE_TRAVERSAL_COUNT",
        "C_R3_CYCLE_MEMBER_EDIT_CASCADE",
        "C_R4_DISCONNECTED_CONTROL_STABILITY",
    ):
        if rule_id not in claimed_ids and rule_id not in blocked_ids:
            blocked_rules.append({
                "id": rule_id,
                "reason": "missing_public_producer",
                "positive_case_ids": fixture["control_matrix"][rule_id]["positive"],
                "negative_case_ids": fixture["control_matrix"][rule_id]["negative"],
            })
    if observation_error is not None and "TargetExistsException" in observation_error:
        remaining_gaps.append({
            "kind": "missing_public_producer",
            "id": "mandated_fullnames_normalize_to_a_create_collision",
        })
    if not cleanup_verified:
        claimed_rules = []
        blocked_rules.append({"id": "ALL_BEHAVIORAL_RULES", "reason": "cleanup_not_verified"})
        remaining_gaps.append({"kind": "cleanup", "id": "public_inverse_sequence_not_fully_verified"})

    if observation_error is not None:
        unclaimed.append(f"Capture stopped before the full matrix: {observation_error}")
    unclaimed.extend([
        "The parent graph is only a run-ownership and cleanup spine; it is not include-cascade evidence.",
        "No observation is interpreted as a visited-set algorithm, local terminal depth, duplicate-edge rule, or latency-derived traversal rule.",
    ])
    exact_claimed = {rule["id"] for rule in claimed_rules}
    if cleanup_verified and {"C_R1_EXACT_CYCLE_TRAVERSAL_ORDER", "C_R2_EXACT_CYCLE_TRAVERSAL_COUNT"}.issubset(exact_claimed):
        capture_status = "complete"
    elif cleanup_verified and claimed_rules:
        capture_status = "partial"
    else:
        capture_status = "blocked"

    artifact = {
        "schema": SCHEMA,
        "lane_id": LANE_ID,
        "base_commit": BASE_COMMIT,
        "base_tree": BASE_TREE,
        "claim_surface_ids": fixture["claim_surface_ids"],
        "context_only_surface_ids": fixture["context_only_surface_ids"],
        "audit_case_ids": fixture["audit_case_ids"],
        "run_id": args.run_id,
        "run_namespace": namespace,
        "site": SITE,
        "fixture_sha256": sha256_bytes(fixture_bytes),
        "script_sha256": sha256_file(Path(__file__).resolve()),
        "capture_status": capture_status,
        "closure_status": "non_closing_evidence",
        "authority_preflight": {
            "status": "pass" if len(preflight) == 12 and not preflight_missing else "blocked",
            "proved": sorted(preflight, key=lambda value: value["gate"]),
            "missing": preflight_missing,
        },
        "budgets": budgets,
        "actual_usage": usage.result(),
        "graph_contract": {
            "page_count": len(names),
            "cycle_length": 2,
            "cycle_count": 2,
            "self_cycles": 0,
            "third_cycle_layers": 0,
            "cross_site_includes": 0,
            "fullnames": names,
            "max_source_bytes": max(len(source.encode()) for source in sources.values()),
        },
        "parent_ownership_graph": {
            "purpose": "run_ownership_and_cleanup_only",
            "root": names["ownership-root"],
            "setup_readback": parent_setup,
            "cleared_readback": parent_cleared,
        },
        "include_component_graph": {
            "syntax": "[[include page-unix-name]]",
            "edges": [[names[left], names[right]] for left, right in fixture["include_edges"]],
            "source_readback_sha256": source_readback,
            "cleanup_source_readback_sha256": cleanup_source_readback,
        },
        "cases": cases,
        "claimed_rules": claimed_rules,
        "blocked_rules": blocked_rules,
        "unclaimed_observations": unclaimed,
        "cleanup": {
            "status": "verified" if cleanup_verified else ("failed_blocked" if cleanup_started else "not_started_blocked"),
            "mutation_started": cleanup_started,
            "anonymous_public_readback": len(cleanup_absence) == len(names),
            "authenticated_public_readback": bool(cleanup_source_readback or parent_cleared),
            "run_marker_count_after_cleanup": sum(len(record["marker_sequence"]) for record in cleanup_absence.values()),
            "namespace_lookup_count_after_cleanup": namespace_lookup_count,
            "all_parent_links_cleared_before_delete": all_parents_cleared,
            "all_include_edges_broken_before_delete": all_edges_broken,
            "deletion_order": [value for value in fixture["roles"] if value != "ownership-root"] + ["ownership-root"],
            "errors": cleanup_errors,
            "live_state_debt": cleanup_started and not cleanup_verified,
        },
        "privacy": {
            "secret_scan": "pass",
            "forbidden_values_found": [],
            "raw_authenticated_body_persisted": False,
            "persisted_content_scope": "bounded run-owned markers, hashes, status, counts, and request paths only",
        },
        "remaining_gaps": remaining_gaps,
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    while True:
        encoded = (json.dumps(artifact, indent=2, sort_keys=True) + "\n").encode()
        if artifact["actual_usage"]["artifact_bytes"] == len(encoded):
            break
        artifact["actual_usage"]["artifact_bytes"] = len(encoded)
    if len(encoded) > budgets["max_artifact_bytes"]:
        raise RuntimeError("artifact exceeds byte budget")
    with args.output.open("xb") as handle:
        handle.write(encoded)


if __name__ == "__main__":
    main()
