#!/usr/bin/env python3
"""Resolve the Wikidot users a mirror refers to, and record them as observed identities.

A mirrored page that says `[[user Name]]` renders on Wikidot with the user's link and avatar. The
mirror can only do the same when it knows that user's Wikidot id, name and slug. Without them the
page prints `Name does not match any existing user name` (issues

Three steps, each restartable:

  collect   scan the shared corpus for `[[user X]]` / `[[*user X]]` and write the distinct names.
  acquire   resolve names in batches through Wikidot's anonymous, non-mutating
            `edit/PagePreviewModule`; every batch response is sealed (barrier first, then a
            create-only record), so an interrupted run blocks silent retries.
  apply     parse the sealed batches and insert `known_user` plus `wikidot_identity_observation`
            rows (`ON CONFLICT DO NOTHING`, one transaction). Without `--apply` it only reports.

Observations are sparse on purpose (id, name, slug): `wikidot_display_user` and the Wikidot
layout read nothing else from them. Names Wikidot itself does not resolve stay unresolved, exactly
as on Wikidot.
"""

from __future__ import annotations

import argparse
import hashlib
import html
import importlib.util
import json
import os
import re
import subprocess
import sys
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

SCHEMA = "wikijump_local_lab.wikidot_identity_batch.v1"
FIRST_WIKIJUMP_USER_ID = 20_000_000
USER_MENTION = re.compile(r"\[\[\*?user\s+([^\]\n]+?)\]\]", re.IGNORECASE)
PRINTUSER = re.compile(
    r'<span class="printuser[^"]*">\s*<a href="[^"]*/user:info/(?P<slug>[^"]+)"\s+'
    r'onclick="WIKIDOT\.page\.listeners\.userInfo\((?P<id>\d+)\);[^"]*">(?P<name>[^<]+)</a>\s*</span>'
)
DELETED = re.compile(r'<span class="printuser deleted" data-id="(?P<id>\d+)">.*?\(account deleted\).*?</span>')
UNRESOLVED = re.compile(r'<span class="error-inline"><em>(?P<name>.*?)</em> does not match any existing user name</span>')


