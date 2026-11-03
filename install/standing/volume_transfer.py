#!/usr/bin/env python3
"""Copy, verify, archive, and restore standing Docker volumes safely.

The standing database/files/cache volumes are state, not build artifacts.  This
tool deliberately separates byte-preserving copy/verification from Compose
activation so a topology change cannot silently become a data migration.
"""

from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import json
import os
import re
import subprocess
import sys
import tempfile
from pathlib import Path
from typing import Any

from volume_contract import (
    ARCHIVE_ROLES,
    ARCHIVE_VOLUMES,
    CADDY_VOLUMES,
    DURABLE_VOLUMES,
    LEGACY_VOLUMES,
    PERSISTENT_VOLUMES,
    PROJECT_NAME,
)


DOCKER = "/usr/bin/docker"
SCHEMA = "wikijump.standing_volume_migration.v1"
ARCHIVE_SCHEMA = "wikijump.standing_volume_archive.v1"
POST_CUTOVER_SCHEMA = "wikijump.standing_volume_cutover.v1"
ROLES = ("database", "files", "cache")
DEFAULT_HELPER_CONTAINER = f"{PROJECT_NAME}-deepwell-1"
SHA256_RE = set("0123456789abcdef")
VOLUME_PREFIX_RE = re.compile(r"^[a-z0-9][a-z0-9_.-]{0,62}-$")


class VolumeTransferError(RuntimeError):
    pass


def utc_now() -> str:
    return dt.datetime.now(dt.UTC).isoformat()


def run(
    args: list[str],
    *,
    check: bool = True,
    text: bool = True,
    stdout: Any = subprocess.PIPE,
    stderr: Any = subprocess.PIPE,
) -> subprocess.CompletedProcess[Any]:
    result = subprocess.run(
        args,
        check=False,
        text=text,
        stdout=stdout,
        stderr=stderr,
    )
    if check and result.returncode != 0:
        detail = result.stderr.strip() if text and result.stderr else ""
        raise VolumeTransferError(
            f"command failed ({result.returncode}): {' '.join(args)}"
            + (f"\n{detail}" if detail else "")
        )
    return result


def docker(*args: str, **kwargs: Any) -> subprocess.CompletedProcess[Any]:
    return run([DOCKER, *args], **kwargs)


def atomic_json(path: Path, value: object) -> None:
    if not path.is_absolute():
        raise VolumeTransferError("record/manifest path must be absolute")
    path.parent.mkdir(parents=True, exist_ok=True)
    handle, temporary = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
    try:
        os.fchmod(handle, 0o600)
        with os.fdopen(handle, "w", encoding="utf-8") as stream:
            json.dump(value, stream, indent=2, sort_keys=True)
            stream.write("\n")
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
    except Exception:
        try:
            os.close(handle)
        except OSError:
            pass
        Path(temporary).unlink(missing_ok=True)
        raise


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        while chunk := stream.read(8 * 1024 * 1024):
            digest.update(chunk)
    return digest.hexdigest()


def exact_sha256(value: object, label: str) -> str:
    if (
        not isinstance(value, str)
        or len(value) != 64
        or any(character not in SHA256_RE for character in value)
    ):
        raise VolumeTransferError(f"{label} is not a lowercase SHA-256")
    return value


def inspect_json(kind: str, names: list[str]) -> list[dict[str, Any]]:
    if not names:
        return []
    result = docker(kind, "inspect", *names)
    value = json.loads(result.stdout)
    if not isinstance(value, list):
        raise VolumeTransferError(f"docker {kind} inspect returned a non-list")
    return value


def volume_exists(name: str) -> bool:
    return docker("volume", "inspect", name, check=False).returncode == 0


def volume_consumers(names: set[str]) -> list[dict[str, object]]:
    ids = docker("ps", "-aq").stdout.split()
    consumers: list[dict[str, object]] = []
    for item in inspect_json("container", ids):
        mounted = sorted(
            mount.get("Name")
            for mount in item.get("Mounts", [])
            if mount.get("Type") == "volume" and mount.get("Name") in names
        )
        if not mounted:
            continue
        consumers.append(
            {
                "id": item.get("Id", ""),
                "name": str(item.get("Name", "")).lstrip("/"),
                "running": bool(item.get("State", {}).get("Running")),
                "volumes": mounted,
            }
        )
    return consumers


