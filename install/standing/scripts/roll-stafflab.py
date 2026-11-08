#!/usr/bin/env python3
"""Roll stafflab onto the application images of an existing build.

Stafflab shares Standing's build: a promotion (or an on-demand candidate
build) produces one image set and records it in
build/images/final-images.json. This command re-pins stafflab's environment
to that build's three application images and the head they were built from,
recreates only the application services, and verifies the stack the way the
manual roll did: render-ahead, the promotion sweep, an anonymous page sweep,
and the served head on /-/about. Any failure after the re-pin restores the
recorded previous pins and recreates the previous services.

Data, credentials, reachability, and the database image are out of scope:
the roll refuses a build whose database image differs from the one stafflab
already pins, because database-image changes belong to the per-stack
clone-upgrade procedure. Stafflab is never rolled backward: the build's
head must descend from the head stafflab currently runs, unless
--allow-downgrade is given.
"""

from __future__ import annotations

import argparse
from datetime import UTC, datetime
import json
from pathlib import Path
import re
import shutil
import subprocess
import sys
import time

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import refresh


SERVICES = refresh.SERVICES
STAFFLAB_PROJECT = "wikijump-stafflab"
STAFFLAB_DEEPWELL = "wikijump-stafflab-deepwell-1"
STAFFLAB_DATABASE = "wikijump-stafflab-database-1"
APP_ROLES = ("deepwell", "framerail", "wws")
REQUIRED_ROLES = APP_ROLES + ("database",)
ABOUT_HOSTS = (
    "scp-jp.localhost",
    "scp-wiki.wikijump.localhost",
    "scpaiueouiuiuiui.wikijump.localhost",
    "scp-jp-sigma10.localhost",
    "scp-jp-basalt.localhost",
)
KNOWN_SWEEP_STATUSES = {("scp-jp-sigma10.localhost", "_admin"): 401}
GIT_OBJECT = re.compile(r"[0-9a-f]{40}")
RENDER_AHEAD = Path(__file__).resolve().parents[1] / "render_ahead.py"


def default_stafflab_home() -> Path:
    return refresh.DEFAULT_RUNTIME_HOME.parent / "stafflab"


def default_repository() -> Path:
    return Path.home() / "src" / "Rokurolize" / "wikijump"


def compose_command(home: Path, *args: str) -> list[str]:
    command = [
        "docker",
        "compose",
        "--project-name",
        STAFFLAB_PROJECT,
        "--env-file",
        str(home / "stafflab.env"),
        "--file",
        str(home / "compose.yaml"),
    ]
    override = home / "compose.override.yaml"
    if override.exists():
        command.extend(("--file", str(override)))
    command.extend(args)
    return command


def wait_for_health(home: Path, timeout_seconds: int) -> dict[str, str]:
    deadline = time.monotonic() + timeout_seconds
    final: dict[str, str] = {}
    while time.monotonic() < deadline:
        final = {}
        for service in SERVICES:
            container_id = refresh.command(
                *compose_command(home, "ps", "--all", "--quiet", service),
                cwd=home,
            )
            if not container_id:
                final[service] = "missing"
                continue
            final[service] = refresh.command(
                "docker",
                "inspect",
                "--format",
                "{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}",
                container_id,
                cwd=home,
            )
        if all(status == "healthy" for status in final.values()):
            return final
        if any(status in {"dead", "exited"} for status in final.values()):
            raise RuntimeError(
                f"stafflab service stopped before becoming healthy: {final}"
            )
        time.sleep(1)
    raise TimeoutError(
        f"stafflab services did not become healthy within {timeout_seconds}s: {final}"
    )


def manifest_path(source: Path) -> Path:
    if source.is_file():
        return source
    for candidate in (
        source / "build" / "images" / "final-images.json",
        source / "final-images.json",
    ):
        if candidate.is_file():
            return candidate
    raise ValueError(f"no final-images.json under {source}")