def sha256_hex(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def collect_names(corpus_root: Path, branch: str) -> list[str]:
    """Distinct user names in source order of first appearance, most-referenced first."""
    counts: dict[str, int] = {}
    first_seen: dict[str, str] = {}
    pages = corpus_root / branch / "pages"
    for page in sorted(pages.iterdir()):
        source = page / "source.wikidot.txt"
        if not source.is_file():
            continue
        text = source.read_text(encoding="utf-8", errors="replace")
        for raw in USER_MENTION.findall(text):
            name = " ".join(raw.split())
            if not name or "|" in name or name.startswith("%%"):
                continue
            key = name.lower()
            counts[key] = counts.get(key, 0) + 1
            first_seen.setdefault(key, name)
    return [first_seen[key] for key in sorted(counts, key=lambda key: (-counts[key], key))]


def preview_source(names: list[str]) -> str:
    return "\n".join(f"[[user {name}]]" for name in names)


def parse_batch(names: list[str], body: str) -> list[dict[str, Any]]:
    """One result per requested name, in order. Raises when the response does not line up."""
    inner = re.sub(r"^\s*<p>|</p>\s*$", "", body.strip())
    lines = [line.strip() for line in re.split(r"<br\s*/?>", inner)]
    if len(lines) != len(names):
        raise ValueError(f"batch returned {len(lines)} lines for {len(names)} names")
    results = []
    for name, line in zip(names, lines):
        resolved = PRINTUSER.fullmatch(line)
        if resolved:
            results.append({
                "requested": name,
                "status": "resolved",
                "user_id": int(resolved["id"]),
                "slug": html.unescape(resolved["slug"]),
                "name": html.unescape(resolved["name"]),
            })
        elif DELETED.fullmatch(line):
            results.append({"requested": name, "status": "deleted", "user_id": int(DELETED.fullmatch(line)["id"])})
        elif UNRESOLVED.fullmatch(line):
            results.append({"requested": name, "status": "unresolved"})
        elif line and "<" not in line:
            results.append({"requested": name, "status": "special"})
        else:
            raise ValueError(f"unrecognized result for {name!r}: {line[:160]!r}")
    return results


def seal(path: Path, value: Any) -> None:
    with path.open("x", encoding="utf-8") as handle:
        json.dump(value, handle, ensure_ascii=False)
        handle.write("\n")
        handle.flush()
        os.fsync(handle.fileno())


def load_capture_module() -> Any:
    path = Path(__file__).with_name("capture_wikidot_preview_references.py")
    spec = importlib.util.spec_from_file_location("capture_wikidot_preview_references", path)
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module


def acquire(names: list[str], out_dir: Path, batch_size: int, site_name: str) -> int:
    capture = load_capture_module()
    out_dir.mkdir(parents=True, exist_ok=True)
    batches = [names[start:start + batch_size] for start in range(0, len(names), batch_size)]
    pending = []
    for index, batch in enumerate(batches, start=1):
        sealed, barrier = out_dir / f"batch-{index:04d}.json", out_dir / f"batch-{index:04d}.acquiring"
        if sealed.exists():
            continue
        if barrier.exists():
            raise RuntimeError(f"unsealed prior acquisition: {barrier.name}; inspect it before retrying")
        pending.append((index, batch))
    if not pending:
        print(f"all {len(batches)} batches sealed")
        return 0

    import wikidot
    from wikidot.connector.ajax import AjaxModuleConnectorConfig

    with wikidot.Client(amc_config=AjaxModuleConnectorConfig(attempt_limit=1)) as client:
        site = client.site.get(site_name)
        for index, batch in pending:
            source = preview_source(batch)
            case = capture.validate_case({
                "schema": capture.CASE_SCHEMA, "case_id": f"identity-batch-{index:04d}", "source": source,
                "title": "Identity batch", "wikidot_observation_tier": "page-preview", "local_execution_tier": "ftml",
            })
            barrier = out_dir / f"batch-{index:04d}.acquiring"
            seal(barrier, {"site": site.unix_name, "names": len(batch), "source_sha256": sha256_hex(source),
                           "started_at": datetime.now(UTC).isoformat(), "authenticated": False, "mutated": False})
            (response,) = site.amc_request([capture.preview_body(case)])
            body = response.json()["body"]
            seal(out_dir / f"batch-{index:04d}.json", {
                "schema": SCHEMA, "batch": index, "site": site.unix_name, "names": batch,
                "source_sha256": sha256_hex(source), "raw_html": body, "raw_html_sha256": sha256_hex(body),
                "captured_at": datetime.now(UTC).isoformat(),
                "provenance": {"module": "edit/PagePreviewModule", "authenticated": False, "mutated": False,
                               "wikidot_py_version": wikidot.__version__},
            })
            barrier.unlink()
            parse_batch(batch, body)
            print(f"batch {index}/{len(batches)} sealed ({len(batch)} names)", flush=True)
    return 0


def load_batches(out_dir: Path) -> list[dict[str, Any]]:
    batches = []
    for path in sorted(out_dir.glob("batch-*.json")):
        record = json.loads(path.read_text(encoding="utf-8"))
        if record.get("schema") != SCHEMA:
            raise ValueError(f"{path.name}: unsupported schema")
        if sha256_hex(record["raw_html"]) != record["raw_html_sha256"]:
            raise ValueError(f"{path.name}: raw_html does not match its recorded digest")
        batches.append(record)
    return batches


def observations(batches: list[dict[str, Any]]) -> tuple[list[dict[str, Any]], list[str]]:
    """Distinct resolved identities (first batch wins per user id) and the names Wikidot does not resolve
    to a live account (unknown names; deleted accounts are counted separately by `summarize`)."""
    by_id: dict[int, dict[str, Any]] = {}
    unresolved: list[str] = []
    for batch in batches:
        for result in parse_batch(batch["names"], batch["raw_html"]):
            if result["status"] != "resolved":
                if result["status"] == "unresolved":
                    unresolved.append(result["requested"])
                continue
            user_id = result["user_id"]
            if not 0 < user_id < FIRST_WIKIJUMP_USER_ID:
                raise ValueError(f"user id {user_id} for {result['requested']!r} is outside the Wikidot id range")
            by_id.setdefault(user_id, {
                "user_id": user_id, "name": result["name"], "slug": result["slug"],
                "source_sha256": batch["raw_html_sha256"], "observed_at": batch["captured_at"],
                "source_reference": f"https://{batch['site']}.wikidot.com/ (anonymous edit/PagePreviewModule [[user]] "
                                    f"resolution, identity batch {batch['batch']:04d})",
            })
    return sorted(by_id.values(), key=lambda row: row["user_id"]), unresolved


def summarize(batches: list[dict[str, Any]]) -> dict[str, int]:
    counts: dict[str, int] = {}
    for batch in batches:
        for result in parse_batch(batch["names"], batch["raw_html"]):
            counts[result["status"]] = counts.get(result["status"], 0) + 1
    return counts


def sql_literal(value: str) -> str:
    return "'" + value.replace("'", "''") + "'"


def build_sql(rows: list[dict[str, Any]]) -> str:
    statements = ["BEGIN;"]
    for row in rows:
        statements.append(f"INSERT INTO known_user(user_id) VALUES({row['user_id']}) ON CONFLICT DO NOTHING;")
        statements.append(
            "INSERT INTO wikidot_identity_observation(user_id,source_sha256,observed_at,name,slug,source_reference) "
            f"VALUES({row['user_id']},decode('{row['source_sha256']}','hex'),{sql_literal(row['observed_at'])}::timestamptz,"
            f"{sql_literal(row['name'])},{sql_literal(row['slug'])},{sql_literal(row['source_reference'])}) ON CONFLICT DO NOTHING;"
        )
    statements.append("COMMIT;")
    return "\n".join(statements) + "\n"


def run_sql(container: str, sql: str) -> str:
    result = subprocess.run(
        ["docker", "exec", "-i", "-u", "wikijump", container, "sh", "-c",
         'PGPASSWORD="$POSTGRES_PASSWORD" psql -h 127.0.0.1 -U wikijump -d wikijump -v ON_ERROR_STOP=1 -At'],
        input=sql, capture_output=True, text=True, check=False,
    )
    if result.returncode != 0:
        raise RuntimeError(f"psql failed: {result.stderr.strip()[:400]}")
    return result.stdout


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = parser.add_subparsers(dest="command", required=True)
    collect = sub.add_parser("collect")
    collect.add_argument("--corpus-root", type=Path, required=True)
    collect.add_argument("--branch", default="en")
    collect.add_argument("--output", type=Path, required=True)
    acquire_parser = sub.add_parser("acquire")
    acquire_parser.add_argument("--names", type=Path, required=True)
    acquire_parser.add_argument("--out-dir", type=Path, required=True)
    acquire_parser.add_argument("--batch-size", type=int, default=100)
    acquire_parser.add_argument("--site", default="scp-wiki")
    apply_parser = sub.add_parser("apply")
    apply_parser.add_argument("--out-dir", type=Path, required=True)
    apply_parser.add_argument("--db-container", default="wikijump-standing-database-1")
    apply_parser.add_argument("--apply", action="store_true")
    args = parser.parse_args(argv)

    if args.command == "collect":
        names = collect_names(args.corpus_root, args.branch)
        args.output.write_text(json.dumps(names, ensure_ascii=False, indent=0) + "\n", encoding="utf-8")
        print(f"{len(names)} distinct user names -> {args.output}")
        return 0
    if args.command == "acquire":
        if args.batch_size < 1 or args.batch_size > 200:
            parser.error("--batch-size must be between 1 and 200")
        return acquire(json.loads(args.names.read_text(encoding="utf-8")), args.out_dir, args.batch_size, args.site)

    batches = load_batches(args.out_dir)
    rows, unresolved = observations(batches)
    print(f"{len(batches)} sealed batches: {len(rows)} identities to record; {summarize(batches)}")
    if not args.apply:
        print("dry run (pass --apply to write)")
        return 0
    before = run_sql(args.db_container, "SELECT count(*) FROM wikidot_identity_observation;").strip()
    run_sql(args.db_container, build_sql(rows))
    after = run_sql(args.db_container, "SELECT count(*) FROM wikidot_identity_observation;").strip()
    print(f"wikidot_identity_observation rows: {before} -> {after}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