def running_project_containers(project: str = PROJECT_NAME) -> list[str]:
    return docker(
        "ps",
        "--filter",
        f"label=com.docker.compose.project={project}",
        "--format",
        "{{.Names}}",
    ).stdout.split()


def resolve_helper_image(explicit: str | None) -> str:
    reference = explicit
    if not reference:
        inspected = inspect_json("container", [DEFAULT_HELPER_CONTAINER])
        if len(inspected) != 1:
            raise VolumeTransferError(
                f"cannot resolve helper image from {DEFAULT_HELPER_CONTAINER}; "
                "pass --helper-image"
            )
        reference = inspected[0].get("Image")
    if not isinstance(reference, str) or not reference:
        raise VolumeTransferError("helper image reference is empty")
    image = inspect_json("image", [reference])
    if len(image) != 1 or not isinstance(image[0].get("Id"), str):
        raise VolumeTransferError("helper image inspection failed")
    image_id = image[0]["Id"]
    if not image_id.startswith("sha256:"):
        raise VolumeTransferError("helper image is not content-addressed")
    version = docker(
        "run",
        "--rm",
        "--pull=never",
        "--network=none",
        "--entrypoint",
        "tar",
        image_id,
        "--version",
    ).stdout
    if "GNU tar" not in version:
        raise VolumeTransferError("helper image must provide GNU tar")
    return image_id


TREE_DIGEST_SCRIPT = r"""
set -eu
cd /volume
entries="$(find . -xdev -printf . | wc -c | tr -d ' ')"
bytes="$(find . -xdev -type f -printf '%s\n' | awk '{sum += $1} END {printf "%.0f", sum + 0}')"
digest="$({ tar \
  --sort=name \
  --numeric-owner \
  --acls \
  --xattrs \
  --sparse \
  --format=posix \
  --pax-option=delete=atime,delete=ctime \
  -cf - .; } | sha256sum | awk '{print $1}')"
printf '%s\t%s\t%s\n' "$digest" "$entries" "$bytes"
""".strip()


COPY_SCRIPT = r"""
set -eu
test -d /source
test -d /destination
if find /destination -mindepth 1 -print -quit | grep -q .; then
  echo 'destination volume is not empty' >&2
  exit 71
fi
tar --numeric-owner --acls --xattrs --sparse -C /source -cf - . \
  | tar --numeric-owner --acls --xattrs --sparse -C /destination -xpf -
""".strip()


def helper_run(
    image: str,
    script: str,
    mounts: list[tuple[str, str, bool]],
) -> str:
    args = [
        "run",
        "--rm",
        "--pull=never",
        "--network=none",
        "--user",
        "0:0",
        "--entrypoint",
        "sh",
    ]
    for source, destination, read_only in mounts:
        suffix = ":ro" if read_only else ""
        args.extend(["--volume", f"{source}:{destination}{suffix}"])
    args.extend([image, "-ceu", script])
    return docker(*args).stdout


def tree_digest(image: str, volume: str) -> dict[str, object]:
    raw = helper_run(image, TREE_DIGEST_SCRIPT, [(volume, "/volume", True)])
    parts = raw.strip().split("\t")
    if len(parts) != 3:
        raise VolumeTransferError(f"invalid tree digest output for {volume}: {raw!r}")
    digest, entries, apparent_bytes = parts
    exact_sha256(digest, f"{volume} tree digest")
    try:
        return {
            "tree_sha256": digest,
            "entries": int(entries),
            "logical_file_bytes": int(apparent_bytes),
        }
    except ValueError as error:
        raise VolumeTransferError(f"invalid tree counters for {volume}") from error


def copy_volume(image: str, source: str, destination: str) -> None:
    helper_run(
        image,
        COPY_SCRIPT,
        [(source, "/source", True), (destination, "/destination", False)],
    )


def create_durable_volume(role: str, *, replace: bool) -> str:
    durable = DURABLE_VOLUMES[role]
    if volume_exists(durable):
        if not replace:
            raise VolumeTransferError(
                f"destination volume already exists: {durable}; "
                "use --replace-destinations only after checking consumers"
            )
        consumers = volume_consumers({durable})
        if consumers:
            raise VolumeTransferError(
                f"cannot replace destination {durable}; it is referenced by containers"
            )
        docker("volume", "rm", durable)
    result = docker(
        "volume",
        "create",
        "--label",
        "com.rokurolize.wikijump.owner=standing-runtime",
        "--label",
        f"com.rokurolize.wikijump.role={role}",
        "--label",
        f"com.rokurolize.wikijump.migrated_from={LEGACY_VOLUMES[role]}",
        durable,
    )
    if result.stdout.strip() != durable:
        raise VolumeTransferError(f"docker returned an unexpected volume name for {durable}")
    return durable