def read_manifest(source: Path) -> dict[str, str]:
    path = manifest_path(source)
    entries = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(entries, list):
        raise ValueError(f"{path} is not a final-images.json image list")
    images: dict[str, str] = {}
    for entry in entries:
        if not isinstance(entry, dict):
            raise ValueError(f"invalid final-images.json entry in {path}: {entry!r}")
        role = entry.get("role")
        image_id = entry.get("image_id")
        if (
            not isinstance(role, str)
            or not isinstance(image_id, str)
            or refresh.IMAGE_ID.fullmatch(image_id) is None
        ):
            raise ValueError(f"invalid final-images.json entry in {path}: {entry!r}")
        if role in images:
            raise ValueError(f"duplicate role {role} in {path}")
        images[role] = image_id
    for role in REQUIRED_ROLES:
        if role not in images:
            raise ValueError(f"{path} has no {role} image")
    return images


def check_database_pin(environment: dict[str, str], images: dict[str, str]) -> None:
    current = environment.get("STANDING_DATABASE_IMAGE")
    if images["database"] != current:
        raise ValueError(
            f"the build pins database image {images['database']}, but stafflab "
            f"pins {current}; database-image changes are a separate "
            "clone-upgrade procedure and never ride an application roll"
        )


def build_identity(images: dict[str, str], cwd: Path) -> dict[str, str]:
    wikijump_shas: set[str] = set()
    ftml_shas: set[str] = set()
    for role in APP_ROLES:
        image = refresh.image_identity(images[role], cwd)
        if image["id"] != images[role]:
            raise ValueError(
                f"image {images[role]} inspected as {image['id']}; refusing to pin"
            )
        labels = image["labels"]
        sha = labels.get("com.rokurolize.wikijump.sha")
        ftml_sha = labels.get("com.rokurolize.wikijump.ftml_sha")
        if not isinstance(sha, str) or GIT_OBJECT.fullmatch(sha) is None:
            raise ValueError(f"{role} image {images[role]} has no wikijump sha label")
        if not isinstance(ftml_sha, str) or GIT_OBJECT.fullmatch(ftml_sha) is None:
            raise ValueError(f"{role} image {images[role]} has no ftml sha label")
        wikijump_shas.add(sha)
        ftml_shas.add(ftml_sha)
    if len(wikijump_shas) != 1 or len(ftml_shas) != 1:
        raise ValueError(
            "the build's application images disagree on their source head: "
            f"wikijump {sorted(wikijump_shas)}, ftml {sorted(ftml_shas)}"
        )
    return {"wikijump_sha": wikijump_shas.pop(), "ftml_sha": ftml_shas.pop()}


def is_ancestor(repository: Path, ancestor: str, descendant: str) -> bool:
    result = subprocess.run(
        [
            "git",
            "-C",
            str(repository),
            "merge-base",
            "--is-ancestor",
            ancestor,
            descendant,
        ],
        capture_output=True,
        text=True,
    )
    if result.returncode == 0:
        return True
    if result.returncode == 1:
        return False
    raise ValueError(
        f"git cannot compare {ancestor} with {descendant} in {repository}: "
        f"{result.stderr.strip()}"
    )


def check_descent(
    repository: Path, current_sha: str, target_sha: str, allow_downgrade: bool
) -> None:
    if target_sha == current_sha:
        return
    if is_ancestor(repository, current_sha, target_sha):
        return
    if allow_downgrade:
        print(
            f"warning: target head {target_sha} does not descend from "
            f"stafflab's current head {current_sha}; rolling anyway "
            "(--allow-downgrade)"
        )
        return
    raise ValueError(
        f"target head {target_sha} does not descend from stafflab's current "
        f"head {current_sha}; refusing to roll stafflab backward "
        "(pass --allow-downgrade to force)"
    )


def pin_updates(images: dict[str, str], identity: dict[str, str]) -> dict[str, str]:
    updates = {
        f"STANDING_{role.upper()}_IMAGE": images[role] for role in APP_ROLES
    }
    updates["STANDING_WIKIJUMP_SHA"] = identity["wikijump_sha"]
    updates["STANDING_FTML_SHA"] = identity["ftml_sha"]
    return updates


def pin_changes(
    environment: dict[str, str], updates: dict[str, str]
) -> list[tuple[str, str | None, str]]:
    return [
        (key, environment.get(key), value)
        for key, value in sorted(updates.items())
        if environment.get(key) != value
    ]


