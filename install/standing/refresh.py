"""Standing runtime helpers: source and container identity, container parking
and restore, health, saved-page freshness and receipts. `promote.py` drives
the promotion with them."""

from __future__ import annotations

import hashlib
import json
import os
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
import re
import subprocess
import tempfile
import threading
import time
import tomllib


SERVICES = ("deepwell", "framerail", "wws")
RUNTIME_SERVICES = (
    "deepwell",
    "framerail",
    "wws",
    "caddy",
)


def default_runtime_home() -> Path:
    state_root = os.environ.get("XDG_STATE_HOME")
    if state_root:
        root = Path(state_root).expanduser()
        if not root.is_absolute():
            raise ValueError("XDG_STATE_HOME must be absolute")
    else:
        root = Path.home() / ".local" / "state"
    return root / "wikijump" / "standing"


DEFAULT_RUNTIME_HOME = default_runtime_home()
CANARY_URL = "http://scp-wiki.wikijump.localhost/scp-9506"
FTML_SOURCE = re.compile(
    r'source = "git\+https://github\.com/Rokurolize/ftml[^\"]*#([0-9a-f]{40})"'
)
ENVIRONMENT_KEY = re.compile(r"[A-Za-z_][A-Za-z0-9_]*")
CONTAINER_ID = re.compile(r"[0-9a-f]{64}")
IMAGE_ID = re.compile(r"sha256:[0-9a-f]{64}")


def command(*args: str, cwd: Path, capture: bool = True) -> str:
    result = subprocess.run(
        args, cwd=cwd, check=True, text=True, capture_output=capture
    )
    return result.stdout.strip() if capture else ""


def repository_identity(source_root: Path) -> dict[str, str]:
    if command("git", "status", "--porcelain", cwd=source_root):
        raise ValueError("source checkout must be clean")
    head = command("git", "rev-parse", "HEAD", cwd=source_root)
    develop = command(
        "git", "rev-parse", "refs/remotes/origin/develop^{commit}", cwd=source_root
    )
    if head != develop:
        raise ValueError(
            f"source HEAD {head} is not the fetched origin/develop head {develop}"
        )
    tree = command("git", "rev-parse", "HEAD^{tree}", cwd=source_root)
    lock_contents = (source_root / "deepwell" / "Cargo.lock").read_text(
        encoding="utf-8"
    )
    if not (source_root / "locales").is_dir():
        raise ValueError("source checkout is missing the locales directory")
    matches = set(FTML_SOURCE.findall(lock_contents))
    if len(matches) != 1:
        raise ValueError("deepwell/Cargo.lock must contain exactly one FTML revision")
    return {
        "wikijump_sha": head,
        "wikijump_tree": tree,
        "ftml_sha": matches.pop(),
    }


def read_environment(path: Path) -> dict[str, str]:
    values: dict[str, str] = {}
    for line in path.read_text(encoding="utf-8").splitlines():
        if not line or line.startswith("#"):
            continue
        key, separator, value = line.partition("=")
        if not separator or not key or key in values:
            raise ValueError(
                f"invalid or duplicate environment entry in {path}: {line}"
            )
        values[key] = value
    return values


def write_environment(path: Path, values: dict[str, str]) -> None:
    for key, value in values.items():
        if not isinstance(key, str) or ENVIRONMENT_KEY.fullmatch(key) is None:
            raise ValueError(f"invalid environment key: {key!r}")
        if not isinstance(value, str) or not value.isprintable():
            raise ValueError(
                f"{key} must contain one printable, single-line environment value"
            )
    contents = "".join(f"{key}={value}\n" for key, value in sorted(values.items()))
    with tempfile.NamedTemporaryFile(
        "w", encoding="utf-8", dir=path.parent, prefix=f".{path.name}.", delete=False
    ) as temporary:
        temporary.write(contents)
        temporary.flush()
        os.fsync(temporary.fileno())
        temporary_path = Path(temporary.name)
    os.chmod(temporary_path, 0o600)
    os.replace(temporary_path, path)


def rollback_environment(
    previous: dict[str, str], images: dict[str, dict[str, object]]
) -> dict[str, str]:
    restored = dict(previous)
    for service in SERVICES:
        image_id = images[service]["id"]
        if not isinstance(image_id, str) or not IMAGE_ID.fullmatch(image_id):
            raise ValueError(f"rollback image {service} has no immutable image ID")
        restored[f"STANDING_{service.upper()}_IMAGE"] = image_id
    return restored