def create_restored_volume(
    role: str, volume: str, *, restored_from: str | None = None
) -> str:
    if volume_exists(volume):
        raise VolumeTransferError(f"restore destination already exists: {volume}")
    args = [
        "volume",
        "create",
        "--label",
        "com.rokurolize.wikijump.owner=standing-runtime",
        "--label",
        f"com.rokurolize.wikijump.role={role}",
    ]
    if restored_from:
        args.extend(
            [
                "--label",
                f"com.rokurolize.wikijump.restored_from={restored_from}",
            ]
        )
    args.append(volume)
    result = docker(*args)
    if result.stdout.strip() != volume:
        raise VolumeTransferError(f"docker returned an unexpected volume name for {volume}")
    return volume


def require_quiesced() -> None:
    running = running_project_containers()
    if running:
        raise VolumeTransferError(
            "standing runtime must be quiesced before volume transfer; running: "
            + ", ".join(running)
        )


def migrate(args: argparse.Namespace) -> int:
    record = args.record.resolve()
    if record.exists():
        raise VolumeTransferError(f"migration record already exists: {record}")
    require_quiesced()
    missing = [name for name in LEGACY_VOLUMES.values() if not volume_exists(name)]
    if missing:
        raise VolumeTransferError("legacy standing volume(s) missing: " + ", ".join(missing))
    helper = resolve_helper_image(args.helper_image)
    started = utc_now()
    rows: list[dict[str, object]] = []
    created: list[str] = []
    try:
        for role in ROLES:
            source = LEGACY_VOLUMES[role]
            destination = create_durable_volume(
                role, replace=args.replace_destinations
            )
            created.append(destination)
            source_before = tree_digest(helper, source)
            copy_volume(helper, source, destination)
            destination_after = tree_digest(helper, destination)
            source_after = tree_digest(helper, source)
            if source_before != source_after:
                raise VolumeTransferError(
                    f"legacy source changed while copying {role}: {source}"
                )
            if source_before != destination_after:
                raise VolumeTransferError(
                    f"destination verification failed for {role}: {destination}"
                )
            rows.append(
                {
                    "role": role,
                    "legacy_volume": source,
                    "durable_volume": destination,
                    "source_before": source_before,
                    "source_after": source_after,
                    "destination_after": destination_after,
                }
            )
        value = {
            "schema": SCHEMA,
            "status": "verified",
            "started_at": started,
            "completed_at": utc_now(),
            "project": PROJECT_NAME,
            "helper_image": helper,
            "standing_quiesced": True,
            "roles": rows,
            "legacy_retained": True,
        }
        atomic_json(record, value)
        print(json.dumps({"status": "verified", "record": str(record)}))
        return 0
    except Exception as error:
        atomic_json(
            record,
            {
                "schema": SCHEMA,
                "status": "failed",
                "started_at": started,
                "failed_at": utc_now(),
                "project": PROJECT_NAME,
                "helper_image": helper,
                "created_destinations": created,
                "error": str(error),
            },
        )
        raise


def load_migration_record(path: Path) -> dict[str, object]:
    value = json.loads(path.read_text(encoding="utf-8"))
    if value.get("schema") != SCHEMA or value.get("status") != "verified":
        raise VolumeTransferError("migration record is not verified")
    rows = value.get("roles")
    if not isinstance(rows, list) or len(rows) != len(ROLES):
        raise VolumeTransferError("migration record role set is incomplete")
    by_role = {row.get("role"): row for row in rows if isinstance(row, dict)}
    if set(by_role) != set(ROLES):
        raise VolumeTransferError("migration record role set is non-canonical")
    for role in ROLES:
        row = by_role[role]
        if row.get("legacy_volume") != LEGACY_VOLUMES[role]:
            raise VolumeTransferError(f"migration record legacy name drift for {role}")
        if row.get("durable_volume") != DURABLE_VOLUMES[role]:
            raise VolumeTransferError(f"migration record durable name drift for {role}")
        before = row.get("source_before")
        after = row.get("source_after")
        destination = row.get("destination_after")
        if not isinstance(before, dict) or before != after or before != destination:
            raise VolumeTransferError(f"migration record digest mismatch for {role}")
        exact_sha256(before.get("tree_sha256"), f"{role} source tree")
    return value