def render_ahead(home: Path, roll_dir: Path, image_id: str) -> dict[str, object]:
    output_dir = roll_dir / "render-ahead"
    refresh.command(
        sys.executable,
        str(RENDER_AHEAD),
        "--image",
        image_id,
        "--deepwell-container",
        STAFFLAB_DEEPWELL,
        "--database-container",
        STAFFLAB_DATABASE,
        "--output-dir",
        str(output_dir),
        cwd=home,
        capture=False,
    )
    summary = json.loads(
        (output_dir / "render-ahead-summary.json").read_text(encoding="utf-8")
    )
    if summary.get("status") != "pass":
        raise RuntimeError(f"render-ahead did not pass: {summary.get('status')}")
    return summary


def promotion_sweep(home: Path) -> dict[str, str]:
    results: dict[str, str] = {}
    for name in ("pages.tsv", "pages-sigma10.tsv"):
        tsv = home / name
        if not tsv.is_file():
            continue
        output = refresh.command(
            "node", str(home / "promotion-sweep.mjs"), str(tsv), cwd=home
        )
        if (
            "SWEEP-DONE" not in output
            or "SWEEP-NON200" in output
            or "SWEEP-ERROR" in output
        ):
            raise RuntimeError(f"promotion sweep over {name} failed:\n{output}")
        results[name] = output
    return results


def fetch(host: str, path: str) -> tuple[int, str]:
    result = subprocess.run(
        [
            "curl",
            "-sk",
            "--resolve",
            f"{host}:28443:127.0.0.1",
            "-w",
            "\n%{http_code}",
            f"https://{host}:28443{path}",
        ],
        capture_output=True,
        text=True,
    )
    if result.returncode != 0:
        raise RuntimeError(
            f"curl failed for https://{host}:28443{path}: {result.stderr.strip()}"
        )
    body, _, status = result.stdout.rpartition("\n")
    return int(status), body


def anonymous_sweep(home: Path) -> dict[str, object]:
    checked = 0
    failures: list[str] = []
    for name in ("pages.tsv", "pages-sigma10.tsv"):
        tsv = home / name
        if not tsv.is_file():
            continue
        for line in tsv.read_text(encoding="utf-8").splitlines():
            if not line.strip():
                continue
            host, _, slug = line.partition("\t")
            status, _ = fetch(host, f"/{slug}")
            expected = KNOWN_SWEEP_STATUSES.get((host, slug), 200)
            checked += 1
            if status != expected:
                failures.append(f"{host}/{slug}: HTTP {status}, expected {expected}")
    if failures:
        raise RuntimeError("anonymous sweep failures:\n" + "\n".join(failures))
    return {"pages_checked": checked}


def collect_strings(value: object, into: set[str]) -> None:
    if isinstance(value, str):
        into.add(value)
    elif isinstance(value, list):
        for item in value:
            collect_strings(item, into)
    elif isinstance(value, dict):
        for item in value.values():
            collect_strings(item, into)


def verify_served_head(wikijump_sha: str) -> dict[str, object]:
    for host in ABOUT_HOSTS:
        status, body = fetch(host, "/-/about/__data.json")
        if status != 200:
            raise RuntimeError(f"{host} served /-/about with HTTP {status}")
        served: set[str] = set()
        collect_strings(json.loads(body), served)
        if wikijump_sha not in served:
            raise RuntimeError(f"{host} does not serve {wikijump_sha} on /-/about")
    return {"hosts": list(ABOUT_HOSTS), "wikijump_sha": wikijump_sha}


def write_record(roll_dir: Path, record: dict[str, object]) -> None:
    (roll_dir / "roll.json").write_text(
        json.dumps(record, indent=2, sort_keys=True) + "\n", encoding="utf-8"
    )


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    source = parser.add_mutually_exclusive_group(required=True)
    source.add_argument(
        "--promotion", type=Path, help="promotion run directory to roll from"
    )
    source.add_argument(
        "--from",
        dest="candidate",
        type=Path,
        help="candidate build directory to roll from",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="run every check and print the pin changes without touching the stack",
    )
    parser.add_argument(
        "--allow-downgrade",
        action="store_true",
        help="roll to a head that does not descend from stafflab's current head",
    )
    parser.add_argument("--stafflab-home", type=Path, default=default_stafflab_home())
    parser.add_argument("--repository", type=Path, default=default_repository())
    parser.add_argument("--health-timeout-seconds", type=int, default=600)
    return parser.parse_args()