def compose_command(
    runtime_home: Path, *args: str, override_file: Path | None = None
) -> list[str]:
    command = [
        "docker",
        "compose",
        "--project-name",
        "wikijump-standing",
        "--env-file",
        str(runtime_home / ".env"),
        "--file",
        str(runtime_home / "compose.yaml"),
    ]
    if override_file is not None:
        command.extend(("--file", str(override_file)))
    command.extend(args)
    return command


def expected_compiled_generator(source_root: Path) -> str:
    lock = tomllib.loads((source_root / "deepwell" / "Cargo.lock").read_text(encoding="utf-8"))
    packages = [
        package
        for package in lock.get("package", [])
        if isinstance(package, dict) and package.get("name") == "ftml"
    ]
    versions = {package.get("version") for package in packages}
    if len(versions) != 1 or not all(isinstance(version, str) and version for version in versions):
        raise ValueError("deepwell/Cargo.lock must contain exactly one FTML package version")
    source = (
        source_root / "deepwell" / "src" / "services" / "render" / "generator.rs"
    ).read_text(encoding="utf-8")
    epochs = set(
        re.findall(r"DEEPWELL_RENDERER_EPOCH:\s*u32\s*=\s*([0-9]+)", source)
    )
    if len(epochs) != 1:
        raise ValueError("Deepwell renderer source must contain exactly one renderer epoch")
    return f"ftml v{versions.pop()}; deepwell-render/v{epochs.pop()}"


def wait_for_health(
    runtime_home: Path, override_file: Path, timeout_seconds: int
) -> dict[str, str]:
    deadline = time.monotonic() + timeout_seconds
    final: dict[str, str] = {}
    while time.monotonic() < deadline:
        final = {}
        for service in SERVICES:
            container_id = command(
                *compose_command(
                    runtime_home,
                    "ps",
                    "--all",
                    "--quiet",
                    service,
                    override_file=override_file,
                ),
                cwd=runtime_home,
            )
            if not container_id:
                final[service] = "missing"
                continue
            final[service] = command(
                "docker",
                "inspect",
                "--format",
                "{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}",
                container_id,
                cwd=runtime_home,
            )
        if all(status == "healthy" for status in final.values()):
            return final
        if any(status in {"dead", "exited"} for status in final.values()):
            raise RuntimeError(
                f"standing service stopped before becoming healthy: {final}"
            )
        time.sleep(1)
    raise TimeoutError(
        f"standing services did not become healthy within {timeout_seconds}s: {final}"
    )


def image_identity(reference: str, cwd: Path) -> dict[str, object]:
    raw = command(
        "docker", "image", "inspect", reference, "--format", "{{json .}}", cwd=cwd
    )
    image = json.loads(raw)
    image_id = image.get("Id")
    if not isinstance(image_id, str) or not IMAGE_ID.fullmatch(image_id):
        raise ValueError(f"image {reference} has no immutable SHA-256 image ID")
    return {
        "reference": reference,
        "id": image_id,
        "repo_digests": sorted(image.get("RepoDigests") or []),
        "labels": image.get("Config", {}).get("Labels") or {},
    }


def normalize_container_identity(value: object) -> dict[str, object]:
    if not isinstance(value, dict):
        raise ValueError("Docker container inspection is not an object")
    container_id = value.get("Id")
    image_id = value.get("Image")
    name = value.get("Name")
    state = value.get("State")
    if not isinstance(container_id, str) or not CONTAINER_ID.fullmatch(container_id):
        raise ValueError("Docker container has no immutable container ID")
    if not isinstance(image_id, str) or not IMAGE_ID.fullmatch(image_id):
        raise ValueError("Docker container has no immutable image ID")
    if not isinstance(name, str) or not name.startswith("/") or name == "/":
        raise ValueError("Docker container has no canonical name")
    status = state.get("Status") if isinstance(state, dict) else None
    if not isinstance(status, str) or not status:
        raise ValueError("Docker container has no state")
    network = value.get("NetworkSettings")
    ports = network.get("Ports", {}) if isinstance(network, dict) else {}
    if not isinstance(ports, dict):
        raise ValueError("Docker container ports are invalid")
    published_ports: list[dict[str, str]] = []
    for container_port, bindings in ports.items():
        if bindings is None:
            continue
        if not isinstance(container_port, str) or not isinstance(bindings, list):
            raise ValueError("Docker container ports are invalid")
        for binding in bindings:
            if not isinstance(binding, dict):
                raise ValueError("Docker container port binding is invalid")
            host_ip = binding.get("HostIp")
            host_port = binding.get("HostPort")
            if (
                not isinstance(host_ip, str)
                or not isinstance(host_port, str)
                or not host_port
            ):
                raise ValueError("Docker container port binding is invalid")
            published_ports.append(
                {
                    "container_port": container_port,
                    "host_ip": host_ip,
                    "host_port": host_port,
                }
            )
    published_ports.sort(
        key=lambda port: (port["host_port"], port["host_ip"], port["container_port"])
    )
    return {
        "container_id": container_id,
        "name": name[1:],
        "image_id": image_id,
        "status": status,
        "running": status == "running",
        "published_ports": published_ports,
    }