def bind_runtime_home_to_durable_volumes(
    runtime_home: Path, *, migration_receipt_sha256: str
) -> dict[str, object]:
    root = runtime_home.resolve()
    compose_path = root / "compose.yaml"
    identity_path = root / "identity.json"
    if not compose_path.is_file() or not identity_path.is_file():
        raise VolumeTransferError(
            "runtime home must contain compose.yaml and identity.json"
        )

    compose = compose_path.read_text(encoding="utf-8")
    legacy_mentions = sorted(
        name for name in LEGACY_VOLUMES.values() if name in compose
    )
    if legacy_mentions:
        raise VolumeTransferError(
            "runtime home compose still names legacy volume(s): "
            + ", ".join(legacy_mentions)
        )
    missing_durable = sorted(
        name for name in DURABLE_VOLUMES.values() if name not in compose
    )
    if missing_durable:
        raise VolumeTransferError(
            "runtime home compose is missing durable volume(s): "
            + ", ".join(missing_durable)
        )

    identity = json.loads(identity_path.read_text(encoding="utf-8"))
    if not isinstance(identity, dict) or identity.get("project_name") != PROJECT_NAME:
        raise VolumeTransferError("runtime identity does not name the standing project")
    current_volumes = identity.get("persistent_volumes")
    # The historical identity used the three legacy application-data names
    # followed by the two stable Caddy names. A repeated post-cutover check may
    # already contain the durable list and is intentionally idempotent.
    legacy_identity = [*LEGACY_VOLUMES.values(), *CADDY_VOLUMES]
    if current_volumes not in (legacy_identity, list(PERSISTENT_VOLUMES)):
        raise VolumeTransferError(
            "runtime identity persistent volume set is neither legacy nor durable"
        )
    identity["persistent_volumes"] = list(PERSISTENT_VOLUMES)
    identity["volume_migration"] = {
        "schema": SCHEMA,
        "receipt_sha256": exact_sha256(
            migration_receipt_sha256, "runtime identity migration record"
        ),
    }
    atomic_json(identity_path, identity)
    return {
        "runtime_home": str(root),
        "identity_path": str(identity_path),
        "identity_sha256": sha256_file(identity_path),
        "persistent_volumes": list(PERSISTENT_VOLUMES),
    }


def post_cutover(args: argparse.Namespace) -> int:
    record = load_migration_record(args.record.resolve())
    running = running_project_containers()
    if len(running) != 7:
        raise VolumeTransferError(
            f"expected seven running standing containers after cutover, found {len(running)}"
        )
    legacy = set(LEGACY_VOLUMES.values())
    durable = set(DURABLE_VOLUMES.values())
    legacy_consumers = volume_consumers(legacy)
    durable_consumers = volume_consumers(durable)
    running_legacy = [item for item in legacy_consumers if item["running"]]
    if running_legacy:
        raise VolumeTransferError("running containers still mount legacy standing volumes")
    expected_roles = {
        "database": DURABLE_VOLUMES["database"],
        "files": DURABLE_VOLUMES["files"],
        "cache": DURABLE_VOLUMES["cache"],
    }
    running_by_name = {
        item["name"]: set(item["volumes"])
        for item in durable_consumers
        if item["running"]
    }
    for role, volume in expected_roles.items():
        name = f"{PROJECT_NAME}-{role}-1"
        if running_by_name.get(name) != {volume}:
            raise VolumeTransferError(
                f"active {role} container is not bound exclusively to {volume}"
            )
    missing_rollback = [name for name in legacy if not volume_exists(name)]
    if missing_rollback:
        raise VolumeTransferError(
            "legacy rollback volume(s) disappeared before validation: "
            + ", ".join(sorted(missing_rollback))
        )
    migration_receipt_sha256 = sha256_file(args.record.resolve())
    runtime_binding = None
    if getattr(args, "runtime_home", None) is not None:
        runtime_binding = bind_runtime_home_to_durable_volumes(
            args.runtime_home,
            migration_receipt_sha256=migration_receipt_sha256,
        )
    value = {
        "schema": POST_CUTOVER_SCHEMA,
        "status": "pass",
        "checked_at": utc_now(),
        "migration_receipt_sha256": migration_receipt_sha256,
        "migration": record,
        "project": PROJECT_NAME,
        "running_containers": sorted(running),
        "active_durable_consumers": durable_consumers,
        "legacy_consumers": legacy_consumers,
        "legacy_retained": True,
        "runtime_binding": runtime_binding,
    }
    atomic_json(args.output.resolve(), value)
    print(json.dumps({"status": "pass", "record": str(args.output.resolve())}))
    return 0


