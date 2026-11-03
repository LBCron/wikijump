#!/usr/bin/env python3
"""Materialize the immutable host-side standing Compose home from a clean merged checkout."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import tempfile
from datetime import UTC, datetime

from volume_contract import PERSISTENT_VOLUMES


IMAGE_ARGUMENTS = (
    "database_image",
    "files_image",
    "cache_image",
    "deepwell_image",
    "framerail_image",
    "wws_image",
    "caddy_image",
)

PRODUCTION_DOMAIN_BLOCK = '[domain]\nmain = "wikijump.com"\nhttps-port = 443\nfiles = "wjfiles.com"'
# Standing is the stack on 127.0.0.1:443; the local development stack has its
# own `wikijump.dev.localhost` hosts on 18443 (install/local/deepwell/config.toml).
STANDING_DOMAIN_BLOCK = '[domain]\nmain = "wikijump.localhost"\nhttps-port = 443\nfiles = "wjfiles.localhost"'


def command(*args: str, cwd: Path) -> str:
    return subprocess.check_output(args, cwd=cwd, text=True).strip()


def required_text(value: str, name: str) -> str:
    if not value or "\n" in value or "\r" in value:
        raise ValueError(f"{name} must be a non-empty single-line value")
    return value


def required_rpc_token() -> str:
    token = os.environ.get("DEEPWELL_RPC_TOKEN", "")
    if not re.fullmatch(r"[0-9a-f]{64}", token):
        raise ValueError(
            "DEEPWELL_RPC_TOKEN must be supplied in the environment as 64 lowercase hexadecimal characters"
        )
    return token


def source_state(source_root: Path, wikijump_sha: str, ftml_sha: str) -> dict[str, str]:
    if not source_root.is_absolute():
        raise ValueError("--source-root must be absolute")
    if command("git", "status", "--porcelain", cwd=source_root):
        raise ValueError("source checkout must be clean")
    head = command("git", "rev-parse", "HEAD", cwd=source_root)
    if head != wikijump_sha:
        raise ValueError(f"source HEAD {head} does not match --wikijump-sha {wikijump_sha}")
    tree = command("git", "rev-parse", "HEAD^{tree}", cwd=source_root)
    lockfile = source_root / "deepwell" / "Cargo.lock"
    lock_contents = lockfile.read_text(encoding="utf-8")
    if f"#{ftml_sha}" not in lock_contents:
        raise ValueError("deepwell/Cargo.lock does not contain the requested FTML revision")
    for required_path in (source_root / "install" / "prod" / "deepwell" / "config.toml", source_root / "locales"):
        if not required_path.exists():
            raise ValueError(f"required source path is missing: {required_path}")
    return {"wikijump_sha": head, "wikijump_tree": tree, "ftml_sha": ftml_sha}


def write_environment(path: Path, values: dict[str, str]) -> None:
    lines = [f"{key}={required_text(value, key)}" for key, value in sorted(values.items())]
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")
    os.chmod(path, 0o600)


def standing_deepwell_config(source: Path) -> tuple[str, str]:
    contents = source.read_text(encoding="utf-8")
    if contents.count(PRODUCTION_DOMAIN_BLOCK) != 1:
        raise ValueError("production Deepwell config must contain exactly one expected domain block")
    return contents.replace(PRODUCTION_DOMAIN_BLOCK, STANDING_DOMAIN_BLOCK), hashlib.sha256(contents.encode()).hexdigest()


def replace_directory(staging: Path, output_dir: Path, replace: bool) -> Path | None:
    if not output_dir.exists():
        staging.replace(output_dir)
        return None
    if not replace:
        raise ValueError(f"output directory already exists: {output_dir}; pass --replace after preserving its record")
    previous = output_dir.with_name(f"{output_dir.name}.previous-{datetime.now(UTC).strftime('%Y%m%dT%H%M%SZ')}")
    output_dir.replace(previous)
    staging.replace(output_dir)
    return previous


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source-root", type=Path, required=True)
    parser.add_argument("--output-dir", type=Path, required=True)
    parser.add_argument("--wikijump-sha", required=True)
    parser.add_argument("--ftml-sha", required=True)
    parser.add_argument("--project-name", default="wikijump-standing")
    parser.add_argument("--network-name")
    parser.add_argument("--replace", action="store_true")
    for image_name in IMAGE_ARGUMENTS:
        parser.add_argument(f"--{image_name.replace('_', '-')}", required=True)
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    source_root = args.source_root.resolve()
    output_dir = args.output_dir.resolve()
    identity = source_state(source_root, required_text(args.wikijump_sha, "wikijump_sha"), required_text(args.ftml_sha, "ftml_sha"))
    project_name = required_text(args.project_name, "project_name")
    network_name = required_text(args.network_name or f"{project_name}_default", "network_name")
    images = {argument: required_text(getattr(args, argument), argument) for argument in IMAGE_ARGUMENTS}
    rpc_token = required_rpc_token()
    template = Path(__file__).with_name("compose.yaml")
    output_dir.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix=f".{output_dir.name}.render-", dir=output_dir.parent) as temporary_dir:
        staging = Path(temporary_dir) / output_dir.name
        staging.mkdir()
        shutil.copy2(template, staging / "compose.yaml")
        staging_deepwell = staging / "deepwell"
        staging_deepwell.mkdir()
        deepwell_config, deepwell_config_source_sha256 = standing_deepwell_config(source_root / "install" / "prod" / "deepwell" / "config.toml")
        (staging_deepwell / "config.toml").write_text(deepwell_config, encoding="utf-8")
        staging_caddy = staging / "caddy"
        staging_caddy.mkdir()
        shutil.copy2(Path(__file__).with_name("caddy") / "request.json", staging_caddy / "request.json")
        environment = {
            "STANDING_PROJECT_NAME": project_name,
            "STANDING_NETWORK_NAME": network_name,
            "STANDING_WIKIJUMP_SHA": identity["wikijump_sha"],
            "STANDING_FTML_SHA": identity["ftml_sha"],
            "DEEPWELL_RPC_TOKEN": rpc_token,
            **{f"STANDING_{argument.upper()}": value for argument, value in images.items()},
        }
        write_environment(staging / ".env", environment)
        template_sha256 = hashlib.sha256(template.read_bytes()).hexdigest()
        record = {
            "schema_version": 1,
            "template_sha256": template_sha256,
            "project_name": project_name,
            "network_name": network_name,
            "deepwell_config_source_sha256": deepwell_config_source_sha256,
            "deepwell_domain_override": {
                "main": "wikijump.localhost",
                "https_port": 443,
                "files": "wjfiles.localhost",
            },
            **identity,
            "images": images,
            "persistent_volumes": list(PERSISTENT_VOLUMES),
        }
        (staging / "identity.json").write_text(json.dumps(record, indent=2, sort_keys=True) + "\n", encoding="utf-8")
        os.chmod(staging / "identity.json", 0o600)
        replaced = replace_directory(staging, output_dir, args.replace)
        result = {"output_dir": str(output_dir), "replaced_directory": str(replaced) if replaced else None, "identity": record}
        print(json.dumps(result, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