def container_identity(reference: str, cwd: Path) -> dict[str, object]:
    raw = command("docker", "inspect", "--format", "{{json .}}", reference, cwd=cwd)
    return normalize_container_identity(json.loads(raw))


def runtime_containers(runtime_home: Path) -> dict[str, dict[str, object]]:
    containers: dict[str, dict[str, object]] = {}
    for service in RUNTIME_SERVICES:
        identity = container_identity(f"wikijump-standing-{service}-1", runtime_home)
        identity["service"] = service
        containers[service] = identity
    return containers


def runtime_images(
    containers: dict[str, dict[str, object]], cwd: Path
) -> dict[str, dict[str, object]]:
    return {
        service: image_identity(container["image_id"], cwd)
        for service, container in containers.items()
    }


def port_443_owner(containers: dict[str, dict[str, object]]) -> dict[str, object]:
    owners = []
    for service, container in containers.items():
        bindings = [
            binding
            for binding in container["published_ports"]
            if binding["host_port"] == "443"
        ]
        if bindings:
            owners.append(
                {
                    "service": service,
                    "container_id": container["container_id"],
                    "name": container["name"],
                    "image_id": container["image_id"],
                    "bindings": bindings,
                }
            )
    if len(owners) != 1:
        raise ValueError(f"expected exactly one port-443 owner, found {len(owners)}")
    return owners[0]


def resource_exists(kind: str, reference: str, cwd: Path) -> bool:
    try:
        if kind == "container":
            command("docker", "inspect", reference, cwd=cwd)
        else:
            command("docker", "image", "inspect", reference, cwd=cwd)
    except subprocess.CalledProcessError:
        return False
    return True


def require_standing_applications_running(runtime_home: Path) -> dict[str, dict[str, object]]:
    """Fail before building/render-ahead if a previous promotion left apps down."""
    try:
        previous = runtime_containers(runtime_home)
    except (subprocess.CalledProcessError, RuntimeError, ValueError, KeyError) as error:
        raise RuntimeError(
            "Standing application containers cannot be inspected; stop promotion "
            "and recover the previous pinned app images from runtime .env before retrying"
        ) from error
    missing = [service for service in SERVICES
               if service not in previous or not previous[service]["running"]]
    if missing:
        raise RuntimeError(
            f"Standing applications are not running: {missing}; recover the prior "
            "pinned app images from runtime .env before starting promotion"
        )
    return previous


def run_scope(run_id: str) -> str:
    if not isinstance(run_id, str) or not run_id:
        raise ValueError("promotion run ID is required for container parking")
    return hashlib.sha256(run_id.encode("utf-8")).hexdigest()[:24]


def parked_container_name(run_id: str, service: str) -> str:
    return f"wikijump-standing-rollback-{run_scope(run_id)}-{service}"


PARKED_IMAGE_REPOSITORY = "wikijump-standing-parked"


def parked_image_tag(run_id: str, service: str) -> str:
    """Run-scoped snapshot tag for a parked application container."""
    return f"{PARKED_IMAGE_REPOSITORY}:{run_scope(run_id)}-{service}"


def commit_parked_container(parked_name: str, tag: str, cwd: Path) -> str:
    """Snapshot a stopped parked container's filesystem; return the image ID.

    The container is stopped before the snapshot, so its filesystem is
    quiescent. Application state lives in the database, files, and cache
    volumes, not in the container layer, so the snapshot restores the exact
    serving filesystem without capturing data-plane state.
    """
    command("docker", "commit", parked_name, tag, cwd=cwd)
    return command("docker", "image", "inspect", "--format", "{{.Id}}", tag, cwd=cwd)


def discard_parked_images(parked: dict[str, dict[str, object]], cwd: Path) -> None:
    """Best-effort removal of committed parked snapshots. Never raises.

    Snapshots are redundant once parked containers are restored, and stale
    once a newer generation replaces the containers that run from them. A
    snapshot still backing a running container cannot be removed; that
    failure is ignored and the tag is reaped by a later run.
    """
    for entry in parked.values():
        spec = entry.get("parked_image")
        tag = spec.get("tag") if isinstance(spec, dict) else None
        if not tag:
            continue
        try:
            command("docker", "rmi", tag, cwd=cwd)
        except subprocess.CalledProcessError:
            continue