def require_archive_quiesced(volumes: list[str]) -> None:
    consumers = volume_consumers(set(volumes))
    running = [item for item in consumers if item["running"]]
    if running:
        raise VolumeTransferError(
            "archive requires quiesced volumes; running consumers: "
            + ", ".join(str(item["name"]) for item in running)
        )


def stream_archive(image: str, volume: str, output: Path, *, gzip: bool) -> None:
    args = [
        DOCKER,
        "run",
        "--rm",
        "--pull=never",
        "--network=none",
        "--user",
        "0:0",
        "--entrypoint",
        "tar",
        "--volume",
        f"{volume}:/volume:ro",
        image,
        "--numeric-owner",
        "--acls",
        "--xattrs",
        "--sparse",
        "-C",
        "/volume",
        "-czf" if gzip else "-cf",
        "-",
        ".",
    ]
    try:
        with output.open("xb") as stream:
            run(args, text=False, stdout=stream)
    except Exception:
        output.unlink(missing_ok=True)
        raise


def backup(args: argparse.Namespace) -> int:
    root = args.output_dir.resolve()
    if root.exists() and any(root.iterdir()):
        raise VolumeTransferError(f"archive output directory is not empty: {root}")
    root.mkdir(parents=True, exist_ok=True, mode=0o700)
    helper = resolve_helper_image(args.helper_image)
    volumes = [ARCHIVE_VOLUMES[role] for role in ARCHIVE_ROLES]
    missing = [name for name in volumes if not volume_exists(name)]
    if missing:
        raise VolumeTransferError("durable standing volume(s) missing: " + ", ".join(missing))
    require_archive_quiesced(volumes)
    rows = []
    for role in ARCHIVE_ROLES:
        volume = ARCHIVE_VOLUMES[role]
        tree = tree_digest(helper, volume)
        suffix = ".tar.gz" if args.gzip else ".tar"
        file_name = f"{role}{suffix}"
        archive_path = root / file_name
        stream_archive(helper, volume, archive_path, gzip=args.gzip)
        rows.append(
            {
                "role": role,
                "volume": volume,
                "tree": tree,
                "archive": file_name,
                "archive_sha256": sha256_file(archive_path),
                "archive_bytes": archive_path.stat().st_size,
                "compression": "gzip" if args.gzip else "none",
            }
        )
    manifest = {
        "schema": ARCHIVE_SCHEMA,
        "status": "sealed",
        "created_at": utc_now(),
        "project": PROJECT_NAME,
        "helper_image": helper,
        "roles": rows,
    }
    atomic_json(root / "manifest.json", manifest)
    print(json.dumps({"status": "sealed", "manifest": str(root / "manifest.json")}))
    return 0


def extract_archive(
    image: str, volume: str, archive: Path, *, gzip: bool
) -> None:
    command = [
        DOCKER,
        "run",
        "--rm",
        "--pull=never",
        "--network=none",
        "--user",
        "0:0",
        "--entrypoint",
        "tar",
        "--volume",
        f"{volume}:/volume",
        "--interactive",
        image,
        "--numeric-owner",
        "--acls",
        "--xattrs",
        "--sparse",
        "-C",
        "/volume",
        "-xzf" if gzip else "-xf",
        "-",
    ]
    with archive.open("rb") as stream:
        result = subprocess.run(
            command,
            stdin=stream,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=False,
            check=False,
        )
    if result.returncode != 0:
        raise VolumeTransferError(
            f"failed to restore {volume}: {result.stderr.decode(errors='replace').strip()}"
        )