def run_roll(args: argparse.Namespace) -> int:
    home: Path = args.stafflab_home
    source = args.promotion if args.promotion is not None else args.candidate
    environment = refresh.read_environment(home / "stafflab.env")
    if environment.get("STANDING_PROJECT_NAME") != STAFFLAB_PROJECT:
        raise ValueError("runtime home is not the wikijump-stafflab project")
    images = read_manifest(source)
    check_database_pin(environment, images)
    identity = build_identity(images, home)
    current_sha = environment.get("STANDING_WIKIJUMP_SHA")
    if not isinstance(current_sha, str) or GIT_OBJECT.fullmatch(current_sha) is None:
        raise ValueError("stafflab.env has no valid STANDING_WIKIJUMP_SHA")
    target_sha = identity["wikijump_sha"]
    check_descent(args.repository, current_sha, target_sha, args.allow_downgrade)
    updates = pin_updates(images, identity)
    changes = pin_changes(environment, updates)

    print(f"source manifest: {manifest_path(source)}")
    print(f"current head:    {current_sha}")
    print(f"target head:     {target_sha}")
    if changes:
        for key, old, new in changes:
            print(f"  {key}: {old} -> {new}")
    else:
        print("  (no pin changes)")
    if args.dry_run:
        print("dry run: every check passed; the stack was not touched")
        return 0
    if not changes:
        print("stafflab already runs this build; nothing to do")
        return 0

    timestamp = datetime.now(UTC).strftime("%Y%m%dT%H%M%SZ")
    roll_dir = home / "rolls" / f"{timestamp}-{target_sha[:12]}"
    roll_dir.mkdir(parents=True, exist_ok=False)
    backup = home / f"stafflab.env.bak-{timestamp}-roll-{target_sha[:8]}"
    shutil.copy2(home / "stafflab.env", backup)
    record: dict[str, object] = {
        "schema": "wikijump.stafflab_roll.v1",
        "started_at": datetime.now(UTC).isoformat(),
        "source_manifest": str(manifest_path(source)),
        "stafflab_home": str(home),
        "env_backup": str(backup),
        "current": {key: environment.get(key) for key in sorted(updates)},
        "target": dict(updates),
        "status": "started",
    }
    write_record(roll_dir, record)
    switched = False
    try:
        record["render_ahead"] = render_ahead(home, roll_dir, images["deepwell"])
        rolled = dict(environment)
        rolled.update(updates)
        refresh.write_environment(home / "stafflab.env", rolled)
        switched = True
        refresh.command(
            *compose_command(
                home, "up", "--detach", "--no-deps", "--no-build", *SERVICES
            ),
            cwd=home,
        )
        record["health"] = wait_for_health(home, args.health_timeout_seconds)
        record["promotion_sweep"] = promotion_sweep(home)
        record["anonymous_sweep"] = anonymous_sweep(home)
        record["about"] = verify_served_head(target_sha)
    except BaseException as error:
        record["status"] = "failed"
        record["error"] = str(error)
        if switched:
            try:
                refresh.write_environment(home / "stafflab.env", environment)
                refresh.command(
                    *compose_command(
                        home, "up", "--detach", "--no-deps", "--no-build", *SERVICES
                    ),
                    cwd=home,
                )
                record["rollback_health"] = wait_for_health(
                    home, args.health_timeout_seconds
                )
                record["rollback"] = "pass"
            except BaseException as rollback_error:
                record["rollback"] = f"failed: {rollback_error}"
        write_record(roll_dir, record)
        raise
    record["status"] = "pass"
    record["completed_at"] = datetime.now(UTC).isoformat()
    write_record(roll_dir, record)
    print(f"stafflab rolled to {target_sha}; record: {roll_dir / 'roll.json'}")
    return 0


def main() -> int:
    args = parse_args()
    try:
        return run_roll(args)
    except (
        ValueError,
        RuntimeError,
        TimeoutError,
        subprocess.CalledProcessError,
    ) as error:
        print(f"roll-stafflab: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