def prune_parked_images(cwd: Path) -> None:
    """Best-effort removal of parked snapshots left by earlier runs.

    Runs before new snapshots are committed so one promotion never
    accumulates more than its own generation of tags. Never raises.
    """
    try:
        listing = command(
            "docker", "images", "--format", "{{.Repository}}:{{.Tag}}",
            "--filter", f"reference={PARKED_IMAGE_REPOSITORY}",
            cwd=cwd,
        )
    except subprocess.CalledProcessError:
        return
    for reference in listing.split():
        try:
            command("docker", "rmi", reference, cwd=cwd)
        except subprocess.CalledProcessError:
            continue


def restore_parked_containers(
    parked: dict[str, dict[str, object]], runtime_home: Path
) -> dict[str, dict[str, object]]:
    restored = {}
    for service, entry in parked.items():
        current = container_identity(entry["parked_name"], runtime_home)
        if (
            current["container_id"] != entry["container"]["container_id"]
            or current["image_id"] != entry["container"]["image_id"]
        ):
            raise RuntimeError(
                f"parked container identity changed before restore for {service}"
            )
        command(
            "docker",
            "rename",
            entry["parked_name"],
            entry["original_name"],
            cwd=runtime_home,
        )
        if entry["was_running"]:
            command(
                "docker",
                "start",
                entry["original_name"],
                cwd=runtime_home,
            )
        after = container_identity(entry["original_name"], runtime_home)
        if (
            after["container_id"] != entry["container"]["container_id"]
            or after["image_id"] != entry["container"]["image_id"]
            or after["running"] != entry["was_running"]
        ):
            raise RuntimeError(
                f"rollback did not restore container identity for {service}"
            )
        restored[service] = after
    return restored


def restore_or_recreate_previous_containers(
    parked: dict[str, dict[str, object]],
    runtime_home: Path,
    override_file: Path,
    rollback_images: dict[str, dict[str, object]],
) -> dict[str, object]:
    """Restore parked app containers, or reconstruct them if Compose removed them.

    Compose matches its containers by immutable labels, which survive
    ``docker rename``, so the activation ``compose up`` removes renamed parked
    containers whose image differs from the new desired state. Parking therefore
    also commits each stopped container to a run-scoped snapshot tag: when the
    container object is gone, rollback recreates the exact parked filesystem
    through Compose from the verified tag instead of the older base image.
    Only when a snapshot is missing too does rollback fall back to the pinned
    base images. The saved .env must already refer to the old, verified image
    IDs. No volumes or non-application services are modified here.
    """
    try:
        restored = restore_parked_containers(parked, runtime_home)
        discard_parked_images(parked, runtime_home)
        return {"mode": "parked", "services": restored}
    except subprocess.CalledProcessError as restore_error:
        # Never hide a genuine identity or rename failure by rebuilding. Only
        # missing parked containers qualify for the snapshot/image fallback.
        missing = [
            service for service, entry in parked.items()
            if not resource_exists("container", entry["parked_name"], runtime_home)
        ]
        if not missing:
            raise
        actual_env = read_environment(runtime_home / ".env")
        if actual_env.get("STANDING_PROJECT_NAME") != "wikijump-standing":
            raise RuntimeError("rollback is not targeting the standing Compose project") from restore_error
        expected = rollback_environment(actual_env, rollback_images)
        for service in SERVICES:
            key = f"STANDING_{service.upper()}_IMAGE"
            if actual_env.get(key) != expected[key]:
                raise RuntimeError(
                    f"rollback image in runtime environment is not pinned for {service}"
                ) from restore_error
        tagged: dict[str, str] = {}
        tagged_ids: dict[str, str] = {}
        for service in missing:
            spec = parked[service].get("parked_image")
            tag = spec.get("tag") if isinstance(spec, dict) else None
            if tag and resource_exists("image", tag, runtime_home):
                actual = command(
                    "docker", "image", "inspect", "--format", "{{.Id}}", tag,
                    cwd=runtime_home,
                )
                if actual != spec.get("image_id"):
                    raise RuntimeError(
                        f"parked snapshot image changed for {service}"
                    ) from restore_error
                tagged[service] = tag
                # The runtime reports resolved image IDs, not tag refs, so the
                # post-recreate check must compare against the snapshot's ID.
                tagged_ids[service] = actual
        wanted = {
            service: tagged_ids.get(service, rollback_images[service]["id"])
            for service in SERVICES
        }
        if tagged:
            rebased = dict(actual_env)
            for service, tag in tagged.items():
                rebased[f"STANDING_{service.upper()}_IMAGE"] = tag
            write_environment(runtime_home / ".env", rebased)
        command(
            *compose_command(
                runtime_home, "up", "--detach", "--no-deps", "--no-build",
                "--pull", "never", "--force-recreate", *SERVICES,
                override_file=override_file,
            ),
            cwd=runtime_home,
        )
        current = runtime_containers(runtime_home)
        for service in SERVICES:
            if current[service]["image_id"] != wanted[service] or not current[service]["running"]:
                raise RuntimeError(
                    f"recreated rollback service {service} does not run its previous image"
                ) from restore_error
        if not tagged:
            return {"mode": "recreated-from-pinned-images", "missing_parked": missing,
                    "services": {service: current[service] for service in SERVICES}}
        return {"mode": "parked-image", "missing_parked": missing,
                "parked_image_services": sorted(tagged),
                "base_image_services": sorted(set(SERVICES) - set(tagged)),
                "services": {service: current[service] for service in SERVICES}}


