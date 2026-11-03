from __future__ import annotations

import json
import sys
import tempfile
import unittest
from argparse import Namespace
from pathlib import Path
from unittest import mock


STANDING_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(STANDING_ROOT))

import volume_transfer as transfer  # noqa: E402


def digest(value: str = "a") -> dict[str, object]:
    return {
        "tree_sha256": value * 64,
        "entries": 12,
        "logical_file_bytes": 345,
    }


class VolumeTransferTest(unittest.TestCase):
    def test_load_migration_record_requires_all_canonical_equal_digests(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            record = root / "migration.json"
            record.write_text(
                json.dumps(
                    {
                        "schema": transfer.SCHEMA,
                        "status": "verified",
                        "roles": [
                            {
                                "role": role,
                                "legacy_volume": transfer.LEGACY_VOLUMES[role],
                                "durable_volume": transfer.DURABLE_VOLUMES[role],
                                "source_before": digest(role[0]),
                                "source_after": digest(role[0]),
                                "destination_after": digest(role[0]),
                            }
                            for role in transfer.ROLES
                        ],
                    }
                ),
                encoding="utf-8",
            )
            loaded = transfer.load_migration_record(record)
            self.assertEqual(loaded["status"], "verified")

            value = json.loads(record.read_text(encoding="utf-8"))
            value["roles"][1]["destination_after"]["entries"] = 13
            record.write_text(json.dumps(value), encoding="utf-8")
            with self.assertRaisesRegex(
                transfer.VolumeTransferError, "digest mismatch for files"
            ):
                transfer.load_migration_record(record)

    def test_migrate_copies_each_legacy_role_and_keeps_rollback_inputs(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            record = Path(temporary).resolve() / "migration.json"
            copies: list[tuple[str, str, str]] = []
            created: list[tuple[str, bool]] = []
            tree_calls: dict[str, int] = {}

            def tree(_image: str, volume: str) -> dict[str, object]:
                tree_calls[volume] = tree_calls.get(volume, 0) + 1
                role = next(
                    role
                    for role in transfer.ROLES
                    if volume
                    in {
                        transfer.LEGACY_VOLUMES[role],
                        transfer.DURABLE_VOLUMES[role],
                    }
                )
                return digest(role[0])

            with (
                mock.patch.object(transfer, "require_quiesced"),
                mock.patch.object(transfer, "volume_exists", return_value=True),
                mock.patch.object(
                    transfer, "resolve_helper_image", return_value="sha256:" + "f" * 64
                ),
                mock.patch.object(
                    transfer,
                    "create_durable_volume",
                    side_effect=lambda role, replace: (
                        created.append((role, replace)),
                        transfer.DURABLE_VOLUMES[role],
                    )[1],
                ),
                mock.patch.object(transfer, "tree_digest", side_effect=tree),
                mock.patch.object(
                    transfer,
                    "copy_volume",
                    side_effect=lambda image, source, destination: copies.append(
                        (image, source, destination)
                    ),
                ),
            ):
                status = transfer.migrate(
                    Namespace(
                        record=record,
                        helper_image=None,
                        replace_destinations=False,
                    )
                )

            self.assertEqual(status, 0)
            value = json.loads(record.read_text(encoding="utf-8"))
            self.assertEqual(value["status"], "verified")
            self.assertTrue(value["legacy_retained"])
            self.assertEqual(created, [(role, False) for role in transfer.ROLES])
            self.assertEqual(
                [(source, destination) for _, source, destination in copies],
                [
                    (transfer.LEGACY_VOLUMES[role], transfer.DURABLE_VOLUMES[role])
                    for role in transfer.ROLES
                ],
            )
            for role in transfer.ROLES:
                self.assertEqual(tree_calls[transfer.LEGACY_VOLUMES[role]], 2)
                self.assertEqual(tree_calls[transfer.DURABLE_VOLUMES[role]], 1)

    def test_migrate_writes_failed_receipt_without_deleting_partial_destination(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            record = Path(temporary).resolve() / "migration.json"
            with (
                mock.patch.object(transfer, "require_quiesced"),
                mock.patch.object(transfer, "volume_exists", return_value=True),
                mock.patch.object(
                    transfer, "resolve_helper_image", return_value="sha256:" + "f" * 64
                ),
                mock.patch.object(
                    transfer,
                    "create_durable_volume",
                    return_value=transfer.DURABLE_VOLUMES["database"],
                ),
                mock.patch.object(
                    transfer, "tree_digest", side_effect=transfer.VolumeTransferError("boom")
                ),
            ):
                with self.assertRaisesRegex(transfer.VolumeTransferError, "boom"):
                    transfer.migrate(
                        Namespace(
                            record=record,
                            helper_image=None,
                            replace_destinations=False,
                        )
                    )
            value = json.loads(record.read_text(encoding="utf-8"))
            self.assertEqual(value["status"], "failed")
            self.assertEqual(
                value["created_destinations"],
                [transfer.DURABLE_VOLUMES["database"]],
            )

    def test_post_cutover_requires_durable_mounts_and_retained_legacy_volumes(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary).resolve()
            record = root / "migration.json"
            output = root / "cutover.json"
            record.write_text(
                json.dumps(
                    {
                        "schema": transfer.SCHEMA,
                        "status": "verified",
                        "roles": [
                            {
                                "role": role,
                                "legacy_volume": transfer.LEGACY_VOLUMES[role],
                                "durable_volume": transfer.DURABLE_VOLUMES[role],
                                "source_before": digest(role[0]),
                                "source_after": digest(role[0]),
                                "destination_after": digest(role[0]),
                            }
                            for role in transfer.ROLES
                        ],
                    }
                ),
                encoding="utf-8",
            )
            running = [
                f"{transfer.PROJECT_NAME}-{role}-1"
                for role in ("database", "files", "cache", "deepwell", "framerail", "wws", "caddy")
            ]
            durable_consumers = [
                {
                    "name": f"{transfer.PROJECT_NAME}-{role}-1",
                    "running": True,
                    "volumes": [transfer.DURABLE_VOLUMES[role]],
                }
                for role in transfer.ROLES
            ]

            def consumers(names: set[str]) -> list[dict[str, object]]:
                return durable_consumers if names == set(transfer.DURABLE_VOLUMES.values()) else []

            with (
                mock.patch.object(
                    transfer, "running_project_containers", return_value=running
                ),
                mock.patch.object(transfer, "volume_consumers", side_effect=consumers),
                mock.patch.object(transfer, "volume_exists", return_value=True),
            ):
                status = transfer.post_cutover(
                    Namespace(record=record, output=output)
                )
            self.assertEqual(status, 0)
            value = json.loads(output.read_text(encoding="utf-8"))
            self.assertEqual(value["status"], "pass")
            self.assertTrue(value["legacy_retained"])

    def test_runtime_home_binding_rewrites_only_the_volume_identity(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary).resolve()
            (root / "compose.yaml").write_text(
                "\n".join(transfer.DURABLE_VOLUMES.values()),
                encoding="utf-8",
            )
            identity = {
                "schema_version": 1,
                "project_name": transfer.PROJECT_NAME,
                "wikijump_sha": "a" * 40,
                "persistent_volumes": [
                    *transfer.LEGACY_VOLUMES.values(),
                    *transfer.CADDY_VOLUMES,
                ],
            }
            (root / "identity.json").write_text(
                json.dumps(identity), encoding="utf-8"
            )
            result = transfer.bind_runtime_home_to_durable_volumes(
                root, migration_receipt_sha256="b" * 64
            )
            updated = json.loads((root / "identity.json").read_text(encoding="utf-8"))
            self.assertEqual(
                updated["persistent_volumes"], list(transfer.PERSISTENT_VOLUMES)
            )
            self.assertEqual(updated["wikijump_sha"], "a" * 40)
            self.assertEqual(updated["volume_migration"]["receipt_sha256"], "b" * 64)
            self.assertEqual(result["persistent_volumes"], list(transfer.PERSISTENT_VOLUMES))

            # Repeating the binding is intentionally idempotent.
            repeated = transfer.bind_runtime_home_to_durable_volumes(
                root, migration_receipt_sha256="b" * 64
            )
            self.assertEqual(repeated["identity_sha256"], result["identity_sha256"])

    def test_runtime_home_binding_refuses_a_compose_that_still_names_legacy_data(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary).resolve()
            (root / "compose.yaml").write_text(
                "\n".join(
                    [
                        transfer.LEGACY_VOLUMES["database"],
                        transfer.DURABLE_VOLUMES["files"],
                        transfer.DURABLE_VOLUMES["cache"],
                    ]
                ),
                encoding="utf-8",
            )
            (root / "identity.json").write_text(
                json.dumps(
                    {
                        "project_name": transfer.PROJECT_NAME,
                        "persistent_volumes": [
                            *transfer.LEGACY_VOLUMES.values(),
                            *transfer.CADDY_VOLUMES,
                        ],
                    }
                ),
                encoding="utf-8",
            )
            with self.assertRaisesRegex(
                transfer.VolumeTransferError, "compose still names legacy"
            ):
                transfer.bind_runtime_home_to_durable_volumes(
                    root, migration_receipt_sha256="c" * 64
                )

    def test_archive_manifest_rejects_unknown_compression(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary).resolve()
            (root / "database.tar").write_bytes(b"archive")
            rows = []
            for role in transfer.ARCHIVE_ROLES:
                archive = root / f"{role}.tar"
                archive.write_bytes(b"archive")
                rows.append(
                    {
                        "role": role,
                        "volume": transfer.ARCHIVE_VOLUMES[role],
                        "tree": digest("a"),
                        "archive": archive.name,
                        "archive_sha256": transfer.sha256_file(archive),
                        "compression": "brotli" if role == "files" else "none",
                    }
                )
            (root / "manifest.json").write_text(
                json.dumps(
                    {
                        "schema": transfer.ARCHIVE_SCHEMA,
                        "status": "sealed",
                        "roles": rows,
                    }
                ),
                encoding="utf-8",
            )
            with (
                mock.patch.object(
                    transfer, "resolve_helper_image", return_value="sha256:" + "f" * 64
                ),
                mock.patch.object(transfer, "volume_exists", return_value=False),
            ):
                with self.assertRaisesRegex(
                    transfer.VolumeTransferError, "unsupported archive compression"
                ):
                    transfer.restore(
                        Namespace(
                            input_dir=root,
                            helper_image="image",
                            volume_prefix=None,
                        )
                    )

    def test_restore_prefix_keeps_archive_identity_but_uses_rehearsal_volumes(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary).resolve()
            rows = []
            for role in transfer.ARCHIVE_ROLES:
                archive = root / f"{role}.tar"
                archive.write_bytes(role.encode())
                rows.append(
                    {
                        "role": role,
                        "volume": transfer.ARCHIVE_VOLUMES[role],
                        "tree": digest(role[0]),
                        "archive": archive.name,
                        "archive_sha256": transfer.sha256_file(archive),
                        "compression": "none",
                    }
                )
            (root / "manifest.json").write_text(
                json.dumps(
                    {
                        "schema": transfer.ARCHIVE_SCHEMA,
                        "status": "sealed",
                        "roles": rows,
                    }
                ),
                encoding="utf-8",
            )
            created: list[tuple[str, str, str | None]] = []
            extracted: list[tuple[str, str]] = []

            with (
                mock.patch.object(
                    transfer, "resolve_helper_image", return_value="sha256:" + "f" * 64
                ),
                mock.patch.object(transfer, "volume_exists", return_value=False),
                mock.patch.object(
                    transfer,
                    "create_restored_volume",
                    side_effect=lambda role, volume, restored_from=None: created.append(
                        (role, volume, restored_from)
                    )
                    or volume,
                ),
                mock.patch.object(
                    transfer,
                    "extract_archive",
                    side_effect=lambda image, volume, archive, gzip: extracted.append(
                        (volume, archive.name)
                    ),
                ),
                mock.patch.object(
                    transfer,
                    "tree_digest",
                    side_effect=lambda image, volume: digest(
                        next(
                            role[0]
                            for role in transfer.ARCHIVE_ROLES
                            if volume.endswith(transfer.ARCHIVE_VOLUMES[role])
                        )
                    ),
                ),
            ):
                status = transfer.restore(
                    Namespace(
                        input_dir=root,
                        helper_image="image",
                        volume_prefix="restore-test-",
                    )
                )

            self.assertEqual(status, 0)
            self.assertEqual(
                created,
                [
                    (
                        role,
                        f"restore-test-{transfer.ARCHIVE_VOLUMES[role]}",
                        transfer.ARCHIVE_VOLUMES[role],
                    )
                    for role in transfer.ARCHIVE_ROLES
                ],
            )
            self.assertEqual(
                [volume for volume, _ in extracted],
                [
                    f"restore-test-{transfer.ARCHIVE_VOLUMES[role]}"
                    for role in transfer.ARCHIVE_ROLES
                ],
            )

    def test_restore_prefix_must_be_docker_safe_and_end_in_dash(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary).resolve()
            rows = []
            for role in transfer.ARCHIVE_ROLES:
                archive = root / f"{role}.tar"
                archive.write_bytes(b"archive")
                rows.append(
                    {
                        "role": role,
                        "volume": transfer.ARCHIVE_VOLUMES[role],
                        "tree": digest("a"),
                        "archive": archive.name,
                        "archive_sha256": transfer.sha256_file(archive),
                        "compression": "none",
                    }
                )
            (root / "manifest.json").write_text(
                json.dumps(
                    {
                        "schema": transfer.ARCHIVE_SCHEMA,
                        "status": "sealed",
                        "roles": rows,
                    }
                ),
                encoding="utf-8",
            )
            with mock.patch.object(
                transfer, "resolve_helper_image", return_value="sha256:" + "f" * 64
            ):
                with self.assertRaisesRegex(
                    transfer.VolumeTransferError, "prefix must be lowercase"
                ):
                    transfer.restore(
                        Namespace(
                            input_dir=root,
                            helper_image="image",
                            volume_prefix="BadPrefix",
                        )
                    )


if __name__ == "__main__":
    unittest.main()