def restore(args: argparse.Namespace) -> int:
    root = args.input_dir.resolve()
    manifest_path = root / "manifest.json"
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    if manifest.get("schema") != ARCHIVE_SCHEMA or manifest.get("status") != "sealed":
        raise VolumeTransferError("archive manifest is not sealed")
    rows = manifest.get("roles")
    if not isinstance(rows, list) or len(rows) != len(ARCHIVE_ROLES):
        raise VolumeTransferError("archive manifest role set is incomplete")
    by_role = {row.get("role"): row for row in rows if isinstance(row, dict)}
    if set(by_role) != set(ARCHIVE_ROLES):
        raise VolumeTransferError("archive manifest role set is non-canonical")
    helper = resolve_helper_image(args.helper_image)
    prefix = getattr(args, "volume_prefix", None)
    if prefix is not None and not VOLUME_PREFIX_RE.fullmatch(prefix):
        raise VolumeTransferError(
            "restore volume prefix must be lowercase Docker-safe text ending in '-'"
        )
    validated: list[tuple[str, str, Path, str]] = []
    for role in ARCHIVE_ROLES:
        canonical_volume = ARCHIVE_VOLUMES[role]
        volume = f"{prefix or ''}{canonical_volume}"
        if volume_exists(volume):
            raise VolumeTransferError(f"restore destination already exists: {volume}")
        row = by_role[role]
        if row.get("volume") != canonical_volume:
            raise VolumeTransferError(f"archive volume name drift for {role}")
        archive = root / str(row.get("archive"))
        if not archive.is_file() or archive.parent != root:
            raise VolumeTransferError(f"archive file is missing or unsafe for {role}")
        if sha256_file(archive) != exact_sha256(
            row.get("archive_sha256"), f"{role} archive"
        ):
            raise VolumeTransferError(f"archive SHA-256 mismatch for {role}")
        compression = row.get("compression")
        if compression not in {"none", "gzip"}:
            raise VolumeTransferError(f"unsupported archive compression for {role}")
        validated.append((role, volume, archive, compression))

    for role, volume, archive, compression in validated:
        row = by_role[role]
        create_restored_volume(
            role,
            volume,
            restored_from=ARCHIVE_VOLUMES[role] if prefix else None,
        )
        extract_archive(
            helper,
            volume,
            archive,
            gzip=compression == "gzip",
        )
        current = tree_digest(helper, volume)
        if current != row.get("tree"):
            raise VolumeTransferError(f"restored tree verification failed for {role}")
    print(
        json.dumps(
            {
                "status": "restored",
                "manifest": str(manifest_path),
                "volume_prefix": prefix,
                "volumes": {
                    role: f"{prefix or ''}{ARCHIVE_VOLUMES[role]}"
                    for role in ARCHIVE_ROLES
                },
            }
        )
    )
    return 0


def parser() -> argparse.ArgumentParser:
    result = argparse.ArgumentParser()
    commands = result.add_subparsers(dest="command", required=True)

    migrate_parser = commands.add_parser("migrate")
    migrate_parser.add_argument("--record", type=Path, required=True)
    migrate_parser.add_argument("--helper-image")
    migrate_parser.add_argument("--replace-destinations", action="store_true")
    migrate_parser.set_defaults(handler=migrate)

    cutover_parser = commands.add_parser("post-cutover")
    cutover_parser.add_argument("--record", type=Path, required=True)
    cutover_parser.add_argument("--output", type=Path, required=True)
    cutover_parser.add_argument(
        "--runtime-home",
        type=Path,
        help="bind the canonical runtime identity to the durable volume names",
    )
    cutover_parser.set_defaults(handler=post_cutover)

    backup_parser = commands.add_parser("backup")
    backup_parser.add_argument("--output-dir", type=Path, required=True)
    backup_parser.add_argument("--helper-image")
    backup_parser.add_argument("--gzip", action="store_true")
    backup_parser.set_defaults(handler=backup)

    restore_parser = commands.add_parser("restore")
    restore_parser.add_argument("--input-dir", type=Path, required=True)
    restore_parser.add_argument("--helper-image", required=True)
    restore_parser.add_argument(
        "--volume-prefix",
        help=(
            "restore into prefixed Docker volumes for a non-destructive local "
            "restore rehearsal; omit on a clean target host"
        ),
    )
    restore_parser.set_defaults(handler=restore)
    return result


def main() -> int:
    args = parser().parse_args()
    try:
        return args.handler(args)
    except VolumeTransferError as error:
        print(f"error: {error}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