def _park_one_container(
    service: str,
    old: dict[str, object],
    runtime_home: Path,
    run_id: str,
    parked: dict[str, dict[str, object]],
    lock: threading.Lock,
) -> None:
    """Rename, stop, verify, and snapshot one application container.

    The entry is registered in ``parked`` at the same point as the serial
    implementation registered it, so a failure partway still leaves the
    container listed for the restore path.
    """
    parked_name = parked_container_name(run_id, service)
    if resource_exists("container", parked_name, runtime_home):
        raise RuntimeError(f"rollback container already exists: {parked_name}")
    command(
        "docker",
        "rename",
        old["container_id"],
        parked_name,
        cwd=runtime_home,
    )
    renamed = container_identity(parked_name, runtime_home)
    if renamed["container_id"] != old["container_id"]:
        raise RuntimeError(f"parked container identity changed for {service}")
    entry: dict[str, object] = {
        "service": service,
        "original_name": old["name"],
        "parked_name": parked_name,
        "was_running": old["running"],
        "container": renamed,
    }
    with lock:
        parked[service] = entry
    if old["running"]:
        command("docker", "stop", parked_name, cwd=runtime_home)
    entry["container"] = container_identity(parked_name, runtime_home)
    if entry["container"]["running"]:
        raise RuntimeError(f"parked container is still running for {service}")
    tag = parked_image_tag(run_id, service)
    entry["parked_image"] = {
        "tag": tag,
        "image_id": commit_parked_container(parked_name, tag, runtime_home),
    }


def park_containers(
    previous: dict[str, dict[str, object]], runtime_home: Path, run_id: str
) -> dict[str, dict[str, object]]:
    """Rename, stop, verify, and snapshot every application container.

    The snapshot tag is the part of the parked set that survives the
    activation ``compose up``: Compose claims containers by immutable labels
    and removes renamed ones whose image changed, but the committed tag keeps
    the exact stopped filesystem restorable through Compose at rollback.

    The services park concurrently: each touches only its own container and
    image tag, and serial parking (stop grace plus a filesystem commit per
    service) was most of the activation stage's unexplained time. A failure
    restores whatever was parked, as the serial version did.
    """
    parked: dict[str, dict[str, object]] = {}
    lock = threading.Lock()
    try:
        prune_parked_images(runtime_home)
        with ThreadPoolExecutor(max_workers=len(SERVICES)) as pool:
            futures = [
                pool.submit(
                    _park_one_container,
                    service,
                    previous[service],
                    runtime_home,
                    run_id,
                    parked,
                    lock,
                )
                for service in SERVICES
            ]
            for future in futures:
                future.result()
    except Exception:
        try:
            restore_parked_containers(parked, runtime_home)
            discard_parked_images(parked, runtime_home)
        except Exception as restore_error:
            raise RuntimeError(
                "failed to restore partially parked containers"
            ) from restore_error
        raise
    return parked


def atomic_json(path: Path, value: dict[str, object]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(
        "w", encoding="utf-8", dir=path.parent, prefix=f".{path.name}.", delete=False
    ) as temporary:
        json.dump(value, temporary, indent=2, sort_keys=True)
        temporary.write("\n")
        temporary.flush()
        os.fsync(temporary.fileno())
        temporary_path = Path(temporary.name)
    os.chmod(temporary_path, 0o600)
    os.replace(temporary_path, path)


